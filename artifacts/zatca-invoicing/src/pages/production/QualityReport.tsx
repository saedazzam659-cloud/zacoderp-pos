import { useEffect, useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { Loader2, ShieldCheck, RefreshCw, AlertTriangle } from "lucide-react";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.VITE_API_URL || "";

const CHECK_TYPE_LABELS_AR: Record<string, string> = {
  visual: "بصري",
  weight: "وزن",
  temperature: "حرارة",
  dimension: "أبعاد",
  barcode: "باركود",
  ai_camera: "كاميرا ذكية",
  other: "أخرى",
};
const RESULT_LABELS_AR: Record<string, string> = {
  pass: "نجاح",
  fail: "رفض",
  conditional: "مشروط",
};
const RESULT_COLORS: Record<string, string> = {
  pass: "bg-emerald-500",
  fail: "bg-red-500",
  conditional: "bg-amber-500",
};

type ByResult = { result: string; count: number; defects: number };
type ByCheckType = { checkType: string; total: number; fails: number; conditionals: number };
type TopFailing = { productItemId: number | null; productNameAr: string | null; total: number; fails: number };
type ReportResp = {
  byResult: ByResult[];
  byCheckType: ByCheckType[];
  topFailingProducts: TopFailing[];
  qcResults: readonly string[];
};

function fmtPct(n: number) {
  return `${n.toFixed(1)}%`;
}

export default function QualityReport() {
  const { token } = useAuth();
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const toIso = (d: Date) => d.toISOString().slice(0, 10);

  const [from, setFrom] = useState(toIso(firstOfMonth));
  const [to, setTo] = useState(toIso(today));
  const [data, setData] = useState<ReportResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p.toString();
  }, [from, to]);

  async function load() {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`${API}/api/production/quality-checks/report?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`report ${r.status}`);
      setData(await r.json());
    } catch (e: any) {
      setErr(e?.message ?? "تعذّر تحميل البيانات");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs, token]);

  const byResult = data?.byResult ?? [];
  const totalChecks = byResult.reduce((s, r) => s + Number(r.count || 0), 0);
  const passCount = Number(byResult.find((r) => r.result === "pass")?.count ?? 0);
  const failCount = Number(byResult.find((r) => r.result === "fail")?.count ?? 0);
  const condCount = Number(byResult.find((r) => r.result === "conditional")?.count ?? 0);
  const totalDefects = byResult.reduce((s, r) => s + Number(r.defects || 0), 0);
  const passRate = totalChecks > 0 ? (passCount / totalChecks) * 100 : 0;
  const failRate = totalChecks > 0 ? (failCount / totalChecks) * 100 : 0;

  return (
    <div className="p-4 md:p-6 space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-emerald-600" />
          <h1 className="text-xl md:text-2xl font-bold">تقرير مراقبة الجودة</h1>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin ml-2" /> : <RefreshCw className="h-4 w-4 ml-2" />}
          تحديث
        </Button>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="from">من تاريخ</Label>
              <DateField id="from" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="to">إلى تاريخ</Label>
              <DateField id="to" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {err && (
        <div className="flex items-center gap-2 p-3 rounded bg-red-50 border border-red-200 text-red-700 text-sm">
          <AlertTriangle className="h-4 w-4" />
          {err}
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">إجمالي الفحوصات</div>
            <div className="text-2xl font-bold">{totalChecks.toLocaleString("ar-SA")}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">نسبة النجاح</div>
            <div className="text-2xl font-bold text-emerald-700">{fmtPct(passRate)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">نسبة الرفض</div>
            <div className="text-2xl font-bold text-red-700">{fmtPct(failRate)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">مشروط</div>
            <div className="text-2xl font-bold text-amber-700">{condCount.toLocaleString("ar-SA")}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">إجمالي العيوب</div>
            <div className="text-2xl font-bold">{totalDefects.toLocaleString("ar-SA")}</div>
          </CardContent>
        </Card>
      </div>

      {/* By result */}
      <Card>
        <CardHeader><CardTitle className="text-base">توزيع نتائج الفحص</CardTitle></CardHeader>
        <CardContent>
          {loading && !data ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : byResult.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-6">لا توجد فحوصات في الفترة المحددة.</div>
          ) : (
            <div className="space-y-3">
              {byResult.map((row) => {
                const c = Number(row.count || 0);
                const pct = totalChecks > 0 ? (c / totalChecks) * 100 : 0;
                return (
                  <div key={row.result} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{RESULT_LABELS_AR[row.result] ?? row.result}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {c.toLocaleString("ar-SA")} فحص · {Number(row.defects).toLocaleString("ar-SA")} عيب
                        </span>
                      </div>
                      <span className="font-mono font-semibold">{fmtPct(pct)}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-100 rounded overflow-hidden">
                      <div className={`h-full ${RESULT_COLORS[row.result] ?? "bg-gray-400"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* By check type */}
      <Card>
        <CardHeader><CardTitle className="text-base">حسب نوع الفحص</CardTitle></CardHeader>
        <CardContent>
          {data?.byCheckType?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-right p-2">نوع الفحص</th>
                    <th className="text-right p-2">إجمالي</th>
                    <th className="text-right p-2">مرفوض</th>
                    <th className="text-right p-2">مشروط</th>
                    <th className="text-right p-2">نسبة الرفض</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byCheckType.map((r) => {
                    const total = Number(r.total);
                    const fails = Number(r.fails);
                    const rate = total > 0 ? (fails / total) * 100 : 0;
                    return (
                      <tr key={r.checkType} className="border-t">
                        <td className="p-2">{CHECK_TYPE_LABELS_AR[r.checkType] ?? r.checkType}</td>
                        <td className="p-2 font-mono">{total.toLocaleString("ar-SA")}</td>
                        <td className="p-2 font-mono text-red-700">{fails.toLocaleString("ar-SA")}</td>
                        <td className="p-2 font-mono text-amber-700">{Number(r.conditionals).toLocaleString("ar-SA")}</td>
                        <td className="p-2 font-mono">{fmtPct(rate)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground text-center py-6">لا توجد بيانات.</div>
          )}
        </CardContent>
      </Card>

      {/* Top failing products */}
      <Card>
        <CardHeader><CardTitle className="text-base">أعلى المنتجات في معدّل الرفض</CardTitle></CardHeader>
        <CardContent>
          {data?.topFailingProducts?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-right p-2">المنتج</th>
                    <th className="text-right p-2">إجمالي الفحوصات</th>
                    <th className="text-right p-2">عدد المرفوض</th>
                    <th className="text-right p-2">نسبة الرفض</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topFailingProducts.map((r, i) => {
                    const total = Number(r.total);
                    const fails = Number(r.fails);
                    const rate = total > 0 ? (fails / total) * 100 : 0;
                    return (
                      <tr key={`${r.productItemId}-${i}`} className="border-t">
                        <td className="p-2">{r.productNameAr ?? `#${r.productItemId ?? "—"}`}</td>
                        <td className="p-2 font-mono">{total.toLocaleString("ar-SA")}</td>
                        <td className="p-2 font-mono text-red-700">{fails.toLocaleString("ar-SA")}</td>
                        <td className="p-2 font-mono">{fmtPct(rate)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground text-center py-6">لا توجد بيانات.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
