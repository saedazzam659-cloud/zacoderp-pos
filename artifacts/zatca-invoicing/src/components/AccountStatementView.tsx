import { useTranslation } from "react-i18next";
import { useFmt } from "@/hooks/use-fmt";
import { Building2 } from "lucide-react";

/**
 * AccountStatementView — a printable, presentation-grade card that renders a
 * customer or supplier account statement in the classic Saudi/Gulf accounting
 * layout used by ERPs like Onyx and Al-Ameen:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  [Company info Arabic]   [Logo]   [Company info English]     │
 *   │ ──────────────────────────────────────────────────────────── │
 *   │                    « كشف حساب »  (blue pill)                 │
 *   │  [Account info]                              [Date range]    │
 *   │ ──────────────────────────────────────────────────────────── │
 *   │  التاريخ │ الرقم │ البيان │ مدين │ دائن │ الرصيد │ الشرح     │
 *   │  ─────────────────────────────────────────────────────────   │
 *   │  ... data rows ...                                           │
 *   │  ─────────────────────────────────────────────────────────   │
 *   │  الإجمالي                              X.XX   X.XX   X.XX    │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * It is purely visual — all numbers/data come from the caller. Used by both
 * the customer-statement and supplier-statement pages so the two screens look
 * identical to the user. Designed to print cleanly: `print:` Tailwind
 * variants strip shadows/borders, force pure-white background, and keep the
 * grid lines crisp on paper.
 *
 * Debit/credit semantic differences (customer = debit-positive, supplier =
 * credit-positive) live in the parent — this component just renders whatever
 * `lines / opening / totals / closing` it receives.
 */

export type StatementLine = {
  date: string;
  type: string;          // localized label (فاتورة، مرتجع، سند قبض ...)
  docNumber?: string | null;
  description: string;
  debit: number;
  credit: number;
  balance: number;
};

export type StatementCompany = {
  nameAr?: string | null;
  nameEn?: string | null;
  crNumber?: string | null;
  vatNumber?: string | null;
  phone?: string | null;
  city?: string | null;
  district?: string | null;
  street?: string | null;
  buildingNumber?: string | null;
  postalCode?: string | null;
  logo?: string | null;  // base64 data-URL stored on companies.logo
};

export type StatementAccount = {
  code?: string | null;       // e.g. "1105030047" — AR/AP sub-account code
  nameAr?: string | null;
  nameEn?: string | null;
  legalName?: string | null;  // الاسم اللاتيني — customer/supplier Latin (English) name; field name kept for back-compat
  level?: string | number | null; // مستوى الحساب
};

export interface AccountStatementViewProps {
  company?: StatementCompany | null;
  account: StatementAccount;
  from: string;
  to: string;
  opening: number;
  lines: StatementLine[];
  totals: { debit: number; credit: number };
  closing: number;
  /** Customer = "كشف حساب عميل", supplier shows "كشف حساب مورد" header. */
  mode: "customer" | "supplier";
}

