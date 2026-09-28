import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Activity, AlertTriangle, Info, RefreshCw, Save, X, Eye, Ban, Check } from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const BASE = `${API_BASE}/api/admin/security/automation`;
const POLL_MS = 30_000;

function headers(): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
}

type Status = "normal" | "monitoring" | "suspicious" | "high_risk";
interface MSession {
  id: string; userId: number; companyId: number | null; loginAt: string | null;
  firstSeenAt: string; lastSeenAt: string; riskScore: number; status: Status;
  signals: string[]; requests: number; denials: number; exports: number;
}
interface MEvent {
  id: number; sessionId: string | null; at: string;
  type: "risk_summary" | "monitor_access" | "settings_changed";
  riskScore: number; signals: string[]; requests: number; denials: number; exports: number;
}
interface Summary {
  mode: "monitor" | "off"; instanceId: string; scope: string; limitations: string[];
  capabilities: { captcha: boolean; blocking: boolean; throttling: boolean; revoke: boolean };
  stats: { activeSessions: number; suspiciousSessions: number; highRiskSessions: number; requests: number; denials: number; exports: number; events: number; droppedEvents: number };
  sessions: MSession[]; events: MEvent[];
}
interface Settings {
  enabled: boolean; retentionDays: 7 | 30 | 90; requestsPerMinute: number;
  sequentialPages: number; denialsPerMinute: number; exportsPerMinute: number;
}
interface SettingsResp { settings: Settings; defaults: Settings; instanceId: string; persistenceError: string | null }

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("ar-SA-u-ca-gregory-nu-latn") : "غير متاح");

const STATUS: Record<Status, { label: string; cls: string }> = {
  normal: { label: "طبيعي", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  monitoring: { label: "تحت المراقبة", cls: "bg-sky-50 text-sky-800 border-sky-200" },
  suspicious: { label: "مؤشر مشتبه", cls: "bg-amber-50 text-amber-900 border-amber-300" },
  high_risk: { label: "مؤشر مرتفع", cls: "bg-rose-50 text-rose-800 border-rose-300" },
};
const EVT: Record<MEvent["type"], string> = {
  risk_summary: "ملخص مخاطر", monitor_access: "اطلاع على المراقب", settings_changed: "تعديل الإعدادات",
};
const RANGES: Record<keyof Omit<Settings, "enabled" | "retentionDays">, [number, number, string]> = {
  requestsPerMinute: [30, 10000, "طلبات في الدقيقة"],
  sequentialPages: [3, 100, "صفحات متتالية"],
  denialsPerMinute: [2, 100, "رفض صلاحيات في الدقيقة"],
  exportsPerMinute: [2, 100, "عمليات تصدير في الدقيقة"],
};

function Pill({ s }: { s: Status }) {
  const m = STATUS[s] ?? STATUS.normal;
  return <span className={`text-xs border rounded px-2 py-0.5 whitespace-nowrap ${m.cls}`}>{m.label}</span>;
}
function RiskBar({ v }: { v: number }) {
  const p = Math.max(0, Math.min(100, v));
  const c = p >= 70 ? "bg-rose-500" : p >= 40 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2 min-w-[90px]">
      <div className="h-1.5 flex-1 rounded bg-muted overflow-hidden"><div className={`h-full ${c}`} style={{ width: `${p}%` }} /></div>
      <span className="font-mono text-xs tabular-nums">{v}</span>
    </div>
  );
}
const NA = () => <span className="text-xs text-muted-foreground">غير متاح</span>;

