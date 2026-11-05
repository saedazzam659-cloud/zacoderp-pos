import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Loader2, Receipt, X } from "lucide-react";
import { api, type CashBox, type PosSession } from "@/lib/api";

type Account = { id: number; code: string; nameAr: string; accountType?: string; isPosting?: boolean; isActive?: boolean };
type ExpenseOptions = { expenseAccounts?: Account[]; cashBoxes?: Array<{ id: number; name: string }>; };
type ShiftReport = {
  movements: Array<{ id: string; code?: string | null; date: string; description?: string | null; amount: number; kind: string; createdAt?: string | null }>;
  openingCash: number; cashSales: number; movementNet: number; expectedCash: number;
};
type Props = {
  open: boolean;
  onClose: () => void;
  companyId: number;
  session: PosSession | null;
  cashBoxes: CashBox[];
  branchId: number | null;
  canManageExpenses: boolean;
  canManageOtherMovements: boolean;
};
type Kind = "expense" | "deposit" | "withdrawal" | "transfer" | "report";

const today = () => new Date().toISOString().slice(0, 10);
const kinds: { id: Kind; label: string; icon: typeof Receipt }[] = [
  { id: "expense", label: "مصروف", icon: Receipt },
  { id: "deposit", label: "إيداع", icon: ArrowDownToLine },
  { id: "withdrawal", label: "سحب", icon: ArrowUpFromLine },
  { id: "transfer", label: "تحويل", icon: ArrowLeftRight },
  { id: "report", label: "تقرير الوردية", icon: Receipt },
];

