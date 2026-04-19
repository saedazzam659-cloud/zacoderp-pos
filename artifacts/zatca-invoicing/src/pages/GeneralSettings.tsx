import { useState, useRef, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Settings2, Upload, Trash2, CheckCircle2, Image as ImageIcon,
  Hash, Building2, Loader2
} from "lucide-react";
import { cn } from "@/lib/utils";

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
