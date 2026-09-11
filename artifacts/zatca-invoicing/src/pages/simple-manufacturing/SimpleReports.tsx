import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, FileText, TrendingUp, TrendingDown, Layers } from "lucide-react";
import { MonthlyOverheadClosures } from "@/components/MonthlyOverheadClosures";

function statusLabel(status: string) {
  return ({
    draft: "مسودة", approved: "معتمد", in_production: "قيد الإنتاج",
    paused: "متوقف مؤقتاً", quality_check: "فحص الجودة", completed: "مكتمل",
    cancelled: "ملغى", reversed: "معكوس",
  } as Record<string, string>)[status] ?? status;
}

export function SimpleReports({ request }: { request: (path: string, init?: RequestInit) => Promise<any> }) {
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setReport(null);
    request("/api/simple-manufacturing/reports", { signal: controller.signal })
      .then(data => {
        if (requestId !== requestIdRef.current) return;
        if (!data || typeof data !== "object" || !data.totals || !Array.isArray(data.rows)) {
          throw new Error("استجابة التقرير غير صالحة");
        }
        setReport(data);
      })
      .catch((e: any) => {
        if (e?.name !== "AbortError" && requestId === requestIdRef.current) setError(e.message);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [request]);

  if (error) {
    return (
      <Card className="border-destructive/50 bg-destructive/5">
        <CardContent className="p-6 text-destructive text-center flex flex-col items-center gap-2">
          <span className="font-semibold">تعذر تحميل التقرير</span>
          <span className="text-sm opacity-80">{error}</span>
        </CardContent>
      </Card>
    );
  }

  if (loading || !report) {
    return (
      <Card>
        <CardContent className="p-16 flex flex-col items-center justify-center text-muted-foreground gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
          <p>جاري تجميع بيانات التكلفة والإنتاج...</p>
        </CardContent>
      </Card>
    );
  }

  const stdCost = Number(report.totals.standardCost || 0);
  const actCost = Number(report.totals.actualCost || 0);
  const diff = actCost - stdCost;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="bg-gradient-to-br from-slate-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-blue-100 text-blue-600"><Layers className="h-5 w-5" /></div>
              <h3 className="font-semibold text-slate-700">التكلفة المعيارية</h3>
            </div>
            <div className="text-3xl font-bold text-slate-900">{stdCost.toLocaleString()}</div>
            <p className="text-xs text-slate-500 mt-1">حسب تسعير المكونات والمصادر المتوقعة</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-slate-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600"><TrendingUp className="h-5 w-5" /></div>
              <h3 className="font-semibold text-slate-700">التكلفة الفعلية</h3>
            </div>
            <div className="text-3xl font-bold text-slate-900">{actCost.toLocaleString()}</div>
            <p className="text-xs text-slate-500 mt-1">إجمالي ما تم صرفه فعلياً على الأوامر</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-slate-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className={`p-2 rounded-lg ${diff > 0 ? "bg-red-100 text-red-600" : "bg-emerald-100 text-emerald-600"}`}>
                <TrendingDown className="h-5 w-5" />
              </div>
              <h3 className="font-semibold text-slate-700">انحراف التكلفة</h3>
            </div>
            <div className={`text-3xl font-bold ${diff > 0 ? "text-red-600" : "text-emerald-600"}`}>
              {diff > 0 ? "+" : ""}{diff.toLocaleString()}
            </div>
            <p className="text-xs text-slate-500 mt-1">الفارق بين الفعلي والمعياري</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="border-b bg-slate-50/50">
          <CardTitle className="text-lg flex items-center gap-2">
            <FileText className="h-5 w-5 text-violet-600" />
            تفصيل تكلفة الأوامر
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-right border-b">
                  <th className="p-4 font-medium">رقم الأمر</th>
                  <th className="p-4 font-medium">المنتج / العنوان</th>
                  <th className="p-4 font-medium">الحالة</th>
                  <th className="p-4 font-medium">التكلفة الفعلية</th>
                </tr>
              </thead>
              <tbody>
                {(report.rows || []).map((row: any) => (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-slate-50/50">
                    <td className="p-4 font-semibold text-violet-700">{row.orderNumber}</td>
                    <td className="p-4">{row.productName || row.title}</td>
                    <td className="p-4"><Badge variant="outline">{statusLabel(row.status)}</Badge></td>
                    <td className="p-4 font-mono font-medium">{Number(row.actualCost || 0).toLocaleString()}</td>
                  </tr>
                ))}
                {!(report.rows?.length) && (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-slate-500">لا توجد بيانات للأوامر</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <MonthlyOverheadClosures request={request} />
    </div>
  );
}
