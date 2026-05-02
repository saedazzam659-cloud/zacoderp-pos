import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sparkles, ShieldCheck, ShieldAlert, FileCode, Stethoscope,
  AlertTriangle, CheckCircle2, XCircle, Activity, Users,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type NphiesCheck = { key: string; label: string; ok: boolean; hint: string };
type NphiesStatus = { ready: boolean; mode: string; message: string; checks: NphiesCheck[] };

type ClaimRisk = {
  score: number; verdict: "high"|"medium"|"low"|"very_low"; verdictLabel: string;
  reasons: string[]; aiNarrative: string | null; mode: string;
};

type DiagnosisResp = {
  suggestions: Array<{ code: string; ar: string; en: string; confidence: number }>;
  aiNarrative: string | null; mode: string; disclaimer: string;
};

type Stats = {
  totals: { patients: number; appointmentsLast500: number; insured: number; uninsured: number; expiredPolicies: number };
  byGender: { male: number; female: number };
  ageBuckets: Record<string, number>;
  byVisitType: Record<string, number>;
  byStatus: Record<string, number>;
};

export default function HospitalAI() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [invoiceId, setInvoiceId] = useState("");
  const [risk, setRisk] = useState<ClaimRisk | null>(null);
  const [builtFhir, setBuiltFhir] = useState<any | null>(null);

  const [complaint, setComplaint] = useState("");
  const [diagResp, setDiagResp] = useState<DiagnosisResp | null>(null);

  const { data: status } = useQuery<NphiesStatus>({
    queryKey: ["hospital-ai/nphies/status"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital-ai/nphies/status`, { headers });
      if (!r.ok) throw new Error("فشل تحميل حالة NPHIES");
      return r.json();
    },
  });

  const { data: stats, isLoading: statsLoading } = useQuery<Stats>({
    queryKey: ["hospital-ai/patient-stats", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital-ai/patient-stats?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الإحصاءات");
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: invoices = [] } = useQuery<any[]>({
    queryKey: ["hospital/invoices", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/hospital/invoices?companyId=${cid}`, { headers });
      return r.ok ? r.json() : [];
    },
    enabled: !!cid,
  });

  const buildClaimMut = useMutation({
    mutationFn: async () => {
      const id = Number(invoiceId);
      if (!id) throw new Error("اختر فاتورة أولاً");
      const r = await fetch(`${API}/api/hospital-ai/nphies/build-claim`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid, invoiceId: id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "فشل بناء المطالبة");
      return j;
    },
    onSuccess: (j) => {
      setBuiltFhir(j.fhir);
      qc.invalidateQueries({ queryKey: ["hospital/summary", cid] });
      toast({ title: "تم بناء المطالبة", description: j.note });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const riskMut = useMutation({
    mutationFn: async () => {
      const id = Number(invoiceId);
      if (!id) throw new Error("اختر فاتورة أولاً");
      const r = await fetch(`${API}/api/hospital-ai/claim-risk`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid, invoiceId: id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "فشل التحليل");
      return j as ClaimRisk;
    },
    onSuccess: (j) => setRisk(j),
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const diagMut = useMutation({
    mutationFn: async () => {
      if (!complaint.trim()) throw new Error("أدخل الشكوى الرئيسية");
      const r = await fetch(`${API}/api/hospital-ai/diagnosis-suggest`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: cid, complaint }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "فشل اقتراح التشخيص");
      return j as DiagnosisResp;
    },
    onSuccess: (j) => setDiagResp(j),
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const verdictColor = (v: string) =>
    v === "high"   ? "bg-emerald-100 text-emerald-800 border-emerald-300" :
    v === "medium" ? "bg-amber-100 text-amber-800 border-amber-300" :
    v === "low"    ? "bg-orange-100 text-orange-800 border-orange-300" :
                     "bg-rose-100 text-rose-800 border-rose-300";

  return (
    <div className="space-y-6 p-4" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-rose-600" />
          الذكاء الاصطناعي و NPHIES
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          مولد مطالبات FHIR R4، توقع موافقة المطالبات، اقتراح التشخيص والإحصاءات.
        </p>
      </div>

      {/* ─── 1. NPHIES Readiness ────────────────────────────────────────── */}
      <section className="border rounded-lg bg-white shadow-sm p-4">
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
          {status?.ready
            ? <ShieldCheck className="h-5 w-5 text-emerald-600" />
            : <ShieldAlert  className="h-5 w-5 text-amber-600" />}
          جاهزية الربط بـ NPHIES
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            status?.ready ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
          }`}>{status?.mode === "live" ? "مباشر" : "مخطط (Blueprint)"}</span>
        </h2>
        <p className="text-sm text-muted-foreground mb-3">{status?.message || "..."}</p>
        <div className="space-y-2">
          {status?.checks.map(c => (
            <div key={c.key} className="flex items-start gap-2 text-sm">
              {c.ok
                ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                : <XCircle      className="h-4 w-4 text-rose-500   shrink-0 mt-0.5" />}
              <div className="flex-1">
                <div className="font-medium">{c.label}</div>
                {!c.ok && <div className="text-xs text-muted-foreground">{c.hint}</div>}
              </div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground mt-3 border-t pt-2">
          💡 الإرسال الفعلي إلى NPHIES يتطلب اعتماد مجلس الضمان الصحي (CCHI). حتى ذلك الحين،
          يقوم النظام ببناء مطالبات FHIR R4 وحفظها للمراجعة والإرسال لاحقاً.
        </p>
      </section>

      {/* ─── 2. Claim builder + risk ──────────────────────────────────── */}
      <section className="border rounded-lg bg-white shadow-sm p-4">
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
          <FileCode className="h-5 w-5 text-rose-600" />
          مولد المطالبات + توقع الموافقة
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <Label>اختر فاتورة</Label>
            <select className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
              value={invoiceId} onChange={(e)=>{ setInvoiceId(e.target.value); setRisk(null); setBuiltFhir(null); }}>
              <option value="">— اختر فاتورة —</option>
              {invoices.map((i:any) => (
                <option key={i.id} value={i.id}>
                  {i.docNumber} — إجمالي {Number(i.totalAmount).toFixed(2)} ر.س
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 items-end">
            <Button onClick={()=>riskMut.mutate()} disabled={riskMut.isPending || !invoiceId}
              className="bg-amber-600 hover:bg-amber-700" data-testid="btn-risk">
              <AlertTriangle className="h-4 w-4 ms-2" />
              {riskMut.isPending ? "..." : "تحليل المخاطر"}
            </Button>
            <Button onClick={()=>buildClaimMut.mutate()} disabled={buildClaimMut.isPending || !invoiceId}
              className="bg-rose-600 hover:bg-rose-700" data-testid="btn-build-claim">
              <FileCode className="h-4 w-4 ms-2" />
              {buildClaimMut.isPending ? "..." : "بناء FHIR R4"}
            </Button>
          </div>
        </div>

        {risk && (
          <div className={`mt-4 border rounded-md p-3 ${verdictColor(risk.verdict)}`}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold">{risk.verdictLabel}</span>
              <span className="text-2xl font-bold font-mono">{risk.score}/100</span>
            </div>
            {risk.reasons.length > 0 && (
              <ul className="text-xs space-y-1 list-disc ps-4">
                {risk.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
            {risk.aiNarrative && (
              <div className="mt-3 bg-white/60 border-t pt-2 text-xs">
                <div className="font-semibold mb-1 flex items-center gap-1"><Sparkles className="h-3 w-3" /> ملاحظة المراجع الذكي:</div>
                <p>{risk.aiNarrative}</p>
              </div>
            )}
            <div className="text-[10px] mt-2 opacity-70">المصدر: {risk.mode === "ai+rules" ? "ذكاء اصطناعي + قواعد" : "قواعد فقط"}</div>
          </div>
        )}

        {builtFhir && (
          <div className="mt-4 border rounded-md p-3 bg-slate-50">
            <div className="text-xs text-muted-foreground mb-2">FHIR R4 Claim resource (تم حفظه في قائمة المطالبات):</div>
            <pre className="text-[10px] font-mono bg-white border rounded p-3 max-h-72 overflow-auto" dir="ltr">
{JSON.stringify(builtFhir, null, 2)}
            </pre>
          </div>
        )}
      </section>

      {/* ─── 3. Diagnosis suggest ─────────────────────────────────────── */}
      <section className="border rounded-lg bg-white shadow-sm p-4">
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
          <Stethoscope className="h-5 w-5 text-emerald-600" />
          مساعد التشخيص (ICD-10)
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <Label>الشكوى الرئيسية للمريض</Label>
            <Input value={complaint} onChange={(e)=>setComplaint(e.target.value)}
              placeholder="حرارة منذ يومين مع سعال…" data-testid="input-complaint" />
          </div>
          <div className="flex items-end">
            <Button onClick={()=>diagMut.mutate()} disabled={diagMut.isPending}
              className="bg-emerald-600 hover:bg-emerald-700" data-testid="btn-diagnose">
              <Sparkles className="h-4 w-4 ms-2" />
              {diagMut.isPending ? "..." : "اقتراح تشخيص"}
            </Button>
          </div>
        </div>
        {diagResp && (
          <div className="mt-3 space-y-2">
            {diagResp.suggestions.length === 0 && (
              <div className="text-sm text-muted-foreground">لا توجد اقتراحات مطابقة — جرّب وصفاً أوضح.</div>
            )}
            {diagResp.suggestions.map((s, i) => (
              <div key={i} className="flex items-center gap-3 border rounded-md p-2 bg-emerald-50/40">
                <span className="font-mono font-bold text-emerald-700">{s.code}</span>
                <div className="flex-1">
                  <div className="font-semibold">{s.ar}</div>
                  <div className="text-[11px] text-muted-foreground" dir="ltr">{s.en}</div>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                  ثقة {Math.round(s.confidence * 100)}%
                </span>
              </div>
            ))}
            {diagResp.aiNarrative && (
              <div className="bg-violet-50 border border-violet-200 rounded p-2 text-xs">
                <div className="font-semibold mb-1 flex items-center gap-1"><Sparkles className="h-3 w-3" /> ملاحظة الذكاء الاصطناعي:</div>
                <p>{diagResp.aiNarrative}</p>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground border-t pt-2">{diagResp.disclaimer}</p>
          </div>
        )}
      </section>

      {/* ─── 4. Patient stats ─────────────────────────────────────────── */}
      <section className="border rounded-lg bg-white shadow-sm p-4">
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
          <Activity className="h-5 w-5 text-indigo-600" />
          إحصاءات المرضى والمواعيد
        </h2>
        {statsLoading && <p className="text-sm text-muted-foreground">جاري التحميل…</p>}
        {stats && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
              <StatCard label="إجمالي المرضى"      value={stats.totals.patients}             color="indigo" />
              <StatCard label="مواعيد (آخر 500)"   value={stats.totals.appointmentsLast500}  color="violet" />
              <StatCard label="مرضى بتأمين"        value={stats.totals.insured}              color="emerald" />
              <StatCard label="بدون تأمين"          value={stats.totals.uninsured}            color="slate" />
              <StatCard label="بوالص منتهية"       value={stats.totals.expiredPolicies}      color="rose" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Breakdown title="حسب الجنس" icon={Users}
                rows={[
                  { label: "ذكر",   v: stats.byGender.male },
                  { label: "أنثى",  v: stats.byGender.female },
                ]} />
              <Breakdown title="حسب الفئة العمرية" icon={Users}
                rows={Object.entries(stats.ageBuckets).map(([k,v]) => ({ label: k, v }))} />
              <Breakdown title="حسب نوع الزيارة" icon={Activity}
                rows={Object.entries(stats.byVisitType).map(([k,v]) => ({ label: k, v }))} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  const cls: Record<string,string> = {
    indigo: "bg-indigo-50 border-indigo-200 text-indigo-900",
    violet: "bg-violet-50 border-violet-200 text-violet-900",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
    slate: "bg-slate-50 border-slate-200 text-slate-900",
    rose: "bg-rose-50 border-rose-200 text-rose-900",
  };
  return (
    <div className={`border rounded-lg p-3 ${cls[color]}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}

function Breakdown({ title, icon: Icon, rows }: { title: string; icon: any; rows: Array<{label: string; v: number}> }) {
  const total = rows.reduce((s, r) => s + r.v, 0) || 1;
  return (
    <div className="border rounded-lg p-3 bg-slate-50/50">
      <div className="flex items-center gap-2 font-semibold text-sm mb-2">
        <Icon className="h-4 w-4 text-indigo-600" /> {title}
      </div>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-20 truncate">{r.label}</span>
            <div className="flex-1 bg-slate-200 rounded-full h-2 overflow-hidden">
              <div className="bg-indigo-500 h-full" style={{ width: `${(r.v/total)*100}%` }} />
            </div>
            <span className="font-mono w-8 text-end">{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
