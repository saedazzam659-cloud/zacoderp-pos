import { useState, useRef, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Settings2, Upload, Trash2, CheckCircle2, Image as ImageIcon,
  Hash, Building2, Loader2, Package, Boxes, Download, FileSpreadsheet
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as XLSX from "xlsx";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const DECIMAL_OPTIONS = [
  { value: 0, label: "0",    example: "1,234" },
  { value: 1, label: "0.0",  example: "1,234.5" },
  { value: 2, label: "0.00", example: "1,234.56" },
  { value: 3, label: "0.000",example: "1,234.567" },
  { value: 4, label: "0.0000",example:"1,234.5678" },
];

export default function GeneralSettings() {
  const { user, token, setUser } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<HTMLDivElement>(null);

  const [logo, setLogo]         = useState<string | null>(user?.company?.logo ?? null);
  const [decimals, setDecimals] = useState<number>(user?.company?.decimalPlaces ?? 2);
  const [dragging, setDragging] = useState(false);
  const [logoError, setLogoError] = useState("");

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const saveMutation = useMutation({
    mutationFn: async (payload: { logo?: string | null; decimalPlaces?: number }) => {
      const cid = user?.company?.id ?? user?.companyId;
      const res = await fetch(`${API}/api/companies/${cid}/general-settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "فشل الحفظ");
      return json;
    },
    onSuccess: (data) => {
      if (setUser) {
        setUser((u: any) => ({ ...u, company: { ...u.company, logo: data.logo, decimalPlaces: data.decimalPlaces } }));
      }
      qc.invalidateQueries({ queryKey: ["auth-me"] });
      toast({ title: "✓ تم حفظ الإعدادات بنجاح" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // ─── Logo upload handling ─────────────────────────────────────────────────

  const processFile = useCallback((file: File) => {
    setLogoError("");
    if (!file.type.startsWith("image/")) {
      setLogoError("الملف يجب أن يكون صورة (PNG، JPG، SVG)"); return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setLogoError("حجم الصورة يجب أن يكون أقل من 2 ميغابايت"); return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setLogo(e.target?.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = () => setDragging(false);

  const handleSave = () => {
    saveMutation.mutate({ logo: logo ?? null, decimalPlaces: decimals });
  };

  const isDirty =
    logo !== (user?.company?.logo ?? null) ||
    decimals !== (user?.company?.decimalPlaces ?? 2);

  // ─── Bulk Import (Items + Opening Balances) ─────────────────────────────
  const itemsFileRef    = useRef<HTMLInputElement>(null);
  const balancesFileRef = useRef<HTMLInputElement>(null);
  const [itemsImporting,    setItemsImporting]    = useState(false);
  const [balancesImporting, setBalancesImporting] = useState(false);
  const [itemsReport,    setItemsReport]    = useState<{ created: number; updated: number; total: number; errors: { row: number; error: string }[] } | null>(null);
  const [balancesReport, setBalancesReport] = useState<{ applied: number; total: number; errors: { row: number; error: string }[] } | null>(null);

  function downloadItemsTemplate() {
    const headers = ["code","nameAr","nameEn","barcode","groupCode","unitCode","itemType","costPrice","salePrice","vatRate","reorderLevel","maxLevel","description"];
    const example = [
      ["ITM-001","حليب طازج 1 لتر","Fresh Milk 1L","6281234567890","DAIRY","PCS","stock",4.50,6.00,15,20,500,"حليب بقري طازج"],
      ["ITM-002","خبز توست أبيض","White Toast Bread","6281234567891","BAKERY","PCS","stock",3.20,5.00,15,30,200,""],
      ["SRV-001","رسوم توصيل","Delivery Fee","","SERVICES","SRV","service",0,15,15,0,"",""],
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...example]);
    ws["!cols"] = headers.map(() => ({ wch: 16 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Items");
    XLSX.writeFile(wb, "items_template.xlsx");
  }

  function downloadBalancesTemplate() {
    const headers = ["itemCode","warehouseCode","qty","costPrice"];
    const example = [
      ["ITM-001","WH-MAIN",100,4.50],
      ["ITM-002","WH-MAIN",50,3.20],
      ["ITM-001","WH-SUB",25,4.50],
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...example]);
    ws["!cols"] = headers.map(() => ({ wch: 18 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "OpeningBalances");
    XLSX.writeFile(wb, "opening_balances_template.xlsx");
  }

  async function parseExcelToObjects(file: File): Promise<any[]> {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: "" });
  }

  async function handleItemsUpload(file: File) {
    setItemsImporting(true);
    setItemsReport(null);
    try {
      const items = await parseExcelToObjects(file);
      if (!items.length) throw new Error("الملف فارغ أو لا يحتوي على بيانات");
      const cid = user?.company?.id ?? user?.companyId;
      const res = await fetch(`${API}/api/inventory/import/items?companyId=${cid}`, {
        method: "POST", headers, body: JSON.stringify({ items }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "فشل الاستيراد");
      setItemsReport(j);
      toast({ title: `تم: ${j.created} مُنشأ، ${j.updated} مُحدَّث${j.errors?.length ? ` — ${j.errors.length} خطأ` : ""}` });
      qc.invalidateQueries({ queryKey: ["items"] });
    } catch (e: any) {
      toast({ title: e.message || "فشل الاستيراد", variant: "destructive" });
    } finally {
      setItemsImporting(false);
    }
  }

  async function handleBalancesUpload(file: File) {
    setBalancesImporting(true);
    setBalancesReport(null);
    try {
      const balances = await parseExcelToObjects(file);
      if (!balances.length) throw new Error("الملف فارغ أو لا يحتوي على بيانات");
      const cid = user?.company?.id ?? user?.companyId;
      const res = await fetch(`${API}/api/inventory/import/opening-balances?companyId=${cid}`, {
        method: "POST", headers, body: JSON.stringify({ balances }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "فشل الاستيراد");
      setBalancesReport(j);
      toast({ title: `تم تطبيق ${j.applied} رصيد افتتاحي${j.errors?.length ? ` — ${j.errors.length} خطأ` : ""}` });
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
    } catch (e: any) {
      toast({ title: e.message || "فشل الاستيراد", variant: "destructive" });
    } finally {
      setBalancesImporting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl" dir="rtl">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings2 className="h-6 w-6 text-primary" />
          الإعدادات العامة
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          تخصيص شعار الشركة وإعدادات عرض الأرقام في الفواتير
        </p>
      </div>

      {/* Company context */}
      {user?.company && (
        <div className="rounded-xl border bg-muted/30 px-4 py-3 flex items-center gap-3">
          <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{user.company.nameAr}</p>
            <p className="text-xs font-mono text-muted-foreground">{user.company.vatNumber}</p>
          </div>
        </div>
      )}

      {/* ─── Logo Section ──────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-muted-foreground" />
          شعار الشركة
        </h2>
        <p className="text-xs text-muted-foreground">
          يُعرض الشعار في رأس الفواتير عند الطباعة. الأبعاد المثلى: 300×100 بكسل. الحد الأقصى: 2 ميغابايت.
        </p>

        <div className="flex flex-col sm:flex-row gap-4">
          {/* Drop zone */}
          <div
            ref={dragRef}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileRef.current?.click()}
            className={cn(
              "flex-1 flex flex-col items-center justify-center rounded-xl border-2 border-dashed cursor-pointer transition-all py-8 px-4 text-center min-h-[140px]",
              dragging
                ? "border-primary bg-primary/5 scale-[1.01]"
                : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/40"
            )}
          >
            <Upload className={cn("h-8 w-8 mb-2 transition-colors", dragging ? "text-primary" : "text-muted-foreground/50")} />
            <p className="text-sm font-medium text-muted-foreground">
              {dragging ? "أفلت الصورة هنا" : "اسحب وأفلت أو انقر للرفع"}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">PNG, JPG, SVG, WebP</p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {/* Preview */}
          {logo ? (
            <div className="relative flex-shrink-0 w-full sm:w-48">
              <div className="rounded-xl border bg-muted/20 p-3 flex items-center justify-center h-full min-h-[140px]">
                <img
                  src={logo}
                  alt="شعار الشركة"
                  className="max-h-28 max-w-full object-contain"
                />
              </div>
              <button
                onClick={() => setLogo(null)}
                className="absolute -top-2 -left-2 h-6 w-6 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow hover:scale-110 transition-transform"
                title="حذف الشعار"
              >
                <Trash2 className="h-3 w-3" />
              </button>
              <p className="text-center text-[10px] text-muted-foreground mt-2">معاينة الشعار</p>
            </div>
          ) : (
            <div className="flex-shrink-0 w-full sm:w-48 rounded-xl border border-dashed bg-muted/10 flex flex-col items-center justify-center h-full min-h-[140px] gap-2">
              <div className="h-12 w-12 rounded-full bg-muted/40 flex items-center justify-center">
                <ImageIcon className="h-6 w-6 text-muted-foreground/40" />
              </div>
              <p className="text-xs text-muted-foreground/50">لا يوجد شعار</p>
            </div>
          )}
        </div>

        {logoError && (
          <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">{logoError}</p>
        )}
      </div>

      {/* ─── Decimal Places Section ────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <h2 className="font-semibold text-base flex items-center gap-2">
          <Hash className="h-4 w-4 text-muted-foreground" />
          دقة الأرقام العشرية في المبالغ
        </h2>
        <p className="text-xs text-muted-foreground">
          يُطبَّق هذا الإعداد على جميع حقول المبالغ في الفواتير
        </p>

        <div className="grid grid-cols-5 gap-2">
          {DECIMAL_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setDecimals(opt.value)}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl border-2 px-2 py-3 transition-all",
                decimals === opt.value
                  ? "border-primary bg-primary/10 text-primary shadow-sm"
                  : "border-muted-foreground/20 hover:border-primary/40 hover:bg-muted/40 text-foreground"
              )}
            >
              <span className="font-mono text-base font-bold">{opt.label}</span>
              <span className="text-[9px] font-mono text-muted-foreground leading-tight text-center">{opt.example}</span>
              {decimals === opt.value && (
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
              )}
            </button>
          ))}
        </div>

        <div className="rounded-lg bg-muted/40 px-4 py-3 text-sm">
          <span className="text-muted-foreground">مثال: </span>
          <span className="font-mono font-medium">
            {(1234.56789).toFixed(decimals)} ريال
          </span>
        </div>
      </div>

      {/* ─── Bulk Import Section ──────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-5 space-y-5">
        <div>
          <h2 className="font-semibold text-base flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            استيراد البيانات من Excel
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            ارفع ملفات Excel جاهزة لإضافة الأصناف والأرصدة الافتتاحية بشكل جماعي. حمّل القالب أولاً، عبّئه، ثم ارفعه.
          </p>
        </div>

        {/* Items Import Card */}
        <div className="rounded-lg border bg-muted/10 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
              <Package className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm">ملف الأصناف</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                الأعمدة: <span className="font-mono" dir="ltr">code, nameAr, nameEn, barcode, groupCode, unitCode, itemType, costPrice, salePrice, vatRate, reorderLevel, maxLevel, description</span>
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                إذا كان الكود موجوداً يتم تحديث بياناته، وإلا يُنشأ صنف جديد. <span className="font-mono" dir="ltr">groupCode</span> و <span className="font-mono" dir="ltr">unitCode</span> اختياريان ويجب أن يطابقا أكواد المجموعات/الوحدات.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={downloadItemsTemplate} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />تحميل القالب
            </Button>
            <Button type="button" size="sm" onClick={() => itemsFileRef.current?.click()} disabled={itemsImporting} className="gap-1.5 bg-blue-600 hover:bg-blue-700">
              {itemsImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {itemsImporting ? "جاري الرفع..." : "رفع ملف الأصناف"}
            </Button>
            <input
              ref={itemsFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleItemsUpload(f); e.target.value = ""; }}
            />
          </div>
          {itemsReport && (
            <div className="rounded-md border bg-card px-3 py-2 text-xs space-y-1">
              <p className="font-medium">
                النتيجة: <span className="text-green-600">{itemsReport.created} إضافة</span> · <span className="text-blue-600">{itemsReport.updated} تحديث</span> من إجمالي {itemsReport.total}
                {itemsReport.errors?.length ? <span className="text-red-600"> · {itemsReport.errors.length} خطأ</span> : null}
              </p>
              {itemsReport.errors?.length > 0 && (
                <ul className="text-[11px] text-red-700 space-y-0.5 max-h-32 overflow-auto pr-2">
                  {itemsReport.errors.slice(0, 50).map((er, i) => (
                    <li key={i}>السطر {er.row}: {er.error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Opening Balances Import Card */}
        <div className="rounded-lg border bg-muted/10 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
              <Boxes className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm">الأرصدة الافتتاحية (الكميات وأسعار التكلفة)</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                الأعمدة: <span className="font-mono" dir="ltr">itemCode, warehouseCode, qty, costPrice</span>
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                يستبدل الرصيد الحالي للصنف في المخزن المحدد بالكمية والتكلفة المُدخلة، ويُسجَّل قيد افتتاحي في دفتر المخزون.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={downloadBalancesTemplate} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />تحميل القالب
            </Button>
            <Button type="button" size="sm" onClick={() => balancesFileRef.current?.click()} disabled={balancesImporting} className="gap-1.5 bg-emerald-600 hover:bg-emerald-700">
              {balancesImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {balancesImporting ? "جاري الرفع..." : "رفع الأرصدة الافتتاحية"}
            </Button>
            <input
              ref={balancesFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBalancesUpload(f); e.target.value = ""; }}
            />
          </div>
          {balancesReport && (
            <div className="rounded-md border bg-card px-3 py-2 text-xs space-y-1">
              <p className="font-medium">
                النتيجة: <span className="text-emerald-600">{balancesReport.applied} رصيد طُبِّق</span> من إجمالي {balancesReport.total}
                {balancesReport.errors?.length ? <span className="text-red-600"> · {balancesReport.errors.length} خطأ</span> : null}
              </p>
              {balancesReport.errors?.length > 0 && (
                <ul className="text-[11px] text-red-700 space-y-0.5 max-h-32 overflow-auto pr-2">
                  {balancesReport.errors.slice(0, 50).map((er, i) => (
                    <li key={i}>السطر {er.row}: {er.error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ─── Save Button ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        {isDirty ? (
          <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
            • يوجد تغييرات غير محفوظة
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">كل التغييرات محفوظة</p>
        )}
        <Button
          onClick={handleSave}
          disabled={saveMutation.isPending || !isDirty}
          className="gap-2 min-w-36"
        >
          {saveMutation.isPending
            ? <><Loader2 className="h-4 w-4 animate-spin" />جاري الحفظ...</>
            : <><CheckCircle2 className="h-4 w-4" />حفظ الإعدادات</>
          }
        </Button>
      </div>

    </div>
  );
}
