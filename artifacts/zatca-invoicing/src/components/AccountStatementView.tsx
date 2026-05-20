import { useTranslation } from "react-i18next";
import { useFmt } from "@/hooks/use-fmt";
import { Building2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  STATEMENT_COL_DEFAULTS,
  type StatementVisibleCols,
} from "@/components/StatementColumnChooser";
import AdvancedReportGrid, {
  type GridColumn,
} from "@/components/auditGrid/AdvancedReportGrid";

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
  /** Source document id (invoice / return / voucher) — used as a fallback
   *  display when docNumber is null and to build deep-links. */
  id?: number | null;
  /** Posted journal-entry id — used to deep-link the "رقم القيد" cell. */
  journalEntryId?: number | null;
  date: string;
  /** Document-source category (نوع الوثيقة) — full categorical label such as
   *  "فاتورة مبيعات", "مرتجع مبيعات", "سند قبض" (customer) or
   *  "فاتورة مشتريات", "مرتجع مشتريات", "سند صرف" (supplier). Distinct from
   *  `type`, which is the short generic word ("فاتورة", "مرتجع"). Optional
   *  for back-compat with any caller that doesn't yet populate it. */
  docType?: string;
  type: string;          // localized label (فاتورة، مرتجع، سند قبض ...) — kept for back-compat
  docNumber?: string | null;
  /** Posted journal-entry number (رقم القيد) — rendered in its own column,
   *  replacing the former "البيان" column per user request. */
  journalEntryNumber?: string | null;
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
  /** Localized branch name when the user filtered by a specific branch.
   *  Undefined / null / empty => "all branches" => the row is hidden. */
  branchName?: string | null;
  /** Optional column-visibility map. When omitted, all 7 columns render —
   *  preserves backwards-compat for any caller that doesn't yet wire up
   *  the column chooser. */
  visibleCols?: StatementVisibleCols;
}

