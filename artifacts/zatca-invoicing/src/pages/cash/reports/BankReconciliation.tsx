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
  GitCompareArrows, Upload, Search, Filter, CheckCircle2, Link2, Link2Off, Trash2, AlertTriangle, Sparkles, Brain,
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

  const [sourceMode, setSourceMode] = useState<"bank" | "account">("bank");
  const [filters, setFilters] = useState({ from: firstDay, to: today, bankAccountId: "", accountId: "" });
  const [applied, setApplied] = useState({ from: firstDay, to: today, bankAccountId: "", accountId: "", sourceMode: "bank" as "bank" | "account" });
  const [bankTxns, setBankTxns] = useState<BankTx[]>([]);
  const [statementLabel, setStatementLabel] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [matchedPairs, setMatchedPairs] = useState<Array<{ bookId: string; bankId: string }>>([]);
  const [selBook, setSelBook] = useState<Set<string>>(new Set());
  const [selBank, setSelBank] = useState<Set<string>>(new Set());
  const [tolerance, setTolerance] = useState(2); // days
  const [parsing, setParsing] = useState(false);
  const [aiMatching, setAiMatching] = useState(false);
  const [aiResult, setAiResult] = useState<{
    pairs: Array<{ bookIds: string[]; bankIds: string[]; confidence: number; reason: string; bookSum: number; bankSum: number }>;
    unmatchedAnalysis: Array<{ side: "book" | "bank"; id: string; likelyExplanation: string }>;
    summary: string;
    stats?: { totalProposed: number; totalAccepted: number; bookMatched: number; bankMatched: number };
  } | null>(null);

  // Bank accounts for the picker (cash & banks module)
  const { data: banks = [] } = useQuery<any[]>({
    queryKey: ["bank-accounts", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/bank-accounts?companyId=${cid}` : `${API}/api/bank-accounts`, { headers: authHeaders() });
      return r.json();
    },
  });
  const bank = (banks as any[]).find(b => String(b.id) === applied.bankAccountId);

  // Chart-of-accounts entries for the alternative picker — restricted to
  // asset accounts that are leaf (postable), since a bank ledger has to be
  // a posting account.
  const { data: chartAccounts = [] } = useQuery<any[]>({
    queryKey: ["chart-accounts", cid],
    queryFn: async () => {
      const r = await fetch(cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`, { headers: authHeaders() });
      const all = await r.json();
      return (Array.isArray(all) ? all : []).filter((a: any) =>
        a.isActive !== false && a.isPosting !== false && (a.accountType === "asset" || !a.accountType)
      );
    },
  });
  const chartAcc = (chartAccounts as any[]).find(a => String(a.id) === applied.accountId);

  const hasSelection = applied.sourceMode === "bank" ? !!applied.bankAccountId : !!applied.accountId;
  const filterHasSelection = sourceMode === "bank" ? !!filters.bankAccountId : !!filters.accountId;

  // Book-side ledger (from posted GL journal entries)
  const { data: book, isLoading: loadingBook } = useQuery<BookSide>({
    queryKey: ["bank-recon-book", cid, applied],
    enabled: hasSelection,
    queryFn: async () => {
      const sp = new URLSearchParams({ from: applied.from, to: applied.to });
      if (applied.sourceMode === "bank") sp.set("bankAccountId", applied.bankAccountId);
      else sp.set("accountId", applied.accountId);
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

  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    setParsing(true);
    try {
      const allTxns: Omit<BankTx, "id">[] = [];
      const allWarnings: string[] = [];
      const fileLabels: string[] = [];
      const failures: string[] = [];

      // Parse files sequentially to avoid hammering the OCR endpoint and to
      // give clear per-file error messages.
      for (const file of files) {
        try {
          const contentBase64 = await toBase64(file);
          const r = await fetch(`${API}/api/bank-reconciliation/parse`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ filename: file.name, contentBase64 }),
          });
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error ?? "فشل التحليل");
          const fileTxns = (j.transactions ?? []) as Omit<BankTx, "id">[];
          allTxns.push(...fileTxns);
          fileLabels.push(`${file.name} (${fileTxns.length})`);
          for (const w of (j.warnings ?? []) as string[]) {
            allWarnings.push(`[${file.name}] ${w}`);
          }
        } catch (e: any) {
          failures.push(`${file.name}: ${e?.message ?? String(e)}`);
        }
      }

      // De-duplicate across files: same date + same description + same debit + same credit
      // counts as a duplicate (a single transaction appearing in two overlapping statements).
      const seen = new Set<string>();
      const merged: Omit<BankTx, "id">[] = [];
      for (const t of allTxns) {
        const key = `${t.date}|${(t.description ?? "").trim()}|${t.debit.toFixed(2)}|${t.credit.toFixed(2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(t);
      }
      const dupCount = allTxns.length - merged.length;
      if (dupCount > 0) {
        allWarnings.unshift(`تم استبعاد ${dupCount} حركة مكررة بين الملفات.`);
      }

      // Sort merged transactions chronologically before assigning stable IDs.
      merged.sort((a, b) => a.date.localeCompare(b.date));
      const txns: BankTx[] = merged.map((t, i) => ({ ...t, id: `bank-${i}-${t.date}` }));

      setBankTxns(txns);
      setStatementLabel(
        files.length === 1
          ? `${files[0].name} — ${txns.length} حركة`
          : `${files.length} ملفات (${fileLabels.join(" • ")}) — ${txns.length} حركة`
      );
      setWarnings(allWarnings);
      resetMatches();

      if (failures.length > 0) {
        toast({
          variant: "destructive",
          title: `فشل ${failures.length} من ${files.length} ملفات`,
          description: failures.join(" | "),
        });
      } else {
        toast({
          title: "تم تحليل الكشوف",
          description: `استخرجنا ${txns.length} حركة من ${files.length} ${files.length === 1 ? "ملف" : "ملفات"}.`,
        });
      }
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

  async function aiMatch() {
    if (bookTxns.length === 0 || bankTxns.length === 0) return;
    setAiMatching(true);
    setAiResult(null);
    try {
      // Send only currently-unmatched txns so AI focuses on the diff
      const matchedBook = new Set(matchedPairs.map(p => p.bookId));
      const matchedBank = new Set(matchedPairs.map(p => p.bankId));
      const book = bookTxns.filter(t => !matchedBook.has(t.id));
      const bank = bankTxns.filter(t => !matchedBank.has(t.id));
      if (book.length === 0 || bank.length === 0) {
        toast({ title: "لا توجد حركات غير مطابقة", description: "كل الحركات مطابقة بالفعل" });
        return;
      }
      const r = await fetch(`${API}/api/bank-reconciliation/ai-match`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ book, bank, toleranceDays: tolerance }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "فشل المطابقة الذكية");
      setAiResult(j);
      // Auto-apply high-confidence pairs (>=0.8)
      const autoApply = j.pairs.filter((p: any) => p.confidence >= 0.8);
      const newPairs: Array<{ bookId: string; bankId: string }> = [];
      for (const p of autoApply) {
        for (const bookId of p.bookIds) {
          for (const bankId of p.bankIds) {
            newPairs.push({ bookId, bankId });
          }
        }
      }
      if (newPairs.length > 0) {
        setMatchedPairs(prev => [...prev, ...newPairs]);
      }
      toast({
        title: "اكتملت المطابقة الذكية",
        description: `${j.stats?.totalAccepted ?? 0} مجموعة (طُبّق تلقائياً ${autoApply.length} عالي الثقة) — راجع الباقي أدناه`,
      });
    } catch (e: any) {
      toast({ variant: "destructive", title: "فشل المطابقة الذكية", description: e?.message ?? String(e) });
    } finally {
      setAiMatching(false);
    }
  }

  function applyAiSuggestion(p: { bookIds: string[]; bankIds: string[] }) {
    const newPairs = p.bookIds.flatMap(bookId => p.bankIds.map(bankId => ({ bookId, bankId })));
    setMatchedPairs(prev => [...prev, ...newPairs]);
    setAiResult(prev => prev ? { ...prev, pairs: prev.pairs.filter(x => x !== p) } : prev);
    toast({ title: "تمت المطابقة", description: `${p.bookIds.length} ↔ ${p.bankIds.length}` });
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

  // Professional bank-reconciliation statement: split unmatched items by
  // direction (deposits vs withdrawals) so we can present the classic
  // 4-quadrant adjusted-balance comparison.
  const unBookDeposits   = unmatchedBook.reduce((s, t) => s + Number(t.debit  || 0), 0);
  const unBookWithdrawals = unmatchedBook.reduce((s, t) => s + Number(t.credit || 0), 0);
  const unBankDeposits   = unmatchedBank.reduce((s, t) => s + Number(t.debit  || 0), 0);
  const unBankWithdrawals = unmatchedBank.reduce((s, t) => s + Number(t.credit || 0), 0);
  // Bank closing per the statement: prefer the reported closing if the
  // parser surfaced one, otherwise infer from net movement.
  const bankClosing = bankReportedClosing != null ? bankReportedClosing : bankMovement;
  // Adjusted balances — once both sides absorb each other's outstanding
  // items they MUST be equal. Any residual is the true unexplained gap.
  const adjustedBookBalance = bookClosing + unBankDeposits - unBankWithdrawals;
  const adjustedBankBalance = bankClosing + unBookDeposits - unBookWithdrawals;
  const trueDifference = adjustedBookBalance - adjustedBankBalance;

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
          filename={`bank-reconciliation-${bank?.nameAr ?? chartAcc?.nameAr ?? ""}-${applied.from}-${applied.to}`}
          title="تقرير مطابقة كشف البنك"
          subtitle={(bank || chartAcc) ? `${bank?.nameAr ?? chartAcc?.nameAr}  |  ${applied.from} → ${applied.to}` : ""}
        />
      </div>

      {/* Filters */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">المرشحات</h2>
        </div>
        {/* Source mode toggle */}
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">مصدر الحساب:</span>
          <button
            type="button"
            onClick={() => setSourceMode("bank")}
            className={`px-3 py-1.5 rounded-lg border transition ${sourceMode === "bank" ? "bg-primary text-primary-foreground border-primary" : "bg-card hover:bg-muted"}`}
          >
            النقد والبنوك
          </button>
          <button
            type="button"
            onClick={() => setSourceMode("account")}
            className={`px-3 py-1.5 rounded-lg border transition ${sourceMode === "account" ? "bg-primary text-primary-foreground border-primary" : "bg-card hover:bg-muted"}`}
          >
            شجرة الحسابات
          </button>
          <span className="text-muted-foreground">
            {sourceMode === "bank"
              ? "— الحسابات المسجّلة في وحدة النقد والبنوك"
              : "— أي حساب أصول من شجرة الحسابات (مفيد لو البنك مضاف مباشرة في الشجرة)"}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label>{sourceMode === "bank" ? "الحساب البنكي" : "حساب من شجرة الحسابات"} <span className="text-red-500">*</span></Label>
            {sourceMode === "bank" ? (
              <SearchCombobox
                items={(banks as any[]).map(b => ({ value: String(b.id), label: b.nameAr, labelEn: b.nameEn }))}
                value={filters.bankAccountId}
                onValueChange={v => setFilters(p => ({ ...p, bankAccountId: v }))}
                placeholder="اختر الحساب البنكي"
              />
            ) : (
              <SearchCombobox
                items={(chartAccounts as any[]).map(a => ({ value: String(a.id), label: `${a.code} — ${a.nameAr}`, labelEn: a.nameEn }))}
                value={filters.accountId}
                onValueChange={v => setFilters(p => ({ ...p, accountId: v }))}
                placeholder="اختر الحساب من الشجرة"
              />
            )}
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
          <Button size="sm" onClick={() => { setApplied({ ...filters, sourceMode }); resetMatches(); }} disabled={!filterHasSelection} className="gap-2">
            <Search className="h-3.5 w-3.5" />جلب القيود الدفترية
          </Button>
        </div>
      </div>

      {hasSelection && (
        <>
          {/* Upload + actions */}
          <div className="rounded-xl border bg-card p-4 flex flex-wrap items-center gap-3">
            <Label htmlFor="recon-file" className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90">
              <Upload className="h-4 w-4" />{parsing ? "جارٍ التحليل..." : "رفع كشوف البنك (متعدد)"}
            </Label>
            <input
              id="recon-file" type="file" className="hidden" disabled={parsing} multiple
              accept=".xlsx,.xls,.csv,.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp"
              onChange={e => {
                const fs = Array.from(e.target.files ?? []);
                if (fs.length > 0) void handleFiles(fs);
                e.currentTarget.value = "";
              }}
            />
            <p className="text-xs text-muted-foreground">يمكن رفع أكثر من ملف معاً • Excel / CSV / PDF / Word / صور (PNG, JPG) — الصور تُقرأ بالـ OCR</p>
            {statementLabel && (
              <span className="text-xs px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                <CheckCircle2 className="h-3 w-3 inline ms-1" />{statementLabel}
              </span>
            )}
            <div className="ms-auto flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={autoMatch} disabled={bookTxns.length === 0 || bankTxns.length === 0} className="gap-2">
                <Link2 className="h-4 w-4" />مطابقة تلقائية
              </Button>
              <Button
                size="sm"
                onClick={aiMatch}
                disabled={bookTxns.length === 0 || bankTxns.length === 0 || aiMatching}
                className="gap-2 bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-700 hover:to-fuchsia-700 text-white border-0"
              >
                <Sparkles className="h-4 w-4" />{aiMatching ? "تحليل ذكي..." : "مطابقة ذكية (AI)"}
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

          {/* Professional bank reconciliation statement */}
          {bankTxns.length > 0 && (
            <div className="rounded-xl border-2 border-slate-200 bg-white p-5 space-y-4">
              <div className="flex items-center justify-between gap-2 border-b pb-3">
                <div>
                  <h3 className="text-base font-bold">مذكرة التسوية البنكية</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {bank?.nameAr ?? chartAcc?.nameAr ?? ""} • {applied.from} → {applied.to}
                  </p>
                </div>
                <div className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${moneyEq(trueDifference, 0) ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200"}`}>
                  {moneyEq(trueDifference, 0) ? "متوازنة ✓" : `فرق غير مفسَّر: ${fmt(trueDifference)}`}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Per Books (Chart of Accounts) */}
                <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-4 space-y-2">
                  <p className="text-xs font-bold text-blue-900 mb-2 pb-1 border-b border-blue-200">
                    وفقاً للدفاتر (شجرة الحسابات)
                  </p>
                  <div className="flex items-center justify-between text-xs">
                    <span>الرصيد الإقفالي حسب الدفاتر</span>
                    <span className="tabular-nums font-bold">{fmt(bookClosing)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-emerald-700">
                    <span className="flex items-center gap-1">+ إيداعات بالكشف لم تُسجَّل دفترياً
                      {unmatchedBank.filter(t => t.debit > 0).length > 0 && <span className="text-[10px] text-muted-foreground">({unmatchedBank.filter(t => t.debit > 0).length} حركة)</span>}
                    </span>
                    <span className="tabular-nums">{fmt(unBankDeposits)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-rose-700">
                    <span className="flex items-center gap-1">− مسحوبات بالكشف لم تُسجَّل دفترياً
                      {unmatchedBank.filter(t => t.credit > 0).length > 0 && <span className="text-[10px] text-muted-foreground">({unmatchedBank.filter(t => t.credit > 0).length} حركة)</span>}
                    </span>
                    <span className="tabular-nums">{fmt(unBankWithdrawals)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm pt-2 border-t border-blue-200 font-bold">
                    <span>الرصيد الدفتري المعدّل</span>
                    <span className="tabular-nums text-blue-900">{fmt(adjustedBookBalance)}</span>
                  </div>
                </div>

                {/* Per Bank Statement */}
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4 space-y-2">
                  <p className="text-xs font-bold text-emerald-900 mb-2 pb-1 border-b border-emerald-200">
                    وفقاً لكشف البنك
                  </p>
                  <div className="flex items-center justify-between text-xs">
                    <span>الرصيد الإقفالي حسب الكشف</span>
                    <span className="tabular-nums font-bold">{fmt(bankClosing)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-emerald-700">
                    <span className="flex items-center gap-1">+ إيداعات دفترية لم تظهر بالكشف
                      {unmatchedBook.filter(t => t.debit > 0).length > 0 && <span className="text-[10px] text-muted-foreground">({unmatchedBook.filter(t => t.debit > 0).length} حركة)</span>}
                    </span>
                    <span className="tabular-nums">{fmt(unBookDeposits)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-rose-700">
                    <span className="flex items-center gap-1">− شيكات/مسحوبات دفترية لم تظهر بالكشف
                      {unmatchedBook.filter(t => t.credit > 0).length > 0 && <span className="text-[10px] text-muted-foreground">({unmatchedBook.filter(t => t.credit > 0).length} حركة)</span>}
                    </span>
                    <span className="tabular-nums">{fmt(unBookWithdrawals)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm pt-2 border-t border-emerald-200 font-bold">
                    <span>الرصيد البنكي المعدّل</span>
                    <span className="tabular-nums text-emerald-900">{fmt(adjustedBankBalance)}</span>
                  </div>
                </div>
              </div>

              {!moneyEq(trueDifference, 0) && (
                <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-bold mb-1">فرق غير مفسَّر بقيمة {fmt(trueDifference)}</p>
                    <p>الرصيدان المعدّلان لا يتساويان — هذا الفرق لا يفسّره غير المطابق المعروض. أسباب محتملة:</p>
                    <ul className="list-disc ms-5 mt-1 space-y-0.5">
                      <li>رصيد افتتاحي مختلف بين الدفاتر والكشف</li>
                      <li>قيود مكرّرة أو محذوفة في فترة سابقة</li>
                      <li>عمولات/فوائد بنكية لم يَلتقطها مُحلِّل الكشف</li>
                      <li>قيود مرحَّلة بعملة مختلفة وفروقات سعر صرف</li>
                    </ul>
                    <p className="mt-2">جرّب زر <strong>"مطابقة ذكية (AI)"</strong> لتحليل الفروقات تلقائياً.</p>
                  </div>
                </div>
              )}
              {moneyEq(trueDifference, 0) && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-800 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>الرصيدان المعدّلان متطابقان — كل الفروقات مُفسَّرة بحركات معلَّقة وستُسوَّى تلقائياً عند ظهورها في الجانب الآخر.</span>
                </div>
              )}
            </div>
          )}

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

          {/* AI suggestions panel */}
          {aiResult && (
            <div className="rounded-xl border-2 border-violet-200 bg-gradient-to-br from-violet-50 to-fuchsia-50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Brain className="h-5 w-5 text-violet-600" />
                <h3 className="text-sm font-bold text-violet-900">تحليل الذكاء الاصطناعي</h3>
                {aiResult.stats && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 border border-violet-200">
                    {aiResult.stats.totalAccepted} مجموعة • {aiResult.stats.bookMatched} دفتري ↔ {aiResult.stats.bankMatched} بنكي
                  </span>
                )}
              </div>
              {aiResult.summary && (
                <p className="text-xs text-violet-800 bg-white/60 rounded-lg p-2 border border-violet-100">{aiResult.summary}</p>
              )}
              {aiResult.pairs.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-violet-900">مطابقات مقترحة (راجع وأكّد):</p>
                  {aiResult.pairs.map((p, i) => {
                    const conf = p.confidence;
                    const confClass =
                      conf >= 0.8 ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : conf >= 0.6 ? "bg-amber-50 text-amber-700 border-amber-200"
                      : "bg-rose-50 text-rose-700 border-rose-200";
                    return (
                      <div key={i} className="rounded-lg bg-white border border-violet-100 p-3">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${confClass}`}>
                              ثقة {Math.round(conf * 100)}%
                            </span>
                            <span className="text-xs text-muted-foreground">{p.bookIds.length} دفتري ↔ {p.bankIds.length} بنكي</span>
                            <span className="text-xs font-bold tabular-nums text-violet-700">{fmt(p.bookSum)}</span>
                          </div>
                          <Button size="sm" variant="outline" onClick={() => applyAiSuggestion(p)} className="h-6 text-xs gap-1">
                            <CheckCircle2 className="h-3 w-3" />تطبيق
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">{p.reason}</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                          <div className="bg-blue-50/50 rounded p-2 border border-blue-100">
                            <p className="font-semibold text-blue-900 mb-1">الدفتري:</p>
                            {p.bookIds.map(id => {
                              const t = bookTxns.find(x => x.id === id);
                              return t ? <div key={id} className="truncate">{t.date} • {t.description.slice(0, 50)} • <span className="tabular-nums font-bold">{fmt(t.debit - t.credit)}</span></div> : null;
                            })}
                          </div>
                          <div className="bg-emerald-50/50 rounded p-2 border border-emerald-100">
                            <p className="font-semibold text-emerald-900 mb-1">البنكي:</p>
                            {p.bankIds.map(id => {
                              const t = bankTxns.find(x => x.id === id);
                              return t ? <div key={id} className="truncate">{t.date} • {t.description.slice(0, 50)} • <span className="tabular-nums font-bold">{fmt(t.debit - t.credit)}</span></div> : null;
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {aiResult.unmatchedAnalysis.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-rose-900">حركات بدون مطابق — تحليل الفروقات:</p>
                  <div className="rounded-lg bg-white border border-rose-100 divide-y max-h-72 overflow-y-auto">
                    {aiResult.unmatchedAnalysis.map((u, i) => {
                      const t = u.side === "book" ? bookTxns.find(x => x.id === u.id) : bankTxns.find(x => x.id === u.id);
                      return (
                        <div key={i} className="p-2 text-[11px] flex items-start gap-2">
                          <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded ${u.side === "book" ? "bg-blue-100 text-blue-700" : "bg-emerald-100 text-emerald-700"}`}>
                            {u.side === "book" ? "دفتري" : "بنكي"}
                          </span>
                          <div className="flex-1 min-w-0">
                            {t && <div className="truncate font-medium">{t.date} • {t.description.slice(0, 60)} • <span className="tabular-nums">{fmt(t.debit - t.credit)}</span></div>}
                            <div className="text-muted-foreground mt-0.5">{u.likelyExplanation}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {aiResult.pairs.length === 0 && aiResult.unmatchedAnalysis.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-3">لم يجد الذكاء الاصطناعي أي مطابقات إضافية موثوقة</p>
              )}
            </div>
          )}

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

      {!hasSelection && (
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
          {/* Totals footer — sum of debit (وارد) and credit (صادر) for
              every row in this pane. Useful especially on the bank-statement
              side so the user can immediately see إجمالي المدين / الدائن
              without exporting. Hidden while loading or when empty. */}
          {!loading && rows.length > 0 && (() => {
            const totalDebit  = rows.reduce((s, t) => s + Number(t.debit  || 0), 0);
            const totalCredit = rows.reduce((s, t) => s + Number(t.credit || 0), 0);
            return (
              <tfoot className="bg-muted/50 border-t-2 sticky bottom-0">
                <tr className="font-bold">
                  <td colSpan={3} className="px-2 py-2 text-right">الإجمالي</td>
                  <td className="px-2 py-2 text-center tabular-nums text-emerald-700">{fmt(totalDebit)}</td>
                  <td className="px-2 py-2 text-center tabular-nums text-rose-700">{fmt(totalCredit)}</td>
                  <td className="px-2 py-2 text-center text-[10px] text-muted-foreground">
                    صافي<br/><span className="tabular-nums">{fmt(totalDebit - totalCredit)}</span>
                  </td>
                </tr>
              </tfoot>
            );
          })()}
        </table>
      </div>
    </div>
  );
}
