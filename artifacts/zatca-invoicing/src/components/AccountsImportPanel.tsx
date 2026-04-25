import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Upload, Download, FileSpreadsheet, CheckCircle2, AlertTriangle, X, Eye } from "lucide-react";
import { COA_TEMPLATES, TEMPLATE_LABELS, type CoaRow } from "@/lib/coaTemplates";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const COLUMN_HEADERS = [
  { key: "code",            ar: "كود الحساب" },
  { key: "nameAr",          ar: "اسم الحساب (عربي)" },
  { key: "nameEn",          ar: "اسم الحساب (إنجليزي)" },
  { key: "accountType",     ar: "نوع الحساب (asset/liability/equity/revenue/expense)" },
  { key: "parentCode",      ar: "كود الحساب الأب" },
  { key: "level",           ar: "المستوى" },
  { key: "isPosting",       ar: "حساب قيد (true/false)" },
  { key: "isActive",        ar: "نشط (true/false)" },
  { key: "reportDirection", ar: "توجيه الحساب (balance_sheet/income_statement)" },
  { key: "notes",           ar: "ملاحظات" },
];

// Map Arabic-friendly direction values to canonical codes
const DIRECTION_MAP: Record<string, string> = {
  "balance_sheet":     "balance_sheet",
  "income_statement":  "income_statement",
  "مركز مالي":         "balance_sheet",
  "ميزانية":           "balance_sheet",
  "الميزانية":         "balance_sheet",
  "قائمة دخل":         "income_statement",
  "قائمة الدخل":       "income_statement",
  "دخل":               "income_statement",
};
function normalizeDirection(v: any): string {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "";
  return DIRECTION_MAP[s] || DIRECTION_MAP[String(v).trim()] || "";
}

