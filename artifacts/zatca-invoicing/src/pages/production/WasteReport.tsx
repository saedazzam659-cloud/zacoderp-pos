import { useEffect, useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { Loader2, Trash2, AlertTriangle, RefreshCw } from "lucide-react";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.VITE_API_URL || "";

const WASTE_TYPE_LABELS_AR: Record<string, string> = {
  burn: "احتراق",
  break: "كسر",
  deform: "تشوّه",
  packaging_error: "خطأ تعبئة",
  quality: "نقص جودة",
  overweight: "زيادة وزن",
  underweight: "نقص وزن",
  contamination: "تلوّث",
  other: "أخرى",
};

type SummaryRow = {
  wasteType: string;
  totalQty: string;
  totalCost: string;
  count: number;
};
type ReasonRow = {
  reason: string;
  totalQty: string;
  totalCost: string;
  count: number;
};

function fmtMoney(n: number) {
  return n.toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtQty(n: number) {
  return n.toLocaleString("ar-SA", { maximumFractionDigits: 4 });
}

export default function WasteReport() {
  const { token } = useAuth();
  // Default range: first day of current month → today.
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const toIso = (d: Date) => d.toISOString().slice(0, 10);

  const [from, setFrom] = useState(toIso(firstOfMonth));
  const [to, setTo] = useState(toIso(today));
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [reasonQ, setReasonQ] = useState("");

  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [reasons, setReasons] = useState<ReasonRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (selectedTypes.length > 0) p.set("wasteType", selectedTypes.join(","));
    if (reasonQ.trim()) p.set("q", reasonQ.trim());
    return p.toString();
  }, [from, to, selectedTypes, reasonQ]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [s, r] = await Promise.all([
        fetch(`${API}/api/production/waste-records/summary?${qs}`, { headers }),
        fetch(`${API}/api/production/waste-records/by-reason?${qs}&limit=20`, { headers }),
      ]);
      if (!s.ok) throw new Error(`summary ${s.status}`);
      if (!r.ok) throw new Error(`by-reason ${r.status}`);
      const sJson = await s.json();
      const rJson = await r.json();
      setSummary(Array.isArray(sJson?.byType) ? sJson.byType : []);
      setReasons(Array.isArray(rJson) ? rJson : []);
    } catch (e: any) {
      setErr(e?.message ?? "تعذّر تحميل البيانات");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs]);

  const totalCost = summary.reduce((s, r) => s + Number(r.totalCost || 0), 0);
  const totalQty = summary.reduce((s, r) => s + Number(r.totalQty || 0), 0);
  const totalCount = summary.reduce((s, r) => s + Number(r.count || 0), 0);

  function toggleType(t: string) {
    setSelectedTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Trash2 className="h-5 w-5 text-red-600" />
          <h1 className="text-xl md:text-2xl font-bold">تقرير الهالك والتالف</h1>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin ml-2" /> : <RefreshCw className="h-4 w-4 ml-2" />}
          تحديث
        </Button>
      </div>

      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <Label htmlFor="from">من تاريخ</Label>
              <DateField id="from" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="to">إلى تاريخ</Label>
              <DateField id="to" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="q">بحث في السبب (نص حر)</Label>
              <Input
                id="q"
                placeholder="مثال: تمزق كيس، خطأ خلط..."
                value={reasonQ}
                onChange={(e) => setReasonQ(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label className="text-xs text-muted-foreground">تصنيفات الهالك</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {Object.entries(WASTE_TYPE_LABELS_AR).map(([k, label]) => {
                const active = selectedTypes.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleType(k)}
                    className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                      active
                        ? "bg-red-600 text-white border-red-600"
                        : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
              {selectedTypes.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedTypes([])}
                  className="px-3 py-1 rounded-full text-xs border border-dashed text-gray-500 hover:bg-gray-50"
                >
                  مسح الفلاتر
                </button>
              )}
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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">إجمالي التكلفة</div>
            <div className="text-2xl font-bold text-red-700">{fmtMoney(totalCost)} ر.س</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">إجمالي الكمية</div>
            <div className="text-2xl font-bold">{fmtQty(totalQty)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">عدد السجلات</div>
            <div className="text-2xl font-bold">{totalCount.toLocaleString("ar-SA")}</div>
          </CardContent>
        </Card>
      </div>

      {/* By type */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">تحليل حسب نوع الهالك</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && summary.length === 0 ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : summary.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-6">لا توجد سجلات هالك في الفترة المحددة.</div>
          ) : (
            <div className="space-y-3">
              {summary.map((row) => {
                const cost = Number(row.totalCost || 0);
                const pct = totalCost > 0 ? (cost / totalCost) * 100 : 0;
                return (
                  <div key={row.wasteType} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{WASTE_TYPE_LABELS_AR[row.wasteType] ?? row.wasteType}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {Number(row.count).toLocaleString("ar-SA")} سجل · {fmtQty(Number(row.totalQty))}
                        </span>
                      </div>
                      <div className="font-mono">
                        <span className="text-red-700 font-semibold">{fmtMoney(cost)}</span>
                        <span className="text-xs text-muted-foreground mr-2">({pct.toFixed(1)}%)</span>
                      </div>
                    </div>
                    <div className="w-full h-2 bg-gray-100 rounded overflow-hidden">
                      <div
                        className="h-full bg-red-500"
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* By reason */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">أعلى الأسباب (نص حر)</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && reasons.length === 0 ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : reasons.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-6">
              لم يتم إدخال أسباب نصية بعد. يستطيع المشغّل كتابة سبب لكل سجل هالك من تفاصيل أمر الإنتاج.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-right p-2">السبب</th>
                    <th className="text-right p-2">عدد السجلات</th>
                    <th className="text-right p-2">إجمالي الكمية</th>
                    <th className="text-right p-2">إجمالي التكلفة</th>
                  </tr>
                </thead>
                <tbody>
                  {reasons.map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-2">{r.reason}</td>
                      <td className="p-2 font-mono">{Number(r.count).toLocaleString("ar-SA")}</td>
                      <td className="p-2 font-mono">{fmtQty(Number(r.totalQty))}</td>
                      <td className="p-2 font-mono text-red-700">{fmtMoney(Number(r.totalCost))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
