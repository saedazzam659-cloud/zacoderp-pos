import { useState, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { journalEntriesApi } from "@/lib/journalEntriesApi";
import { branchesApi } from "@/lib/branchesApi";
import { AccountCombobox } from "@/components/AccountCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Plus, Trash2, ArrowRight, BookOpen, AlertCircle,
  FileText, ListOrdered, Printer, FileSpreadsheet, FileDown,
} from "lucide-react";
import * as XLSX from "xlsx";

const ENTRY_TYPES = [
  { value: "general",      label: "قيد عام" },
  { value: "opening",      label: "قيد افتتاحي" },
  { value: "closing",      label: "قيد إقفال" },
  { value: "adjustment",   label: "قيد تسوية" },
  { value: "depreciation", label: "قيد إهلاك" },
];

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface JournalLine {
  id:          string;
  accountId:   string;
  costCenter:  string;
  debit:       string;
  credit:      string;
  description: string;
}

function newLine(): JournalLine {
  return { id: crypto.randomUUID(), accountId: "", costCenter: "", debit: "", credit: "", description: "" };
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function JournalEntryForm() {
  const { user } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [, navigate] = useLocation();
  const [matchNew] = useRoute("/accounting/journals/new");
  const [matchEdit, params] = useRoute("/accounting/journals/:id");
  const isNew    = !!matchNew;
  const editId   = matchEdit ? Number((params as any).id) : null;
  const qc       = useQueryClient();
  const { toast } = useToast();

  const [activeTab,    setActiveTab]    = useState(() => {
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get("tab") === "lines") return "lines";
    }
    return "header";
  });
  const [docNumber,    setDocNumber]    = useState("");
  const [entryDate,    setEntryDate]    = useState(today());
  const [currency,     setCurrency]     = useState("SAR");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [description,  setDescription]  = useState("");
  const [entryType,    setEntryType]    = useState("general");
  const [branchId,     setBranchId]     = useState("");
  const [lines,        setLines]        = useState<JournalLine[]>([newLine(), newLine()]);

  const { token } = useAuth() as any;
  const authHeaders = { Authorization: `Bearer ${token}` };

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: () => branchesApi.getBranches(cid),
    enabled: !!user,
  });

  const { data: dbCurrencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/currencies?companyId=${cid}` : `${API}/api/currencies`;
      const res = await fetch(url, { headers: authHeaders });
      return res.json();
    },
    enabled: !!user,
  });

  const { data: exchangeRates = [] } = useQuery<any[]>({
    queryKey: ["exchange-rates", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/currencies/rates?companyId=${cid}` : `${API}/api/currencies/rates`;
      const res = await fetch(url, { headers: authHeaders });
      return res.json();
    },
    enabled: !!user,
  });

  const hasCurrencies = dbCurrencies.length > 0;
  const defaultCurrency = dbCurrencies.find((c: any) => c.isDefault) ?? dbCurrencies[0];

  function getLatestRate(selectedCode: string): string {
    if (!hasCurrencies) return "1";
    const selected = dbCurrencies.find((c: any) => c.code === selectedCode);
    const base     = defaultCurrency;
    if (!selected || !base || selected.id === base.id) return "1";
    const rate = exchangeRates
      .filter((r: any) =>
        (r.fromCurrencyId === selected.id && r.toCurrencyId === base.id) ||
        (r.fromCurrencyId === base.id     && r.toCurrencyId === selected.id)
      )
      .sort((a: any, b: any) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
    if (!rate) return "1";
    if (rate.fromCurrencyId === selected.id) return String(rate.rate);
    return String((1 / Number(rate.rate)).toFixed(6));
  }

  function handleCurrencyChange(code: string) {
    setCurrency(code);
    setExchangeRate(getLatestRate(code));
  }

  useEffect(() => {
    if (!isNew || !hasCurrencies || !defaultCurrency) return;
    setCurrency(defaultCurrency.code);
    setExchangeRate("1");
  }, [isNew, defaultCurrency?.code]);

  const { data: existing, isLoading: loadingEdit } = useQuery({
    queryKey: ["journal-entry", editId],
    queryFn:  () => journalEntriesApi.get(editId!, cid),
    enabled:  !!editId,
  });

  const { data: accountsList = [] } = useQuery<any[]>({
    queryKey: ["accounts-flat", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers: authHeaders });
      return res.json();
    },
    enabled: !!user,
  });
  const acctMap = new Map<number, any>(accountsList.map((a: any) => [a.id, a]));
  const acctLabel = (id: any) => {
    const a = acctMap.get(Number(id));
    return a ? `${a.code} — ${a.nameAr || a.nameEn || ""}` : "—";
  };

  useEffect(() => {
    if (!existing) return;
    setDocNumber(existing.docNumber ?? "");
    setEntryDate(existing.entryDate ?? today());
    setCurrency(existing.currency ?? "SAR");
    setExchangeRate(String(existing.exchangeRate ?? "1"));
    setDescription(existing.description ?? "");
    setEntryType(existing.entryType ?? "general");
    setBranchId(existing.branchId ? String(existing.branchId) : "");
    setLines(
      existing.lines?.length
        ? existing.lines.map((l: any) => ({
            id:          crypto.randomUUID(),
            accountId:   l.accountId ? String(l.accountId) : "",
            costCenter:  l.costCenter ?? "",
            debit:       l.debit  ? String(Number(l.debit))  : "",
            credit:      l.credit ? String(Number(l.credit)) : "",
            description: l.description ?? "",
          }))
        : [newLine(), newLine()]
    );
    const tabParam = new URLSearchParams(window.location.search).get("tab");
    setActiveTab(tabParam === "lines" ? "lines" : "header");
  }, [existing]);

  const totalDebit  = lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const diff        = Math.abs(totalDebit - totalCredit);
  const isBalanced  = diff < 0.001;

  function updateLine(id: string, field: keyof JournalLine, value: string) {
    setLines(prev => prev.map(l => l.id === id ? { ...l, [field]: value } : l));
  }
  function addLine() { setLines(prev => [...prev, newLine()]); }

  // Enter-key navigation between line inputs.
  // Pressing Enter moves focus to the next input marked with [data-enter-nav].
  // If on the last input, a new line is appended and focus jumps to its first cell.
  function handleEnterNav(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const all = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-enter-nav="true"]'));
    const i = all.indexOf(e.currentTarget);
    if (i >= 0 && i + 1 < all.length) {
      all[i + 1].focus();
      all[i + 1].select?.();
    } else if (i === all.length - 1) {
      // Last input on last row → append a new line and focus its first nav input
      addLine();
      setTimeout(() => {
        const after = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-enter-nav="true"]'));
        after[i + 1]?.focus();
      }, 30);
    }
  }
  function removeLine(id: string) {
    if (lines.length <= 2) return;
    setLines(prev => prev.filter(l => l.id !== id));
  }

  const saveMutation = useMutation({
    mutationFn: (data: any) =>
      isNew ? journalEntriesApi.create(data) : journalEntriesApi.update(editId!, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-entries", cid] });
      toast({ title: isNew ? "تم إنشاء القيد بنجاح" : "تم تحديث القيد بنجاح" });
      navigate("/accounting/journals");
    },
    onError: (e: any) => {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    },
  });

  function handleSave() {
    if (!entryDate) {
      toast({ title: "التاريخ مطلوب", variant: "destructive" }); return;
    }
    if (!isBalanced) {
      toast({ title: "القيد غير متوازن", description: `الفرق: ${diff.toFixed(2)}`, variant: "destructive" }); return;
    }
    const validLines = lines.filter(l => l.accountId);
    if (validLines.length < 2) {
      toast({ title: "يجب أن يحتوي القيد على سطرين على الأقل", variant: "destructive" }); return;
    }
    saveMutation.mutate({
      companyId:    cid,
      docNumber:    docNumber || null,
      entryDate,
      currency,
      exchangeRate,
      description:  description || null,
      entryType,
      branchId:     branchId ? Number(branchId) : null,
      lines:        validLines.map(l => ({
        accountId:   l.accountId ? Number(l.accountId) : null,
        costCenter:  l.costCenter || null,
        debit:       l.debit  || "0",
        credit:      l.credit || "0",
        description: l.description || null,
      })),
    });
  }

  const escapeHtml = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

  const printableLines = lines.filter(l => l.accountId);
  const docLabel = existing?.docNumber ?? (editId ? `QYD-${String(editId).padStart(4, "0")}` : "—");
  const typeLabel = ENTRY_TYPES.find(t => t.value === entryType)?.label ?? entryType;
  const branchLabel = branches.find((b: any) => String(b.id) === String(branchId))?.nameAr ?? "—";

  const handleExportEntryExcel = () => {
    const headerRows = [
      ["رقم القيد", docLabel],
      ["التاريخ",   entryDate],
      ["النوع",     typeLabel],
      ["العملة",    `${currency} (سعر الصرف ${exchangeRate})`],
      ["الفرع",     branchLabel],
      ["البيان",    description || "—"],
      [],
    ];
    const lineHeader = ["#", "كود الحساب", "اسم الحساب", "مركز التكلفة", "مدين", "دائن", "البيان"];
    const lineRows = printableLines.map((l, i) => {
      const a = acctMap.get(Number(l.accountId));
      return [
        i + 1,
        a?.code ?? "",
        a?.nameAr || a?.nameEn || "",
        l.costCenter || "",
        Number(l.debit  || 0).toFixed(2),
        Number(l.credit || 0).toFixed(2),
        l.description || "",
      ];
    });
    const totalsRow = ["", "", "", "الإجمالي", totalDebit.toFixed(2), totalCredit.toFixed(2), isBalanced ? "متوازن ✓" : `فرق: ${diff.toFixed(2)}`];
    const aoa = [...headerRows, lineHeader, ...lineRows, totalsRow];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 6 }, { wch: 12 }, { wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 28 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `قيد ${docLabel}`);
    XLSX.writeFile(wb, `journal-entry-${docLabel}.xlsx`);
  };

  const buildEntryPrintHtml = () => {
    const today = new Date().toLocaleDateString("ar-SA");
    const lineRowsHtml = printableLines.map((l, i) => {
      const a = acctMap.get(Number(l.accountId));
      return `<tr>
        <td class="c">${i + 1}</td>
        <td class="num">${escapeHtml(a?.code ?? "")}</td>
        <td>${escapeHtml(a?.nameAr || a?.nameEn || "—")}</td>
        <td>${escapeHtml(l.costCenter || "—")}</td>
        <td class="num">${Number(l.debit  || 0).toFixed(2)}</td>
        <td class="num">${Number(l.credit || 0).toFixed(2)}</td>
        <td>${escapeHtml(l.description || "—")}</td>
      </tr>`;
    }).join("");
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>قيد ${escapeHtml(docLabel)}</title>
<style>
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI","Tahoma","Arial",system-ui,sans-serif; color:#111; margin:0; padding:0; }
.head { text-align:center; border-bottom: 2px solid #1e3a8a; padding-bottom:10px; margin-bottom:12px; }
.head h1 { margin:0 0 4px; font-size:20px; color:#1e3a8a; }
.head .meta { font-size:11px; color:#555; }
.info { display:grid; grid-template-columns: repeat(3, 1fr); gap:6px 14px; font-size:12px; margin-bottom:14px; padding:10px; border:1px solid #e5e7eb; border-radius:6px; background:#fafbfd; }
.info .lbl { color:#6b7280; font-size:10px; }
.info .val { font-weight:600; }
.desc { font-size:12px; padding:8px 10px; border:1px dashed #cbd5e1; border-radius:6px; margin-bottom:12px; }
.desc .lbl { color:#6b7280; font-size:10px; display:block; margin-bottom:2px; }
table { width:100%; border-collapse:collapse; font-size:11px; }
thead th { background:#1e3a8a; color:#fff; padding:6px 8px; border:1px solid #1e3a8a; text-align:right; font-weight:600; }
tbody td { padding:6px 8px; border:1px solid #d1d5db; text-align:right; vertical-align: middle; }
tbody tr:nth-child(even) td { background:#f5f7fb; }
.c { text-align:center; }
.num { font-family:"Consolas",monospace; }
tfoot td { background:#eef2ff; font-weight:700; padding:8px; border:1px solid #1e3a8a; }
.balanced { color:#15803d; }
.unbalanced { color:#b91c1c; }
.print-btn { position:fixed; top:10px; left:10px; padding:8px 14px; background:#1e3a8a; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:12px; }
@media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">طباعة / حفظ PDF</button>
<div class="head">
  <h1>قيد محاسبي — ${escapeHtml(docLabel)}</h1>
  <div class="meta">طُبع في ${today}</div>
</div>
<div class="info">
  <div><div class="lbl">رقم القيد</div><div class="val">${escapeHtml(docLabel)}</div></div>
  <div><div class="lbl">التاريخ</div><div class="val">${escapeHtml(entryDate)}</div></div>
  <div><div class="lbl">النوع</div><div class="val">${escapeHtml(typeLabel)}</div></div>
  <div><div class="lbl">العملة</div><div class="val">${escapeHtml(currency)} (سعر الصرف ${escapeHtml(exchangeRate)})</div></div>
  <div><div class="lbl">الفرع</div><div class="val">${escapeHtml(branchLabel)}</div></div>
  <div><div class="lbl">عدد السطور</div><div class="val">${printableLines.length}</div></div>
</div>
${description ? `<div class="desc"><span class="lbl">البيان العام</span>${escapeHtml(description)}</div>` : ""}
<table>
  <thead><tr>
    <th class="c">#</th><th>كود الحساب</th><th>اسم الحساب</th><th>مركز التكلفة</th><th>مدين</th><th>دائن</th><th>البيان</th>
  </tr></thead>
  <tbody>${lineRowsHtml}</tbody>
  <tfoot><tr>
    <td colspan="4" class="c">الإجمالي</td>
    <td class="num">${totalDebit.toFixed(2)}</td>
    <td class="num">${totalCredit.toFixed(2)}</td>
    <td class="${isBalanced ? "balanced" : "unbalanced"}">${isBalanced ? "متوازن ✓" : `فرق: ${diff.toFixed(2)}`}</td>
  </tr></tfoot>
</table>
<script>setTimeout(()=>window.print(),300);</script>
</body></html>`;
  };

  const openEntryPrintWindow = () => {
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) return;
    w.document.open(); w.document.write(buildEntryPrintHtml()); w.document.close();
  };

  if (!isNew && loadingEdit) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">جارٍ التحميل...</div>;
  }

  return (
    <div className="p-6 space-y-5 max-w-5xl mx-auto" dir="rtl">

      {/* ─── Page title ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/accounting/journals")} className="h-8 w-8">
            <ArrowRight className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
              <BookOpen className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-bold">{isNew ? "قيد جديد" : "تعديل القيد"}</h1>
              <p className="text-xs text-muted-foreground">
                {isNew ? "إنشاء قيد يومية جديد" : `تعديل القيد رقم ${existing?.docNumber ?? editId}`}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isNew && (
            <>
              <Button variant="outline" size="sm" onClick={openEntryPrintWindow} className="gap-1.5 print:hidden">
                <Printer className="h-4 w-4" /> طباعة
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportEntryExcel} className="gap-1.5 text-green-700 border-green-200 hover:bg-green-50 print:hidden">
                <FileSpreadsheet className="h-4 w-4" /> Excel
              </Button>
              <Button variant="outline" size="sm" onClick={openEntryPrintWindow} className="gap-1.5 text-red-700 border-red-200 hover:bg-red-50 print:hidden">
                <FileDown className="h-4 w-4" /> PDF
              </Button>
            </>
          )}
        </div>

        {/* Balance indicator in header */}
        {activeTab === "lines" && (
          <div className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border",
            isBalanced
              ? "bg-green-50 text-green-700 border-green-200"
              : "bg-red-50 text-red-700 border-red-200"
          )}>
            {!isBalanced && <AlertCircle className="h-3.5 w-3.5" />}
            {isBalanced ? "القيد متوازن ✓" : `فرق: ${diff.toFixed(2)}`}
          </div>
        )}
      </div>

      {/* ─── Tabs ───────────────────────────────────────────────── */}
      <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl">

        {/* Tab headers */}
        <Card className="border-2">
          <CardHeader className="p-0">
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/20">
              {/* Left: context hint */}
              <p className="text-[11px] text-muted-foreground">
                {activeTab === "header"
                  ? "أدخل بيانات الرأسية ثم انتقل إلى سطور القيد"
                  : `${lines.filter(l => l.accountId).length} سطر — مدين: ${totalDebit.toFixed(2)} | دائن: ${totalCredit.toFixed(2)}`}
              </p>

              {/* Right: tabs */}
              <TabsList className="h-8 bg-background border gap-1">
                <TabsTrigger
                  value="header"
                  className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  <FileText className="h-3.5 w-3.5" />
                  البيانات الرأسية
                </TabsTrigger>
                <TabsTrigger
                  value="lines"
                  className="h-7 px-3 text-xs gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  <ListOrdered className="h-3.5 w-3.5" />
                  سطور القيد
                  {lines.filter(l => l.accountId).length > 0 && (
                    <span className="mr-1 bg-primary-foreground/20 text-current rounded-full px-1.5 py-0 text-[10px] font-bold">
                      {lines.filter(l => l.accountId).length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>
          </CardHeader>

          {/* ── Tab 1: Header data ────────────────────────── */}
          <TabsContent value="header" className="mt-0">
            <CardContent className="pt-5 pb-5">
              {/* Row 1 */}
              <div className="grid grid-cols-3 gap-4 mb-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">رقم المستند</Label>
                  <Input
                    value={docNumber}
                    onChange={e => setDocNumber(e.target.value)}
                    placeholder="تلقائي"
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    التاريخ <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    type="date"
                    value={entryDate}
                    onChange={e => setEntryDate(e.target.value)}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">العملة</Label>
                  <Select value={currency} onValueChange={handleCurrencyChange}>
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {hasCurrencies
                        ? dbCurrencies
                            .filter((c: any) => c.isActive)
                            .map((c: any) => (
                              <SelectItem key={c.code} value={c.code}>
                                {c.symbol ? `${c.symbol} ` : ""}{c.nameAr} ({c.code})
                                {c.isDefault ? " ★" : ""}
                              </SelectItem>
                            ))
                        : <SelectItem value="SAR">ريال سعودي (SAR)</SelectItem>
                      }
                    </SelectContent>
                  </Select>
                  {!hasCurrencies && (
                    <p className="text-[10px] text-amber-600 mt-0.5">
                      أضف عملات من شاشة العملات لتظهر هنا
                    </p>
                  )}
                </div>
              </div>

              {/* Row 2 */}
              <div className="grid grid-cols-3 gap-4 mb-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">سعر الصرف</Label>
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={exchangeRate}
                    onChange={e => {
                      const v = e.target.value.replace(/[^0-9.]/g, "").replace(/^(\d*\.?\d*).*/, "$1");
                      setExchangeRate(v);
                    }}
                    className="h-9 text-sm"
                    dir="ltr"
                  />
                  {hasCurrencies && currency && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      1 {currency} = {Number(exchangeRate) > 0 ? (1 / Number(exchangeRate)).toFixed(4) : "—"} {defaultCurrency?.code ?? "SAR"}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">النوع</Label>
                  <Select value={entryType} onValueChange={setEntryType}>
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ENTRY_TYPES.map(t => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">الفرع</Label>
                  <Select
                    value={branchId || "__none"}
                    onValueChange={v => setBranchId(v === "__none" ? "" : v)}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue placeholder="— اختر الفرع —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">— بدون فرع —</SelectItem>
                      {branches.map((b: any) => (
                        <SelectItem key={b.id} value={String(b.id)}>{b.nameAr}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Row 3 – description */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">البيان العام</Label>
                <Textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="وصف القيد..."
                  className="text-sm resize-none"
                  rows={2}
                />
              </div>

              {/* Next button */}
              <div className="mt-5 flex justify-start">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setActiveTab("lines")}
                  className="gap-2 text-sm"
                >
                  <ListOrdered className="h-4 w-4" />
                  التالي: سطور القيد
                </Button>
              </div>
            </CardContent>
          </TabsContent>

          {/* ── Tab 2: Lines ──────────────────────────────── */}
          <TabsContent value="lines" className="mt-0">
            <CardContent className="p-0">
              {/* Add line + column headers */}
              <div className="flex items-center justify-between px-4 py-2.5 border-b bg-muted/10">
                <div className="grid grid-cols-[32px_2fr_1fr_1fr_1.5fr_1.2fr_32px] gap-2 flex-1 text-[11px] font-semibold text-muted-foreground">
                  <span></span>
                  <span>الحساب</span>
                  <span>مدين</span>
                  <span>دائن</span>
                  <span>البيان</span>
                  <span>مركز التكلفة</span>
                  <span></span>
                </div>
                <Button
                  variant="outline" size="sm"
                  onClick={addLine}
                  className="h-7 gap-1 text-xs mr-2 shrink-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                  إضافة سطر
                </Button>
              </div>

              {/* Lines */}
              <div className="divide-y">
                {lines.map((line, idx) => (
                  <div
                    key={line.id}
                    className="grid grid-cols-[32px_2fr_1fr_1fr_1.5fr_1.2fr_32px] gap-2 px-4 py-2.5 items-center hover:bg-muted/10"
                  >
                    <span className="text-[10px] text-muted-foreground text-center font-mono">{idx + 1}</span>

                    <AccountCombobox
                      value={line.accountId}
                      onValueChange={v => updateLine(line.id, "accountId", v)}
                      placeholder="بحث بالكود أو الاسم..."
                      grouped={false}
                      allowEmpty
                      emptyLabel="— اختر الحساب —"
                    />

                    <Input
                      type="number"
                      data-enter-nav="true"
                      value={line.debit}
                      onChange={e => {
                        updateLine(line.id, "debit", e.target.value);
                        if (e.target.value) updateLine(line.id, "credit", "");
                      }}
                      onKeyDown={handleEnterNav}
                      placeholder="0.00"
                      className={cn(
                        "h-8 text-sm text-left font-mono",
                        parseFloat(line.debit) > 0 && "border-green-400 bg-green-50/50"
                      )}
                      min="0"
                      step="0.01"
                    />

                    <Input
                      type="number"
                      data-enter-nav="true"
                      value={line.credit}
                      onChange={e => {
                        updateLine(line.id, "credit", e.target.value);
                        if (e.target.value) updateLine(line.id, "debit", "");
                      }}
                      onKeyDown={handleEnterNav}
                      placeholder="0.00"
                      className={cn(
                        "h-8 text-sm text-left font-mono",
                        parseFloat(line.credit) > 0 && "border-red-400 bg-red-50/50"
                      )}
                      min="0"
                      step="0.01"
                    />

                    <Input
                      data-enter-nav="true"
                      value={line.description}
                      onChange={e => updateLine(line.id, "description", e.target.value)}
                      onKeyDown={handleEnterNav}
                      placeholder="بيان السطر..."
                      className="h-8 text-sm"
                    />

                    <Input
                      data-enter-nav="true"
                      value={line.costCenter}
                      onChange={e => updateLine(line.id, "costCenter", e.target.value)}
                      onKeyDown={handleEnterNav}
                      placeholder="-"
                      className="h-8 text-sm"
                    />

                    <Button
                      variant="ghost" size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => removeLine(line.id)}
                      disabled={lines.length <= 2}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>

              {/* Totals footer */}
              <div className="border-t bg-muted/20 px-4 py-3">
                <div className="grid grid-cols-[32px_2fr_1fr_1fr_1.5fr_1.2fr_32px] gap-2 items-center">
                  <span />
                  <span className="text-xs font-semibold text-muted-foreground">الإجماليات</span>
                  <span className={cn(
                    "font-mono font-bold text-sm text-left px-2",
                    totalDebit > 0 ? "text-green-700" : "text-muted-foreground"
                  )}>
                    {totalDebit.toFixed(2)}
                  </span>
                  <span className={cn(
                    "font-mono font-bold text-sm text-left px-2",
                    totalCredit > 0 ? "text-red-700" : "text-muted-foreground"
                  )}>
                    {totalCredit.toFixed(2)}
                  </span>
                  <div className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium justify-self-start",
                    isBalanced ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                  )}>
                    {!isBalanced && <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
                    {isBalanced ? "متوازن ✓" : `فرق: ${diff.toFixed(2)}`}
                  </div>
                  <span />
                  <span />
                </div>
              </div>
            </CardContent>
          </TabsContent>
        </Card>
      </Tabs>

      {/* ─── Action buttons ─────────────────────────────────────── */}
      <div className="flex gap-3 justify-start pb-4">
        <Button
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="min-w-[120px]"
        >
          {saveMutation.isPending ? "جارٍ الحفظ..." : "حفظ"}
        </Button>
        <Button variant="outline" onClick={() => navigate("/accounting/journals")}>
          إلغاء
        </Button>
      </div>
    </div>
  );
}