function downloadTemplate(kind: keyof typeof COA_TEMPLATES) {
  const rows = COA_TEMPLATES[kind];
  const aoa: any[][] = [COLUMN_HEADERS.map(c => c.ar)];
  for (const r of rows) {
    aoa.push([
      r.code,
      r.nameAr,
      r.nameEn || "",
      r.accountType,
      r.parentCode || "",
      r.level ?? "",
      r.isPosting === false ? "false" : "true",
      r.isActive  === false ? "false" : "true",
      r.reportDirection || "",
      r.notes || "",
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 12 }, { wch: 38 }, { wch: 32 }, { wch: 14 }, { wch: 14 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 22 }, { wch: 24 }];
  if (ws["!ref"]) {
    ws["!rows"] = [{ hpx: 28 }];
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Chart of Accounts");
  // Add a help sheet
  const help = XLSX.utils.aoa_to_sheet([
    ["تعليمات تعبئة دليل الحسابات"],
    [""],
    ["1. لا تغيّر أسماء الأعمدة في الصف الأول"],
    ["2. الأعمدة المطلوبة: كود الحساب، اسم الحساب (عربي)، نوع الحساب"],
    ["3. نوع الحساب يجب أن يكون أحد القيم التالية بالإنجليزية:"],
    ["   asset = أصول"],
    ["   liability = خصوم"],
    ["   equity = حقوق ملكية"],
    ["   revenue = إيرادات"],
    ["   expense = مصروفات"],
    ["4. عمود 'كود الحساب الأب' يربط الحساب بالحساب الرئيسي عبر الكود (وليس المعرّف)"],
    ["5. الحسابات الرئيسية تُكتب أولاً (يمكن تركها بدون 'حساب قيد' أو وضع false)"],
    ["6. عند الاستيراد: إذا وُجد حساب بنفس الكود يُحدَّث وإلا يُضاف جديداً"],
    ["7. ترقيم معياري مقترح:"],
    ["   1xxxx = الأصول"],
    ["   2xxxx = الخصوم"],
    ["   3xxxx = حقوق الملكية"],
    ["   4xxxx = الإيرادات"],
    ["   5xxxx = المصروفات"],
    ["   6xxxx = تكاليف الإنتاج (للشركات الصناعية)"],
  ]);
  help["!cols"] = [{ wch: 60 }];
  XLSX.utils.book_append_sheet(wb, help, "تعليمات");
  XLSX.writeFile(wb, `قالب-دليل-الحسابات-${kind}-${new Date().toISOString().slice(0,10)}.xlsx`);
}

const HEADER_MAP: Record<string, string> = {
  "كود الحساب": "code",
  "اسم الحساب (عربي)": "nameAr",
  "اسم الحساب (إنجليزي)": "nameEn",
  "نوع الحساب (asset/liability/equity/revenue/expense)": "accountType",
  "نوع الحساب": "accountType",
  "كود الحساب الأب": "parentCode",
  "المستوى": "level",
  "حساب قيد (true/false)": "isPosting",
  "حساب قيد": "isPosting",
  "نشط (true/false)": "isActive",
  "نشط": "isActive",
  "توجيه الحساب (balance_sheet/income_statement)": "reportDirection",
  "توجيه الحساب": "reportDirection",
  "التوجيه": "reportDirection",
  "ملاحظات": "notes",
  // English fallbacks
  "code": "code", "nameAr": "nameAr", "nameEn": "nameEn",
  "accountType": "accountType", "parentCode": "parentCode",
  "level": "level", "isPosting": "isPosting", "isActive": "isActive",
  "reportDirection": "reportDirection", "notes": "notes",
};

function parseBool(v: any): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "" || s === "true" || s === "1" || s === "نعم" || s === "yes";
}

function parseFile(file: File): Promise<CoaRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
        const rows: CoaRow[] = json.map(row => {
          const out: any = {};
          for (const [k, v] of Object.entries(row)) {
            const mapped = HEADER_MAP[String(k).trim()];
            if (mapped) out[mapped] = v;
          }
          if (out.level)     out.level = Number(out.level) || undefined;
          if (out.isPosting !== undefined) out.isPosting = parseBool(out.isPosting);
          if (out.isActive  !== undefined) out.isActive  = parseBool(out.isActive);
          out.code        = String(out.code ?? "").trim();
          out.nameAr      = String(out.nameAr ?? "").trim();
          out.nameEn      = String(out.nameEn ?? "").trim() || undefined;
          out.accountType = String(out.accountType ?? "").trim().toLowerCase();
          out.parentCode  = String(out.parentCode ?? "").trim() || undefined;
          out.reportDirection = normalizeDirection(out.reportDirection) || undefined;
          out.notes       = String(out.notes ?? "").trim() || undefined;
          return out as CoaRow;
        }).filter(r => r.code && r.nameAr);
        resolve(rows);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

export default function AccountsImportPanel() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [parsed, setParsed]   = useState<CoaRow[] | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [mode, setMode]       = useState<"append" | "replace">("append");
  const [showPreview, setShowPreview] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [result, setResult]   = useState<{ inserted: number; updated: number; skipped: number; errors: string[] } | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const rows = await parseFile(file);
      if (rows.length === 0) {
        toast({ title: "لم يتم العثور على حسابات صالحة في الملف", variant: "destructive" });
        return;
      }
      setParsed(rows);
      setFileName(file.name);
      setResult(null);
      toast({ title: `تم قراءة ${rows.length} حساباً من الملف` });
    } catch (err: any) {
      toast({ title: err.message || "تعذّر قراءة الملف", variant: "destructive" });
    }
  }

  function loadTemplateDirect(kind: keyof typeof COA_TEMPLATES) {
    const rows = COA_TEMPLATES[kind];
    if (rows.length === 0) {
      toast({ title: "القالب الفارغ لا يحتوي حسابات للاستيراد المباشر — حمّل الملف وعبّئه ثم ارفعه", variant: "destructive" });
      return;
    }
    setParsed(rows);
    setFileName(`قالب جاهز — ${TEMPLATE_LABELS[kind]}`);
    setResult(null);
    toast({ title: `تم تحميل ${rows.length} حساباً من القالب` });
  }

  const importMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/accounts/bulk-import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: parsed, mode }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "فشل الاستيراد");
      return json;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      // The mappings cache is also stale — bulk-import auto-seeds the
      // canonical accounting-mapping template against the new accounts.
      qc.invalidateQueries({ queryKey: ["accounting-mappings"] });
      setResult(data);
      const mappingsBit = data.mappingsAutoSeeded > 0
        ? ` — وتم ربط ${data.mappingsAutoSeeded} قيد محاسبي تلقائياً`
        : "";
      toast({
        title: `تم — أضيف ${data.inserted}، حُدِّث ${data.updated}، تُجوهل ${data.skipped}${mappingsBit}`,
      });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function startImport() {
    if (mode === "replace") { setConfirmReplace(true); return; }
    importMut.mutate();
  }

  function clearAll() {
    setParsed(null); setFileName(""); setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="border-b bg-muted/30 px-4 py-3 flex items-center gap-2">
        <Upload className="h-4 w-4 text-primary" />
        <p className="text-sm font-semibold">رفع وتصدير دليل الحسابات</p>
      </div>

      <div className="p-4 space-y-5">
        {/* Templates download */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">1) تنزيل قوالب جاهزة (Excel)</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => downloadTemplate("empty")}>
              <Download className="h-3.5 w-3.5" />قالب فارغ
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => downloadTemplate("commercial")}>
              <Download className="h-3.5 w-3.5" />قالب شركة تجارية
              <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded-full">{COA_TEMPLATES.commercial.length} حساب</span>
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => downloadTemplate("industrial")}>
              <Download className="h-3.5 w-3.5" />قالب شركة صناعية
              <span className="text-[10px] bg-purple-50 text-purple-700 border border-purple-200 px-1.5 py-0.5 rounded-full">{COA_TEMPLATES.industrial.length} حساب</span>
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">القوالب جاهزة بترقيم محاسبي معياري (5 مستويات) ومُعبَّأة بحسابات شركة تجارية أو صناعية كاملة وفق المعايير المحاسبية السعودية.</p>
        </div>

        {/* Direct load (no download needed) */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">2) أو حمّل القالب مباشرةً للاستيراد دون تنزيل</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => loadTemplateDirect("commercial")}>
              <FileSpreadsheet className="h-3.5 w-3.5" />تحميل قالب تجارية للاستيراد
            </Button>
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => loadTemplateDirect("industrial")}>
              <FileSpreadsheet className="h-3.5 w-3.5" />تحميل قالب صناعية للاستيراد
            </Button>
          </div>
        </div>

        {/* File upload */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">3) أو ارفع ملف Excel/CSV مُعبَّأ يدوياً</p>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={onFile}
              className="block w-full max-w-sm text-sm border border-input rounded-md px-2 py-1.5 file:mr-3 file:px-3 file:py-1 file:border-0 file:rounded file:bg-primary file:text-primary-foreground file:text-xs file:cursor-pointer cursor-pointer"
            />
          </div>
        </div>

        {/* Preview & import controls */}
        {parsed && (
          <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="font-medium">جاهز للاستيراد:</span>
                <span className="font-mono">{parsed.length}</span>
                <span>حساب من</span>
                <span className="text-muted-foreground text-xs">{fileName}</span>
              </div>
              <button onClick={clearAll} className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1">
                <X className="h-3 w-3" />إلغاء
              </button>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input type="radio" checked={mode === "append"} onChange={() => setMode("append")} className="h-3.5 w-3.5" />
                إضافة / تحديث (الموجود يُحدَّث، الجديد يُضاف)
              </label>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} className="h-3.5 w-3.5" />
                <span className="text-destructive">استبدال كامل (يحذف كل الحسابات الحالية)</span>
              </label>
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" className="gap-1.5" onClick={startImport} disabled={importMut.isPending}>
                <Upload className="h-3.5 w-3.5" />
                {importMut.isPending ? "جاري الاستيراد..." : `استيراد ${parsed.length} حساباً`}
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowPreview(true)}>
                <Eye className="h-3.5 w-3.5" />معاينة
              </Button>
            </div>
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="rounded-lg border border-green-200 bg-green-50/50 p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-green-800">
              <CheckCircle2 className="h-4 w-4" />نتيجة الاستيراد
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded border bg-white px-2 py-1.5">
                <p className="text-base font-bold text-green-700">{result.inserted}</p>
                <p className="text-muted-foreground">حساب جديد</p>
              </div>
              <div className="rounded border bg-white px-2 py-1.5">
                <p className="text-base font-bold text-blue-700">{result.updated}</p>
                <p className="text-muted-foreground">حساب مُحدَّث</p>
              </div>
              <div className="rounded border bg-white px-2 py-1.5">
                <p className="text-base font-bold text-amber-700">{result.skipped}</p>
                <p className="text-muted-foreground">تم تجاوزه</p>
              </div>
            </div>
            {result.errors.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer flex items-center gap-1 text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" />تنبيهات ({result.errors.length})
                </summary>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground bg-white border rounded p-2 max-h-32 overflow-y-auto">
                  {result.errors.map((e, i) => <li key={i}>• {e}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      {/* Preview dialog */}
      <AlertDialog open={showPreview} onOpenChange={setShowPreview}>
        <AlertDialogContent dir="rtl" className="max-w-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><Eye className="h-5 w-5" />معاينة قبل الاستيراد</AlertDialogTitle>
            <AlertDialogDescription>أول 50 صفاً من إجمالي {parsed?.length || 0} حساب</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="overflow-auto max-h-96 text-xs border rounded">
            <table className="w-full">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 text-right font-medium">الكود</th>
                  <th className="px-2 py-1.5 text-right font-medium">الاسم</th>
                  <th className="px-2 py-1.5 text-right font-medium">النوع</th>
                  <th className="px-2 py-1.5 text-right font-medium">الأب</th>
                  <th className="px-2 py-1.5 text-right font-medium">التوجيه</th>
                  <th className="px-2 py-1.5 text-center font-medium">قيد</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(parsed || []).slice(0, 50).map((r, i) => (
                  <tr key={i} className="hover:bg-muted/20">
                    <td className="px-2 py-1.5 font-mono">{r.code}</td>
                    <td className="px-2 py-1.5">{r.nameAr}</td>
                    <td className="px-2 py-1.5">{r.accountType}</td>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">{r.parentCode || "—"}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {r.reportDirection === "balance_sheet" ? "مركز مالي" :
                       r.reportDirection === "income_statement" ? "قائمة دخل" : "تلقائي"}
                    </td>
                    <td className="px-2 py-1.5 text-center">{r.isPosting === false ? "—" : "✓"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>إغلاق</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm replace */}
      <AlertDialog open={confirmReplace} onOpenChange={setConfirmReplace}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive"><AlertTriangle className="h-5 w-5" />تأكيد الاستبدال الكامل</AlertDialogTitle>
            <AlertDialogDescription>
              هذا الإجراء سيحذف <strong>كل</strong> الحسابات الحالية في الشركة ويستبدلها بحسابات الملف ({parsed?.length || 0} حساب).
              قد يؤثر هذا على القيود والفواتير المرتبطة. هل تريد المتابعة؟
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={() => { setConfirmReplace(false); importMut.mutate(); }}>
              نعم، استبدل الكل
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
