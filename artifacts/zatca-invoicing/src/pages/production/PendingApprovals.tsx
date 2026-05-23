import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2, XCircle, AlertTriangle, ShieldCheck, Loader2, FileSearch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

const API = import.meta.env.VITE_API_URL || "";

type Row = {
  id: number;
  orderNumber: string;
  title: string;
  status: string;
  plannedQty: string;
  unitCode: string;
  estimatedCost: string;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  createdAt: string;
  productNameAr: string | null;
  creatorName: string | null;
  needsApproval: boolean;
  overThreshold: boolean;
};
type Resp = {
  settings: { approvalRequired: boolean; approvalThreshold: number | null };
  items: Row[];
};

const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PendingApprovals() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [rejectFor, setRejectFor] = useState<Row | null>(null);
  const [reason, setReason] = useState("");

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }), [token]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/production/orders/pending-approval`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e: any) {
      toast({ title: "فشل تحميل قائمة الاعتمادات", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [headers, toast]);

  useEffect(() => { if (token) load(); }, [token, load]);

  const approve = async (row: Row) => {
    setBusy(row.id);
    try {
      const r = await fetch(`${API}/api/production/orders/${row.id}/approve`, {
        method: "POST", headers,
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || `HTTP ${r.status}`);
      }
      toast({ title: "تم الاعتماد", description: `أمر ${row.orderNumber}` });
      await load();
    } catch (e: any) {
      toast({ title: "فشل الاعتماد", description: e?.message, variant: "destructive" });
      // On any failure (409 stale state, network, etc.) re-sync the queue
      // so the user sees the current truth and isn't acting on stale rows.
      load().catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!rejectFor) return;
    if (reason.trim().length < 5) {
      toast({ title: "سبب الرفض مطلوب", description: "5 أحرف على الأقل", variant: "destructive" });
      return;
    }
    setBusy(rejectFor.id);
    try {
      const r = await fetch(`${API}/api/production/orders/${rejectFor.id}/reject`, {
        method: "POST", headers, body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || `HTTP ${r.status}`);
      }
      toast({ title: "تم الرفض", description: `أمر ${rejectFor.orderNumber}` });
      setRejectFor(null);
      setReason("");
      await load();
    } catch (e: any) {
      toast({ title: "فشل الرفض", description: e?.message, variant: "destructive" });
      load().catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  const needCount = data?.items.filter((i) => i.needsApproval).length ?? 0;
  const totalCount = data?.items.length ?? 0;

  return (
    <div className="container mx-auto p-4 space-y-4" dir="rtl">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-violet-600" />
        <div>
          <h1 className="text-2xl font-bold">اعتماد أوامر الإنتاج</h1>
          <p className="text-sm text-slate-500">
            مراجعة أوامر الإنتاج بحالة "مسودة" واعتمادها أو رفضها.
          </p>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-xs text-slate-500">إجمالي المسودات</div>
            <div className="text-2xl font-bold mt-1">{totalCount}</div>
          </CardContent>
        </Card>
        <Card className={needCount > 0 ? "border-amber-300" : ""}>
          <CardContent className="p-3 text-center">
            <div className="text-xs text-slate-500">تستلزم اعتماد إلزامي</div>
            <div className={`text-2xl font-bold mt-1 ${needCount > 0 ? "text-amber-700" : ""}`}>
              {needCount}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-xs text-slate-500">إلزامية الاعتماد</div>
            <Badge variant={data?.settings.approvalRequired ? "default" : "outline"} className="mt-2">
              {data?.settings.approvalRequired ? "مفعّل" : "اختياري"}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="text-xs text-slate-500">حدّ الاعتماد (ر.س)</div>
            <div className="text-xl font-bold mt-1 font-mono">
              {data?.settings.approvalThreshold != null
                ? fmtMoney(data.settings.approvalThreshold)
                : <span className="text-slate-400 text-sm">—</span>}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* List */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <FileSearch className="h-4 w-4" />قائمة المسودات
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : totalCount === 0 ? (
            <div className="p-10 text-center text-slate-500">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-400" />
              لا توجد أوامر إنتاج تنتظر الاعتماد.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100/60 text-xs">
                  <tr>
                    <th className="p-2 text-start">رقم الأمر</th>
                    <th className="p-2 text-start">العنوان / المنتج</th>
                    <th className="p-2 text-end">الكمية</th>
                    <th className="p-2 text-end">التكلفة المتوقعة</th>
                    <th className="p-2 text-start">منشئ الأمر</th>
                    <th className="p-2 text-center">العلامات</th>
                    <th className="p-2 text-center w-44">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.items.map((row) => (
                    <tr key={row.id} className={`border-t ${row.needsApproval ? "bg-amber-50/40" : ""}`}>
                      <td className="p-2 font-mono text-xs">{row.orderNumber}</td>
                      <td className="p-2">
                        <div className="font-bold">{row.title}</div>
                        {row.productNameAr && (
                          <div className="text-[11px] text-slate-500">{row.productNameAr}</div>
                        )}
                      </td>
                      <td className="p-2 text-end font-mono">
                        {Number(row.plannedQty).toLocaleString("en-US")} <span className="text-[10px] text-slate-400">{row.unitCode}</span>
                      </td>
                      <td className="p-2 text-end font-mono">{fmtMoney(Number(row.estimatedCost))}</td>
                      <td className="p-2 text-xs">{row.creatorName ?? "—"}</td>
                      <td className="p-2 text-center">
                        <div className="flex flex-col items-center gap-1">
                          {row.overThreshold && (
                            <Badge className="text-[10px] bg-amber-100 text-amber-800 hover:bg-amber-100 gap-1">
                              <AlertTriangle className="h-3 w-3" />فوق الحد
                            </Badge>
                          )}
                          {row.needsApproval && !row.overThreshold && (
                            <Badge variant="secondary" className="text-[10px]">إلزامي</Badge>
                          )}
                        </div>
                      </td>
                      <td className="p-2 text-center">
                        <div className="flex gap-1 justify-center">
                          <Button
                            size="sm" variant="default"
                            disabled={busy === row.id}
                            onClick={() => approve(row)}
                          >
                            {busy === row.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                            <span className="ms-1">اعتماد</span>
                          </Button>
                          <Button
                            size="sm" variant="outline"
                            className="text-rose-700 border-rose-200 hover:bg-rose-50"
                            disabled={busy === row.id}
                            onClick={() => { setRejectFor(row); setReason(""); }}
                          >
                            <XCircle className="h-3 w-3" />
                            <span className="ms-1">رفض</span>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!rejectFor} onOpenChange={(o) => !o && setRejectFor(null)}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>رفض أمر الإنتاج {rejectFor?.orderNumber}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">سبب الرفض (5 أحرف على الأقل)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="مثال: المنتج غير مطلوب حالياً، أو نقص في المواد، أو خطأ في التكلفة..."
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectFor(null)}>إلغاء</Button>
            <Button
              variant="destructive"
              disabled={busy === rejectFor?.id || reason.trim().length < 5}
              onClick={reject}
            >
              {busy === rejectFor?.id ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <XCircle className="h-4 w-4 me-1" />}
              تأكيد الرفض
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
