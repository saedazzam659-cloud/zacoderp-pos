import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useToast } from "@/hooks/use-toast";
import { useFmt } from "@/hooks/use-fmt";
import ExportButtons from "@/components/ExportButtons";
import {
  GitCompareArrows, Upload, Search, Filter, CheckCircle2, Link2, Link2Off, Trash2, AlertTriangle,
} from "lucide-react";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...extra };
}

type BookTx = { id: string; date: string; description: string; debit: number; credit: number; ref?: string | null };
type BankTx = { id: string; date: string; description: string; debit: number; credit: number; balance?: number | null; ref?: string | null };
type BookSide = { opening: number; transactions: Omit<BookTx, "id">[] };

const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const res = r.result as string;
      const idx = res.indexOf("base64,");
      resolve(idx >= 0 ? res.slice(idx + 7) : res);
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });

const dayDiff = (a: string, b: string) => {
  const ad = new Date(a + "T00:00:00").getTime();
  const bd = new Date(b + "T00:00:00").getTime();
  if (isNaN(ad) || isNaN(bd)) return 999999;
  return Math.abs((ad - bd) / 86400000);
};
const moneyEq = (a: number, b: number) => Math.abs(a - b) < 0.005;

export default function BankReconciliation() {
  const { fmt } = useFmt();
  const { toast } = useToast();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);

  const [filters, setFilters] = useState({ from: firstDay, to: today, bankAccountId: "" });
  const [applied, setApplied] = useState({ from: firstDay, to: today, bankAccountId: "" });
  const [bankTxns, setBankTxns] = useState<BankTx[]>([]);
  const [statementLabel, setStatementLabel] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [matchedPairs, setMatchedPairs] = useState<Array<{ bookId: string; bankId: string }>>([]);
  const [selBook, setSelBook] = useState<Set<string>>(new Set());
  const [selBank, setSelBank] = useState<Set<string>>(new Set());
  const [tolerance, setTolerance] = useState(2); // days
  const [parsing, setParsing] = useState(false);

  // Bank accounts for the picker
  const { data: banks = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/bank-accounts?companyId=${cid}` : `${API}/api/bank-accounts`, { headers: authHeaders() });
      return r.json();
    },
  });
  const bank = (banks as any[]).find(b => String(b.id) === applied.bankAccountId);

  // Book-side ledger (from posted GL journal entries)
  const { data: book, isLoading: loadingBook } = useQuery<BookSide>({
    queryKey: ["bank-recon-book", cid, applied],
    enabled: !!applied.bankAccountId,
    queryFn: async () => {
      const sp = new URLSearchParams({ bankAccountId: applied.bankAccountId, from: applied.from, to: applied.to });
      if (cid) sp.set("companyId", String(cid));
      const r = await fetch(`${API}/api/bank-reconciliation/book-ledger?${sp}`, { headers: authHeaders() });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const bookTxns: BookTx[] = useMemo(() => {
    if (!book) return [];
    return book.transactions.map((t, i) => ({ ...t, id: `book-${i}-${t.date}` }));
  }, [book]);

  // Reset matches whenever the underlying datasets change
  const resetMatches = () => { setMatchedPairs([]); setSelBook(new Set()); setSelBank(new Set()); };

  async function handleFile(file: File) {
    setParsing(true);
    try {
      const contentBase64 = await toBase64(file);
      const r = await fetch(`${API}/api/bank-reconciliation/parse`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ filename: file.name, contentBase64 }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "فشل رفع الكشف");
      const txns: BankTx[] = (j.transactions ?? []).map((t: any, i: number) => ({ ...t, id: `bank-${i}-${t.date}` }));
      setBankTxns(txns);
      setStatementLabel(`${file.name} — ${txns.length} حركة`);
      setWarnings(j.warnings ?? []);
      resetMatches();
      toast({ title: "تم تحليل الكشف", description: `استخرجنا ${txns.length} حركة من ${file.name}` });
    } catch (e: any) {
      toast({ variant: "destructive", title: "خطأ في الرفع", description: e?.message ?? String(e) });
    } finally {
      setParsing(false);
    }
  }

  function autoMatch() {
    if (bookTxns.length === 0 || bankTxns.length === 0) return;
    const matchedBook = new Set(matchedPairs.map(p => p.bookId));
    const matchedBank = new Set(matchedPairs.map(p => p.bankId));
    const newPairs: Array<{ bookId: string; bankId: string }> = [];

    // Pass 1: exact date + same direction + same magnitude
    // Pass 2: within tolerance days
    for (const pass of [0, tolerance]) {
      for (const bk of bookTxns) {
        if (matchedBook.has(bk.id)) continue;
        const bkAmt = bk.debit - bk.credit; // signed
        const cand = bankTxns.find(bn => {
          if (matchedBank.has(bn.id)) return false;
          if (dayDiff(bk.date, bn.date) > pass) return false;
          const bnAmt = bn.debit - bn.credit;
          return Math.sign(bkAmt) === Math.sign(bnAmt) && moneyEq(Math.abs(bkAmt), Math.abs(bnAmt));
        });
        if (cand) {
          newPairs.push({ bookId: bk.id, bankId: cand.id });
          matchedBook.add(bk.id);
          matchedBank.add(cand.id);
        }
      }
    }

    setMatchedPairs(p => [...p, ...newPairs]);
    toast({ title: "مطابقة تلقائية", description: `طوبق ${newPairs.length} حركة جديدة` });
  }

  function manualMatch() {
    const bookIds = [...selBook];
    const bankIds = [...selBank];
    if (bookIds.length === 0 || bankIds.length === 0) {
      toast({ variant: "destructive", title: "اختيار غير مكتمل", description: "حدد حركة من كل جانب على الأقل" });
      return;
    }
    const bookSum = bookIds.reduce((s, id) => {
      const t = bookTxns.find(x => x.id === id)!;
      return s + (t.debit - t.credit);
    }, 0);
    const bankSum = bankIds.reduce((s, id) => {
      const t = bankTxns.find(x => x.id === id)!;
      return s + (t.debit - t.credit);
    }, 0);
    if (!moneyEq(bookSum, bankSum)) {
      toast({
        variant: "destructive",
        title: "المبالغ غير متطابقة",
        description: `مجموع الدفتري: ${fmt(bookSum)} | مجموع البنكي: ${fmt(bankSum)} | الفرق: ${fmt(bookSum - bankSum)}`,
      });
      return;
    }
    // Pair them up by zipping (works for 1↔1, 1↔N, N↔1, N↔N as a single grouping).
    const newPairs = bookIds.flatMap(bookId => bankIds.map(bankId => ({ bookId, bankId })));
    setMatchedPairs(p => [...p, ...newPairs]);
    setSelBook(new Set());
    setSelBank(new Set());
    toast({ title: "تمت المطابقة اليدوية", description: `طوبق ${bookIds.length} ↔ ${bankIds.length}` });
  }

  function unmatchPair(bookId: string, bankId: string) {
    setMatchedPairs(p => p.filter(x => !(x.bookId === bookId && x.bankId === bankId)));
  }

  // Derived sets
  const matchedBookIds = useMemo(() => new Set(matchedPairs.map(p => p.bookId)), [matchedPairs]);
  const matchedBankIds = useMemo(() => new Set(matchedPairs.map(p => p.bankId)), [matchedPairs]);
  const unmatchedBook = bookTxns.filter(t => !matchedBookIds.has(t.id));
  const unmatchedBank = bankTxns.filter(t => !matchedBankIds.has(t.id));

  // Totals & balances
  const bookOpening = book?.opening ?? 0;
  const bookMovement = bookTxns.reduce((s, t) => s + t.debit - t.credit, 0);
  const bookClosing = bookOpening + bookMovement;
  const bankMovement = bankTxns.reduce((s, t) => s + t.debit - t.credit, 0);
  const bankReportedClosing = useMemo(() => {
    if (bankTxns.length === 0) return null;
    const last = bankTxns[bankTxns.length - 1];
    return last?.balance ?? null;
  }, [bankTxns]);
  const unmatchedBookSum = unmatchedBook.reduce((s, t) => s + t.debit - t.credit, 0);
  const unmatchedBankSum = unmatchedBank.reduce((s, t) => s + t.debit - t.credit, 0);
  const reconciledDifference = bookMovement - bankMovement; // 0 = perfect

  const exportRows = [
    { side: "دفتري — افتتاحي", date: applied.from, ref: "", description: "الرصيد الافتتاحي", debit: bookOpening > 0 ? fmt(bookOpening) : "", credit: bookOpening < 0 ? fmt(-bookOpening) : "", status: "" },
    ...bookTxns.map(t => ({
      side: "دفتري", date: t.date, ref: t.ref ?? "", description: t.description,
      debit: t.debit ? fmt(t.debit) : "", credit: t.credit ? fmt(t.credit) : "",
      status: matchedBookIds.has(t.id) ? "مطابق" : "غير مطابق",
    })),
    ...bankTxns.map(t => ({
      side: "بنكي", date: t.date, ref: t.ref ?? "", description: t.description,
      debit: t.debit ? fmt(t.debit) : "", credit: t.credit ? fmt(t.credit) : "",
      status: matchedBankIds.has(t.id) ? "مطابق" : "غير مطابق",
    })),
  ];

  const COLS = [
    { key: "side", header: "الطرف", width: 14 },
    { key: "date", header: "التاريخ", width: 12 },
    { key: "ref", header: "المرجع", width: 14 },
    { key: "description", header: "البيان", width: 36 },
    { key: "debit", header: "وارد", width: 12 },
    { key: "credit", header: "صادر", width: 12 },
    { key: "status", header: "الحالة", width: 12 },
  ];

  const toggle = (set: Set<string>, id: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitCompareArrows className="h-6 w-6 text-primary" />مطابقة كشف البنك
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            قارن حركات البنك في قيود اليومية مع كشف الحساب الفعلي من البنك (Excel/CSV/PDF/Word)
          </p>
        </div>
        <ExportButtons
          rows={exportRows}
          columns={COLS}
          filename={`bank-reconciliation-${bank?.nameAr ?? ""}-${applied.from}-${applied.to}`}
          title="تقرير مطابقة كشف البنك"
          subtitle={bank ? `${bank.nameAr}  |  ${applied.from} → ${applied.to}` : ""}
        />
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">المرشحات</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label>الحساب البنكي <span className="text-red-500">*</span></Label>
            <SearchCombobox
              items={(banks as any[]).map(b => ({ value: String(b.id), label: b.nameAr, labelEn: b.nameEn }))}
              value={filters.bankAccountId}
              onValueChange={v => setFilters(p => ({ ...p, bankAccountId: v }))}
              placeholder="اختر الحساب البنكي"
            />
          </div>
          <div className="space-y-1.5">
            <Label>من تاريخ</Label>
            <Input type="date" value={filters.from} onChange={e => setFilters(p => ({ ...p, from: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>إلى تاريخ</Label>
            <Input type="date" value={filters.to} onChange={e => setFilters(p => ({ ...p, to: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>تسامح المطابقة (أيام)</Label>
            <Input type="number" min={0} max={15} value={tolerance} onChange={e => setTolerance(Number(e.target.value) || 0)} />
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <Button size="sm" onClick={() => { setApplied({ ...filters }); resetMatches(); }} disabled={!filters.bankAccountId} className="gap-2">
            <Search className="h-3.5 w-3.5" />جلب القيود الدفترية
          </Button>
        </div>
      </div>

      {applied.bankAccountId && (
        <>
          {/* Upload + actions */}
          <div className="rounded-xl border bg-card p-4 flex flex-wrap items-center gap-3">
            <Label htmlFor="recon-file" className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90">
              <Upload className="h-4 w-4" />{parsing ? "جارٍ التحليل..." : "رفع كشف البنك"}
            </Label>
            <input
              id="recon-file" type="file" className="hidden" disabled={parsing}
              accept=".xlsx,.xls,.csv,.pdf,.doc,.docx"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.currentTarget.value = ""; }}
            />
            <p className="text-xs text-muted-foreground">المدعوم: Excel / CSV / PDF / Word</p>
            {statementLabel && (
              <span className="text-xs px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                <CheckCircle2 className="h-3 w-3 inline ms-1" />{statementLabel}
              </span>
            )}
            <div className="ms-auto flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={autoMatch} disabled={bookTxns.length === 0 || bankTxns.length === 0} className="gap-2">
                <Link2 className="h-4 w-4" />مطابقة تلقائية
              </Button>
              <Button size="sm" onClick={manualMatch} disabled={selBook.size === 0 || selBank.size === 0} className="gap-2">
                <Link2 className="h-4 w-4" />مطابقة المحدد
              </Button>
              <Button size="sm" variant="ghost" onClick={resetMatches} disabled={matchedPairs.length === 0} className="gap-2 text-rose-600">
                <Trash2 className="h-4 w-4" />إلغاء كل المطابقات
              </Button>
            </div>
          </div>

          {warnings.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 space-y-1">
              {warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{w}</div>
              ))}
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">رصيد دفتري (إقفال)</p>
              <p className="text-lg font-bold tabular-nums mt-1">{fmt(bookClosing)}</p>
              <p className="text-[10px] text-muted-foreground mt-1">افتتاحي {fmt(bookOpening)} + حركة {fmt(bookMovement)}</p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">صافي حركة البنك من الكشف</p>
              <p className="text-lg font-bold tabular-nums mt-1">{fmt(bankMovement)}</p>
              {bankReportedClosing != null && <p className="text-[10px] text-muted-foreground mt-1">رصيد البنك المُعلَن: {fmt(bankReportedClosing)}</p>}
            </div>
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">غير مطابق (دفتري)</p>
              <p className="text-lg font-bold tabular-nums mt-1 text-amber-700">{unmatchedBook.length} <span className="text-xs">({fmt(unmatchedBookSum)})</span></p>
            </div>
            <div className={`rounded-xl border p-4 ${moneyEq(reconciledDifference, 0) ? "bg-emerald-50 border-emerald-200" : "bg-rose-50 border-rose-200"}`}>
              <p className="text-xs text-muted-foreground">الفرق (حركة دفترية − حركة بنكية)</p>
              <p className={`text-lg font-bold tabular-nums mt-1 ${moneyEq(reconciledDifference, 0) ? "text-emerald-700" : "text-rose-700"}`}>{fmt(reconciledDifference)}</p>
              <p className="text-[10px] text-muted-foreground mt-1">{moneyEq(reconciledDifference, 0) ? "متطابقان ✓" : "يوجد فرق — راجع غير المطابقة"}</p>
            </div>
          </div>

          {/* Two-pane diff */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SidePane
              title="السجل الدفتري (قيود اليومية)"
              count={bookTxns.length}
              opening={bookOpening}
              loading={loadingBook}
              rows={bookTxns}
              matchedIds={matchedBookIds}
              selected={selBook}
              onToggle={id => toggle(selBook, id, setSelBook)}
              fmt={fmt}
            />
            <SidePane
              title="كشف البنك المرفوع"
              count={bankTxns.length}
              opening={null}
              loading={false}
              rows={bankTxns}
              matchedIds={matchedBankIds}
              selected={selBank}
              onToggle={id => toggle(selBank, id, setSelBank)}
              fmt={fmt}
            />
          </div>

          {/* Matched pairs list */}
          {matchedPairs.length > 0 && (
            <div className="rounded-xl border bg-card p-4">
              <h3 className="text-sm font-semibold mb-3">المطابقات ({matchedPairs.length})</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="px-2 py-2 text-right">دفتري</th>
                      <th className="px-2 py-2 text-right">↔</th>
                      <th className="px-2 py-2 text-right">بنكي</th>
                      <th className="px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {matchedPairs.map((p, i) => {
                      const bk = bookTxns.find(t => t.id === p.bookId);
                      const bn = bankTxns.find(t => t.id === p.bankId);
                      return (
                        <tr key={i}>
                          <td className="px-2 py-1.5">{bk ? `${bk.date} | ${bk.description.slice(0, 40)} | ${fmt(bk.debit - bk.credit)}` : "—"}</td>
                          <td className="px-2 py-1.5 text-center text-emerald-600"><Link2 className="h-3 w-3 inline" /></td>
                          <td className="px-2 py-1.5">{bn ? `${bn.date} | ${bn.description.slice(0, 40)} | ${fmt(bn.debit - bn.credit)}` : "—"}</td>
                          <td className="px-2 py-1.5 text-left">
                            <Button size="sm" variant="ghost" onClick={() => unmatchPair(p.bookId, p.bankId)} className="h-6 px-2 text-rose-600">
                              <Link2Off className="h-3 w-3" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {!applied.bankAccountId && (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          <GitCompareArrows className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p>اختر الحساب البنكي والفترة لبدء المطابقة</p>
        </div>
      )}
    </div>
  );
}

function SidePane({
  title, count, opening, loading, rows, matchedIds, selected, onToggle, fmt,
}: {
  title: string; count: number; opening: number | null; loading: boolean;
  rows: Array<BookTx | BankTx>; matchedIds: Set<string>; selected: Set<string>;
  onToggle: (id: string) => void; fmt: (n: number) => string;
}) {
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{count} حركة {opening != null ? ` | افتتاحي: ${fmt(opening)}` : ""}</p>
        </div>
        <p className="text-xs text-muted-foreground">المحدد: {selected.size}</p>
      </div>
      <div className="max-h-[500px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 border-b sticky top-0">
            <tr>
              <th className="px-2 py-2 w-8"></th>
              <th className="px-2 py-2 text-right">التاريخ</th>
              <th className="px-2 py-2 text-right">البيان</th>
              <th className="px-2 py-2 text-center text-emerald-700">وارد</th>
              <th className="px-2 py-2 text-center text-rose-700">صادر</th>
              <th className="px-2 py-2 w-12 text-center">حالة</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading
              ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={6} className="px-2 py-2"><Skeleton className="h-5 w-full" /></td></tr>)
              : rows.length === 0
              ? <tr><td colSpan={6} className="py-10 text-center text-muted-foreground">لا توجد حركات</td></tr>
              : rows.map(t => {
                  const matched = matchedIds.has(t.id);
                  const isSel = selected.has(t.id);
                  return (
                    <tr
                      key={t.id}
                      onClick={() => !matched && onToggle(t.id)}
                      className={`${matched ? "opacity-40 bg-emerald-50/30" : "cursor-pointer hover:bg-muted/40"} ${isSel ? "bg-primary/10" : ""}`}
                    >
                      <td className="px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          disabled={matched}
                          checked={isSel}
                          onChange={() => onToggle(t.id)}
                          onClick={e => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-2 py-1.5 tabular-nums text-muted-foreground whitespace-nowrap">{t.date}</td>
                      <td className="px-2 py-1.5">
                        <div className="truncate max-w-[200px]" title={t.description}>{t.description}</div>
                        {t.ref && <div className="text-[10px] text-muted-foreground font-mono">{t.ref}</div>}
                      </td>
                      <td className="px-2 py-1.5 text-center tabular-nums text-emerald-600">{t.debit ? fmt(t.debit) : "—"}</td>
                      <td className="px-2 py-1.5 text-center tabular-nums text-rose-600">{t.credit ? fmt(t.credit) : "—"}</td>
                      <td className="px-2 py-1.5 text-center">
                        {matched && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 inline" />}
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
