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
    setTypedName("");
    setPreview(null);
    setError("");
    setLoading(true);
    fetch(`${api}/reset-preview${agentQuery}`, { headers: { Authorization: `Bearer ${token ?? ""}` } })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "تعذر إعداد معاينة آمنة");
        setPreview(body);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
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
          {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />جارٍ إعداد معاينة البيانات…</div>}
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
