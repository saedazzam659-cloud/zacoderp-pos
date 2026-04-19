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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Plus, Trash2, ArrowRight, BookOpen, AlertCircle } from "lucide-react";

const ENTRY_TYPES = [
  { value: "general",      label: "قيد عام" },
  { value: "opening",      label: "قيد افتتاحي" },
  { value: "closing",      label: "قيد إقفال" },
  { value: "adjustment",   label: "قيد تسوية" },
  { value: "depreciation", label: "قيد إهلاك" },
];

const CURRENCIES = [
  { value: "SAR", label: "ريال سعودي (SAR)" },
  { value: "USD", label: "دولار أمريكي (USD)" },
  { value: "EUR", label: "يورو (EUR)" },
  { value: "AED", label: "درهم إماراتي (AED)" },
  { value: "GBP", label: "جنيه إسترليني (GBP)" },
];

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
  const isNew = !!matchNew;
  const editId = matchEdit ? Number((params as any).id) : null;
  const qc = useQueryClient();
  const { toast } = useToast();

  const [docNumber,    setDocNumber]    = useState("");
  const [entryDate,    setEntryDate]    = useState(today());
  const [currency,     setCurrency]     = useState("SAR");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [description,  setDescription]  = useState("");
  const [entryType,    setEntryType]    = useState("general");
  const [branchId,     setBranchId]     = useState("");
  const [lines,        setLines]        = useState<JournalLine[]>([newLine(), newLine()]);

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: () => branchesApi.getBranches(cid),
    enabled: !!user,
  });

  const { data: existing, isLoading: loadingEdit } = useQuery({
    queryKey: ["journal-entry", editId],
    queryFn:  () => journalEntriesApi.get(editId!, cid),
    enabled:  !!editId,
  });

  useEffect(() => {
    if (!existing) return;
    setDocNumber(existing.docNumber    ?? "");
    setEntryDate(existing.entryDate    ?? today());
    setCurrency(existing.currency      ?? "SAR");
    setExchangeRate(String(existing.exchangeRate ?? "1"));
    setDescription(existing.description ?? "");
    setEntryType(existing.entryType    ?? "general");
    setBranchId(existing.branchId ? String(existing.branchId) : "");
    setLines(
      existing.lines?.length
        ? existing.lines.map((l: any) => ({
            id:          crypto.randomUUID(),
            accountId:   l.accountId ? String(l.accountId) : "",
            costCenter:  l.costCenter  ?? "",
            debit:       l.debit  ? String(Number(l.debit))  : "",
            credit:      l.credit ? String(Number(l.credit)) : "",
            description: l.description ?? "",
          }))
        : [newLine(), newLine()]
    );
  }, [existing]);

  const totalDebit  = lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const diff        = Math.abs(totalDebit - totalCredit);
  const isBalanced  = diff < 0.001;

  function updateLine(id: string, field: keyof JournalLine, value: string) {
    setLines(prev => prev.map(l => l.id === id ? { ...l, [field]: value } : l));
  }
  function addLine() {
    setLines(prev => [...prev, newLine()]);
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

  if (!isNew && loadingEdit) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">جارٍ التحميل...</div>;
  }

  return (
    <div className="p-6 space-y-5 max-w-5xl mx-auto" dir="rtl">
      {/* Page title */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/accounting/journals")} className="h-8 w-8">
          <ArrowRight className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
            <BookOpen className="h-4.5 w-4.5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">{isNew ? "قيد جديد" : "تعديل القيد"}</h1>
            <p className="text-xs text-muted-foreground">
              {isNew ? "إنشاء قيد يومية جديد" : `تعديل القيد رقم ${existing?.docNumber ?? editId}`}
            </p>
          </div>
        </div>
      </div>

      {/* ─── Header Card ─────────────────────────────────────────── */}
      <Card className="border-2">
        <CardHeader className="pb-3 border-b bg-muted/20">
          <CardTitle className="text-sm font-semibold text-muted-foreground">بيانات الرأسية</CardTitle>
        </CardHeader>
        <CardContent className="pt-5">
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
              <Label className="text-xs font-medium">التاريخ <span className="text-destructive">*</span></Label>
              <Input
                type="date"
                value={entryDate}
                onChange={e => setEntryDate(e.target.value)}
                className="h-9 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">العملة</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map(c => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Row 2 */}
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">سعر الصرف</Label>
              <Input
                type="number"
                value={exchangeRate}
                onChange={e => setExchangeRate(e.target.value)}
                className="h-9 text-sm"
                min="0"
                step="0.0001"
              />
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
              <Select value={branchId || "__none"} onValueChange={v => setBranchId(v === "__none" ? "" : v)}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="— اختر الفرع —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">— بدون فرع —</SelectItem>
                  {branches.map((b: any) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.nameAr}
                    </SelectItem>
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
        </CardContent>
      </Card>

      {/* ─── Lines Card ──────────────────────────────────────────── */}
      <Card className="border-2">
        <CardHeader className="pb-3 border-b bg-muted/20">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold text-muted-foreground">سطور القيد</CardTitle>
            <Button variant="outline" size="sm" onClick={addLine} className="h-7 gap-1 text-xs">
              <Plus className="h-3.5 w-3.5" />
              إضافة سطر
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* Column headers */}
          <div className="grid gap-0 border-b bg-muted/30">
            <div className="grid grid-cols-[32px_2fr_1.2fr_1fr_1fr_1.5fr_32px] gap-2 px-4 py-2 text-[11px] font-semibold text-muted-foreground">
              <span></span>
              <span>الحساب</span>
              <span>مركز التكلفة</span>
              <span>مدين</span>
              <span>دائن</span>
              <span>البيان</span>
              <span></span>
            </div>
          </div>

          {/* Lines */}
          <div className="divide-y">
            {lines.map((line, idx) => (
              <div
                key={line.id}
                className="grid grid-cols-[32px_2fr_1.2fr_1fr_1fr_1.5fr_32px] gap-2 px-4 py-2.5 items-center hover:bg-muted/10"
              >
                {/* Row # */}
                <span className="text-[10px] text-muted-foreground text-center font-mono">{idx + 1}</span>

                {/* Account */}
                <AccountCombobox
                  value={line.accountId}
                  onValueChange={v => updateLine(line.id, "accountId", v)}
                  placeholder="بحث بالكود أو الاسم..."
                  grouped={false}
                  allowEmpty
                  emptyLabel="— اختر الحساب —"
                />

                {/* Cost center */}
                <Input
                  value={line.costCenter}
                  onChange={e => updateLine(line.id, "costCenter", e.target.value)}
                  placeholder="-"
                  className="h-8 text-sm"
                />

                {/* Debit */}
                <Input
                  type="number"
                  value={line.debit}
                  onChange={e => {
                    updateLine(line.id, "debit", e.target.value);
                    if (e.target.value) updateLine(line.id, "credit", "");
                  }}
                  placeholder="0.00"
                  className={cn(
                    "h-8 text-sm text-left font-mono",
                    parseFloat(line.debit) > 0 && "border-green-400 bg-green-50/50"
                  )}
                  min="0"
                  step="0.01"
                />

                {/* Credit */}
                <Input
                  type="number"
                  value={line.credit}
                  onChange={e => {
                    updateLine(line.id, "credit", e.target.value);
                    if (e.target.value) updateLine(line.id, "debit", "");
                  }}
                  placeholder="0.00"
                  className={cn(
                    "h-8 text-sm text-left font-mono",
                    parseFloat(line.credit) > 0 && "border-red-400 bg-red-50/50"
                  )}
                  min="0"
                  step="0.01"
                />

                {/* Line description */}
                <Input
                  value={line.description}
                  onChange={e => updateLine(line.id, "description", e.target.value)}
                  placeholder="بيان السطر..."
                  className="h-8 text-sm"
                />

                {/* Delete */}
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
            <div className="grid grid-cols-[32px_2fr_1.2fr_1fr_1fr_1.5fr_32px] gap-2 items-center">
              <span />
              <span className="text-xs font-semibold text-muted-foreground">الإجماليات</span>
              <span />
              <span className={cn(
                "font-mono font-bold text-sm px-2",
                totalDebit > 0 ? "text-green-700" : "text-muted-foreground"
              )}>
                {totalDebit.toFixed(2)}
              </span>
              <span className={cn(
                "font-mono font-bold text-sm px-2",
                totalCredit > 0 ? "text-red-700" : "text-muted-foreground"
              )}>
                {totalCredit.toFixed(2)}
              </span>
              <div className={cn(
                "flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium",
                isBalanced
                  ? "bg-green-50 text-green-700"
                  : "bg-red-50 text-red-700"
              )}>
                {!isBalanced && <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
                {isBalanced ? "متوازن ✓" : `فرق: ${diff.toFixed(2)}`}
              </div>
              <span />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Action buttons ───────────────────────────────────────── */}
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
