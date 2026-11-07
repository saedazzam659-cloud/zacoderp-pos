export function monthlyBasicLeaveProvision(basicSalary: number, annualLeaveDays: number) {
  if (!Number.isFinite(basicSalary) || !Number.isFinite(annualLeaveDays) || basicSalary < 0 || annualLeaveDays < 0)
    throw new Error("أساس مخصص الإجازة غير صحيح");
  return Math.round(basicSalary * annualLeaveDays / 360 * 100) / 100;
}

/** Largest-remainder allocation: no negative last line, even for one cent. */
export function splitProvisionMoney(amount: number, weights: number[]) {
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || cents < 0 || weights.some(weight => !Number.isFinite(weight) || weight < 0))
    throw new Error("توزيع مبلغ التسوية غير صحيح");
  const integers = weights.map(weight => {
    const scaled = Math.round(weight * 1_000);
    if (!Number.isSafeInteger(scaled)) throw new Error("وزن توزيع التسوية يتجاوز الدقة المدعومة");
    return BigInt(scaled);
  });
  const total = integers.reduce((sum, weight) => sum + weight, 0n);
  if (total <= 0n) throw new Error("أوزان توزيع التسوية غير موجبة");
  const parts = integers.map((weight, index) => ({
    index, cents: Number(BigInt(cents) * weight / total), remainder: BigInt(cents) * weight % total,
  }));
  let remaining = cents - parts.reduce((sum, part) => sum + part.cents, 0);
  const ranked = [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const part of ranked) { if (!remaining) break; part.cents++; remaining--; }
  return parts.map(part => part.cents / 100);
}

export function netProvisionSourceAmount(gross: number, offset: number) {
  if (!Number.isFinite(gross) || !Number.isFinite(offset) || offset < 0 || offset > gross + 0.005)
    throw Object.assign(new Error("تسويات المخصص تتجاوز تكلفة مصدر التصنيع؛ يجب مراجعة المصدر"), { status: 409 });
  return Math.max(0, Math.round((gross - offset) * 100) / 100);
}
