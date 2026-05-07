import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Copy, ArrowLeftRight, FileSearch, PlayCircle, AlertTriangle,
  CheckCircle2, Loader2, Info, ShieldAlert,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Company = { id: number; code: string | null; nameAr: string; nameEn: string | null; vatNumber: string | null; status: string };

type Issue = { entryId: number; docNumber: string | null; kind: string; detail: string };

type CopyResult = {
  dryRun: boolean;
  totalSource: number;
  copied: number;
  skipped: number;
  failed: number;
  issues: Issue[];
  mappingSummary?: {
    accounts?: { unmatched?: string[] };
    branches?: { unmatched?: string[] };
  };
  error?: string;
  aborted?: boolean;
};

const KIND_LABEL: Record<string, { ar: string; tone: "danger" | "warn" | "info" }> = {
  missing_account:  { ar: "حساب غير موجود",         tone: "danger" },
  account_inactive: { ar: "حساب غير قابل للترحيل",  tone: "warn" },
  missing_branch:   { ar: "فرع غير موجود",          tone: "warn" },
  missing_period:   { ar: "لا توجد فترة مالية",     tone: "warn" },
  doc_conflict:     { ar: "رقم المستند مكرر",       tone: "warn" },
  doc_renamed:      { ar: "أُعيدت تسمية المستند",   tone: "info" },
  unbalanced:       { ar: "قيد غير متوازن",         tone: "danger" },
};

const TONE_STYLE = {
  danger: "bg-red-50 text-red-800 border-red-200",
  warn:   "bg-amber-50 text-amber-900 border-amber-200",
  info:   "bg-blue-50 text-blue-900 border-blue-200",
} as const;