export default function AccountStatementView({
  company, account, from, to, opening, lines, totals, closing, mode,
}: AccountStatementViewProps) {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, dflt: string) => {
    const v = t(`accountStatement.${k}`) as string;
    return v && v !== `accountStatement.${k}` ? v : dflt;
  };

  const addressLine = [
    company?.buildingNumber, company?.street,
    company?.district, company?.city, company?.postalCode,
  ].filter(Boolean).join(" - ");

  return (
    <div
      dir={isRtl ? "rtl" : "ltr"}
      className="rounded-2xl border bg-white shadow-sm overflow-hidden print:shadow-none print:border-0 print:rounded-none"
    >
      {/* ─── Company header ──────────────────────────────────────── */}
      <div className="px-6 pt-6 pb-4 border-b border-dashed border-slate-200 bg-gradient-to-b from-slate-50/60 to-white">
        <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center">
          {/* Right: Arabic */}
          <div className="text-right text-[12px] leading-relaxed text-slate-700 space-y-1 min-w-0">
            <div className="font-bold text-base text-slate-900 truncate">
              {company?.nameAr || "—"}
            </div>
            {company?.crNumber && (
              <div><span className="text-slate-500">{tr("crNoAr", "س.ت")}</span> : <span className="font-mono">{company.crNumber}</span></div>
            )}
            {company?.vatNumber && (
              <div><span className="text-slate-500">{tr("vatNoAr", "الرقم الضريبي")}</span> : <span className="font-mono">{company.vatNumber}</span></div>
            )}
            {company?.phone && (
              <div><span className="text-slate-500">{tr("phoneAr", "الجوال")}</span> : <span className="font-mono" dir="ltr">{company.phone}</span></div>
            )}
            {addressLine && (
              <div className="truncate"><span className="text-slate-500">{tr("addressAr", "العنوان")}</span> : {addressLine}</div>
            )}
          </div>

          {/* Center: logo */}
          <div className="shrink-0 h-20 w-20 rounded-full border-2 border-slate-200 bg-white shadow-sm flex items-center justify-center overflow-hidden">
            {company?.logo ? (
              <img src={company.logo} alt={company.nameAr || company.nameEn || "Company logo"} className="h-full w-full object-contain p-1" />
            ) : (
              <Building2 className="h-9 w-9 text-slate-300" />
            )}
          </div>

          {/* Left: English */}
          <div className="text-left text-[12px] leading-relaxed text-slate-700 space-y-1 min-w-0" dir="ltr">
            <div className="font-bold text-base text-slate-900 truncate">
              {company?.nameEn || company?.nameAr || "—"}
            </div>
            {company?.crNumber && (
              <div><span className="text-slate-500">C.R. No</span> : <span className="font-mono">{company.crNumber}</span></div>
            )}
            {company?.vatNumber && (
              <div><span className="text-slate-500">VAT Number</span> : <span className="font-mono">{company.vatNumber}</span></div>
            )}
            {company?.phone && (
              <div><span className="text-slate-500">Phone</span> : <span className="font-mono">{company.phone}</span></div>
            )}
            {addressLine && (
              <div className="truncate"><span className="text-slate-500">Address</span> : {addressLine}</div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Centered "كشف حساب" pill ───────────────────────────── */}
      <div className="flex justify-center -mt-1 mb-4 pt-4">
        <div className="px-10 py-2 rounded-md bg-sky-100 text-sky-800 font-bold text-base tracking-wide border border-sky-200 shadow-sm">
          {mode === "supplier"
            ? tr("titleSupplier", "كشف حساب مورد")
            : tr("titleCustomer", "كشف حساب")}
        </div>
      </div>

      {/* ─── Account info row ───────────────────────────────────── */}
      <div className="px-6 pb-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-2 text-[13px]">
          {/* Right column: account identification */}
          <div className="space-y-2">
            <Row label={tr("accountCode", "رمز الحساب")}    value={account.code || "—"} />
            <Row label={tr("accountName", "اسم الحساب")}    value={account.nameAr || account.nameEn || "—"} />
            <Row label={tr("latinName", "الاسم اللاتيني")}  value={account.legalName || account.nameEn || "—"} />
            <Row label={tr("accountLevel", "مستوى الحساب")} value={account.level != null ? String(account.level) : "—"} />
          </div>
          {/* Left column: date range */}
          <div className="space-y-2">
            <Row label={tr("fromDate", "من تاريخ")} value={from} mono />
            <Row label={tr("toDate",   "إلى تاريخ")} value={to}   mono />
            <Row label={tr("settlementFactor", "معامل التصفية")} value="—" />
          </div>
        </div>
      </div>

      {/* ─── Table ──────────────────────────────────────────────── */}
      <div className="px-6 pb-6">
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-[12.5px] border-collapse min-w-[760px]">
            <thead>
              <tr className="bg-slate-100 text-slate-700">
                <Th>{tr("colDate", "التاريخ")}</Th>
                <Th>{tr("colDoc", "الرقم")}</Th>
                <Th>{tr("colType", "البيان")}</Th>
                <Th center>{tr("colDebit", "مدين")}</Th>
                <Th center>{tr("colCredit", "دائن")}</Th>
                <Th center>{tr("colBalance", "الرصيد")}</Th>
                <Th>{tr("colDescription", "الشرح")}</Th>
              </tr>
            </thead>
            <tbody>
              {/* Opening row — sign semantics differ per mode:
                  - customer: opening > 0 means the customer owes us (debit side)
                  - supplier: opening > 0 means we owe the supplier (credit side) */}
              {(() => {
                const openingDebit  = mode === "supplier" ? (opening < 0 ? -opening : 0) : (opening > 0 ? opening : 0);
                const openingCredit = mode === "supplier" ? (opening > 0 ? opening  : 0) : (opening < 0 ? -opening : 0);
                return (
                  <tr className="bg-amber-50/40 border-t border-slate-200">
                    <Td mono>{from}</Td>
                    <Td>—</Td>
                    <Td className="italic text-slate-500">{tr("openingRow", "رصيد افتتاحي")}</Td>
                    <Td center mono>{openingDebit  ? fmt(openingDebit)  : "0.00"}</Td>
                    <Td center mono>{openingCredit ? fmt(openingCredit) : "0.00"}</Td>
                    <Td center mono className="font-semibold">{fmt(opening)}</Td>
                    <Td className="text-slate-500">—</Td>
                  </tr>
                );
              })()}

              {lines.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400">
                    {tr("noRows", "لا توجد حركات في الفترة المحددة")}
                  </td>
                </tr>
              ) : lines.map((l, i) => (
                <tr key={i} className="border-t border-slate-200 even:bg-slate-50/40 hover:bg-sky-50/40 transition-colors">
                  <Td mono className="text-slate-600">{l.date}</Td>
                  <Td mono className="text-slate-600">{l.docNumber || "—"}</Td>
                  <Td>{l.type}</Td>
                  <Td center mono className={l.debit ? "font-semibold text-sky-700" : "text-slate-400"}>
                    {l.debit ? fmt(l.debit) : "0.00"}
                  </Td>
                  <Td center mono className={l.credit ? "font-semibold text-emerald-700" : "text-slate-400"}>
                    {l.credit ? fmt(l.credit) : "0.00"}
                  </Td>
                  <Td center mono className="font-bold text-slate-800">{fmt(l.balance)}</Td>
                  <Td className="text-slate-700">{l.description}</Td>
                </tr>
              ))}
            </tbody>
            {lines.length > 0 && (
              <tfoot>
                <tr className="bg-slate-100 border-t-2 border-slate-300 font-bold">
                  <Td colSpan={3} className="text-slate-700">
                    {tr("totalLabel", "الإجمالي")}
                  </Td>
                  <Td center mono className="text-sky-700">{fmt(totals.debit)}</Td>
                  <Td center mono className="text-emerald-700">{fmt(totals.credit)}</Td>
                  <Td center mono className="text-slate-900">{fmt(closing)}</Td>
                  <Td>—</Td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Tiny presentational helpers (kept local — only used here) ────────
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-dotted border-slate-200 pb-1.5">
      <span className="text-slate-500 min-w-[110px] text-[12px]">{label}</span>
      <span className="text-slate-500">:</span>
      <span className={`text-slate-900 font-medium ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
function Th({ children, center }: { children: React.ReactNode; center?: boolean }) {
  return (
    <th className={`px-3 py-2.5 font-semibold border-b border-slate-300 ${center ? "text-center" : "text-start"}`}>
      {children}
    </th>
  );
}
function Td({ children, center, mono, colSpan, className = "" }: {
  children: React.ReactNode; center?: boolean; mono?: boolean; colSpan?: number; className?: string;
}) {
  return (
    <td
      colSpan={colSpan}
      className={`px-3 py-2 ${center ? "text-center" : "text-start"} ${mono ? "font-mono tabular-nums" : ""} ${className}`}
    >
      {children}
    </td>
  );
}
