import { useEffect, useState } from "react";
import { RotateCcw, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

type Props = {
  companyId: number;
  companyName: string;
  agentInstanceId?: number | null;
  token?: string;
};

export default function CompanyResetTool({ companyId, companyName, agentInstanceId, token }: Props) {
  const [open, setOpen] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [preview, setPreview] = useState<{ totalRows: number; tables: Array<{ table: string; rows: number }> } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const api = import.meta.env.BASE_URL.replace(/\/$/, "") + `/api/admin/companies/${companyId}`;
  const agentQuery = agentInstanceId ? `?agent=${agentInstanceId}` : "";

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setTypedName("");
    setPreview(null);
    setError("");
    setLoading(true);
    fetch(`${api}/reset-preview${agentQuery}`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
      signal: controller.signal,
    })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "تعذر إعداد معاينة آمنة");
        if (controller.signal.aborted) return;
        setPreview(body);
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError" && !controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, api, agentQuery, token]);

  const reset = async () => {
    if (!preview || typedName !== companyName || saving) return;
    setSaving(true);
    try {
      const response = await fetch(`${api}/reset${agentQuery}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmationName: typedName,
          expectedFingerprint: JSON.stringify([...preview.tables].sort((a, b) => a.table.localeCompare(b.table))),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "فشلت التهيئة");
      toast({ title: "تمت تهيئة الشركة", description: `تم حذف ${body.totalRows} سجل تشغيلي وإعادة التسلسلات للبداية.` });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشلت التهيئة");
    } finally {
      setSaving(false);
    }
  };

  return <>
    <Button size="sm" variant="destructive" className="gap-1.5 h-8"
      onClick={() => setOpen(true)} data-testid={`button-reset-company-${companyId}`}>
      <RotateCcw className="h-3.5 w-3.5" />تهيئة الشركة
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent dir="rtl" className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />تهيئة بيانات الشركة
          </DialogTitle>
          <DialogDescription>
            ستحذف الحركات التشغيلية للشركة وتعيد أرقام التسلسل للبداية. تبقى بيانات الشركة الأساسية وإعداداتها كما هي. العملية لا يمكن التراجع عنها.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <div className="font-semibold">{companyName}</div>
            <div className="text-muted-foreground">معرّف الشركة: {companyId} — سيتم استهداف هذه الشركة فقط.</div>
          </div>
          {loading && <div
            role="status"
            aria-live="polite"
            className="space-y-3 rounded-md border border-primary/20 bg-primary/5 p-4"
            data-testid={`company-reset-scan-loading-${companyId}`}
          >
            <div className="flex items-start gap-3">
              <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-primary" aria-hidden="true" />
              <div className="space-y-1">
                <p className="text-sm font-semibold">جارٍ فحص بيانات الشركة…</p>
                <p className="text-xs leading-5 text-muted-foreground">
                  يتم حصر السجلات التشغيلية للتأكد من نطاق التهيئة. لا تُحذف أي بيانات أثناء الفحص.
                </p>
              </div>
            </div>
            <div
              role="progressbar"
              aria-label="فحص بيانات الشركة"
              aria-valuetext="جارٍ فحص الجداول وحساب السجلات"
              className="h-1.5 overflow-hidden rounded-full bg-primary/15"
            >
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
            </div>
          </div>}
          {preview && <div className="rounded-md border p-3 text-sm">
            <div className="font-medium">معاينة الحذف: {preview.totalRows.toLocaleString("ar-EG")} سجل</div>
            <div className="mt-2 max-h-36 space-y-1 overflow-y-auto text-xs text-muted-foreground">
              {preview.tables.length
                ? preview.tables.map(item => <div key={item.table} className="flex justify-between gap-3"><span dir="ltr">{item.table}</span><span>{item.rows.toLocaleString("ar-EG")}</span></div>)
                : <div>لا توجد حركات في الجداول المحددة.</div>}
            </div>
          </div>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <label className="block space-y-2 text-sm font-medium">
            اكتب اسم الشركة كما يظهر أعلاه لتفعيل زر التهيئة
            <Input value={typedName} onChange={e => setTypedName(e.target.value)} autoComplete="off"
              disabled={loading || saving}
              placeholder={companyName} data-testid={`input-reset-company-name-${companyId}`} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>إلغاء</Button>
          <Button variant="destructive" onClick={reset}
            disabled={!preview || loading || saving || typedName !== companyName || !!error}
            data-testid={`confirm-reset-company-${companyId}`}>
            {saving ? <><Loader2 className="me-2 h-4 w-4 animate-spin" />جارٍ التنفيذ…</> : "تأكيد التهيئة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
