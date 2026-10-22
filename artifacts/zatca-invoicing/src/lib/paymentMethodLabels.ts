export type PaymentMethod = "cash" | "credit" | "bank";

export function paymentMethodLabel(
  company: any,
  method: PaymentMethod,
  fallback: string,
  language?: string | null,
): string {
  if (language?.toLowerCase().startsWith("en")) {
    const customEnglish = company?.paymentMethodLabelsEn?.[method];
    return typeof customEnglish === "string" && customEnglish.trim()
      ? customEnglish.trim()
      : fallback;
  }
  const custom = company?.paymentMethodLabels?.[method];
  return typeof custom === "string" && custom.trim() ? custom.trim() : fallback;
}

export function companyPaymentDefault(company: any, key: string): PaymentMethod {
  const value = company?.[key];
  return value === "cash" || value === "bank" || value === "credit" ? value : "credit";
}
