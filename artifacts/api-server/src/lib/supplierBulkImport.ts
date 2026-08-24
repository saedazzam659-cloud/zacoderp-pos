import {
  buildSupplierBulkAccountCodes,
  SupplierBulkAccountPlanError,
} from "./supplierBulkAccounts.js";

export interface SupplierBulkImportAccount {
  id: number;
  code: string | null;
  nameAr: string | null;
  parentId: number | null;
}

export interface SupplierBulkImportExisting {
  id: number;
  code: string | null;
  nameAr: string;
  nameEn: string | null;
  vatNumber: string | null;
  crNumber: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
  buildingNumber: string | null;
  postalCode: string | null;
  country: string | null;
  currencyCode: string | null;
  creditLimit: string | null;
  accountId: number | null;
  accessible: boolean;
  currentAccount: SupplierBulkImportAccount | null;
}

export type SupplierBulkImportStatus =
  | "create"
  | "update"
  | "reassign"
  | "blocked"
  | "error";

export interface SupplierBulkImportPlanRow {
  rowNumber: number;
  status: SupplierBulkImportStatus;
  scopeBlocked?: boolean;
  matchedBy: "id" | "code" | "vatNumber" | "crNumber" | "nameAr" | null;
  supplierId: number | null;
  previousAccountId: number | null;
  nameAr: string;
  nameEn: string | null;
  currentAccount: SupplierBulkImportAccount | null;
  accountCode: string | null;
  patch: Record<string, string>;
  error: string | null;
}

export interface SupplierBulkImportPlan {
  rows: SupplierBulkImportPlanRow[];
  canCommit: boolean;
  summary: {
    total: number;
    create: number;
    update: number;
    reassign: number;
    blocked: number;
    errors: number;
  };
}

export function chooseSupplierBulkCreateBranchId(
  allowedBranchIds: number[] | null,
  requestedBranchId?: number,
): number | null {
  if (allowedBranchIds === null) return requestedBranchId ?? null;
  if (allowedBranchIds.length === 0) {
    throw new SupplierBulkAccountPlanError(
      "ليس لديك فرع مسموح لإنشاء الموردين",
      403,
    );
  }
  if (requestedBranchId == null && allowedBranchIds.length === 1) {
    return allowedBranchIds[0]!;
  }
  if (requestedBranchId == null) {
    throw new SupplierBulkAccountPlanError(
      "يجب اختيار الفرع الذي ستُنشأ فيه الموردون الجدد",
      400,
    );
  }
  if (!allowedBranchIds.includes(requestedBranchId)) {
    throw new SupplierBulkAccountPlanError(
      "غير مصرح بإنشاء الموردين في هذا الفرع",
      403,
    );
  }
  return requestedBranchId;
}

const FIELD_ALIASES = {
  id: ["id", "supplierId", "معرف المورد", "رقم المورد"],
  code: ["code", "supplierCode", "كود المورد"],
  nameAr: ["nameAr", "name", "اسم المورد", "الاسم العربي"],
  nameEn: ["nameEn", "الاسم الإنجليزي"],
  vatNumber: ["vatNumber", "vat", "الرقم الضريبي"],
  crNumber: ["crNumber", "commercialRegistration", "رقم السجل التجاري"],
  email: ["email", "البريد الإلكتروني"],
  phone: ["phone", "الجوال", "الهاتف"],
  city: ["city", "المدينة"],
  district: ["district", "الحي"],
  street: ["street", "الشارع"],
  buildingNumber: ["buildingNumber", "رقم المبنى"],
  postalCode: ["postalCode", "الرمز البريدي"],
  country: ["country", "الدولة"],
  currencyCode: ["currencyCode", "currency", "العملة"],
  creditLimit: ["creditLimit", "حد الائتمان"],
} as const;

function rawCell(row: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) return row[alias];
  }
  return undefined;
}

