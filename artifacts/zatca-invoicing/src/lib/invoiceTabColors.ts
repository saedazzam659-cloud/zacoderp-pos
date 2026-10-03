export const COLORFUL_INVOICE_TAB_LIST_CLASS =
  "border-slate-200 bg-gradient-to-r from-slate-50 via-white to-slate-50 shadow-inner";

export const INVOICE_TAB_COLOR_CLASSES = {
  basic: "text-teal-800 hover:bg-teal-50 data-[state=active]:bg-teal-700 data-[state=active]:text-white",
  items: "text-indigo-800 hover:bg-indigo-50 data-[state=active]:bg-indigo-700 data-[state=active]:text-white",
  industrialCosts: "text-amber-800 hover:bg-amber-50 data-[state=active]:bg-amber-700 data-[state=active]:text-white",
  debitNote: "text-sky-800 hover:bg-sky-50 data-[state=active]:bg-sky-700 data-[state=active]:text-white",
  creditNote: "text-rose-800 hover:bg-rose-50 data-[state=active]:bg-rose-700 data-[state=active]:text-white",
  payments: "text-emerald-800 hover:bg-emerald-50 data-[state=active]:bg-emerald-700 data-[state=active]:text-white",
  returns: "text-orange-800 hover:bg-orange-50 data-[state=active]:bg-orange-700 data-[state=active]:text-white",
  deferred: "text-violet-800 hover:bg-violet-50 data-[state=active]:bg-violet-700 data-[state=active]:text-white",
  archive: "text-slate-700 hover:bg-slate-100 data-[state=active]:bg-slate-700 data-[state=active]:text-white",
  expenses: "text-cyan-800 hover:bg-cyan-50 data-[state=active]:bg-cyan-700 data-[state=active]:text-white",
  details: "text-purple-800 hover:bg-purple-50 data-[state=active]:bg-purple-700 data-[state=active]:text-white",
} as const;

export type InvoiceTabColorId = keyof typeof INVOICE_TAB_COLOR_CLASSES;

export function getInvoiceTabColorClass(id: InvoiceTabColorId, enabled: boolean): string {
  return enabled ? INVOICE_TAB_COLOR_CLASSES[id] : "";
}