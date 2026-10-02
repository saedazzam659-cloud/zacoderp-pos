import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

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
      issued_number TEXT;
      previous_number TEXT;
      protection_enabled BOOLEAN := FALSE;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF COALESCE((to_jsonb(OLD)->>'is_sequence_protected')::BOOLEAN, FALSE) THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'هذا المستند المرقم محمي ولا يمكن حذفه. استخدم مسار الإلغاء بدلاً من الحذف.',
            DETAIL = 'SEQUENCE_PROTECTED_DELETE';
        END IF;
        RETURN OLD;
      END IF;

      current_row := to_jsonb(NEW);
      IF COALESCE((current_row->>'is_sequence_protected')::BOOLEAN, FALSE) THEN
        RETURN NEW;
      END IF;

      company_id_value := NULLIF(current_row->>'company_id', '')::INTEGER;
      issued_number := NULLIF(BTRIM(current_row->>TG_ARGV[0]), '');
      IF company_id_value IS NULL OR issued_number IS NULL THEN
        RETURN NEW;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        previous_row := to_jsonb(OLD);
        IF COALESCE((previous_row->>'is_sequence_protected')::BOOLEAN, FALSE) THEN
          previous_number := NULLIF(BTRIM(previous_row->>TG_ARGV[0]), '');
          IF issued_number IS DISTINCT FROM previous_number THEN
            RAISE EXCEPTION USING
              ERRCODE = 'P0001',
              MESSAGE = 'لا يمكن تغيير رقم مستند محمي بعد إصداره.',
              DETAIL = 'SEQUENCE_PROTECTED_NUMBER_CHANGE';
          END IF;
          NEW.is_sequence_protected := TRUE;
          RETURN NEW;
        END IF;

        -- Do not retroactively protect a legacy document just because an
        -- unrelated field is edited after package activation. Only its first
        -- non-empty sequence assignment can make it protected.
        previous_number := NULLIF(BTRIM(previous_row->>TG_ARGV[0]), '');
        IF previous_number IS NOT NULL THEN
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
          CONTINUE;
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