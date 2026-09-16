import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const API = import.meta.env.VITE_API_URL || "";
export type RecoveryOverride = { advanceRecoveryOverrideAmount: string | null; advanceRecoveryOverrideReason: string | null };
export type AdvanceRecoverySummary = {
  enabled: boolean; method: "percentage" | "fixed"; fixedAmount: string;
  advanceRecoveryPercent: string; contractAdvanceAmount: string; totalPreviouslyRecovered: string;
  actualAdvanceRemaining: string; recoveryAmount: string; remainingAdvanceAfter: string;
  startReached: boolean; startProgressPercent: string; canOverride: boolean;
  source: "contract" | "snapshot" | "override"; overrideAmount: string | null; overrideReason: string | null;
  netDue: string;
};
const money = (value: string | number) => Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One read-only server calculator for both new and existing certificates. */
export default function ContractingAdvanceRecoverySummary({
  projectId, direction, contractId, billDate, billId, currentValue, locked = false,
  override, onOverrideChange, onSaved, refreshKey, retentionPercent,
}: {
  projectId: number; direction: "outgoing" | "incoming"; contractId: number | null; billDate: string;
  billId?: number; currentValue?: number; locked?: boolean; override?: RecoveryOverride;
  onOverrideChange?: (value: RecoveryOverride) => void; onSaved?: () => void; refreshKey?: unknown;
  retentionPercent?: string | number | null;
}) {
  const { token } = useAuth() as any;
  const [result, setResult] = useState<AdvanceRecoverySummary | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [exception, setException] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const scope = `${projectId}:${direction}:${contractId}:${billDate}:${billId ?? "new"}`;
  useEffect(() => {
    setException(false); setAmount(""); setReason(""); setSaveError(""); setResult(null);
  }, [scope]);
  useEffect(() => {
    const refresh = () => setReload(value => value + 1);
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30000);
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(interval); };
  }, []);
  useEffect(() => {
    if (!token || !contractId || !billDate) return;
    const abort = new AbortController();
    setBusy(true); setError("");
    const timer = window.setTimeout(() => {
      if (currentValue != null && (!Number.isFinite(currentValue) || currentValue < 0)) {
        setError("أكمل قيم البنود الصحيحة لحساب الاسترداد."); setBusy(false); return;
      }
      void fetch(`${API}/api/contracting/projects/${projectId}/advance-recovery-preview`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({ direction, billDate, billId,
          [direction === "incoming" ? "subcontractorContractId" : "ownerContractId"]: contractId,
          ...(!locked && currentValue != null ? { currentCertifiedWorkBeforeVat: currentValue.toFixed(2) } : {}),
          ...(!locked && retentionPercent != null ? { retentionPercent } : {}),
          ...(!billId && override ? override : {}),
        }),
      }).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "تعذر حساب استرداد المقدم");
        if (!data.advanceRecovery) throw new Error("استجابة استرداد المقدم غير صحيحة");
        if (!abort.signal.aborted) setResult(data.advanceRecovery);
      }).catch(caught => { if (!abort.signal.aborted) setError(caught.message); })
        .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    }, 250);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [token, scope, currentValue, locked, override?.advanceRecoveryOverrideAmount,
    override?.advanceRecoveryOverrideReason, reload, refreshKey, retentionPercent]);

  async function saveOverride(clear = false) {
    if (!result?.canOverride || locked) return;
    setSaveError("");
    if (!clear && (!amount.trim() || !Number.isFinite(Number(amount)) || Number(amount) < 0 || !reason.trim())) {
      setSaveError("أدخل مبلغًا غير سالب وسبب الاستثناء."); return;
    }
    const value: RecoveryOverride = { advanceRecoveryOverrideAmount: clear ? null : amount, advanceRecoveryOverrideReason: clear ? null : reason.trim() };
    if (!billId) {
      onOverrideChange?.(value); setException(false); return;
    }
    setSaving(true);
    try {
      const response = await fetch(`${API}/api/contracting/bills/${billId}`, {
        method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error((await response.json()).error || "تعذر حفظ الاستثناء");
      setException(false); setReload(v => v + 1); onSaved?.();
    } catch (caught: any) { setSaveError(caught.message); }
    finally { setSaving(false); }
  }
  if (!contractId || !billDate) return <p className="text-xs text-muted-foreground">اختر العقد والتاريخ لعرض استرداد المقدم تلقائيًا.</p>;
  const fields = result ? [
    ["الدفعة المقدمة المحددة في العقد", `${money(result.contractAdvanceAmount)} ر.س`],
    ["طريقة الاسترداد من العقد", result.method === "fixed" ? "مبلغ ثابت لكل مستخلص" : "نسبة من الأعمال المعتمدة الحالية"],
    ["النسبة / القيمة المحددة في العقد", result.method === "fixed" ? `${money(result.fixedAmount)} ر.س` : `${money(result.advanceRecoveryPercent)}%`],
    ["إجمالي الاسترداد السابق", `${money(result.totalPreviouslyRecovered)} ر.س`],
    ["المتبقي من مبلغ العقد قبل المستخلص", `${money(Math.max(0, Number(result.contractAdvanceAmount) - Number(result.totalPreviouslyRecovered)))} ر.س`],
    ["رصيد المقدم المرحّل المتاح", `${money(result.actualAdvanceRemaining)} ر.س`],
    ["استرداد المستخلص الحالي", `${money(result.recoveryAmount)} ر.س`],
    ["الرصيد المرحّل بعد الاسترداد", `${money(result.remainingAdvanceAfter)} ر.س`],
  ] : [];
  return <section className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/30 p-3 dark:bg-amber-950/20" aria-label="استرداد الدفعة المقدمة تلقائيًا">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h5 className="text-sm font-semibold">الدفعة المقدمة واستردادها — {locked ? "محفوظ عند الاعتماد" : "تلقائي من العقد"}</h5>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReload(v => v + 1)}>تحديث من العقد</Button>
    </div>
    {busy && <p className="text-xs text-muted-foreground" role="status">جارٍ تحديث الحساب والأرصدة…</p>}
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : result && <>
      <dl className={`grid grid-cols-2 gap-3 lg:grid-cols-4 ${busy ? "opacity-50" : ""}`}>
        {fields.map(([label, value]) => <div key={label} className="rounded bg-background/70 p-2">
          <dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-semibold">{value}</dd>
        </div>)}
      </dl>
      {!locked && <p className="text-sm font-semibold">المستحق بعد استرداد المقدم (معاينة): {money(Math.max(0, Number(result.netDue) - Number(result.recoveryAmount)))} ر.س</p>}
      {!result.enabled && <p className="text-xs text-amber-800 dark:text-amber-200">الاسترداد غير مفعّل في العقد.</p>}
      {result.enabled && Number(result.contractAdvanceAmount) > 0 && Number(result.totalPreviouslyRecovered) >= Number(result.contractAdvanceAmount) && <p className="text-xs text-emerald-700">اكتمل استرداد الدفعة المقدمة؛ الاسترداد الحالي صفر تلقائيًا.</p>}
      {result.enabled && Number(result.actualAdvanceRemaining) <= 0 && <p className="text-xs text-muted-foreground">لا يوجد رصيد مقدم مرحّل متاح لهذا العقد. قيمة العقد التخطيطية لا تنشئ دفعة مالية.</p>}
      {result.enabled && !result.startReached && <p className="text-xs text-muted-foreground">يبدأ الخصم عند اعتماد مالي تراكمي {result.startProgressPercent}%.</p>}
      <p className="text-xs leading-5 text-muted-foreground">{locked
        ? "هذه قيم المستخلص المحفوظة؛ تعديل العقد لا يعيد حساب المستخلصات المعتمدة."
        : "معاينة تلقائية؛ يعاد التحقق عند الاعتماد المالي. إعدادات العقد هي المصدر ولا تُعدّل من المستخلص. لن يتجاوز الاسترداد الرصيد المتاح أو المستحق، ولا يكرر استردادًا سابقًا."}</p>
      {result.overrideAmount != null && <p className="text-xs font-semibold">استثناء: {money(result.overrideAmount)} ر.س — {result.overrideReason}</p>}
      {result.canOverride && !locked && <div className="space-y-2 border-t pt-2">
        {!exception ? <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={saving || busy} onClick={() => { setAmount(result.overrideAmount ?? ""); setReason(result.overrideReason ?? ""); setException(true); }}>استثناء بصلاحية خاصة</Button>
          {result.overrideAmount != null && <Button size="sm" variant="ghost" disabled={saving} onClick={() => void saveOverride(true)}>إلغاء الاستثناء والعودة للعقد</Button>}
        </div> : <>
          <p className="text-xs text-amber-800 dark:text-amber-200">يسجل هذا الاستثناء وسببه للتدقيق، ولا يتجاوز الرصيد الفعلي.</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">مبلغ الاستثناء<Input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></label>
            <label className="text-xs">سبب الاستثناء (إلزامي)<Input value={reason} onChange={e => setReason(e.target.value)} /></label>
          </div>
          <div className="flex gap-2"><Button size="sm" disabled={saving} onClick={() => void saveOverride()}>تثبيت الاستثناء</Button><Button size="sm" variant="ghost" onClick={() => setException(false)}>إلغاء</Button></div>
        </>}
        {saveError && <p role="alert" className="text-xs text-red-700">{saveError}</p>}
      </div>}
    </>}
  </section>;
}