function textCell(row: Record<string, unknown>, aliases: readonly string[]): string | null {
  const value = rawCell(row, aliases);
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

function normalizedKey(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

function pushIndex<T>(map: Map<string, T[]>, key: string | null, value: T): void {
  if (!key) return;
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function buildPatch(row: Record<string, unknown>): {
  patch: Record<string, string>;
  id: number | null;
  error: string | null;
} {
  const idRaw = rawCell(row, FIELD_ALIASES.id);
  let id: number | null = null;
  if (idRaw !== undefined && idRaw !== null && String(idRaw).trim() !== "") {
    const parsed = Number(idRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { patch: {}, id: null, error: "معرف المورد في الملف غير صحيح" };
    }
    id = parsed;
  }

  const nameAr = textCell(row, FIELD_ALIASES.nameAr);
  if (!nameAr) {
    return { patch: {}, id, error: "اسم المورد العربي مطلوب" };
  }

  const patch: Record<string, string> = { nameAr };
  const optionalFields = [
    "code",
    "nameEn",
    "vatNumber",
    "crNumber",
    "email",
    "phone",
    "city",
    "district",
    "street",
    "buildingNumber",
    "postalCode",
    "country",
    "currencyCode",
  ] as const;
  for (const field of optionalFields) {
    const value = textCell(row, FIELD_ALIASES[field]);
    if (value !== null) patch[field] = value;
  }

  const creditRaw = rawCell(row, FIELD_ALIASES.creditLimit);
  if (creditRaw !== undefined && creditRaw !== null && String(creditRaw).trim() !== "") {
    const credit = Number(creditRaw);
    if (!Number.isFinite(credit) || credit < 0) {
      return { patch: {}, id, error: "حد الائتمان يجب أن يكون رقمًا موجبًا أو صفرًا" };
    }
    patch.creditLimit = credit.toFixed(2);
  }

  return { patch, id, error: null };
}

function uniqueLookup<T>(
  map: Map<string, T[]>,
  key: string | null,
  label: string,
): { hit: T | null; error: string | null } {
  if (!key) return { hit: null, error: null };
  const matches = map.get(key) ?? [];
  if (matches.length > 1) {
    return { hit: null, error: `${label} يطابق أكثر من مورد؛ صحّح الملف قبل المتابعة` };
  }
  return { hit: matches[0] ?? null, error: null };
}

export function summarizeSupplierBulkImportRows(
  rows: readonly SupplierBulkImportPlanRow[],
): SupplierBulkImportPlan["summary"] {
  return {
    total: rows.length,
    create: rows.filter(row => row.status === "create").length,
    update: rows.filter(row => row.status === "update").length,
    reassign: rows.filter(row => row.status === "reassign").length,
    blocked: rows.filter(row => row.status === "blocked").length,
    errors: rows.filter(row => row.error != null || row.status === "error").length,
  };
}

export function planSupplierBulkImportRows(input: {
  rawRows: unknown[];
  existingSuppliers: SupplierBulkImportExisting[];
  parentAccountId: number;
  parentAccountCode: string;
  leadingZeros: number;
  allowReassign: boolean;
}): SupplierBulkImportPlan {
  const {
    rawRows,
    existingSuppliers,
    parentAccountId,
    parentAccountCode,
    leadingZeros,
    allowReassign,
  } = input;

  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new SupplierBulkAccountPlanError("لا توجد بيانات موردين في الملف");
  }

  const codes = buildSupplierBulkAccountCodes(
    parentAccountCode,
    leadingZeros,
    rawRows.length,
  );
  const byId = new Map(existingSuppliers.map(supplier => [supplier.id, supplier]));
  const byCode = new Map<string, SupplierBulkImportExisting[]>();
  const byVat = new Map<string, SupplierBulkImportExisting[]>();
  const byCr = new Map<string, SupplierBulkImportExisting[]>();
  const byName = new Map<string, SupplierBulkImportExisting[]>();
  for (const supplier of existingSuppliers) {
    pushIndex(byCode, normalizedKey(supplier.code), supplier);
    pushIndex(byVat, normalizedKey(supplier.vatNumber), supplier);
    pushIndex(byCr, normalizedKey(supplier.crNumber), supplier);
    pushIndex(byName, normalizedKey(supplier.nameAr), supplier);
  }

  const claimedSupplierIds = new Set<number>();
  const claimedNewKeys = new Set<string>();
  const claimedNames = new Set<string>();
  const plannedRows: SupplierBulkImportPlanRow[] = [];

  for (let index = 0; index < rawRows.length; index++) {
    const raw = rawRows[index];
    const rowNumber = index + 2;
    const blankPlan = (error: string): SupplierBulkImportPlanRow => ({
      rowNumber,
      status: "error",
      matchedBy: null,
      supplierId: null,
      previousAccountId: null,
      nameAr: "",
      nameEn: null,
      currentAccount: null,
      accountCode: codes[index] ?? null,
      patch: {},
      error,
    });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      plannedRows.push(blankPlan("صف المورد غير صالح"));
      continue;
    }

    const { patch, id, error: patchError } = buildPatch(raw as Record<string, unknown>);
    if (patchError) {
      plannedRows.push(blankPlan(patchError));
      continue;
    }

    // Branch secrecy wins over every other diagnostic. Gather every raw
    // candidate first (including ambiguous buckets) so a caller cannot mix an
    // accessible identifier with a guessed hidden identifier and learn that
    // the latter matched from a more specific conflict response.
    const rawCandidates = [
      ...(id != null && byId.has(id) ? [byId.get(id)!] : []),
      ...(normalizedKey(patch.code) ? (byCode.get(normalizedKey(patch.code)!) ?? []) : []),
      ...(normalizedKey(patch.vatNumber) ? (byVat.get(normalizedKey(patch.vatNumber)!) ?? []) : []),
      ...(normalizedKey(patch.crNumber) ? (byCr.get(normalizedKey(patch.crNumber)!) ?? []) : []),
      ...(normalizedKey(patch.nameAr) ? (byName.get(normalizedKey(patch.nameAr)!) ?? []) : []),
    ];
    if (rawCandidates.some(candidate => !candidate.accessible)) {
      plannedRows.push({
        ...blankPlan("غير مصرح بإجراء العملية على أحد الموردين أو معرّفاته"),
        scopeBlocked: true,
        nameAr: patch.nameAr,
        nameEn: patch.nameEn ?? null,
        patch,
      });
      continue;
    }

    const lookups: Array<{
      matchedBy: SupplierBulkImportPlanRow["matchedBy"];
      hit: SupplierBulkImportExisting | null;
      error: string | null;
    }> = [];
    if (id != null) {
      lookups.push({
        matchedBy: "id",
        hit: byId.get(id) ?? null,
        error: byId.has(id) ? null : `المورد رقم ${id} غير موجود في هذه الشركة`,
      });
    }
    const codeLookup = uniqueLookup(byCode, normalizedKey(patch.code), "كود المورد");
    const vatLookup = uniqueLookup(byVat, normalizedKey(patch.vatNumber), "الرقم الضريبي");
    const crLookup = uniqueLookup(byCr, normalizedKey(patch.crNumber), "رقم السجل التجاري");
    const nameLookup = uniqueLookup(byName, normalizedKey(patch.nameAr), "اسم المورد");
    lookups.push(
      { matchedBy: "code", ...codeLookup },
      { matchedBy: "vatNumber", ...vatLookup },
      { matchedBy: "crNumber", ...crLookup },
      { matchedBy: "nameAr", ...nameLookup },
    );

    const lookupError = lookups.find(lookup => lookup.error)?.error;
    if (lookupError) {
      plannedRows.push({ ...blankPlan(lookupError), nameAr: patch.nameAr, nameEn: patch.nameEn ?? null, patch });
      continue;
    }

    const hits = lookups.filter(
      (lookup): lookup is typeof lookup & { hit: SupplierBulkImportExisting } => lookup.hit != null,
    );
    const distinctHitIds = new Set(hits.map(lookup => lookup.hit.id));
    if (distinctHitIds.size > 1) {
      plannedRows.push({
        ...blankPlan("بيانات الصف تطابق موردين مختلفين؛ راجع الكود والرقم الضريبي والسجل التجاري"),
        nameAr: patch.nameAr,
        nameEn: patch.nameEn ?? null,
        patch,
      });
      continue;
    }

    const chosen = hits[0] ?? null;
    const match = chosen?.hit ?? null;
    if (match && claimedSupplierIds.has(match.id)) {
      plannedRows.push({
        ...blankPlan(`المورد "${patch.nameAr}" مكرر داخل الملف`),
        nameAr: patch.nameAr,
        nameEn: patch.nameEn ?? null,
        supplierId: match.id,
        previousAccountId: match.accountId,
        matchedBy: chosen?.matchedBy ?? null,
        currentAccount: match.currentAccount,
        patch,
      });
      continue;
    }

    const finalNameKey = normalizedKey(patch.nameAr)!;
    if (claimedNames.has(finalNameKey)) {
      plannedRows.push({
        ...blankPlan(`اسم المورد "${patch.nameAr}" مكرر داخل الملف`),
        nameAr: patch.nameAr,
        nameEn: patch.nameEn ?? null,
        supplierId: match?.id ?? null,
        previousAccountId: match?.accountId ?? null,
        matchedBy: chosen?.matchedBy ?? null,
        currentAccount: match?.currentAccount ?? null,
        patch,
      });
      continue;
    }

    const rowKeys = [
      patch.code ? `code:${normalizedKey(patch.code)}` : null,
      patch.vatNumber ? `vat:${normalizedKey(patch.vatNumber)}` : null,
      patch.crNumber ? `cr:${normalizedKey(patch.crNumber)}` : null,
      `name:${finalNameKey}`,
    ].filter((key): key is string => key != null);
    if (!match && rowKeys.some(key => claimedNewKeys.has(key))) {
      plannedRows.push({
        ...blankPlan(`بيانات المورد "${patch.nameAr}" مكررة داخل الملف`),
        nameAr: patch.nameAr,
        nameEn: patch.nameEn ?? null,
        patch,
      });
      continue;
    }

    let status: SupplierBulkImportStatus = match ? "update" : "create";
    let rowError: string | null = null;
    if (match?.accountId != null) {
      if (!allowReassign) {
        status = "blocked";
        rowError = `المورد "${patch.nameAr}" مرتبط بحساب بالفعل؛ فعّل استبدال الربط للمتابعة`;
      } else if (match.currentAccount?.parentId === parentAccountId) {
        status = "blocked";
        rowError = `المورد "${patch.nameAr}" مرتبط بالفعل بحساب تحت الأب المختار`;
      } else {
        status = "reassign";
      }
    }

    if (match) claimedSupplierIds.add(match.id);
    else for (const key of rowKeys) claimedNewKeys.add(key);
    claimedNames.add(finalNameKey);
    plannedRows.push({
      rowNumber,
      status,
      matchedBy: chosen?.matchedBy ?? null,
      supplierId: match?.id ?? null,
      previousAccountId: match?.accountId ?? null,
      nameAr: patch.nameAr,
      nameEn: patch.nameEn ?? match?.nameEn ?? null,
      currentAccount: match?.currentAccount ?? null,
      accountCode: codes[index] ?? null,
      patch,
      error: rowError,
    });
  }

  const summary = summarizeSupplierBulkImportRows(plannedRows);
  return {
    rows: plannedRows,
    canCommit: summary.errors === 0 && summary.blocked === 0,
    summary,
  };
}