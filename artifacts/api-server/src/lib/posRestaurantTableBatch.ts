export type TableBatchInput = {
  count: number;
  startNumber: number;
  codePrefix: string;
  namePrefix: string;
};

export type GeneratedTable = {
  number: number;
  code: string;
  nameAr: string;
};

export function generateRestaurantTables(
  input: TableBatchInput,
  existingCodes: Iterable<string>,
): GeneratedTable[] {
  const count = Number(input.count);
  const startNumber = Number(input.startNumber);
  const codePrefix = String(input.codePrefix ?? "").trim();
  const namePrefix = String(input.namePrefix ?? "").trim();

  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("عدد الطاولات يجب أن يكون بين 1 و100");
  }
  if (!Number.isInteger(startNumber) || startNumber < 1 || startNumber > 999999) {
    throw new Error("رقم البداية غير صالح");
  }
  if (!/^[\p{L}\p{N}_-]{1,12}$/u.test(codePrefix)) {
    throw new Error("بادئة الرمز يجب أن تكون من 1 إلى 12 حرفاً أو رقماً");
  }
  if (namePrefix.length < 1 || namePrefix.length > 40) {
    throw new Error("اسم الطاولة يجب أن يكون بين 1 و40 حرفاً");
  }

  const used = new Set([...existingCodes].map((code) => code.trim().toLocaleLowerCase()));
  const rows: GeneratedTable[] = [];
  let number = startNumber;

  while (rows.length < count) {
    if (number > 999999) throw new Error("تعذّر إكمال الترقيم: تجاوز الحد الأقصى");
    const code = `${codePrefix}${String(number).padStart(2, "0")}`;
    const normalizedCode = code.toLocaleLowerCase();
    if (!used.has(normalizedCode)) {
      rows.push({ number, code, nameAr: `${namePrefix} ${number}` });
      used.add(normalizedCode);
    }
    number += 1;
  }
  return rows;
}