export default function SecurityMonitorPanel() {
  const { toast } = useToast();
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ session: MSession; events: MEvent[] } | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [view, setView] = useState<"sessions" | "settings">("sessions");
  const [st, setSt] = useState<SettingsResp | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/summary`, { headers: headers() });
      if (!r.ok) throw new Error(r.status === 403 ? "غير مصرح" : `خطأ ${r.status}`);
      const j = await r.json();
      if (alive.current) { setData(j); setErr(null); }
    } catch (e) {
      if (alive.current) setErr((e as Error).message || "تعذر التحميل");
    } finally { if (alive.current) setLoading(false); }
  }, []);

  // Poll only while visible & mounted
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(load, POLL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => { if (document.hidden) stop(); else { load(); start(); } };
    load();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => { alive.current = false; stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    setDetail(null); setDetailErr(null);
    fetch(`${BASE}/sessions/${encodeURIComponent(openId)}`, { headers: headers() })
      .then(async r => {
        if (r.status === 404) throw new Error("انتهت الهوية أو لم تعد في ذاكرة هذا الخادم");
        if (!r.ok) throw new Error(`خطأ ${r.status}`);
        const j = await r.json();
        if (alive.current) setDetail({ session: j.session, events: j.events ?? [] });
      })
      .catch(e => alive.current && setDetailErr((e as Error).message));
  }, [openId]);

  const loadSettings = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/settings`, { headers: headers() });
      if (!r.ok) throw new Error();
      const j: SettingsResp = await r.json(); setSt(j); setDraft(j.settings);
    } catch {
      toast({ title: "تعذر تحميل الإعدادات", variant: "destructive" }); setView("sessions");
    }
  }, [toast]);
  useEffect(() => { if (view === "settings" && !st) loadSettings(); }, [view, st, loadSettings]);

  const invalid = draft ? (Object.keys(RANGES) as (keyof typeof RANGES)[]).filter(k => {
    const [lo, hi] = RANGES[k]; const v = draft[k];
    return !Number.isInteger(v) || v < lo || v > hi;
  }) : [];

  async function save() {
    if (!draft || invalid.length) return;
    setSaving(true);
    let r: Response;
    try { r = await fetch(`${BASE}/settings`, { method: "PUT", headers: headers(), body: JSON.stringify(draft) }); }
    catch { setSaving(false); toast({ title: "تعذر الاتصال بالخادم", variant: "destructive" }); return; }
    setSaving(false);
    if (r.ok) { const j: SettingsResp = await r.json(); setSt(j); setDraft(j.settings); toast({ title: "تم حفظ إعدادات المراقبة" }); load(); }
    else {
      const e = await r.json().catch(() => ({}));
      toast({ title: r.status === 503 ? "تعذر الحفظ - لم تتغير الإعدادات" : "قيم غير صالحة", description: e.error, variant: "destructive" });
    }
  }

  const caps = data?.capabilities;
  const s = data?.stats;

  return (
    <div className="space-y-4">
      {/* Disclaimer */}
      <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-4 text-sm text-sky-950 flex gap-3">
        <Info className="h-5 w-5 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div className="font-semibold">وضع المراقبة فقط - لا حظر ولا CAPTCHA تلقائي</div>
          <p className="text-xs leading-relaxed">
            الدرجات مؤشرات سلوكية على نمط استخراج آلي محتمل، وليست دليلاً على استخدام ذكاء اصطناعي أو أداة آلية.
            العمل الاعتيادي للمستخدمين لا يتأثر. راجع السياق قبل أي إجراء.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border bg-card p-0.5">
          {(["sessions", "settings"] as const).map(v => (
            <button key={v} data-testid={`tab-monitor-${v}`} onClick={() => setView(v)}
              className={`px-3 py-1.5 text-sm rounded ${view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {v === "sessions" ? "الهويات المرصودة" : "الإعدادات"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {data && (
            <span className="inline-flex items-center gap-1">
              <Activity className={`h-3.5 w-3.5 ${data.mode === "monitor" ? "text-emerald-600" : ""}`} />
              {data.mode === "monitor" ? "المراقبة تعمل" : "المراقبة متوقفة"} · خادم <span className="font-mono" dir="ltr">{data.instanceId}</span>
            </span>
          )}
          <Button size="sm" variant="outline" data-testid="button-monitor-refresh" onClick={load} className="gap-1"><RefreshCw className="h-3.5 w-3.5" /> تحديث</Button>
        </div>
      </div>

      {loading && !data && (
        <div className="space-y-2">{[0, 1, 2, 3].map(i => <div key={i} className="h-10 rounded bg-muted animate-pulse" />)}</div>
      )}
      {err && !data && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm flex items-center justify-between">
          <span className="text-destructive">تعذر تحميل المراقب: {err}</span>
          <Button size="sm" variant="outline" data-testid="button-monitor-retry" onClick={load}>إعادة المحاولة</Button>
        </div>
      )}

      {err && data && <div className="text-xs text-amber-800" data-testid="status-monitor-stale">تعذر آخر تحديث ({err}) - البيانات المعروضة قد تكون قديمة.</div>}
      {data && view === "sessions" && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
            {[
              ["هويات مرصودة (30 د)", s!.activeSessions], ["مشتبه", s!.suspiciousSessions, s!.suspiciousSessions > 0],
              ["مرتفع", s!.highRiskSessions, s!.highRiskSessions > 0], ["طلبات آخر نافذة 60ث", s!.requests],
              ["رفض", s!.denials], ["تصدير", s!.exports], ["أحداث", s!.events], ["أحداث مفقودة", s!.droppedEvents, s!.droppedEvents > 0],
            ].map(([t, v, w]) => (
              <div key={t as string} data-testid={`stat-monitor-${t as string}`} className={`rounded-lg border bg-card p-2.5 ${w ? "border-amber-300" : ""}`}>
                <div className="text-[11px] text-muted-foreground">{t}</div>
                <div className={`text-lg font-bold tabular-nums ${w ? "text-amber-700" : ""}`}>{v as number}</div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs">
                <tr>
                  {["المستخدم", "الشركة", "وقت الدخول", "آخر نشاط", "IP", "الجهاز", "المتصفح", "طلبات (نافذة 60ث)", "صفحات", "رفض", "تصدير", "المخاطر", "الحالة", ""].map(h =>
                    <th key={h} className="p-2 text-right whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.sessions.length === 0 && (
                  <tr><td colSpan={14} className="p-8 text-center text-muted-foreground text-sm">
                    لا توجد هويات (مستخدم/شركة) مرصودة عبر الويب على هذا الخادم خلال آخر 30 دقيقة.
                  </td></tr>
                )}
                {data.sessions.map(r => (
                  <tr key={r.id} data-testid={`row-monitor-${r.id}`} className={`border-t hover:bg-muted/40 ${r.status === "high_risk" ? "bg-rose-50/40" : r.status === "suspicious" ? "bg-amber-50/40" : ""}`}>
                    <td className="p-2 font-mono text-xs">#{r.userId}</td>
                    <td className="p-2 font-mono text-xs">{r.companyId ?? "—"}</td>
                    <td className="p-2 text-xs whitespace-nowrap">{r.loginAt ? fmt(r.loginAt) : <NA />}</td>
                    <td className="p-2 text-xs whitespace-nowrap">{fmt(r.lastSeenAt)}</td>
                    <td className="p-2"><NA /></td><td className="p-2"><NA /></td><td className="p-2"><NA /></td>
                    <td className="p-2 tabular-nums">{r.requests}</td>
                    <td className="p-2"><NA /></td>
                    <td className="p-2 tabular-nums">{r.denials}</td>
                    <td className="p-2 tabular-nums">{r.exports}</td>
                    <td className="p-2"><RiskBar v={r.riskScore} /></td>
                    <td className="p-2"><Pill s={r.status} /></td>
                    <td className="p-2"><Button size="sm" variant="ghost" className="gap-1" data-testid={`button-monitor-detail-${r.id}`} onClick={() => setOpenId(r.id)}><Eye className="h-3.5 w-3.5" /> تفاصيل</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="rounded-lg border bg-card p-4">
              <h4 className="font-medium text-sm mb-2">القدرات المدعومة</h4>
              <ul className="text-xs space-y-1.5">
                <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-600" /> رصد جلسات الويب الموثقة على مسارات ERP المركزية</li>
                {([["captcha", "CAPTCHA"], ["blocking", "الحظر التلقائي"], ["throttling", "تقييد المعدل"], ["revoke", "إنهاء الجلسة من المراقب"]] as const).map(([k, l]) => (
                  <li key={k} className="flex items-center gap-2">
                    {caps?.[k] ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Ban className="h-3.5 w-3.5 text-muted-foreground" />}
                    <span className={caps?.[k] ? "" : "text-muted-foreground"}>{l}: {caps?.[k] ? "مدعوم" : "غير مدعوم"}</span>
                  </li>
                ))}
                <li className="flex items-center gap-2 text-muted-foreground"><Ban className="h-3.5 w-3.5" /> IP / الجهاز / المتصفح / عدد الصفحات: غير متاح (لا يُخزّن)</li>
                <li className="flex items-center gap-2 text-muted-foreground"><Ban className="h-3.5 w-3.5" /> الموبايل، ويندوز/POS، الوكلاء، القواعد الخارجية: خارج النطاق</li>
              </ul>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
              <h4 className="font-medium text-sm mb-2 flex items-center gap-1.5 text-amber-900"><AlertTriangle className="h-4 w-4" /> حدود القياس</h4>
              <ul className="text-xs space-y-1 text-amber-950 list-disc pr-4">
                <li>العدادات لكل خادم على حدة، في الذاكرة، وتُصفّر عند إعادة التشغيل.</li>
                <li>نافذة ثابتة 60 ثانية؛ الحد الأقصى 2000 هوية و500 حدث.</li>
                <li>قناة الويب ليست دليلاً على متصفح، والبيانات المشتركة لا تميّز الأجهزة.</li>
                {data.limitations.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </div>
          </div>
        </>
      )}

      {data && view === "settings" && (
        !draft || !st ? <div className="h-40 rounded bg-muted animate-pulse" /> : (
          <div className="rounded-lg border bg-card p-4 space-y-4 max-w-2xl">
            <label className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium text-sm">تفعيل المراقبة</div>
                <div className="text-xs text-muted-foreground">عند الإيقاف لا تُجمع مؤشرات جديدة. لا يوجد أي حظر في الحالتين.</div>
              </div>
              <button type="button" role="switch" data-testid="switch-monitor-enabled" aria-checked={draft.enabled}
                onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                className={`relative h-6 w-11 rounded-full transition-colors ${draft.enabled ? "bg-primary" : "bg-muted-foreground/30"}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-background transition-transform ${draft.enabled ? "right-0.5" : "right-[1.375rem]"}`} />
              </button>
            </label>
            <div className="grid sm:grid-cols-2 gap-3">
              {(Object.keys(RANGES) as (keyof typeof RANGES)[]).map(k => {
                const [lo, hi, l] = RANGES[k]; const bad = invalid.includes(k);
                return (
                  <div key={k}>
                    <label className="text-sm">{l}</label>
                    <Input type="number" data-testid={`input-monitor-${k}`} min={lo} max={hi} value={Number.isNaN(draft[k]) ? "" : draft[k]} dir="ltr"
                      className={bad ? "border-destructive" : ""}
                      onChange={e => setDraft({ ...draft, [k]: e.target.value === "" ? NaN : Number(e.target.value) })} />
                    <p className={`text-xs mt-1 ${bad ? "text-destructive" : "text-muted-foreground"}`}>
                      {lo} - {hi} · الافتراضي {st.defaults[k]}
                    </p>
                  </div>
                );
              })}
              <div>
                <label className="text-sm">مدة الاحتفاظ بالأحداث المجمعة</label>
                <select data-testid="select-monitor-retention" value={draft.retentionDays} onChange={e => setDraft({ ...draft, retentionDays: Number(e.target.value) as 7 | 30 | 90 })}
                  className="mt-0.5 h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {[7, 30, 90].map(d => <option key={d} value={d}>{d} يوم</option>)}
                </select>
              </div>
            </div>
            {st.persistenceError && <div className="text-xs text-destructive">خطأ في الحفظ الدائم: {st.persistenceError}</div>}
            <p className="text-xs text-muted-foreground">
              تنتقل الإعدادات إلى الخوادم الأخرى خلال نحو 60 ثانية. هذه عتبات للمؤشرات وليست محدد معدل عام.
            </p>
            <div className="flex gap-2">
              <Button data-testid="button-monitor-save" onClick={save} disabled={saving || invalid.length > 0} className="gap-1"><Save className="h-4 w-4" /> حفظ</Button>
              <Button variant="outline" data-testid="button-monitor-defaults" onClick={() => setDraft(st.defaults)}>استعادة الافتراضي</Button>
            </div>
          </div>
        )
      )}

      {openId && (
        <div className="fixed inset-0 z-50 flex justify-start bg-foreground/30" onClick={() => setOpenId(null)}>
          <aside dir="rtl" className="h-full w-full max-w-md bg-background border-l shadow-xl overflow-y-auto p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">تفاصيل الهوية المرصودة (مستخدم/شركة، ليست جلسة فعلية بالضرورة)</h3>
              <Button size="icon" variant="ghost" data-testid="button-monitor-close" onClick={() => setOpenId(null)}><X className="h-4 w-4" /></Button>
            </div>
            {detailErr && <div className="text-sm text-destructive">{detailErr}</div>}
            {!detail && !detailErr && <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="h-12 rounded bg-muted animate-pulse" />)}</div>}
            {detail && (
              <>
                <div className="rounded-lg border p-3 grid grid-cols-2 gap-2 text-xs">
                  <div>المستخدم: <span className="font-mono">#{detail.session.userId}</span></div>
                  <div>الشركة: <span className="font-mono">{detail.session.companyId ?? "—"}</span></div>
                  <div>أول رصد: {fmt(detail.session.firstSeenAt)}</div>
                  <div>آخر نشاط: {fmt(detail.session.lastSeenAt)}</div>
                  <div className="col-span-2 flex items-center gap-2">المخاطر: <RiskBar v={detail.session.riskScore} /> <Pill s={detail.session.status} /></div>
                </div>
                <div>
                  <div className="text-xs font-medium mb-1">أسباب المؤشر</div>
                  {detail.session.signals.length === 0 ? <p className="text-xs text-muted-foreground">لا توجد إشارات حالياً.</p> :
                    <div className="flex flex-wrap gap-1">{detail.session.signals.map(g => <span key={g} className="text-[11px] font-mono border rounded px-1.5 py-0.5 bg-muted" dir="ltr">{g}</span>)}</div>}
                </div>
                <div>
                  <div className="text-xs font-medium mb-2">الخط الزمني (مجمّع، على هذا الخادم فقط)</div>
                  <ol className="relative border-r pr-4 space-y-3">
                    {detail.events.length === 0 && <li className="text-xs text-muted-foreground">لا أحداث مجمعة بعد.</li>}
                    {detail.events.slice(0, 100).map(ev => (
                      <li key={ev.id} className="text-xs">
                        <span className="absolute -right-1 mt-1 h-2 w-2 rounded-full bg-primary" />
                        <div className="flex justify-between"><span className="font-medium">{EVT[ev.type] ?? ev.type}</span><span className="text-muted-foreground">{fmt(ev.at)}</span></div>
                        <div className="text-muted-foreground">درجة {ev.riskScore} · طلبات {ev.requests} · رفض {ev.denials} · تصدير {ev.exports}</div>
                        {ev.signals.length > 0 && <div className="font-mono text-[10px] text-muted-foreground" dir="ltr">{ev.signals.join(", ")}</div>}
                      </li>
                    ))}
                  </ol>
                </div>
                <p className="text-[11px] text-muted-foreground">إنهاء الجلسة غير مدعوم من المراقب؛ لا يمكن استهداف الموبايل أو ويندوز أو الوكلاء من هنا.</p>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