export default function DataCopyJournalEntries() {
  const { token } = useAuth();
  const { toast } = useToast();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [sourceCompanyId, setSourceCompanyId] = useState<string>("");
  const [targetCompanyId, setTargetCompanyId] = useState<string>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [includeDraft, setIncludeDraft] = useState(true);
  const [includePosted, setIncludePosted] = useState(true);
  const [docNumberOnConflict, setDocNumberOnConflict] = useState<"skip" | "rename" | "keep">("rename");
  const [onMissingAccount, setOnMissingAccount] = useState<"skip_entry" | "abort">("skip_entry");
  const [onMissingBranch, setOnMissingBranch] = useState<"null" | "skip_entry" | "abort">("null");
  const [onMissingPeriod, setOnMissingPeriod] = useState<"null" | "skip_entry" | "abort">("null");
  const [copyAsDraft, setCopyAsDraft] = useState(true);

  const [result, setResult] = useState<CopyResult | null>(null);
  const [confirmExec, setConfirmExec] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  // Invalidate the dry-run result whenever any input that affects the
  // payload changes — prevents the operator from "executing" a plan
  // that no longer matches the form. The user must re-run the preview.
  function invalidateResult<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setResult(null); };
  }

  const companiesQ = useQuery<{ companies: Company[] }>({
    queryKey: ["data-copy", "companies"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/data-copy/companies`, { headers });
      if (!r.ok) throw new Error("فشل تحميل قائمة الشركات");
      return r.json();
    },
  });
  const companies = companiesQ.data?.companies ?? [];

  const companyItems: ComboboxItem[] = useMemo(
    () => companies.map(c => ({
      value: String(c.id),
      code: c.code ?? undefined,
      label: c.nameAr,
      labelEn: c.nameEn ?? undefined,
      description: c.vatNumber ? `الرقم الضريبي: ${c.vatNumber}` : undefined,
    })),
    [companies],
  );

  const sourceName = companies.find(c => String(c.id) === sourceCompanyId)?.nameAr ?? "";
  const targetName = companies.find(c => String(c.id) === targetCompanyId)?.nameAr ?? "";

  function buildPayload(dryRun: boolean) {
    const statusFilter: ("draft" | "posted")[] = [];
    if (includeDraft) statusFilter.push("draft");
    if (includePosted) statusFilter.push("posted");
    return {
      sourceCompanyId: Number(sourceCompanyId),
      targetCompanyId: Number(targetCompanyId),
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      statusFilter,
      docNumberOnConflict,
      onMissingAccount,
      onMissingBranch,
      onMissingPeriod,
      copyAsDraft,
      dryRun,
    };
  }

  const dryRunMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/data-copy/journal-entries`, {
        method: "POST", headers, body: JSON.stringify(buildPayload(true)),
      });
      const data = await r.json();
      if (!r.ok) throw Object.assign(new Error(data?.error ?? "فشل المعاينة"), { data });
      return data as CopyResult;
    },
    onSuccess: (d) => { setResult(d); },
    onError: (e: any) => {
      setResult(e?.data ?? null);
      toast({ title: "فشل المعاينة", description: e?.message ?? "", variant: "destructive" });
    },
  });

  const executeMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/data-copy/journal-entries`, {
        method: "POST", headers, body: JSON.stringify(buildPayload(false)),
      });
      const data = await r.json();
      if (!r.ok) throw Object.assign(new Error(data?.error ?? "فشل التنفيذ"), { data });
      return data as CopyResult;
    },
    onSuccess: (d) => {
      setResult(d);
      setConfirmExec(false); setConfirmText("");
      toast({
        title: "اكتمل النسخ",
        description: `تم نسخ ${d.copied} قيد · تم تخطي ${d.skipped} · فشل ${d.failed}`,
      });
    },
    onError: (e: any) => {
      setResult(e?.data ?? null);
      toast({ title: "فشل التنفيذ", description: e?.message ?? "", variant: "destructive" });
    },
  });

  const ready = !!sourceCompanyId && !!targetCompanyId && sourceCompanyId !== targetCompanyId
    && (includeDraft || includePosted);

  const showExecBtn = result && !result.dryRun ? false : true;

  return (
    <div className="container mx-auto p-4 space-y-6 max-w-6xl" dir="rtl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Copy className="h-6 w-6 text-blue-600" />
            نسخ البيانات بين الشركات — القيود المحاسبية
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            نسخ قيود اليومية (الرأس + السطور) من شركة إلى أخرى مع إعادة ربط الحسابات والفروع والفترات المالية تلقائياً.
            صلاحية المشرف العام فقط.
          </p>
        </div>
      </div>

      {/* Safety banner */}
      <Card className="border-amber-200 bg-amber-50">
        <CardContent className="p-4 flex gap-3 items-start">
          <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900 leading-7">
            <strong>قبل التنفيذ:</strong> تأكّد أن الشركة الهدف فيها <em>دليل حسابات</em> بنفس الأكواد، و<em>فروع</em> بنفس الأكواد، و<em>فترات مالية</em> تغطي تواريخ القيود المنسوخة.
            ينصح بترك خيار <strong>«نسخ كمسودة»</strong> مفعّلاً لمراجعة القيود قبل ترحيلها في الشركة الهدف.
            النسخ يجري داخل عملية واحدة (transaction) — أي فشل سيؤدي إلى التراجع الكامل.
          </div>
        </CardContent>
      </Card>

      {/* Selection card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5" /> الشركتان والفلاتر
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <Label className="mb-1 block">من شركة (المصدر)</Label>
              <SearchCombobox
                items={companyItems}
                value={sourceCompanyId}
                onValueChange={invalidateResult(setSourceCompanyId)}
                placeholder="اختر الشركة المصدر"
                searchPlaceholder="ابحث بالاسم أو الكود..."
                emptyText="لا توجد شركات"
              />
            </div>
            <div>
              <Label className="mb-1 block">إلى شركة (الهدف)</Label>
              <SearchCombobox
                items={companyItems.filter(i => i.value !== sourceCompanyId)}
                value={targetCompanyId}
                onValueChange={invalidateResult(setTargetCompanyId)}
                placeholder="اختر الشركة الهدف"
                searchPlaceholder="ابحث بالاسم أو الكود..."
                emptyText="لا توجد شركات"
              />
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <Label className="mb-1 block">من تاريخ (اختياري)</Label>
              <Input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setResult(null); }} />
            </div>
            <div>
              <Label className="mb-1 block">إلى تاريخ (اختياري)</Label>
              <Input type="date" value={toDate} onChange={e => { setToDate(e.target.value); setResult(null); }} />
            </div>
            <div>
              <Label className="mb-1 block">حالات القيود المنسوخة</Label>
              <div className="flex items-center gap-4 h-10">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={includeDraft} onCheckedChange={v => { setIncludeDraft(!!v); setResult(null); }} />
                  مسودات
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={includePosted} onCheckedChange={v => { setIncludePosted(!!v); setResult(null); }} />
                  مرحّلة
                </label>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Policies card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">قواعد التعامل مع التعارضات</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <Label className="mb-2 block font-semibold">تكرار رقم المستند في الهدف</Label>
            <RadioGroup value={docNumberOnConflict} onValueChange={(v: any) => { setDocNumberOnConflict(v); setResult(null); }} className="grid sm:grid-cols-3 gap-2">
              <label className="flex items-center gap-2 border rounded p-2 cursor-pointer">
                <RadioGroupItem value="rename" /> <span className="text-sm">إعادة تسمية تلقائية (-CP)</span>
              </label>
              <label className="flex items-center gap-2 border rounded p-2 cursor-pointer">
                <RadioGroupItem value="skip" /> <span className="text-sm">تخطّي القيد</span>
              </label>
              <label className="flex items-center gap-2 border rounded p-2 cursor-pointer">
                <RadioGroupItem value="keep" /> <span className="text-sm">الإبقاء كما هو (يسمح بالتكرار)</span>
              </label>
            </RadioGroup>
          </div>

          <div>
            <Label className="mb-2 block font-semibold">عند عدم وجود حساب مطابق في الهدف</Label>
            <RadioGroup value={onMissingAccount} onValueChange={(v: any) => { setOnMissingAccount(v); setResult(null); }} className="grid sm:grid-cols-2 gap-2">
              <label className="flex items-center gap-2 border rounded p-2 cursor-pointer">
                <RadioGroupItem value="skip_entry" /> <span className="text-sm">تخطّي القيد بأكمله</span>
              </label>
              <label className="flex items-center gap-2 border rounded p-2 cursor-pointer">
                <RadioGroupItem value="abort" /> <span className="text-sm">إيقاف العملية كلها</span>
              </label>
            </RadioGroup>
          </div>

          <div>
            <Label className="mb-2 block font-semibold">عند عدم وجود فرع مطابق في الهدف</Label>
            <RadioGroup value={onMissingBranch} onValueChange={(v: any) => { setOnMissingBranch(v); setResult(null); }} className="grid sm:grid-cols-3 gap-2">
              <label className="flex items-center gap-2 border rounded p-2 cursor-pointer">
                <RadioGroupItem value="null" /> <span className="text-sm">ضبطه على null</span>
              </label>
              <label className="flex items-center gap-2 border rounded p-2 cursor-pointer">
                <RadioGroupItem value="skip_entry" /> <span className="text-sm">تخطّي القيد</span>
              </label>
              <label className="flex items-center gap-2 border rounded p-2 cursor-pointer">
                <RadioGroupItem value="abort" /> <span className="text-sm">إيقاف العملية</span>
              </label>
            </RadioGroup>
          </div>

          <div>
            <Label className="mb-2 block font-semibold">عند عدم وجود فترة مالية تغطي التاريخ</Label>
            <RadioGroup value={onMissingPeriod} onValueChange={(v: any) => { setOnMissingPeriod(v); setResult(null); }} className="grid sm:grid-cols-3 gap-2">
              <label className="flex items-center gap-2 border rounded p-2 cursor-pointer">
                <RadioGroupItem value="null" /> <span className="text-sm">ضبطها على null</span>
              </label>
              <label className="flex items-center gap-2 border rounded p-2 cursor-pointer">
                <RadioGroupItem value="skip_entry" /> <span className="text-sm">تخطّي القيد</span>
              </label>
              <label className="flex items-center gap-2 border rounded p-2 cursor-pointer">
                <RadioGroupItem value="abort" /> <span className="text-sm">إيقاف العملية</span>
              </label>
            </RadioGroup>
          </div>

          <div className="flex items-center gap-3 pt-2 border-t">
            <Switch checked={copyAsDraft} onCheckedChange={(v) => { setCopyAsDraft(v); setResult(null); }} />
            <Label className="cursor-pointer" onClick={() => setCopyAsDraft(!copyAsDraft)}>
              نسخ القيود كمسودة في الشركة الهدف (موصى به)
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* Action bar */}
      <div className="flex flex-wrap gap-3 items-center">
        <Button variant="outline" disabled={!ready || dryRunMut.isPending} onClick={() => dryRunMut.mutate()}>
          {dryRunMut.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <FileSearch className="h-4 w-4 ml-2" />}
          معاينة (Dry-run)
        </Button>
        <Button
          disabled={!ready || executeMut.isPending || !result || result.dryRun !== true || result.copied === 0}
          onClick={() => { setConfirmText(""); setConfirmExec(true); }}
        >
          <PlayCircle className="h-4 w-4 ml-2" />
          تنفيذ النسخ
        </Button>
        {!ready && (
          <span className="text-xs text-slate-500 flex items-center gap-1">
            <Info className="h-3.5 w-3.5" /> اختر شركتين مختلفتين وحالة قيود واحدة على الأقل
          </span>
        )}
      </div>

      {/* Result card */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              {result.dryRun ? <FileSearch className="h-5 w-5 text-blue-600" /> : <CheckCircle2 className="h-5 w-5 text-green-600" />}
              {result.dryRun ? "نتيجة المعاينة" : "نتيجة التنفيذ"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {result.error && (
              <div className="p-3 rounded border border-red-200 bg-red-50 text-red-800 text-sm flex gap-2 items-start">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <strong>خطأ:</strong> {result.error}
                  {result.aborted && <div className="text-xs mt-1">تم إيقاف العملية بناءً على قاعدة «إيقاف العملية».</div>}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="إجمالي قيود المصدر" value={result.totalSource} />
              <Stat label={result.dryRun ? "ستُنسخ" : "تم نسخها"} value={result.copied} tone="green" />
              <Stat label="ستُتخطّى" value={result.skipped} tone="amber" />
              <Stat label="فشلت" value={result.failed} tone={result.failed > 0 ? "red" : undefined} />
            </div>

            {(result.mappingSummary?.accounts?.unmatched?.length ?? 0) > 0 && (
              <div className="p-3 rounded border border-red-200 bg-red-50">
                <div className="text-sm font-semibold text-red-900 mb-1">حسابات مفقودة في الشركة الهدف ({result.mappingSummary!.accounts!.unmatched!.length}):</div>
                <div className="flex flex-wrap gap-1">
                  {result.mappingSummary!.accounts!.unmatched!.slice(0, 30).map(c => (
                    <Badge key={c} variant="outline" className="bg-white">{c}</Badge>
                  ))}
                  {result.mappingSummary!.accounts!.unmatched!.length > 30 && <Badge variant="outline">+المزيد</Badge>}
                </div>
              </div>
            )}

            {(result.mappingSummary?.branches?.unmatched?.length ?? 0) > 0 && (
              <div className="p-3 rounded border border-amber-200 bg-amber-50">
                <div className="text-sm font-semibold text-amber-900 mb-1">فروع مفقودة في الشركة الهدف:</div>
                <div className="flex flex-wrap gap-1">
                  {result.mappingSummary!.branches!.unmatched!.map(c => (
                    <Badge key={c} variant="outline" className="bg-white">{c}</Badge>
                  ))}
                </div>
              </div>
            )}

            {result.issues.length > 0 && (
              <div>
                <div className="text-sm font-semibold mb-2">تفاصيل المشاكل ({result.issues.length}):</div>
                <div className="border rounded max-h-96 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr>
                        <th className="text-right p-2 border-b">رقم المستند</th>
                        <th className="text-right p-2 border-b">النوع</th>
                        <th className="text-right p-2 border-b">التفاصيل</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.issues.slice(0, 500).map((iss, i) => {
                        const meta = KIND_LABEL[iss.kind] ?? { ar: iss.kind, tone: "info" as const };
                        return (
                          <tr key={i} className="border-b last:border-b-0">
                            <td className="p-2 font-mono text-xs">{iss.docNumber ?? "—"}</td>
                            <td className="p-2">
                              <Badge variant="outline" className={TONE_STYLE[meta.tone]}>{meta.ar}</Badge>
                            </td>
                            <td className="p-2 text-slate-700">{iss.detail}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {result.issues.length > 500 && (
                    <div className="p-2 text-xs text-slate-500 text-center bg-slate-50">
                      عرض أول 500 مشكلة من أصل {result.issues.length}
                    </div>
                  )}
                </div>
              </div>
            )}

            {!result.dryRun && result.copied > 0 && (
              <div className="p-3 rounded border border-green-200 bg-green-50 text-green-900 text-sm flex gap-2 items-start">
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                تم نسخ {result.copied} قيد إلى «{targetName}» {copyAsDraft ? "كمسودات" : "بحالاتها الأصلية"}.
                راجعها في شاشة قيود اليومية للشركة الهدف.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Execute confirmation */}
      <AlertDialog open={confirmExec} onOpenChange={setConfirmExec}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-red-600" />
              تأكيد تنفيذ النسخ
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 text-right">
              <div>
                ستقوم بنسخ <strong>{result?.copied ?? 0}</strong> قيد محاسبي من شركة
                <strong> «{sourceName}» </strong>
                إلى شركة
                <strong> «{targetName}»</strong>.
              </div>
              <div className="text-amber-700 text-sm">
                هذا الإجراء يُعدّل بيانات الشركة الهدف. التراجع يتم يدوياً عبر حذف القيود من شاشة قيود اليومية.
              </div>
              <div className="pt-2">
                للتأكيد، اكتب اسم الشركة الهدف:
                <code className="bg-slate-100 px-2 py-0.5 rounded mx-1 text-sm">{targetName}</code>
              </div>
              <Input
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={targetName}
                className="mt-2"
                dir="rtl"
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmText.trim() !== targetName.trim() || executeMut.isPending}
              onClick={(e) => { e.preventDefault(); executeMut.mutate(); }}
              className="bg-red-600 hover:bg-red-700"
            >
              {executeMut.isPending ? <Loader2 className="h-4 w-4 ml-2 animate-spin" /> : <PlayCircle className="h-4 w-4 ml-2" />}
              نفّذ النسخ
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "green" | "amber" | "red" }) {
  const cls = tone === "green" ? "border-green-200 bg-green-50 text-green-800"
    : tone === "amber" ? "border-amber-200 bg-amber-50 text-amber-900"
    : tone === "red"   ? "border-red-200 bg-red-50 text-red-800"
    : "border-slate-200 bg-slate-50 text-slate-800";
  return (
    <div className={`rounded border p-3 ${cls}`}>
      <div className="text-2xl font-bold">{value.toLocaleString("ar-SA")}</div>
      <div className="text-xs mt-1">{label}</div>
    </div>
  );
}
