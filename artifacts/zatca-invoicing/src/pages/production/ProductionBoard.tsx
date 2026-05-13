import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import {
  GitBranch, RefreshCw, Play, CheckCircle2, Clock, AlertCircle,
  ChevronLeft, X, Save, Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

const API = import.meta.env.VITE_API_URL || "";

type Stage = {
  id: number;
  orderId: number;
  sequence: number;
  code: string;
  nameAr: string;
  status: "pending" | "in_progress" | "done" | "skipped";
  inputQty: string;
  outputQty: string;
  wasteQty: string;
  expectedWasteRatio: string;
  icon: string | null;
  color: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

type BoardOrder = {
  id: number;
  orderNumber: string;
  title: string;
  status: string;
  plannedQty: string;
  producedQty: string;
  wasteQty: string;
  productItemId: number | null;
  productNameAr: string | null;
  productNameEn: string | null;
};

type BoardResponse = {
  orders: BoardOrder[];
  stages: Record<number, Stage[]>;
};

const STATUS_TONE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  approved: "bg-blue-100 text-blue-700",
  in_production: "bg-amber-100 text-amber-700",
  quality_check: "bg-purple-100 text-purple-700",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "مسودّة",
  approved: "معتمد",
  in_production: "قيد الإنتاج",
  quality_check: "فحص جودة",
};

export default function ProductionBoard() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [data, setData] = useState<BoardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [actStage, setActStage] = useState<{ orderId: number; stage: Stage } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/production/board`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (token) void load(); /* eslint-disable-next-line */ }, [token]);


  const ordersWithStages = useMemo(() => {
    if (!data) return [];
    return data.orders
      .map((o) => ({ order: o, stages: data.stages[o.id] || [] }))
      .filter((x) => x.stages.length > 0);
  }, [data]);

  const ordersWithoutStages = useMemo(() => {
    if (!data) return [];
    return data.orders.filter((o) => !data.stages[o.id] || data.stages[o.id].length === 0);
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-orange-500 via-rose-500 to-pink-500 p-2 text-white shadow-lg">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">خط الإنتاج المرئي</h1>
            <p className="text-sm text-slate-500">
              لوحة حيّة لكل أمر إنتاج جارٍ — اضغط أي مرحلة لبدئها أو إكمالها بكميتها وهالكها.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 me-1 ${loading ? "animate-spin" : ""}`} />
            تحديث
          </Button>
        </div>
      </div>

      {loading && !data ? (
        <div className="space-y-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : ordersWithStages.length === 0 && ordersWithoutStages.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-12 text-center">
          <Activity className="mx-auto h-14 w-14 text-slate-300 mb-3" />
          <h3 className="font-bold text-lg mb-1">لا توجد أوامر إنتاج جارية</h3>
          <p className="text-sm text-slate-500 mb-4">
            ابدأ بإنشاء قالب مراحل من صفحة «قوالب مراحل الإنتاج»، ثم أنشئ أمر إنتاج جديداً.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {ordersWithStages.map(({ order, stages }) => (
            <OrderRow
              key={order.id}
              order={order}
              stages={stages}
              onStageClick={(s) => setActStage({ orderId: order.id, stage: s })}
            />
          ))}
          {ordersWithoutStages.length > 0 && (
            <div className="rounded-xl border border-dashed p-3 bg-slate-50">
              <h4 className="text-xs font-semibold text-slate-500 mb-2">
                أوامر بدون قالب مراحل ({ordersWithoutStages.length})
              </h4>
              <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-2">
                {ordersWithoutStages.map((o) => (
                  <Link key={o.id} href={`/production/orders/${o.id}`}>
                    <a className="block rounded-lg bg-white border p-2 text-sm hover:bg-slate-50">
                      <span className="font-mono text-xs text-slate-400">#{o.orderNumber}</span>{" "}
                      {o.title}
                    </a>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {actStage && (
        <StageActionModal
          orderId={actStage.orderId}
          stage={actStage.stage}
          token={token}
          onClose={() => setActStage(null)}
          onSaved={async () => { setActStage(null); await load(); }}
        />
      )}
    </div>
  );
}

// ─── Order Row (Pipeline view) ────────────────────────────────────────────

function OrderRow({
  order, stages, onStageClick,
}: {
  order: BoardOrder;
  stages: Stage[];
  onStageClick: (s: Stage) => void;
}) {
  const done = stages.filter((s) => s.status === "done").length;
  const total = stages.length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const totalWaste = stages.reduce((sum, s) => sum + Number(s.wasteQty || 0), 0);
  const lastDone = [...stages].reverse().find((s) => s.status === "done");
  const currentOutput = lastDone ? Number(lastDone.outputQty || 0) : 0;
  const planned = Number(order.plannedQty || 0);
  const yieldPct = planned > 0 ? Math.round((currentOutput / planned) * 100) : 0;

  return (
    <div
      className="rounded-2xl border bg-white shadow-sm overflow-hidden"
      data-testid={`order-row-${order.id}`}
    >
      <div className="flex items-center justify-between gap-2 p-3 bg-gradient-to-l from-slate-50 to-white border-b">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/production/orders/${order.id}`}>
              <a className="font-bold hover:text-indigo-600">{order.title}</a>
            </Link>
            <span className="font-mono text-xs text-slate-400">#{order.orderNumber}</span>
            <Badge className={STATUS_TONE[order.status] || "bg-slate-100"}>
              {STATUS_LABEL[order.status] || order.status}
            </Badge>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {order.productNameAr || order.productNameEn || "—"} ·
            مخطط <strong>{Number(order.plannedQty).toLocaleString()}</strong>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-center">
            <div className="text-[10px] text-slate-400">التقدّم</div>
            <div className="text-sm font-bold">{done}/{total}</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-slate-400">المخرجات</div>
            <div className="text-sm font-bold text-emerald-600">{currentOutput.toLocaleString()}</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-slate-400">الهالك</div>
            <div className="text-sm font-bold text-rose-600">{totalWaste.toLocaleString()}</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-slate-400">العائد</div>
            <div className="text-sm font-bold text-indigo-600">{yieldPct}%</div>
          </div>
        </div>
      </div>

      <div className="h-1.5 bg-slate-100">
        <div
          className="h-full bg-gradient-to-l from-emerald-400 to-emerald-600 transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="p-3 overflow-x-auto">
        <div className="flex items-center gap-1 min-w-max">
          {stages.map((s, i) => (
            <div key={s.id} className="flex items-center">
              <StageNode stage={s} onClick={() => onStageClick(s)} />
              {i < stages.length - 1 && (
                <ChevronLeft className="h-4 w-4 text-slate-300 mx-0.5 shrink-0" />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StageNode({ stage, onClick }: { stage: Stage; onClick: () => void }) {
  const isDone = stage.status === "done";
  const isActive = stage.status === "in_progress";
  const isPending = stage.status === "pending";
  const color = stage.color || (isDone ? "#10b981" : isActive ? "#f59e0b" : "#94a3b8");
  return (
    <button
      onClick={onClick}
      className={`relative rounded-xl border-2 p-2 min-w-[140px] text-start transition-all hover:shadow-md hover:-translate-y-0.5 ${
        isActive ? "ring-2 ring-amber-300 ring-offset-1 animate-pulse" : ""
      }`}
      style={{
        borderColor: color,
        background: isDone
          ? `linear-gradient(135deg, ${color}15, ${color}05)`
          : isActive
            ? `linear-gradient(135deg, ${color}25, ${color}10)`
            : "white",
      }}
      data-testid={`stage-node-${stage.id}`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-base leading-none">{stage.icon || "•"}</span>
        <span className="text-[10px] font-mono text-slate-400">#{stage.sequence}</span>
        <div className="flex-1" />
        {isDone && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
        {isActive && <Play className="h-3.5 w-3.5 text-amber-600 fill-amber-600" />}
        {isPending && <Clock className="h-3.5 w-3.5 text-slate-400" />}
      </div>
      <div className="text-xs font-bold truncate" style={{ color }}>{stage.nameAr}</div>
      <div className="mt-1 grid grid-cols-3 gap-1 text-[10px]">
        <div>
          <div className="text-slate-400">دخل</div>
          <div className="font-semibold">{Number(stage.inputQty).toLocaleString()}</div>
        </div>
        <div>
          <div className="text-slate-400">خرج</div>
          <div className="font-semibold text-emerald-600">{Number(stage.outputQty).toLocaleString()}</div>
        </div>
        <div>
          <div className="text-slate-400">هالك</div>
          <div className="font-semibold text-rose-600">{Number(stage.wasteQty).toLocaleString()}</div>
        </div>
      </div>
    </button>
  );
}

// ─── Stage Action Modal ───────────────────────────────────────────────────

function StageActionModal({
  orderId, stage, token, onClose, onSaved,
}: {
  orderId: number;
  stage: Stage;
  token: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [inputQty, setInputQty] = useState(stage.inputQty);
  const [outputQty, setOutputQty] = useState(stage.outputQty || stage.inputQty);
  const [wasteQty, setWasteQty] = useState(stage.wasteQty);
  const [notes, setNotes] = useState("");

  async function start() {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/production/orders/${orderId}/stages/${stage.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ inputQty }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "بدء");
      toast({ title: "✓ بدأت المرحلة" });
      onSaved();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  async function complete() {
    if (Number(outputQty) <= 0 && Number(wasteQty) <= 0) {
      toast({ title: "أدخل كمية الإخراج أو الهالك", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/production/orders/${orderId}/stages/${stage.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ outputQty, wasteQty, notes }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "إكمال");
      toast({ title: "✓ تم إكمال المرحلة" });
      onSaved();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  async function reopen() {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/production/orders/${orderId}/stages/${stage.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: "in_progress" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "إعادة فتح");
      toast({ title: "✓ أُعيد فتح المرحلة" });
      onSaved();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const color = stage.color || "#6366f1";

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div
          className="p-4 text-white"
          style={{ background: `linear-gradient(135deg, ${color}, ${color}aa)` }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-2xl">{stage.icon || "•"}</span>
              <div>
                <div className="text-xs opacity-90">المرحلة #{stage.sequence}</div>
                <h3 className="text-lg font-bold">{stage.nameAr}</h3>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} className="text-white hover:bg-white/20">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="mt-2 text-xs opacity-90">
            الحالة الحالية: <strong>{stage.status === "done" ? "مكتملة" : stage.status === "in_progress" ? "جارية" : "قيد الانتظار"}</strong>
          </div>
        </div>

        <div className="p-4 space-y-3">
          {stage.status === "pending" && (
            <>
              <div>
                <label className="text-sm font-medium block mb-1">كمية الإدخال (Input)</label>
                <Input
                  type="number"
                  step="0.001"
                  value={inputQty}
                  onChange={(e) => setInputQty(e.target.value)}
                  data-testid="input-stage-input-qty"
                />
                <p className="text-xs text-slate-500 mt-1">
                  افتراضياً = ناتج المرحلة السابقة، أو الكمية المخططة للأمر للمرحلة الأولى.
                </p>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={onClose}>إلغاء</Button>
                <Button onClick={start} disabled={busy} data-testid="btn-stage-start">
                  <Play className="h-4 w-4 me-1" />
                  ابدأ المرحلة
                </Button>
              </div>
            </>
          )}

          {stage.status === "in_progress" && (
            <>
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-2 text-xs text-amber-700 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  المرحلة جارية. أدخل الكمية النهائية الخارجة + الهالك لإكمالها.
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-sm font-medium block mb-1">دخل (للقراءة)</label>
                  <Input value={inputQty} disabled />
                </div>
                <div>
                  <label className="text-sm font-medium block mb-1">خرج *</label>
                  <Input
                    type="number"
                    step="0.001"
                    value={outputQty}
                    onChange={(e) => setOutputQty(e.target.value)}
                    data-testid="input-stage-output-qty"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">
                  هالك (متوقّع ~ {(Number(stage.expectedWasteRatio) * Number(inputQty)).toFixed(3)})
                </label>
                <Input
                  type="number"
                  step="0.001"
                  value={wasteQty}
                  onChange={(e) => setWasteQty(e.target.value)}
                  data-testid="input-stage-waste-qty"
                />
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">ملاحظات</label>
                <textarea
                  className="w-full rounded-md border p-2 text-sm min-h-[60px]"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={onClose}>إلغاء</Button>
                <Button onClick={complete} disabled={busy} data-testid="btn-stage-complete">
                  <CheckCircle2 className="h-4 w-4 me-1" />
                  إكمال المرحلة
                </Button>
              </div>
            </>
          )}

          {stage.status === "done" && (
            <>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-slate-50 p-2">
                  <div className="text-xs text-slate-500">دخل</div>
                  <div className="font-bold">{Number(stage.inputQty).toLocaleString()}</div>
                </div>
                <div className="rounded-lg bg-emerald-50 p-2">
                  <div className="text-xs text-emerald-600">خرج</div>
                  <div className="font-bold text-emerald-700">{Number(stage.outputQty).toLocaleString()}</div>
                </div>
                <div className="rounded-lg bg-rose-50 p-2">
                  <div className="text-xs text-rose-600">هالك</div>
                  <div className="font-bold text-rose-700">{Number(stage.wasteQty).toLocaleString()}</div>
                </div>
              </div>
              {stage.startedAt && (
                <div className="text-xs text-slate-500">
                  من <strong>{new Date(stage.startedAt).toLocaleString("ar-SA")}</strong>
                  {stage.completedAt && <> إلى <strong>{new Date(stage.completedAt).toLocaleString("ar-SA")}</strong></>}
                </div>
              )}
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={onClose}>إغلاق</Button>
                <Button variant="outline" onClick={reopen} disabled={busy}>
                  <RefreshCw className="h-4 w-4 me-1" />
                  إعادة فتح
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
