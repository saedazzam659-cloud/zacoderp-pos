export const SUPPLIER_BULK_EXCEL_HEADERS = [
  "id",
  "code",
  "nameAr",
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
  "creditLimit",
] as const;

export const SUPPLIER_BULK_EXCEL_SAMPLE = {
  id: "",
  code: "SUP-001",
  nameAr: "مورد تجريبي",
  nameEn: "Sample Supplier",
  vatNumber: "310000000000003",
  crNumber: "1010000000",
  email: "supplier@example.com",
  phone: "0500000000",
  city: "الرياض",
  district: "العليا",
  street: "طريق الملك فهد",
  buildingNumber: "100",
  postalCode: "12345",
  country: "SA",
  currencyCode: "SAR",
  creditLimit: "0",
};

export function normalizeSupplierBulkExcelRows(
  rows: unknown[],
): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Record<string, unknown> => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    return Object.values(row).some(value => String(value ?? "").trim() !== "");
  });
}