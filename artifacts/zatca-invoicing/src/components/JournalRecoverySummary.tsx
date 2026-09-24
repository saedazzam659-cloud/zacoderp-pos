import { recoverySummaryFields, type ContractingRecoverySummary } from "@/lib/journalPrint";

/** Context only: these values do not participate in the displayed journal's debit/credit totals. */
export function JournalRecoverySummary({
  summaries,
  isRtl,
}: {
  summaries?: ContractingRecoverySummary[] | null;
  isRtl: boolean;
}) {
  if (!summaries?.length) return null;
  return (
    <section className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-slate-800 dark:border-blue-900 dark:bg-blue-950 dark:text-slate-100" data-testid="journal-recovery-context">
      <h3 className="font-semibold">{isRtl ? "بيان استرداد السلفة — للعرض فقط" : "Advance recovery — information only"}</h3>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
        {isRtl
          ? "قيود الاسترداد الأصلية مرحّلة بشكل مستقل؛ لا تنشئ هذه البيانات قيداً أو ترحيلاً إضافياً."
          : "Original recovery journals were posted separately; this information does not create another posting."}
      </p>
      {summaries.map((summary) => (
        <div key={`${summary.direction}-${summary.billId}`} className="mt-3 border-t border-blue-200 pt-3 dark:border-blue-900">
          <div className="font-medium">
            {isRtl ? "مستخلص" : "Certificate"} {summary.billNumber} — {summary.direction === "incoming"
              ? (isRtl ? "مقاول باطن / صرف" : "Subcontractor / payment")
              : (isRtl ? "مالك / قبض" : "Owner / receipt")}
          </div>
          <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {recoverySummaryFields(summary, isRtl).map(([label, value]) => (
              <div key={label}><dt className="text-xs text-slate-600 dark:text-slate-300">{label}</dt><dd className="font-medium">{value}</dd></div>
            ))}
          </dl>
          {(summary.recoveryJournals ?? []).map((journal) => (
            <div key={journal.id} className="mt-2 rounded border border-blue-200 p-2 text-xs dark:border-blue-900">
              {isRtl ? "قيد الاسترداد الأصلي" : "Original recovery journal"}:{" "}
              <a className="font-medium text-blue-700 underline dark:text-blue-300" href={`/accounting/journals/${encodeURIComponent(String(journal.id))}`}>
                {journal.number}
              </a>{" "}
              ({Number(journal.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
              <div>{isRtl ? "مدين" : "Debit"}: {(journal.debitAccounts ?? []).join("، ") || "—"}</div>
              <div>{isRtl ? "دائن" : "Credit"}: {(journal.creditAccounts ?? []).join("، ") || "—"}</div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}