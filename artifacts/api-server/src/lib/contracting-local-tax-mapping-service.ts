import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  companiesTable,
  contractingOwnerBillTaxMappingsTable,
} from "@workspace/db";
import { listContractBoqLines } from "./contracting-boq-service.js";

type CountryConfig = {
  countryCode: "EG" | "JO";
  provider: "egypt_eta" | "jordan_national";
  permission: "egypt_tax" | "jordan_tax";
};

type CleanMapping = {
  providerItemCode: string;
  providerUnitCode: string;
  providerTaxCategoryCode: string;
};

let ensureTablesPromise: Promise<void> | null = null;

function error(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function validateOwnerBillTaxMappingInput(input: unknown): CleanMapping {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw error("بيانات ربط البنود غير صالحة");
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set([
    "providerItemCode",
    "providerUnitCode",
    "providerTaxCategoryCode",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw error("تحتوي بيانات الربط على حقول غير مسموح بها");
  }

  const clean: CleanMapping = {
    providerItemCode: "",
    providerUnitCode: "",
    providerTaxCategoryCode: "",
  };
  for (const key of allowed) {
    const value = body[key];
    if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 128) {
      throw error("أدخل رموز الصنف والوحدة والفئة الضريبية المعتمدة، بحد أقصى 128 حرفًا لكل رمز");
    }
    clean[key as keyof CleanMapping] = value.trim();
  }
  return clean;
}

export async function ensureContractingLocalTaxMappingTables(): Promise<void> {
  if (!ensureTablesPromise) {
    ensureTablesPromise = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS contracting_owner_bill_tax_mappings (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE CASCADE,
          owner_contract_id INTEGER NOT NULL REFERENCES contracting_owner_contracts(id) ON DELETE CASCADE,
          boq_line_id INTEGER NOT NULL REFERENCES contracting_contract_boq_lines(id) ON DELETE CASCADE,
          country_code TEXT NOT NULL,
          provider TEXT NOT NULL,
          provider_item_code TEXT NOT NULL,
          provider_unit_code TEXT NOT NULL,
          provider_tax_category_code TEXT NOT NULL,
          created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          CONSTRAINT ctg_owner_bill_tax_map_country_provider_ck CHECK (
            (country_code = 'EG' AND provider = 'egypt_eta')
            OR (country_code = 'JO' AND provider = 'jordan_national')
          ),
          CONSTRAINT ctg_owner_bill_tax_map_line_provider_uidx
            UNIQUE (company_id, boq_line_id, provider)
        )
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS ctg_owner_bill_tax_map_contract_idx
          ON contracting_owner_bill_tax_mappings(company_id, project_id, owner_contract_id)
      `);
    })().catch((caught) => {
      ensureTablesPromise = null;
      throw caught;
    });
  }
  await ensureTablesPromise;
}

async function requireMappingAdmin(
  companyId: number,
  user: any,
): Promise<CountryConfig> {
  if (user?.role !== "admin" || Number(user.companyId) !== companyId) {
    throw error("إعداد ربط الضريبة متاح لمدير الشركة فقط", 403);
  }
  const [company] = await db.select({
    id: companiesTable.id,
    country: companiesTable.country,
    menuPermissions: companiesTable.menuPermissions,
  }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  if (!company) throw error("الشركة غير موجودة", 404);

  const country = String(company.country ?? "").toUpperCase();
  const config: CountryConfig | null = country === "EG"
    ? { countryCode: "EG", provider: "egypt_eta", permission: "egypt_tax" }
    : country === "JO"
      ? { countryCode: "JO", provider: "jordan_national", permission: "jordan_tax" }
      : null;
  if (!config) throw error("الربط المحلي متاح لمصر والأردن فقط؛ مسار زاتكا السعودي منفصل", 403);

  let permissions: Record<string, unknown> = {};
  try {
    permissions = JSON.parse(company.menuPermissions ?? "{}");
  } catch {
    permissions = {};
  }
  if (permissions[config.permission] !== true) {
    throw error("وحدة التكامل الضريبي غير مفعلة لهذه الشركة", 403);
  }
  return config;
}

function cleanId(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw error(`${label} غير صالح`);
  return parsed;
}

function mappingDto(row: any) {
  return {
    boqLineId: Number(row.boqLineId),
    ownerContractId: Number(row.ownerContractId),
    countryCode: row.countryCode,
    provider: row.provider,
    providerItemCode: row.providerItemCode,
    providerUnitCode: row.providerUnitCode,
    providerTaxCategoryCode: row.providerTaxCategoryCode,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

export async function listOwnerBillTaxMappings(
  companyId: number,
  projectIdValue: unknown,
  ownerContractIdValue: unknown,
  user: any,
) {
  const projectId = cleanId(projectIdValue, "المشروع");
  const ownerContractId = ownerContractIdValue == null || ownerContractIdValue === ""
    ? null
    : cleanId(ownerContractIdValue, "عقد المالك");
  const config = await requireMappingAdmin(companyId, user);

  const lines = await listContractBoqLines(companyId, projectId, {
    direction: "owner",
    ...(ownerContractId == null ? {} : { ownerContractId }),
  }, user);
  const lineIds = lines.map((line) => line.id);
  const mappings = lineIds.length === 0
    ? []
    : await db.select().from(contractingOwnerBillTaxMappingsTable).where(and(
      eq(contractingOwnerBillTaxMappingsTable.companyId, companyId),
      eq(contractingOwnerBillTaxMappingsTable.projectId, projectId),
      eq(contractingOwnerBillTaxMappingsTable.countryCode, config.countryCode),
      eq(contractingOwnerBillTaxMappingsTable.provider, config.provider),
      inArray(contractingOwnerBillTaxMappingsTable.boqLineId, lineIds),
    ));

  return {
    countryCode: config.countryCode,
    provider: config.provider,
    mappings: mappings.map(mappingDto),
  };
}

export async function saveOwnerBillTaxMapping(
  companyId: number,
  projectIdValue: unknown,
  boqLineIdValue: unknown,
  body: unknown,
  user: any,
) {
  const projectId = cleanId(projectIdValue, "المشروع");
  const boqLineId = cleanId(boqLineIdValue, "سطر جدول الكميات");
  const config = await requireMappingAdmin(companyId, user);
  const mapping = validateOwnerBillTaxMappingInput(body);
  const lines = await listContractBoqLines(companyId, projectId, { direction: "owner" }, user);
  const line = lines.find((candidate) => candidate.id === boqLineId);
  if (!line || line.ownerContractId == null) {
    throw error("سطر عقد المالك غير موجود في هذا المشروع", 404);
  }
  const userId = cleanId(user?.id, "المستخدم");

  const [saved] = await db.insert(contractingOwnerBillTaxMappingsTable).values({
    companyId,
    projectId,
    ownerContractId: line.ownerContractId,
    boqLineId,
    countryCode: config.countryCode,
    provider: config.provider,
    ...mapping,
    createdByUserId: userId,
    updatedByUserId: userId,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [
      contractingOwnerBillTaxMappingsTable.companyId,
      contractingOwnerBillTaxMappingsTable.boqLineId,
      contractingOwnerBillTaxMappingsTable.provider,
    ],
    set: {
      ownerContractId: line.ownerContractId,
      projectId,
      countryCode: config.countryCode,
      ...mapping,
      updatedByUserId: userId,
      updatedAt: new Date(),
    },
  }).returning();

  return mappingDto(saved);
}