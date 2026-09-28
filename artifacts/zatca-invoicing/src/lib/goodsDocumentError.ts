// Never display an untrusted transport/SQL exception in a document toast.
export function goodsDocumentError(error: unknown, t: any, arabic: boolean): string {
  let body: any;
  const message = error instanceof Error ? error.message : String(error);
  try { body = JSON.parse(message); } catch { body = { error: message }; }
  const missingBase = body?.code === "MISSING_BASE" || body?.code === "AMBIGUOUS_BASE";
  if (missingBase) {
    const identity = body.details?.itemName || body.details?.itemId || "";
    return `${t("inventoryMaster.units.missingBaseError")} ${identity}`.trim();
  }
  // Only explicit Arabic business validation is safe to pass through.
  if (typeof body?.error === "string" && /[\u0600-\u06ff]/.test(body.error)
      && !/sql|query|constraint|select |insert |update |delete /i.test(body.error)) return body.error;
  if (body?.code && /UNIT|FACTOR|CONFLICT|CYCLE|BASE/.test(body.code)) {
    return arabic
      ? `تعذر تحويل وحدة الصنف ${body.details?.itemName || body.details?.itemId || ""}. راجع الوحدة الأساسية وروابط وحدات الصنف.`
      : "Cannot convert this item's unit. Check its base unit and unit relationships.";
  }
  return arabic ? "تعذر إتمام العملية. تحقق من الاتصال وأعد المحاولة." : "Unable to complete the operation. Check your connection and try again.";
}