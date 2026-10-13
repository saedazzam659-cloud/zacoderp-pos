import { and, eq, sql } from "drizzle-orm";
import { companiesTable, db } from "@workspace/db";

/**
 * Tenant-owned records whose identifiers are issued by a document sequence.
 * Master-data codes and external references are deliberately excluded.
 */
const NUMBERED_DOCUMENT_TABLES = [
  ["sales_invoices", "doc_number"],
  ["sales_returns", "doc_number"],
  ["sales_quotations", "doc_number"],
  ["sales_orders", "doc_number"],
  ["customer_settlements", "doc_number"],
  ["purchase_invoices", "doc_number"],
  ["purchase_returns", "doc_number"],
  ["purchase_orders", "doc_number"],
  ["supplier_settlements", "doc_number"],
  ["journal_entries", "doc_number"],
  ["receipt_vouchers", "code"],
  ["payment_vouchers", "code"],
  ["cash_transfers", "code"],
  ["stock_transfers", "transfer_number"],
  ["stock_adjustments", "adjustment_number"],
  ["stock_counts", "count_number"],
  ["goods_receipts", "doc_number"],
  ["goods_deliveries", "doc_number"],
  ["sister_transfers", "transfer_number"],
  ["sister_returns", "return_number"],
  ["sister_settlements", "code"],
  ["account_notes", "note_number"],
  ["employee_contracts", "contract_number"],
  ["payroll_runs", "code"],
  ["mudad_salary_batches", "code"],
  ["production_orders", "order_number"],
  ["contracting_owner_contracts", "contract_number"],
  ["contracting_sub_contracts", "contract_number"],
  ["contracting_progress_bills", "bill_number"],
  ["installment_contracts", "contract_number"],
  ["maintenance_orders", "doc_number"],
  ["hotel_bookings", "doc_number"],
  ["hotel_payments", "doc_number"],
  ["hotel_housekeeping", "doc_number"],
  ["hospital_appointments", "doc_number"],
  ["hospital_invoices", "doc_number"],
  ["hospital_insurance_claims", "claim_number"],
  ["safety_incidents", "incident_number"],
  ["pos_orders", "order_number"],
  ["offers", "offer_number"],
  ["online_store_orders", "code"],
] as const;

const targetValues = NUMBERED_DOCUMENT_TABLES
  .map(([tableName, numberColumn]) => `('${tableName}', '${numberColumn}')`)
  .join(",\n");

export const SEQUENCE_PROTECTION_LOCK_NAMESPACE = 8_164_027;

/**
 * Change the package flag and, when enabling it, protect every already-issued
 * number in one transaction. The advisory lock serializes this backfill with
 * number-bearing writes in the trigger, so no legacy row can slip between the
 * setting change and the sweep.
 */