export default function CashMovementDialog({ open, onClose, companyId, session, cashBoxes, branchId, canManageExpenses, canManageOtherMovements }: Props) {
  const [kind, setKind] = useState<Kind>("expense");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<Account[]>([]);
  const [banks, setBanks] = useState<Array<{ id: number; nameAr?: string; name?: string; accountId?: number | null; currencyId?: number | null }>>([]);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(today());
  const [accountId, setAccountId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [transferTarget, setTransferTarget] = useState<"cash" | "bank">("cash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [movementRows, setMovementRows] = useState<Array<{ id: string; code?: string | null; date: string; description?: string | null; amount: number; kind: string; createdAt?: string | null }>>([]);
  const [reportSummary, setReportSummary] = useState<ShiftReport | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const sourceBoxId = session?.cashBoxId ?? null;
  const usableBoxes = useMemo(() => cashBoxes.filter((box) => box.id !== sourceBoxId), [cashBoxes, sourceBoxId]);
  const visibleKinds = useMemo(
    () => kinds.filter((item) => item.id === "expense" ? canManageExpenses : canManageOtherMovements),
    [canManageExpenses, canManageOtherMovements],
  );
  const activeKind = visibleKinds.some((item) => item.id === kind)
    ? kind
    : visibleKinds[0]?.id ?? "report";
  const cashOptions = useMemo(() => {
    if (activeKind === "expense") return expenseAccounts;
    return accounts.filter((a) => a.isPosting !== false && a.isActive !== false);
  }, [accounts, expenseAccounts, activeKind]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError(""); setNotice("");
    void Promise.all([
      canManageExpenses
        ? api.request<ExpenseOptions>("GET", "/api/cash-expenses/options").catch(() => ({} as ExpenseOptions))
        : Promise.resolve({} as ExpenseOptions),
      api.request<Account[] | { data?: Account[] }>("GET", `/api/accounts?companyId=${companyId}`).catch(() => []),
      api.request<typeof banks>("GET", `/api/bank-accounts?companyId=${companyId}`).catch(() => []),
    ]).then(([options, accountRows, bankRows]) => {
      if (!active) return;
      setExpenseAccounts(options.expenseAccounts ?? []);
      setAccounts(Array.isArray(accountRows) ? accountRows : accountRows.data ?? []);
      setBanks(Array.isArray(bankRows) ? bankRows : []);
    });
    return () => { active = false; };
  }, [open, companyId, canManageExpenses]);

  useEffect(() => {
    if (!open || visibleKinds.length === 0 || activeKind !== "report" || !session) return;
    let active = true;
    setReportBusy(true);
    api.request<ShiftReport>("GET", `/api/pos-sessions/${session.id}/cash-movements`)
      .then((data) => { if (active) { setMovementRows(data.movements ?? []); setReportSummary(data); } })
      .catch((e: any) => { if (active) setError(e?.message || "تعذّر تحميل تقرير الوردية."); })
      .finally(() => { if (active) setReportBusy(false); });
    return () => { active = false; };
  }, [open, activeKind, session?.id, visibleKinds.length]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = Number(amount);
    const selectedAccount = Number(accountId);
    if (!session || !sourceBoxId) { setError("افتح وردية مرتبطة بخزينة أولاً."); return; }
    if (!Number.isFinite(value) || value <= 0 || Math.round(value * 100) !== value * 100) { setError("أدخل مبلغاً موجباً حتى منزلتين عشريتين."); return; }
    if (!description.trim()) { setError("البيان مطلوب."); return; }
    if (activeKind !== "transfer" && !selectedAccount) { setError("اختر الحساب المقابل."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      let created: any;
      if (activeKind === "expense") {
        created = await api.request<any>("POST", "/api/cash-expenses", {
          cashBoxId: sourceBoxId, expenseAccountId: selectedAccount, amount: value, description: description.trim(), date,
        });
        await api.request("POST", `/api/cash-expenses/${created.id}/post`);
      } else if (activeKind === "deposit" || activeKind === "withdrawal") {
        const receipt = activeKind === "deposit";
        const path = receipt ? "/api/receipt-vouchers" : "/api/payment-vouchers";
        created = await api.request<any>("POST", path, {
          companyId, branchId, date, paymentType: "cash", cashBoxId: sourceBoxId,
          bankAccountId: null, entityType: "other", entityName: receipt ? "إيداع نقدي" : "سحب نقدي",
          amount: value.toFixed(2), currencyId: null, exchangeRate: "1", description: description.trim(),
          lines: [{ accountId: selectedAccount, description: description.trim(), amount: value.toFixed(2), taxRate: "0", taxAmount: "0" }],
        });
        await api.request("POST", `/${receipt ? "api/receipt-vouchers" : "api/payment-vouchers"}/${created.id}/post`);
      } else {
        const isBank = transferTarget === "bank";
        const target = Number(targetId);
        if (!target) throw new Error("اختر وجهة التحويل.");
        created = await api.request<any>("POST", "/api/cash-transfers", {
          companyId, branchId, date, transferType: isBank ? "cash_to_bank" : "cash_to_cash",
          fromCashBoxId: sourceBoxId, fromBankId: null, toCashBoxId: isBank ? null : target,
          toBankId: isBank ? target : null, amount: value.toFixed(2), exchangeRate: "1",
          currencyId: isBank
            ? banks.find((bank) => bank.id === target)?.currencyId ?? null
            : cashBoxes.find((box) => box.id === target)?.currencyId ?? null,
          description: description.trim(),
        });
        await api.request("POST", `/api/cash-transfers/${created.id}/post`);
      }
      setNotice("تم تسجيل الحركة وترحيلها عبر دورة النظام الحالية.");
      setAmount(""); setDescription(""); setAccountId(""); setTargetId("");
    } catch (e: any) {
      setError(e?.message || "تعذّر تسجيل الحركة.");
    } finally { setBusy(false); }
  };

  const title = visibleKinds.find((item) => item.id === activeKind)?.label;
  const reportNet = movementRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  if (visibleKinds.length === 0) {
    return (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-3" dir="rtl" role="dialog" aria-modal="true" aria-label="المصروفات والحركات النقدية">
        <section className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-black">المصروفات والحركات النقدية</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                لا تظهر العمليات لهذا المستخدم حتى تُمنح صلاحية إدارة الحركة النقدية أو صلاحيتا تسجيل مصروف الصندوق وترحيله.
              </p>
            </div>
            <button type="button" onClick={onClose} aria-label="إغلاق" className="grid size-9 shrink-0 place-items-center rounded-lg hover:bg-muted"><X className="size-4" /></button>
          </div>
        </section>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-3" dir="rtl" role="dialog" aria-modal="true" aria-label="الحركة النقدية">
      <section className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div><h2 className="text-lg font-black">الحركة النقدية</h2><p className="mt-1 text-xs text-muted-foreground">تُرحّل العمليات من خلال السندات والتحويلات المعتمدة في النظام.</p></div>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="grid size-9 place-items-center rounded-lg hover:bg-muted"><X className="size-4" /></button>
        </header>
        <div className="grid grid-cols-5 gap-2 p-4 pb-0">
          {visibleKinds.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => { setKind(id); setError(""); setNotice(""); }} className={`flex flex-col items-center gap-1 rounded-xl border p-2 text-xs font-bold ${activeKind === id ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}><Icon className="size-4" />{label}</button>)}
        </div>
        {!canManageExpenses && canManageOtherMovements && (
          <p className="mx-4 mt-3 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            مصروفات الصندوق تحتاج صلاحية «تسجيل مصروفات الصندوق» للمستخدم.
          </p>
        )}
        {activeKind === "report" ? <div className="space-y-3 p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["نقد افتتاحي", reportSummary?.openingCash ?? 0], ["مبيعات نقدية", reportSummary?.cashSales ?? 0], ["صافي الحركات", reportSummary?.movementNet ?? reportNet], ["النقد المتوقع", reportSummary?.expectedCash ?? 0]].map(([label, value]) => <div key={String(label)} className="rounded-xl bg-muted/60 p-3"><p className="text-[11px] text-muted-foreground">{label}</p><strong className="mt-1 block text-sm">{Number(value).toFixed(2)} ر.س</strong></div>)}
          </div>
          {reportBusy ? <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin" /></div> : movementRows.length ? <div className="max-h-72 space-y-2 overflow-auto">
            {movementRows.map((row) => <article key={row.id} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
              <div className="min-w-0"><p className="truncate text-sm font-bold">{row.description || row.code || "حركة نقدية"}</p><p className="mt-1 text-[11px] text-muted-foreground">{row.date} · {row.kind}</p></div>
              <strong className={row.amount < 0 ? "shrink-0 text-destructive" : "shrink-0 text-primary"}>{Number(row.amount).toFixed(2)}</strong>
            </article>)}
          </div> : <p className="py-8 text-center text-sm text-muted-foreground">لا توجد حركات نقدية مسجلة في هذه الوردية.</p>}
        </div> : <form onSubmit={submit} className="space-y-3 p-5">
          {activeKind === "transfer" ? <>
            <label className="block text-xs font-bold">التحويل إلى<select value={transferTarget} onChange={(e) => { setTransferTarget(e.target.value as "cash" | "bank"); setTargetId(""); }} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"><option value="cash">خزينة أخرى</option><option value="bank">حساب بنكي</option></select></label>
            <label className="block text-xs font-bold">الوجهة<select required value={targetId} onChange={(e) => setTargetId(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"><option value="">اختر الوجهة</option>{transferTarget === "cash" ? usableBoxes.map((box) => <option key={box.id} value={box.id}>{box.nameAr} ({box.code})</option>) : banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.nameAr || bank.name || `#${bank.id}`}</option>)}</select></label>
          </> : <label className="block text-xs font-bold">{activeKind === "expense" ? "حساب المصروف" : "الحساب المقابل"}<select required value={accountId} onChange={(e) => setAccountId(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"><option value="">اختر الحساب</option>{cashOptions.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.nameAr}</option>)}</select></label>}
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-bold">المبلغ<input required type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
            <label className="block text-xs font-bold">التاريخ<input required type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
          </div>
          <label className="block text-xs font-bold">البيان<input required maxLength={240} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={`بيان ${title ?? "الحركة"}`} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm" /></label>
          {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
          {notice && <p role="status" className="rounded-lg bg-primary/10 p-3 text-sm text-primary">{notice}</p>}
          <button disabled={busy || !session} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50">{busy && <Loader2 className="size-4 animate-spin" />}{busy ? "جارٍ الحفظ..." : `تسجيل ${title ?? "الحركة"} وترحيلها`}</button>
          {!session && <p className="text-center text-xs text-amber-700">افتح وردية بيع مرتبطة بخزينة لتسجيل حركة.</p>}
        </form>}
      </section>
    </div>
  );
}
