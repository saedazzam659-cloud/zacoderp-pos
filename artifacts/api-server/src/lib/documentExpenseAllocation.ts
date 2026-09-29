export type ExpenseAllocation = { lineId: number; amount: number };
export type ExpenseLine = { lineId: number; itemId: number; description: string; quantity: number; value: number; warehouseId?: number };
export type ExpenseRow = {
  description: string; amount: number; treatment: "period" | "capitalized";
  allocationMethod: "value" | "quantity" | "manual"; allocations: ExpenseAllocation[];
  costCenterId: number | null; reference: string;
};
export function cents(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e10 || Math.abs(n * 100 - Math.round(n * 100)) > 0.0001)
    throw new Error("المبلغ يجب أن يكون موجباً وبمنزلتين عشريتين");
  return Math.round(n * 100);
}
/** Cumulative rounding ensures partial returns eventually reverse every cent. */
export function returnedCostShare(totalCost: number, received: number, alreadyReturned: number, quantity: number): number {
  if (!(received > 0) || alreadyReturned < 0 || quantity <= 0 || alreadyReturned + quantity > received + 0.000001)
    throw new Error("كمية عكس التكلفة غير صالحة");
  return (Math.round(totalCost * 100 * (alreadyReturned + quantity) / received)
    - Math.round(totalCost * 100 * alreadyReturned / received)) / 100;
}
export function allocateExpense(row: ExpenseRow, lines: ExpenseLine[]): ExpenseAllocation[] {
  const total = cents(row.amount);
  if (!total) throw new Error("مبلغ المصروف يجب أن يكون أكبر من صفر");
  if (row.treatment !== "capitalized") return [];
  if (!lines.length) throw new Error("لا توجد بنود مخزنية مؤهلة لتحميل المصروف");
  if (row.allocationMethod === "manual") {
    const seen = new Set<number>();
    const allocations = row.allocations.map(a => {
      if (seen.has(a.lineId) || !lines.some(l => l.lineId === a.lineId)) throw new Error("توزيع يدوي يشير إلى بند غير صالح أو مكرر؛ أعد التوزيع بعد حفظ الفاتورة");
      seen.add(a.lineId);
      return { lineId: a.lineId, amount: cents(a.amount) / 100 };
    });
    if (allocations.reduce((s, a) => s + cents(a.amount), 0) !== total) throw new Error("مجموع التوزيع اليدوي يجب أن يساوي مبلغ المصروف");
    return allocations;
  }
  const weights = lines.map(l => Math.max(0, row.allocationMethod === "quantity" ? l.quantity : l.value));
  const sum = weights.reduce((s, n) => s + n, 0);
  if (!(sum > 0)) throw new Error("أساس توزيع المصروف يجب أن يكون أكبر من صفر");
  const shares = weights.map((w, i) => ({ i, exact: total * w / sum, n: Math.floor(total * w / sum) }));
  let remaining = total - shares.reduce((s, a) => s + a.n, 0);
  for (const a of [...shares].sort((a, b) => (b.exact - b.n) - (a.exact - a.n) || a.i - b.i)) {
    if (remaining-- > 0) a.n++;
  }
  return shares.map(a => ({ lineId: lines[a.i].lineId, amount: a.n / 100 }));
}