export async function setCompanySequenceProtectionEnabled(
  companyId: number,
  enabled: boolean,
): Promise<{ sequenceProtectionEnabled: boolean; protectedExistingRecords: number } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(${SEQUENCE_PROTECTION_LOCK_NAMESPACE}, ${companyId})
        `);

        const [company] = await tx.select({ id: companiesTable.id })
          .from(companiesTable)
          .where(and(
            eq(companiesTable.id, companyId),
            eq(companiesTable.isInternalDemoWorkspace, false),
          ))
          .for("update")
          .limit(1);
        if (!company) return null;

        const [updated] = await tx.update(companiesTable)
          .set({ sequenceProtectionEnabled: enabled })
          .where(eq(companiesTable.id, companyId))
          .returning({ sequenceProtectionEnabled: companiesTable.sequenceProtectionEnabled });
        if (!updated) return null;

        let protectedExistingRecords = 0;
        if (enabled) {
          const result = await tx.execute(sql`
            SELECT public.zacode_backfill_sequence_protection(${companyId}) AS protected_count
          `);
          const rows = Array.isArray(result)
            ? result
            : Array.isArray((result as any)?.rows)
              ? (result as any).rows
              : [];
          protectedExistingRecords = Number(rows[0]?.protected_count ?? 0);
          if (!Number.isFinite(protectedExistingRecords)) {
            throw new Error("تعذر التحقق من عدد المستندات التي شملتها حماية التسلسلات.");
          }
        }

        return {
          sequenceProtectionEnabled: updated.sequenceProtectionEnabled,
          protectedExistingRecords,
        };
      });
    } catch (error) {
      const databaseError = error as { code?: string; cause?: { code?: string } };
      const code = databaseError?.code ?? databaseError?.cause?.code;
      if (code !== "40P01" || attempt === 2) throw error;
      // A numbered-row writer can already own its row lock while contending
      // for this activation lock. PostgreSQL rolls one side back; retry the
      // entire atomic activation if it chose this transaction as the victim.
    }
  }
  throw new Error("تعذر تفعيل حماية التسلسلات بعد إعادة المحاولة.");
}

/**
 * Install an additive marker + database guard on each existing numbered
 * document header. The marker is stored on the record itself, so it remains
 * protected if the company later disables the package and travels with normal
 * company snapshots/restores.
 */
export async function ensureSequenceProtectionSchema(): Promise<void> {
  await db.execute(sql.raw(`
    ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS sequence_protection_enabled BOOLEAN NOT NULL DEFAULT FALSE
  `));

  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION public.zacode_sequence_protection_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      current_row JSONB;
      previous_row JSONB;
      company_id_value INTEGER;
      previous_company_id INTEGER;
      issued_number TEXT;
      previous_number TEXT;
      protection_enabled BOOLEAN := FALSE;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        previous_row := to_jsonb(OLD);
        previous_company_id := NULLIF(previous_row->>'company_id', '')::INTEGER;
        previous_number := NULLIF(BTRIM(previous_row->>TG_ARGV[0]), '');

        IF previous_company_id IS NOT NULL
           AND (
             previous_number IS NOT NULL
             OR COALESCE((previous_row->>'is_sequence_protected')::BOOLEAN, FALSE)
           ) THEN
          PERFORM pg_advisory_xact_lock(${SEQUENCE_PROTECTION_LOCK_NAMESPACE}, previous_company_id);
        END IF;

        IF COALESCE((previous_row->>'is_sequence_protected')::BOOLEAN, FALSE)
           AND (
             previous_company_id IS NULL
             OR current_setting('zacode.company_reset_company_id', TRUE)
                  IS DISTINCT FROM previous_company_id::TEXT
           ) THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'هذا المستند المرقم محمي ولا يمكن حذفه. استخدم مسار الإلغاء بدلاً من الحذف.',
            DETAIL = 'SEQUENCE_PROTECTED_DELETE';
        END IF;
        RETURN OLD;
      END IF;

      current_row := to_jsonb(NEW);
      company_id_value := NULLIF(current_row->>'company_id', '')::INTEGER;
      issued_number := NULLIF(BTRIM(current_row->>TG_ARGV[0]), '');

      IF TG_OP = 'UPDATE' THEN
        previous_row := to_jsonb(OLD);
        previous_company_id := NULLIF(previous_row->>'company_id', '')::INTEGER;
        previous_number := NULLIF(BTRIM(previous_row->>TG_ARGV[0]), '');

        -- Only identity changes need coordination. Unrelated edits to legacy
        -- rows can proceed while a backfill waits for their row lock, avoiding
        -- a lock cycle with activation.
        IF issued_number IS DISTINCT FROM previous_number
           OR company_id_value IS DISTINCT FROM previous_company_id THEN
          IF company_id_value IS NOT NULL AND previous_company_id IS NOT NULL
             AND company_id_value IS DISTINCT FROM previous_company_id THEN
            PERFORM pg_advisory_xact_lock(
              ${SEQUENCE_PROTECTION_LOCK_NAMESPACE},
              LEAST(company_id_value, previous_company_id)
            );
            PERFORM pg_advisory_xact_lock(
              ${SEQUENCE_PROTECTION_LOCK_NAMESPACE},
              GREATEST(company_id_value, previous_company_id)
            );
          ELSIF COALESCE(company_id_value, previous_company_id) IS NOT NULL THEN
            PERFORM pg_advisory_xact_lock(
              ${SEQUENCE_PROTECTION_LOCK_NAMESPACE},
              COALESCE(company_id_value, previous_company_id)
            );
          END IF;
        END IF;
      ELSIF company_id_value IS NOT NULL
         AND (
           issued_number IS NOT NULL
           OR COALESCE((current_row->>'is_sequence_protected')::BOOLEAN, FALSE)
         ) THEN
        PERFORM pg_advisory_xact_lock(${SEQUENCE_PROTECTION_LOCK_NAMESPACE}, company_id_value);
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF COALESCE((previous_row->>'is_sequence_protected')::BOOLEAN, FALSE) THEN
          IF issued_number IS DISTINCT FROM previous_number
             OR company_id_value IS DISTINCT FROM previous_company_id THEN
            RAISE EXCEPTION USING
              ERRCODE = 'P0001',
              MESSAGE = 'لا يمكن تغيير رقم المستند المحمي أو نقله إلى شركة أخرى.',
              DETAIL = 'SEQUENCE_PROTECTED_NUMBER_CHANGE';
          END IF;
          NEW.is_sequence_protected := TRUE;
          RETURN NEW;
        END IF;
      END IF;

      IF COALESCE((current_row->>'is_sequence_protected')::BOOLEAN, FALSE) THEN
        RETURN NEW;
      END IF;

      IF company_id_value IS NULL OR issued_number IS NULL THEN
        RETURN NEW;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        -- A legacy row only becomes newly protected through activation's
        -- backfill, unless its number or tenant changes under the active policy.
        IF issued_number IS NOT DISTINCT FROM previous_number
           AND company_id_value IS NOT DISTINCT FROM previous_company_id THEN
          RETURN NEW;
        END IF;
      END IF;

      SELECT c.sequence_protection_enabled
        INTO protection_enabled
        FROM companies c
        WHERE c.id = company_id_value;

      IF COALESCE(protection_enabled, FALSE) THEN
        NEW.is_sequence_protected := TRUE;
      END IF;
      RETURN NEW;
    END;
    $function$;
  `));

  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION public.zacode_backfill_sequence_protection(target_company_id INTEGER)
    RETURNS BIGINT
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      target RECORD;
      target_regclass REGCLASS;
      protected_rows BIGINT;
      total_protected BIGINT := 0;
    BEGIN
      FOR target IN
        SELECT * FROM (VALUES
          ${targetValues}
        ) AS document_targets(table_name, number_column)
      LOOP
        target_regclass := to_regclass(format('public.%I', target.table_name));
        IF target_regclass IS NULL THEN
          CONTINUE;
        END IF;

        IF (
          SELECT COUNT(DISTINCT column_name)
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = target.table_name
            AND column_name IN ('id', 'company_id', target.number_column, 'is_sequence_protected')
        ) <> 4 THEN
          RAISE EXCEPTION 'sequence protection target %.% is missing a required column',
            target.table_name, target.number_column;
        END IF;

        EXECUTE format(
          'UPDATE public.%I
              SET is_sequence_protected = TRUE
            WHERE company_id = $1
              AND NULLIF(BTRIM(%I::TEXT), '''') IS NOT NULL
              AND NOT COALESCE(is_sequence_protected, FALSE)',
          target.table_name,
          target.number_column
        ) USING target_company_id;
        GET DIAGNOSTICS protected_rows = ROW_COUNT;
        total_protected := total_protected + protected_rows;
      END LOOP;

      RETURN total_protected;
    END;
    $function$;
  `));

  await db.execute(sql.raw(`
    DO $sequence_protection$
    DECLARE
      target RECORD;
      trigger_name TEXT;
      target_regclass REGCLASS;
    BEGIN
      FOR target IN
        SELECT * FROM (VALUES
          ${targetValues}
        ) AS document_targets(table_name, number_column)
      LOOP
        target_regclass := to_regclass(format('public.%I', target.table_name));
        IF target_regclass IS NULL THEN
          CONTINUE;
        END IF;

        IF (
          SELECT COUNT(DISTINCT column_name)
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = target.table_name
            AND column_name IN ('id', 'company_id', target.number_column)
        ) <> 3 THEN
          RAISE EXCEPTION 'sequence protection target %.% is missing id, company_id, or number column',
            target.table_name, target.number_column;
        END IF;

        EXECUTE format(
          'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS is_sequence_protected BOOLEAN NOT NULL DEFAULT FALSE',
          target.table_name
        );

        trigger_name := format('trg_seq_protect_%s', target.table_name);
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = target_regclass
            AND tgname = trigger_name
            AND NOT tgisinternal
        ) THEN
          EXECUTE format(
            'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.zacode_sequence_protection_guard(%L)',
            trigger_name,
            target.table_name,
            target.number_column
          );
        END IF;
      END LOOP;
    END;
    $sequence_protection$;
  `));
}