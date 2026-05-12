import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useFormatters } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { branchesApi } from "@/lib/branchesApi";
import {
  Save, Upload, Download, ScrollText, Search,
  AlertTriangle, CheckCircle2, FileSpreadsheet, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as XLSX from "xlsx";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const TYPE_BADGES: Record<string, string> = {
  asset:     "bg-blue-50 text-blue-700 border-blue-200",
  liability: "bg-red-50 text-red-700 border-red-200",
  equity:    "bg-purple-50 text-purple-700 border-purple-200",
  revenue:   "bg-green-50 text-green-700 border-green-200",
  expense:   "bg-orange-50 text-orange-700 border-orange-200",
};

type Account = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  accountType: keyof typeof TYPE_BADGES;
  isPosting: boolean;
  isActive: boolean;
};

type Amount = { debit: string; credit: string };

function todayIsoStartOfYear(): string {
  const d = new Date();
  return `${d.getFullYear()}-01-01`;
}

function num(v: string | number | undefined | null): number {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export default function OpeningBalances() {
  const { user, token } = useAuth() as any;
  const { t } = useTranslation();
  const { fmt, isRtl } = useFormatters();
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [entryDate, setEntryDate]       = useState<string>(todayIsoStartOfYear());
  const [description, setDescription]   = useState<string>(t("openingBalances.defaultDesc", { year: new Date().getFullYear() }));
  const [branchId, setBranchId]         = useState<string>("");
  const [search, setSearch]             = useState("");
  const [filterType, setFilterType]     = useState<string>("all");
  const [amounts, setAmounts]           = useState<Record<number, Amount>>({});
  const [isExporting, setIsExporting]   = useState(false);

  // Load branches for the current company so the opening JE can be tied to a
  // specific branch. Without this, Trial Balance / Account Statement filtered
  // by branch will exclude the opening entry entirely.
  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: () => branchesApi.getBranches(cid),
    enabled: !!user && !!cid,
  });

  // Default to the company's main branch (or first available) the first time
  // branches load, so the user does not accidentally save a branch-less entry.
  const branchDefaultedRef = useRef(false);
  useEffect(() => {
    if (branchDefaultedRef.current || branchId) return;
    const def = (branches as any[]).find((b: any) => b.isMain) ?? (branches as any[])[0];
    if (def?.id) {
      setBranchId(String(def.id));
      branchDefaultedRef.current = true;
    }
  }, [branches, branchId]);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data: accounts = [], isLoading } = useQuery<Account[]>({
    queryKey: ["accounts", cid, "opening"],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    },
    enabled: !!user,
  });

  // Only leaf, posting, active accounts can hold an opening balance.
  const postableAccounts = useMemo(
    () => accounts.filter(a => a.isPosting && a.isActive),
    [accounts]
  );

  const codeIndex = useMemo(() => {
    const m = new Map<string, Account>();
    for (const a of postableAccounts) m.set(String(a.code).trim(), a);
    return m;
  }, [postableAccounts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return postableAccounts
      .filter(a => filterType === "all" || a.accountType === filterType)
      .filter(a =>
        !q ||
        a.code.toLowerCase().includes(q) ||
        a.nameAr.includes(search) ||
        (a.nameEn ?? "").toLowerCase().includes(q)
      )
      .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
  }, [postableAccounts, filterType, search]);

  const totals = useMemo(() => {
    let debit = 0, credit = 0, filledRows = 0;
    for (const a of postableAccounts) {
      const row = amounts[a.id];
      if (!row) continue;
      const d = num(row.debit), c = num(row.credit);
      if (d > 0 || c > 0) filledRows++;
      debit  += d;
      credit += c;
    }
    const diff = debit - credit;
    return { debit, credit, diff, filledRows, balanced: Math.abs(diff) < 0.005 && (debit + credit) > 0 };
  }, [amounts, postableAccounts]);

  function setAmount(id: number, side: "debit" | "credit", value: string) {
    // Allow only digits, dot, comma, minus
    const cleaned = value.replace(/[^\d.,-]/g, "");
    setAmounts(prev => {
      const current = prev[id] ?? { debit: "", credit: "" };
      // Setting one side clears the other so a row holds only debit OR credit.
      return {
        ...prev,
        [id]: side === "debit"
          ? { debit: cleaned, credit: "" }
          : { debit: "", credit: cleaned },
      };
    });
  }

  function clearAll() {
    if (totals.filledRows === 0) return;
    if (!window.confirm(t("openingBalances.confirmClear"))) return;
    setAmounts({});
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────
  // When `includeAmounts=true`, the export must reflect the REAL cumulative
  // balances posted up to `entryDate` — not whatever the user happens to have
  // typed into the on-screen form (which is empty on a fresh page load and
  // would otherwise produce an empty file). We pull the trial-balance from
  // the server with `toDate=entryDate` (no fromDate, so movements are
  // cumulative since inception) and use its signed `balance` per account
  // (debit − credit) to fill the right column. Branch filter is applied when
  // an opening branch is selected so the export matches the same scope the
  // user would post the JE under.
  async function exportXlsx(includeAmounts: boolean) {
    if (isExporting) return;
    let serverBalances: Record<number, { debit: number; credit: number }> = {};
    if (includeAmounts) {
      setIsExporting(true);
      try {
        const params = new URLSearchParams();
        if (cid) params.set("companyId", String(cid));
        if (entryDate) params.set("toDate", entryDate);
        if (branchId) params.set("branchId", branchId);
        const res = await fetch(`${API}/api/accounting-reports/trial-balance?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const rows = await res.json() as Array<{ accountId: number; balance: number }>;
          for (const r of rows) {
            const bal = Number(r.balance) || 0;
            // Positive net = debit side; negative = credit side. Tiny
            // residuals (< 0.005) round to zero so we don't pollute the
            // sheet with noise like "0.0000001".
            if (Math.abs(bal) < 0.005) continue;
            serverBalances[r.accountId] = bal > 0
              ? { debit: bal,  credit: 0 }
              : { debit: 0,    credit: -bal };
          }
        } else {
          toast({
            title: t("openingBalances.exportFailed"),
            description: await res.text(),
            variant: "destructive",
          });
          setIsExporting(false);
          return;
        }
      } catch (err: any) {
        toast({
          title: t("openingBalances.exportFailed"),
          description: err?.message ?? String(err),
          variant: "destructive",
        });
        setIsExporting(false);
        return;
      } finally {
        setIsExporting(false);
      }
    }

    const aoa: any[][] = [[
      "code",
      "nameAr",
      "nameEn",
      "accountType",
      "debit",
      "credit",
    ]];
    for (const a of postableAccounts.sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }))) {
      // Prefer what the user typed on screen (mid-edit values), fall back to
      // the server-side cumulative balance for that account. This way the
      // export reflects in-flight edits PLUS any pre-existing posted balances.
      const typed = amounts[a.id];
      const typedDebit  = num(typed?.debit);
      const typedCredit = num(typed?.credit);
      const fromServer  = serverBalances[a.id] ?? { debit: 0, credit: 0 };
      const d = includeAmounts ? (typedDebit  || fromServer.debit)  : 0;
      const c = includeAmounts ? (typedCredit || fromServer.credit) : 0;
      aoa.push([
        a.code,
        a.nameAr,
        a.nameEn ?? "",
        t(`chartOfAccounts.type${a.accountType.charAt(0).toUpperCase() + a.accountType.slice(1)}`),
        d > 0 ? d : "",
        c > 0 ? c : "",
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 14 }, { wch: 38 }, { wch: 32 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Opening Balances");

    const help = XLSX.utils.aoa_to_sheet([
      [t("openingBalances.help.title")],
      [""],
      [t("openingBalances.help.l1")],
      [t("openingBalances.help.l2")],
      [t("openingBalances.help.l3")],
      [t("openingBalances.help.l4")],
      [t("openingBalances.help.l5")],
      [t("openingBalances.help.l6")],
    ]);
    help["!cols"] = [{ wch: 80 }];
    XLSX.utils.book_append_sheet(wb, help, "تعليمات");

    const fname = includeAmounts
      ? `opening-balances-${entryDate || new Date().toISOString().slice(0, 10)}.xlsx`
      : `opening-balances-template.xlsx`;
    XLSX.writeFile(wb, fname);
  }

  // ── IMPORT ────────────────────────────────────────────────────────────────
  function triggerImport() { fileInputRef.current?.click(); }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb  = XLSX.read(buf, { type: "array" });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });

      const TYPE_ALIASES: Record<string, Account["accountType"]> = {
        asset: "asset", assets: "asset", "أصول": "asset", "اصول": "asset",
        liability: "liability", liabilities: "liability", "خصوم": "liability", "التزامات": "liability",
        equity: "equity", "حقوق ملكية": "equity", "حقوق الملكية": "equity",
        revenue: "revenue", income: "revenue", "إيرادات": "revenue", "ايرادات": "revenue", "دخل": "revenue",
        expense: "expense", expenses: "expense", "مصروفات": "expense", "مصاريف": "expense",
      };

      let matched = 0, unmatched = 0, created = 0, createFailed = 0;
      const next: Record<number, Amount> = { ...amounts };
      const localIndex = new Map(codeIndex);
      const errors: string[] = [];

      for (const row of json) {
        // Try common header names (Arabic + English)
        const code   = String(row.code ?? row.Code ?? row["كود الحساب"] ?? row["الكود"] ?? "").trim();
        const debit  = num(row.debit  ?? row.Debit  ?? row["مدين"]);
        const credit = num(row.credit ?? row.Credit ?? row["دائن"]);
        if (!code) continue;

        let acc = localIndex.get(code);

        // ── Auto-create missing account in chart of accounts ────────────────
        if (!acc) {
          const nameAr = String(row.nameAr ?? row["الاسم"] ?? row["الاسم العربي"] ?? row["اسم الحساب"] ?? "").trim();
          const nameEn = String(row.nameEn ?? row["Name"] ?? row["Name En"] ?? row["English Name"] ?? "").trim();
          const typeRaw = String(row.accountType ?? row.type ?? row["النوع"] ?? row["نوع الحساب"] ?? "").trim().toLowerCase();
          const accountType = TYPE_ALIASES[typeRaw];

          if (!nameAr || !accountType) {
            unmatched++;
            errors.push(`${code}: ${t("openingBalances.missingNameOrType")}`);
            continue;
          }

          try {
            const createRes = await fetch(`${API}/api/accounts${cid ? `?companyId=${cid}` : ""}`, {
              method: "POST", headers,
              body: JSON.stringify({
                code, nameAr, nameEn: nameEn || null,
                accountType, parentId: null, level: 1,
                isPosting: true, isActive: true,
              }),
            });
            const createJson = await createRes.json();
            if (!createRes.ok) {
              createFailed++;
              errors.push(`${code}: ${createJson?.error || createRes.statusText}`);
              continue;
            }
            acc = {
              id: createJson.id,
              code: createJson.code,
              nameAr: createJson.nameAr,
              nameEn: createJson.nameEn,
              accountType: createJson.accountType,
              isPosting: true,
              isActive: true,
            };
            localIndex.set(code, acc);
            created++;
          } catch (err: any) {
            createFailed++;
            errors.push(`${code}: ${err?.message || "create failed"}`);
            continue;
          }
        }

        if (debit > 0) next[acc.id] = { debit: String(debit),  credit: "" };
        else if (credit > 0) next[acc.id] = { debit: "", credit: String(credit) };
        else next[acc.id] = { debit: "", credit: "" };
        matched++;
      }
      setAmounts(next);
      // Refresh chart of accounts cache so newly created rows show up
      if (created > 0) {
        await qc.invalidateQueries({ queryKey: ["accounts", cid, "opening"] });
        await qc.invalidateQueries({ queryKey: ["accounts"] });
      }
      toast({
        title: t("openingBalances.importDone"),
        description: t("openingBalances.importStatsV2", { matched, created, unmatched: unmatched + createFailed }),
      });
      if (errors.length > 0) {
        // eslint-disable-next-line no-console
        console.warn("[OpeningBalances import] issues:", errors);
      }
    } catch (err: any) {
      toast({ title: t("openingBalances.importFailed"), description: err?.message, variant: "destructive" });
    }
  }

  // ── SAVE (creates one journal entry) ──────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: async () => {
      const lines: any[] = [];
      for (const a of postableAccounts) {
        const row = amounts[a.id];
        if (!row) continue;
        const d = num(row.debit), c = num(row.credit);
        if (d <= 0 && c <= 0) continue;
        lines.push({
          accountId: a.id,
          debit:     d > 0 ? d.toFixed(2) : "0",
          credit:    c > 0 ? c.toFixed(2) : "0",
          description: t("openingBalances.lineMemo", { code: a.code, name: a.nameAr }),
        });
      }
      if (lines.length < 2) throw new Error(t("openingBalances.errAtLeastTwo"));
      // Allow saving even if not balanced — warn the user once.
      const totalD = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
      const totalC = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
      const diff   = totalD - totalC;
      if (Math.abs(diff) > 0.005) {
        const proceed = window.confirm(
          t("openingBalances.confirmUnbalanced", { diff: diff.toFixed(2) }),
        );
        if (!proceed) throw new Error(t("openingBalances.cancelledByUser"));
      }
      const payload: any = {
        entryDate,
        description: description || t("openingBalances.defaultDesc", { year: new Date(entryDate).getFullYear() }),
        entryType: "opening",
        branchId: branchId ? Number(branchId) : null,
        lines,
      };
      const res = await fetch(`${API}/api/journal-entries`, {
        method: "POST", headers, body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("openingBalances.saveFailed"));
      return json;
    },
    onSuccess: (entry) => {
      toast({
        title: t("openingBalances.savedTitle"),
        description: t("openingBalances.savedDesc", { docNumber: entry.docNumber ?? "—" }),
      });
      qc.invalidateQueries({ queryKey: ["accounts-balances"] });
      qc.invalidateQueries({ queryKey: ["journal-entries"] });
      setAmounts({});
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const ACCOUNT_TYPES = [
    { value: "asset",     label: t("chartOfAccounts.typeAsset") },
    { value: "liability", label: t("chartOfAccounts.typeLiability") },
    { value: "equity",    label: t("chartOfAccounts.typeEquity") },
    { value: "revenue",   label: t("chartOfAccounts.typeRevenue") },
    { value: "expense",   label: t("chartOfAccounts.typeExpense") },
  ];

  const balancedNow = totals.balanced && totals.filledRows >= 2;
  const canSave     = totals.filledRows >= 2;

  return (
    <div className="space-y-6 pb-44">
      <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} />

      {/* Hero header */}
      <div className="rounded-2xl border bg-gradient-to-br from-indigo-50 via-violet-50 to-fuchsia-50 dark:from-indigo-950/30 dark:via-violet-950/20 dark:to-fuchsia-950/30 p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-indigo-100 dark:bg-indigo-900/40 p-3 ring-1 ring-indigo-200/60">
              <ScrollText className="h-7 w-7 text-indigo-600 dark:text-indigo-300" />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                {t("openingBalances.title")}
                <Sparkles className="h-5 w-5 text-amber-500" />
              </h1>
              <p className="text-muted-foreground text-sm mt-1 max-w-2xl">{t("openingBalances.subtitle")}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" className="gap-2" onClick={() => exportXlsx(false)}>
              <FileSpreadsheet className="h-4 w-4" /> {t("openingBalances.downloadTemplate")}
            </Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => exportXlsx(true)} disabled={isExporting}>
              <Download className={cn("h-4 w-4", isExporting && "animate-pulse")} />
              {isExporting ? t("openingBalances.exporting") : t("openingBalances.exportCurrent")}
            </Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={triggerImport}>
              <Upload className="h-4 w-4" /> {t("openingBalances.import")}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-5">
          <div>
            <label className="text-xs text-muted-foreground font-medium">{t("openingBalances.entryDate")}</label>
            <Input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} className="mt-1" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-medium">{t("openingBalances.branch")}</label>
            <Select value={branchId || "__none"} onValueChange={(v) => setBranchId(v === "__none" ? "" : v)}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={t("openingBalances.branchPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">— {t("openingBalances.noBranch")} —</SelectItem>
                {(branches as any[]).map((b: any) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {isRtl ? (b.nameAr || b.nameEn) : (b.nameEn || b.nameAr)}
                    {b.isMain ? ` ★` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-muted-foreground font-medium">{t("openingBalances.description")}</label>
            <Input value={description} onChange={e => setDescription(e.target.value)} className="mt-1" placeholder={t("openingBalances.descPlaceholder")} />
          </div>
        </div>
        {!branchId && (branches as any[]).length > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{t("openingBalances.branchWarning")}</span>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <Search className={cn("absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground", isRtl ? "right-3" : "left-3")} />
          <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={t("openingBalances.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <button
          onClick={() => setFilterType("all")}
          className={cn("text-xs rounded-full px-3 py-1 border font-medium",
            filterType === "all" ? "bg-primary text-primary-foreground border-primary" : "border-input bg-background hover:bg-muted"
          )}
        >
          {t("common.all")} ({postableAccounts.length})
        </button>
        {ACCOUNT_TYPES.map(tt => {
          const cnt = postableAccounts.filter(a => a.accountType === tt.value).length;
          if (cnt === 0) return null;
          return (
            <button
              key={tt.value}
              onClick={() => setFilterType(tt.value)}
              className={cn("text-xs rounded-full px-3 py-1 border font-medium",
                filterType === tt.value ? "bg-primary text-primary-foreground border-primary" : "border-input bg-background hover:bg-muted"
              )}
            >
              {tt.label} ({cnt})
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b sticky top-0 z-10">
            <tr>
              <th className="px-3 py-2.5 text-start font-semibold text-muted-foreground w-24">{t("openingBalances.col.code")}</th>
              <th className="px-3 py-2.5 text-start font-semibold text-muted-foreground">{t("openingBalances.col.nameAr")}</th>
              <th className="px-3 py-2.5 text-center font-semibold text-muted-foreground w-32 hidden md:table-cell">{t("openingBalances.col.type")}</th>
              <th className="px-3 py-2.5 text-center font-semibold text-muted-foreground w-44">{t("openingBalances.col.debit")}</th>
              <th className="px-3 py-2.5 text-center font-semibold text-muted-foreground w-44">{t("openingBalances.col.credit")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(8)].map((_, i) => (
                  <tr key={i}><td colSpan={5} className="px-3 py-3"><Skeleton className="h-7 w-full" /></td></tr>
                ))
              : filtered.length === 0
              ? (
                <tr>
                  <td colSpan={5} className="px-3 py-12 text-center text-muted-foreground">
                    <ScrollText className="h-10 w-10 mx-auto mb-2 opacity-20" />
                    <p className="font-medium">{t("openingBalances.empty")}</p>
                    <p className="text-xs mt-1">{t("openingBalances.emptyHint")}</p>
                  </td>
                </tr>
              )
              : filtered.map(a => {
                  const row = amounts[a.id] ?? { debit: "", credit: "" };
                  const hasValue = num(row.debit) > 0 || num(row.credit) > 0;
                  return (
                    <tr key={a.id} className={cn("hover:bg-muted/30 transition-colors", hasValue && "bg-emerald-50/40 dark:bg-emerald-950/15")}>
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded border">{a.code}</span>
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-medium text-sm">{isRtl ? a.nameAr : (a.nameEn || a.nameAr)}</p>
                        {a.nameEn && isRtl && <p className="text-[10px] text-muted-foreground" dir="ltr">{a.nameEn}</p>}
                      </td>
                      <td className="px-3 py-2 text-center hidden md:table-cell">
                        <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5 border", TYPE_BADGES[a.accountType])}>
                          {t(`chartOfAccounts.type${a.accountType.charAt(0).toUpperCase() + a.accountType.slice(1)}`)}
                        </span>
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          dir="ltr"
                          inputMode="decimal"
                          value={row.debit}
                          onChange={e => setAmount(a.id, "debit", e.target.value)}
                          className={cn("text-end tabular-nums font-mono h-8", num(row.debit) > 0 && "border-emerald-400 bg-emerald-50/60 dark:bg-emerald-950/20")}
                          placeholder="0.00"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          dir="ltr"
                          inputMode="decimal"
                          value={row.credit}
                          onChange={e => setAmount(a.id, "credit", e.target.value)}
                          className={cn("text-end tabular-nums font-mono h-8", num(row.credit) > 0 && "border-rose-400 bg-rose-50/60 dark:bg-rose-950/20")}
                          placeholder="0.00"
                        />
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && (
          <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground flex justify-between">
            <span>{t("openingBalances.showingAccounts", { count: filtered.length, total: postableAccounts.length })}</span>
            <span>{t("openingBalances.filledRows", { count: totals.filledRows })}</span>
          </div>
        )}
      </div>

      {/* Sticky totals + save bar */}
      <div className="fixed bottom-0 inset-x-0 z-30 border-t bg-background/95 backdrop-blur-sm shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.18)]">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="rounded-lg border bg-emerald-50/60 dark:bg-emerald-950/20 px-3 py-2 min-w-[150px]">
              <p className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">{t("openingBalances.totalDebit")}</p>
              <p className="font-mono font-bold text-emerald-700 dark:text-emerald-300 tabular-nums" dir="ltr">{fmt(totals.debit)}</p>
            </div>
            <div className="rounded-lg border bg-rose-50/60 dark:bg-rose-950/20 px-3 py-2 min-w-[150px]">
              <p className="text-[10px] font-medium text-rose-700 dark:text-rose-300">{t("openingBalances.totalCredit")}</p>
              <p className="font-mono font-bold text-rose-700 dark:text-rose-300 tabular-nums" dir="ltr">{fmt(totals.credit)}</p>
            </div>
            <div className={cn(
              "rounded-lg border px-3 py-2 min-w-[170px] flex items-center gap-2",
              balancedNow
                ? "bg-emerald-50 border-emerald-300 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
                : Math.abs(totals.diff) > 0.005
                ? "bg-amber-50 border-amber-300 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                : "bg-muted text-muted-foreground"
            )}>
              {balancedNow
                ? <CheckCircle2 className="h-4 w-4" />
                : <AlertTriangle className="h-4 w-4" />}
              <div>
                <p className="text-[10px] font-medium">{t("openingBalances.difference")}</p>
                <p className="font-mono font-bold tabular-nums" dir="ltr">{fmt(totals.diff)}</p>
              </div>
            </div>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={clearAll} disabled={totals.filledRows === 0}>
              {t("openingBalances.clearAll")}
            </Button>
            <Button
              size="lg"
              className="gap-2"
              onClick={() => saveMut.mutate()}
              disabled={!canSave || saveMut.isPending}
            >
              <Save className="h-4 w-4" />
              {saveMut.isPending ? t("openingBalances.saving") : t("openingBalances.saveEntry")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