export default function AccountStatementView({
  company, account, from, to, opening, lines, totals, closing, mode, branchName,
  visibleCols = STATEMENT_COL_DEFAULTS,
}: AccountStatementViewProps) {
  const { fmt } = useFmt();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const { user, actingCompanyId } = useAuth() as {
    user?: { role?: string; company?: { id?: number } } | null;
    actingCompanyId?: number | null;
  };
  // Per-tenant grid layout — superadmins get a shared "anon" bucket unless
  // they're acting on a specific company.
  const cid: number | undefined =
    user?.role === "superadmin"
      ? (actingCompanyId ?? undefined)
      : user?.company?.id;
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

          {/* Left: Customer / Supplier identification card (replaces the
              former English company-info card). Shows the statemented party
              info — code, name (AR), Latin name, level — so the header
              displays BOTH parties at a glance: issuing company on the
              right, statemented party on the left. The party name is now
              prefixed with an "اسم العميل" / "اسم المورد" label per user
              request, and the from/to date filters were moved INTO this
              card (just under "مستوى الحساب") so all account-filter context
              lives in one place. */}
          <div className="text-right text-[12px] leading-relaxed text-slate-700 space-y-1 min-w-0 border-r-4 border-emerald-400 pr-3 bg-emerald-50/40 rounded-md py-2">
            <div className="flex items-baseline gap-2">
              <span className="text-slate-500 shrink-0">
                {mode === "supplier"
                  ? tr("supplierNameLabel", "اسم المورد")
                  : tr("customerNameLabel", "اسم العميل")}
              </span>
              <span className="text-slate-500">:</span>
              <span className="font-bold text-base text-slate-900 truncate">
                {account.nameAr || account.nameEn || "—"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">{tr("accountCode", "رمز الحساب")}</span> :{" "}
              <span className="font-mono">{account.code || "—"}</span>
            </div>
            {(account.legalName || account.nameEn) && (
              <div className="truncate">
                <span className="text-slate-500">{tr("latinName", "الاسم اللاتيني")}</span> :{" "}
                <span dir="ltr">{account.legalName || account.nameEn}</span>
              </div>
            )}
            <div>
              <span className="text-slate-500">{tr("accountLevel", "مستوى الحساب")}</span> :{" "}
              <span>{account.level != null ? String(account.level) : "—"}</span>
            </div>
            {/* Date filters moved here (was a separate strip below the
                title pill) per user request — they belong with the rest of
                the account-filter context. */}
            <div className="pt-1 mt-1 border-t border-dashed border-emerald-200 grid grid-cols-2 gap-x-3">
              <div>
                <span className="text-slate-500">{tr("fromDate", "من تاريخ")}</span> :{" "}
                <span className="font-mono">{from}</span>
              </div>
              <div>
                <span className="text-slate-500">{tr("toDate", "إلى تاريخ")}</span> :{" "}
                <span className="font-mono">{to}</span>
              </div>
            </div>
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

      {/* ─── Branch / filter strip ─────────────────────────────────
          Dates moved up to the party card; this strip carries only the
          branch (when filtered) and the settlement-factor placeholder. */}
      <div className="px-6 pb-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-2 text-[13px]">
          {branchName ? (
            <Row label={tr("branchLabel", "الفرع")} value={branchName} />
          ) : (
            <Row label={tr("settlementFactor", "معامل التصفية")} value="—" />
          )}
        </div>
      </div>

      {/* ─── Table ──────────────────────────────────────────────── */}
      {/* Each column is conditionally rendered based on `visibleCols` so
          the chooser controls the on-screen layout. Same map is forwarded
          to Excel / PDF / print so all four surfaces stay identical.

          We render TWO tables: the interactive AdvancedReportGrid (screen
          only) and the classic compact table (print/PDF only). This keeps
          paper output deterministic while giving the user an Excel-style
          grid on screen (sort/filter/group/conditional format/etc). */}
      {(() => {
        const v = visibleCols;
        // colSpan of the leading "الإجمالي" cell = number of visible
        // pre-numeric columns (date / docNumber / type). When all three
        // are hidden we drop the label cell entirely so the row stays
        // valid HTML.
        const leadingSpan =
          (v.docType ? 1 : 0) + (v.date ? 1 : 0) + (v.docNumber ? 1 : 0) + (v.type ? 1 : 0);
        const visibleCount =
          leadingSpan +
          (v.debit ? 1 : 0) + (v.credit ? 1 : 0) +
          (v.balance ? 1 : 0) + (v.description ? 1 : 0);
        const openingDebit  = mode === "supplier" ? (opening < 0 ? -opening : 0) : (opening > 0 ? opening  : 0);
        const openingCredit = mode === "supplier" ? (opening > 0 ? opening  : 0) : (opening < 0 ? -opening : 0);

        /* ── Grid columns (screen only). Order here is the DEFAULT; the
           user can reorder via the toolbar (persisted per company). ── */
        const allGridColumns: GridColumn<StatementLine>[] = [
          { key: "date",        label: tr("colDate", "التاريخ"),  type: "text",
            className: "font-mono tabular-nums text-slate-600",
            value: r => r.date,
          },
          { key: "docType",     label: tr("colDocType", "نوع الوثيقة"), type: "text",
            className: "text-slate-700 font-medium",
            value: r => r.docType ?? "",
            render: r => r.docType || "—",
          },
          { key: "docNumber",   label: tr("colDoc", "الرقم"),     type: "text",
            className: "font-mono tabular-nums text-slate-600",
            value: r => r.docNumber ?? (r.id != null ? `#${r.id}` : ""),
            render: r => r.docNumber || (r.id != null ? `#${r.id}` : "—"),
          },
          { key: "type",        label: tr("colJournalEntryNumber", "رقم القيد"), type: "text",
            className: "font-mono tabular-nums text-slate-600",
            value: r => r.journalEntryNumber ?? (r.journalEntryId != null ? `#${r.journalEntryId}` : ""),
            render: r => {
              const label = r.journalEntryNumber || (r.journalEntryId != null ? `#${r.journalEntryId}` : "");
              if (!label) return "—";
              if (r.journalEntryId == null) return label;
              return (
                <a
                  href={`/accounting/journals/${r.journalEntryId}`}
                  className="text-sky-700 hover:text-sky-900 hover:underline"
                  title="فتح القيد المحاسبي"
                >
                  {label}
                </a>
              );
            },
          },
          { key: "debit",       label: tr("colDebit", "مدين"),    type: "num",
            align: "center", totalable: true,
            className: "font-mono tabular-nums",
            value: r => r.debit,
            render: r => (
              <span className={r.debit ? "font-semibold text-sky-700" : "text-slate-400"}>
                {r.debit ? fmt(r.debit) : "0.00"}
              </span>
            ),
          },
          { key: "credit",      label: tr("colCredit", "دائن"),   type: "num",
            align: "center", totalable: true,
            className: "font-mono tabular-nums",
            value: r => r.credit,
            render: r => (
              <span className={r.credit ? "font-semibold text-emerald-700" : "text-slate-400"}>
                {r.credit ? fmt(r.credit) : "0.00"}
              </span>
            ),
          },
          { key: "balance",     label: tr("colBalance", "الرصيد"), type: "num",
            align: "center",
            className: "font-mono tabular-nums font-bold text-slate-800",
            value: r => r.balance,
            render: r => fmt(r.balance),
          },
          { key: "description", label: tr("colDescription", "الشرح"), type: "text",
            className: "text-slate-700 min-w-[260px]",
            value: r => r.description,
          },
        ];
        const gridColumns = allGridColumns.filter(c => v[c.key as keyof typeof v]);

        /* Opening row mapped by column key — the grid renders the cells in
           whatever order the user has chosen. */
        const openingCells: Record<string, React.ReactNode> = {
          docType: <span className="italic text-slate-500">{tr("openingRow", "رصيد افتتاحي")}</span>,
          date: from,
          docNumber: "—",
          type: <span className="text-slate-400">—</span>,
          debit: <span className="font-mono tabular-nums">{openingDebit ? fmt(openingDebit) : "0.00"}</span>,
          credit: <span className="font-mono tabular-nums">{openingCredit ? fmt(openingCredit) : "0.00"}</span>,
          balance: <span className="font-mono tabular-nums font-semibold">{fmt(opening)}</span>,
          description: <span className="text-slate-500">—</span>,
        };

        /* Totals row mapped by column key. __label goes in the first visible
           column when that column has no explicit value. */
        const totalsCells: Record<string, React.ReactNode> & { __label?: React.ReactNode } = {
          __label: <span>{tr("totalLabel", "الإجمالي")}</span>,
          debit: <span className="text-sky-700 font-mono tabular-nums">{fmt(totals.debit)}</span>,
          credit: <span className="text-emerald-700 font-mono tabular-nums">{fmt(totals.credit)}</span>,
          balance: <span className="text-slate-900 font-mono tabular-nums">{fmt(closing)}</span>,
        };

        return (
          <div className="px-6 pb-6">
            {/* ── Interactive grid (screen only) ─────────────────── */}
            <div className="print:hidden">
              <AdvancedReportGrid
                slug={`${mode}Statement`}
                cid={cid}
                columns={gridColumns}
                rowKey={(_r, i) => i}
                rows={lines}
                leadingRows={[openingCells]}
                totalsRow={lines.length > 0 ? totalsCells : null}
                unitLabel="حركة"
                emptyMessage={tr("noRows", "لا توجد حركات في الفترة المحددة")}
              />
            </div>

            {/* ── Classic printable table (print/PDF only) ───────── */}
            <div className="hidden print:block border rounded-lg overflow-x-auto">
              <table className="w-full text-[12.5px] border-collapse min-w-[480px]">
                <thead>
                  <tr className="bg-slate-100 text-slate-700">
                    {v.date        && <Th>{tr("colDate", "التاريخ")}</Th>}
                    {v.docType     && <Th>{tr("colDocType", "نوع الوثيقة")}</Th>}
                    {v.docNumber   && <Th>{tr("colDoc", "الرقم")}</Th>}
                    {v.type        && <Th>{tr("colJournalEntryNumber", "رقم القيد")}</Th>}
                    {v.debit       && <Th center>{tr("colDebit", "مدين")}</Th>}
                    {v.credit      && <Th center>{tr("colCredit", "دائن")}</Th>}
                    {v.balance     && <Th center>{tr("colBalance", "الرصيد")}</Th>}
                    {v.description && <Th>{tr("colDescription", "الشرح")}</Th>}
                  </tr>
                </thead>
                <tbody>
                  {/* Opening row — sign semantics differ per mode:
                      - customer: opening > 0 means the customer owes us (debit side)
                      - supplier: opening > 0 means we owe the supplier (credit side) */}
                  <tr className="bg-amber-50/40 border-t border-slate-200">
                    {v.date        && <Td mono>{from}</Td>}
                    {v.docType     && <Td className="italic text-slate-500">{tr("openingRow", "رصيد افتتاحي")}</Td>}
                    {v.docNumber   && <Td>—</Td>}
                    {v.type        && <Td className="text-slate-400">—</Td>}
                    {v.debit       && <Td center mono>{openingDebit  ? fmt(openingDebit)  : "0.00"}</Td>}
                    {v.credit      && <Td center mono>{openingCredit ? fmt(openingCredit) : "0.00"}</Td>}
                    {v.balance     && <Td center mono className="font-semibold">{fmt(opening)}</Td>}
                    {v.description && <Td className="text-slate-500">—</Td>}
                  </tr>

                  {lines.length === 0 ? (
                    <tr>
                      <td colSpan={Math.max(1, visibleCount)} className="py-10 text-center text-slate-400">
                        {tr("noRows", "لا توجد حركات في الفترة المحددة")}
                      </td>
                    </tr>
                  ) : lines.map((l, i) => (
                    <tr key={i} className="border-t border-slate-200 even:bg-slate-50/40 hover:bg-sky-50/40 transition-colors">
                      {v.date      && <Td mono className="text-slate-600">{l.date}</Td>}
                      {v.docType   && <Td className="text-slate-700 font-medium">{l.docType || "—"}</Td>}
                      {v.docNumber && <Td mono className="text-slate-600">{l.docNumber || (l.id != null ? `#${l.id}` : "—")}</Td>}
                      {v.type      && <Td mono className="text-slate-600">{l.journalEntryNumber || (l.journalEntryId != null ? `#${l.journalEntryId}` : "—")}</Td>}
                      {v.debit && (
                        <Td center mono className={l.debit ? "font-semibold text-sky-700" : "text-slate-400"}>
                          {l.debit ? fmt(l.debit) : "0.00"}
                        </Td>
                      )}
                      {v.credit && (
                        <Td center mono className={l.credit ? "font-semibold text-emerald-700" : "text-slate-400"}>
                          {l.credit ? fmt(l.credit) : "0.00"}
                        </Td>
                      )}
                      {v.balance     && <Td center mono className="font-bold text-slate-800">{fmt(l.balance)}</Td>}
                      {v.description && <Td className="text-slate-700 min-w-[260px]">{l.description}</Td>}
                    </tr>
                  ))}
                </tbody>
                {lines.length > 0 && (
                  <tfoot>
                    <tr className="bg-slate-100 border-t-2 border-slate-300 font-bold">
                      {leadingSpan > 0 && (
                        <Td colSpan={leadingSpan} className="text-slate-700">
                          {tr("totalLabel", "الإجمالي")}
                        </Td>
                      )}
                      {v.debit       && <Td center mono className="text-sky-700">{fmt(totals.debit)}</Td>}
                      {v.credit      && <Td center mono className="text-emerald-700">{fmt(totals.credit)}</Td>}
                      {v.balance     && <Td center mono className="text-slate-900">{fmt(closing)}</Td>}
                      {v.description && <Td>—</Td>}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        );
      })()}
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
