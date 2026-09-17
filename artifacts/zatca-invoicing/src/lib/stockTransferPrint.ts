function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function nameOf(value: any, isRtl: boolean): string {
  if (!value) return "—";
  return String((isRtl ? value.nameAr ?? value.nameEn : value.nameEn ?? value.nameAr) ?? "—");
}

export function printPersistedStockTransfer(doc: any, options: {
  isRtl: boolean;
  companyName?: string;
  targetWindow?: Window;
}): void {
  if (!doc?.id) throw new Error("لا يمكن طباعة مستند غير محفوظ");
  const { isRtl, companyName = "" } = options;
  const rows = (Array.isArray(doc.items) ? doc.items : []).map((line: any, index: number) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(line.item?.code ?? "")}</td>
      <td>${escapeHtml(nameOf(line.item, isRtl))}</td>
      <td>${escapeHtml(line.unit ? nameOf(line.unit, isRtl) : "الوحدة الأساسية")}</td>
      <td class="num">${escapeHtml(line.qty)}</td>
    </tr>`).join("");
  const transport = Number(doc.internalTransportAmount ?? 0);
  const popup = options.targetWindow ?? window.open("", "_blank", "width=900,height=720");
  if (!popup) throw new Error("تعذر فتح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.");
  popup.opener = null;
  popup.document.open();
  popup.document.write(`<!doctype html>
<html dir="${isRtl ? "rtl" : "ltr"}"><head><meta charset="utf-8">
<title>${escapeHtml(doc.transferNumber)}</title>
<style>
body{font-family:Arial,"Noto Sans Arabic",sans-serif;color:#111;padding:28px;font-size:13px}
h1{text-align:center;font-size:22px;margin:4px 0}.company{text-align:center;font-weight:700;margin-bottom:8px}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;border:1px solid #bbb;padding:12px;margin:18px 0}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #aaa;padding:8px;text-align:start}th{background:#eee}.num{text-align:center}
.notes,.transport{border:1px solid #bbb;padding:10px;margin-top:12px;white-space:pre-wrap}
.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:30px;margin-top:70px;text-align:center}.line{border-top:1px solid #333;padding-top:7px}
.print{position:fixed;top:10px;left:10px;padding:8px 16px}@media print{.print{display:none}body{padding:0}}
</style></head><body>
<button class="print" onclick="window.print()">طباعة</button>
${companyName ? `<div class="company">${escapeHtml(companyName)}</div>` : ""}
<h1>${doc.transferType === "manufacturing" ? "إذن تسليم داخلي إلى التصنيع" : "تحويل مخزني"}</h1>
<div class="meta">
<div><b>رقم المستند:</b> ${escapeHtml(doc.transferNumber)}</div>
<div><b>التاريخ:</b> ${escapeHtml(String(doc.transferDate ?? "").slice(0, 10))}</div>
<div><b>من مستودع:</b> ${escapeHtml(nameOf(doc.fromWarehouse, isRtl))}</div>
<div><b>إلى مستودع:</b> ${escapeHtml(nameOf(doc.toWarehouse, isRtl))}</div>
</div>
<table><thead><tr><th>#</th><th>الكود</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th></tr></thead>
<tbody>${rows || `<tr><td colspan="5" class="num">لا توجد أصناف</td></tr>`}</tbody></table>
<div class="transport"><b>تكلفة النقل الداخلي:</b> ${escapeHtml(transport.toFixed(2))}</div>
${doc.notes ? `<div class="notes"><b>ملاحظات:</b><br>${escapeHtml(doc.notes)}</div>` : ""}
<div class="signatures"><div class="line">أمين المستودع</div><div class="line">المستلم</div><div class="line">الاعتماد</div></div>
</body></html>`);
  popup.document.close();
  popup.focus();
}

export function openStockTransferPrintWindow(): Window {
  const popup = window.open("", "_blank", "width=900,height=720");
  if (!popup) throw new Error("تعذر فتح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.");
  popup.opener = null;
  popup.document.write("<!doctype html><html dir=\"rtl\"><meta charset=\"utf-8\"><body style=\"font-family:Arial;padding:30px\">جارٍ تحميل المستند المحفوظ…</body></html>");
  popup.document.close();
  return popup;
}