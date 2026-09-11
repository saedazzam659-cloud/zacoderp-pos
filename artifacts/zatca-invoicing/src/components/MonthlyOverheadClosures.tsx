import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Calculator, CheckCircle2, RotateCcw, Unlock, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { usePermission } from "@/hooks/usePermission";

export function MonthlyOverheadClosures({ request }: { request: (path: string, init?: RequestInit) => Promise<any> }) {
  const [closures, setClosures] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<{value: string, label: string}[]>([]);
  const [varianceAccountId, setVarianceAccountId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7)); // YYYY-MM
  const { toast } = useToast();
  
  const canEdit = usePermission("simple_manufacturing", "edit");
  const canPost = usePermission("simple_manufacturing", "post");

  useEffect(() => {
    // Fetch compact catalog merged accounts
    request("/api/simple-manufacturing/catalog")
      .then(data => {
        if (data && data.accounting) {
          const list = data.accounting.accounts || [];
          setAccounts(list.map((a: any) => ({ value: String(a.id), label: `${a.code} - ${a.nameAr}` })));
          if (data.accounting.settings?.defaultVarianceAccountId) {
            setVarianceAccountId(String(data.accounting.settings.defaultVarianceAccountId));
          }
        }
      })
      .catch(console.error);
  }, [request]);

  const load = async () => {
    setLoading(true);
    try {
      const data = await request(`/api/simple-manufacturing/overhead-closures?period=${period}`);
      setClosures(Array.isArray(data) ? data : data.rows || []);
    } catch (e: any) {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [period]);

  const handleCreate = async () => {
    if (!varianceAccountId) {
      toast({ title: "الرجاء اختيار حساب الفروقات (Variance Account)", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await request("/api/simple-manufacturing/overhead-closures", {
        method: "POST",
        body: JSON.stringify({ period, varianceAccountId: Number(varianceAccountId) })
      });
      toast({ title: "تم إنشاء مسودة إقفال المصادر بنجاح" });
      load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleAction = async (id: string, action: "post" | "reverse" | "reopen") => {
    setBusy(true);
    try {
      await request(`/api/simple-manufacturing/overhead-closures/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify({})
      });
      const title = action === "post" ? "تم ترحيل إقفال المصادر بنجاح" 
                  : action === "reverse" ? "تم عكس الإقفال بنجاح" 
                  : "تم إعادة فتح مسودة الإقفال بنجاح";
      toast({ title });
      load();
    } catch (e: any) {
      toast({ title: "خطأ", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-violet-100 shadow-sm mt-6">
      <CardHeader className="bg-violet-50/50 pb-4">
        <CardTitle className="text-lg flex items-center gap-2">
          <Calculator className="h-5 w-5 text-violet-600" />
          إقفال المصادر الشهري (Overhead Closures)
        </CardTitle>
        <CardDescription>
          مقارنة التكاليف غير المباشرة (الرواتب، الإهلاك، المصاريف) الموزعة على أوامر الإنتاج بالاستحقاقات الفعلية وإثبات الفروقات.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <div className="grid md:grid-cols-3 gap-4 items-end bg-slate-50 p-4 rounded-xl border border-slate-100">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">الشهر (YYYY-MM)</label>
            <Input type="month" value={period} onChange={e => setPeriod(e.target.value)} className="bg-white" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">حساب الفروقات (Variance)</label>
            <SearchCombobox
              value={varianceAccountId}
              onValueChange={setVarianceAccountId}
              items={accounts}
              placeholder="اختر الحساب..."
            />
                  </div>
          {canEdit && (
            <Button onClick={handleCreate} disabled={busy || loading || !varianceAccountId} className="bg-violet-600 hover:bg-violet-700 w-full">
              <Plus className="h-4 w-4 me-2" /> إنشاء مسودة للشهر المحدد
            </Button>
          )}
        </div>

        {loading ? (
          <div className="py-8 text-center text-slate-500 flex flex-col items-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-violet-500" />
            <span>جاري التحميل...</span>
          </div>
        ) : closures.length === 0 ? (
          <div className="text-center p-8 border-2 border-dashed rounded-lg text-slate-500 text-sm">
            لا توجد سجلات إقفال لشهر {period}.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm text-right">
              <thead>
                <tr className="bg-slate-50 border-b">
                  <th className="p-3 font-semibold">رقم الإقفال</th>
                  <th className="p-3 font-semibold">الشهر</th>
                  <th className="p-3 font-semibold">الحالة</th>
                  <th className="p-3 font-semibold">قيمة الفروقات</th>
                  <th className="p-3 font-semibold">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {closures.map(c => (
                  <tr key={c.id} className="hover:bg-slate-50/50">
                    <td className="p-3 font-medium">#{c.id}</td>
                    <td className="p-3">{c.period}</td>
                    <td className="p-3">
                      <Badge variant="outline" className={c.status === "posted" ? "bg-emerald-50 text-emerald-700" : c.status === "reversed" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700"}>
                        {c.status === "posted" ? "مرحّل" : c.status === "reversed" ? "معكوس" : "مسودة"}
                      </Badge>
                    </td>
                    <td className="p-3 font-mono">{Number(c.varianceAmount || 0).toLocaleString()}</td>
                    <td className="p-3">
  <div className="flex gap-2 justify-end">
    {c.status === "draft" && canPost && (
      <Button size="sm" variant="outline" className="text-emerald-700 hover:text-emerald-800" disabled={busy} onClick={() => handleAction(c.id, "post")}>
        <CheckCircle2 className="h-4 w-4 me-1" /> ترحيل
      </Button>
    )}
    {c.status === "posted" && canPost && (
      <Button size="sm" variant="outline" className="text-rose-700 hover:text-rose-800" disabled={busy} onClick={() => handleAction(c.id, "reverse")}>
        <RotateCcw className="h-4 w-4 me-1" /> عكس
      </Button>
    )}
    {c.status === "reversed" && canEdit && (
      <Button size="sm" variant="outline" className="text-blue-700 hover:text-blue-800" disabled={busy} onClick={() => handleAction(c.id, "reopen")}>
        <Unlock className="h-4 w-4 me-1" /> إعادة فتح
      </Button>
    )}
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
  );
}