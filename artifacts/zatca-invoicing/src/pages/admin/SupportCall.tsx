import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Video, Copy, RefreshCw, Users, ShieldCheck, Phone,
  Radio, StickyNote, MousePointer2, History, Loader2, PhoneCall,
} from "lucide-react";
import AgentCobrowseViewer from "@/components/cobrowse/AgentCobrowseViewer";
import LiveRoom from "@/components/livekit/LiveRoom";
import { supportRoomApi, type JoinInfo } from "@/lib/liveRoomApi";

// ─────────────────────────────────────────────────────────────────────────────
// SupportCall — غرفة الدعم الفني المباشرة (LiveKit داخل النظام).
//
// استُبدل Jitsi (نافذة منبثقة خارجية) بغرفة LiveKit عربية مدمجة داخل الصفحة:
//   • السوبر أدمن يبدأ مكالمة ويختار المستخدم المستهدف → يرن عنده فورًا
//     عبر SSE (support_call_invite) ويرد من داخل النظام.
//   • الطرفان ينشران الكاميرا/المايك/الشاشة.
//   • سجل مكالمات كامل (support_call_logs) أسفل الصفحة.
// لوحة «التحكم بشاشة العميل» (co-browse) بقيت كما هي بجانب المكالمة.
// ─────────────────────────────────────────────────────────────────────────────

interface CallRow {
  id: number; agentUsername: string | null; targetUserId: number | null;
  targetLabel: string | null; status: string; createdAt: string;
  joinedAt: string | null; endedAt: string | null; endReason: string | null;
}

interface EligibleUser { id: number; username: string; nameAr?: string | null; role?: string }

function fmt(v: string | null): string {
  if (!v) return "—";
  try { return new Date(v).toLocaleString("ar-SA-u-nu-latn", { dateStyle: "short", timeStyle: "short" }); } catch { return v; }
}

function durationOf(c: CallRow): string {
  if (!c.joinedAt || !c.endedAt) return "—";
  const s = Math.max(0, Math.floor((new Date(c.endedAt).getTime() - new Date(c.joinedAt).getTime()) / 1000));
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")} د`;
}

export default function SupportCall() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [users, setUsers] = useState<EligibleUser[]>([]);
  const [targetId, setTargetId] = useState<string>("none");
  const [starting, setStarting] = useState(false);
  const [active, setActive] = useState<(JoinInfo & { callId: number; targetLabel: string | null }) | null>(null);
  const [notes, setNotes] = useState("");
  const [logs, setLogs] = useState<CallRow[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);

  // قائمة المستخدمين للاستدعاء المباشر — نعيد استخدام endpoint الكوبراوز
  useEffect(() => {
    const tok = localStorage.getItem("zatca_token");
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    fetch(`${base}/api/cobrowse/eligible-users`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} })
      .then(r => (r.ok ? r.json() : []))
      .then((rows: EligibleUser[]) => setUsers(Array.isArray(rows) ? rows : []))
      .catch(() => setUsers([]));
  }, []);

  const refreshLogs = useCallback(async () => {
    try { setLogs(await supportRoomApi.listCalls()); }
    catch { /* السجل اختياري — لا نعطّل الصفحة */ }
    finally { setLogsLoading(false); }
  }, []);
  useEffect(() => { void refreshLogs(); }, [refreshLogs]);

  const startCall = async () => {
    setStarting(true);
    try {
      const tid = targetId !== "none" ? Number(targetId) : null;
      const res = await supportRoomApi.createCall(tid);
      const label = tid ? (users.find(u => u.id === tid)?.username ?? null) : null;
      setActive({ ...res, callId: res.call.id, targetLabel: label });
      if (tid) toast({ title: "جارٍ رنّ المستخدم...", description: "سيظهر له إشعار المكالمة فور فتحه النظام." });
      void refreshLogs();
    } catch (e: any) {
      toast({ title: "تعذّر بدء المكالمة", description: e.message, variant: "destructive" });
    } finally { setStarting(false); }
  };

  const endCall = async () => {
    if (!active) return;
    try { await supportRoomApi.endCall(active.callId); } catch { /* ignore */ }
    setActive(null);
    toast({ title: "تم إنهاء المكالمة" });
    void refreshLogs();
  };

  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); toast({ title: `تم نسخ ${label}` }); }
    catch { toast({ title: "تعذّر النسخ", variant: "destructive" }); }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Video className="h-6 w-6 text-emerald-600" /> غرفة الدعم الفني المباشرة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            مكالمة فيديو وصوت ومشاركة شاشة مع العميل — داخل النظام مباشرة وبدون أي برنامج خارجي.
          </p>
        </div>
        <Badge variant="outline" className="text-emerald-700 border-emerald-300 bg-emerald-50 gap-1">
          <ShieldCheck className="h-3.5 w-3.5" /> اتصال مشفّر
        </Badge>
      </div>

      {/* المكالمة النشطة */}
      {active ? (
        <Card className="border-emerald-300">
          <CardContent className="pt-4">
            <LiveRoom
              token={active.token} wsUrl={active.wsUrl}
              role="publisher"
              title={active.targetLabel ? `مكالمة مع ${active.targetLabel}` : "مكالمة دعم فني"}
              myName={user?.username ?? "الدعم الفني"}
              autoPublishAv
              hideChat={false}
              onLeave={endCall}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Phone className="h-4 w-4" /> بدء مكالمة جديدة</CardTitle>
            <CardDescription>
              اختر مستخدمًا ليرن عنده إشعار المكالمة داخل النظام فورًا، أو ابدأ غرفة مفتوحة بدون استدعاء.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
              <div>
                <Label className="text-xs">استدعاء مستخدم (اختياري)</Label>
                <Select value={targetId} onValueChange={setTargetId}>
                  <SelectTrigger className="mt-1" data-testid="select-target-user">
                    <SelectValue placeholder="بدون استدعاء" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">بدون استدعاء — غرفة مفتوحة</SelectItem>
                    {users.map(u => (
                      <SelectItem key={u.id} value={String(u.id)}>
                        {u.nameAr || u.username}{u.role ? ` · ${u.role}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button size="lg" className="gap-2 bg-emerald-600 hover:bg-emerald-500" onClick={startCall} disabled={starting} data-testid="btn-start-call">
                {starting ? <Loader2 className="h-5 w-5 animate-spin" /> : <PhoneCall className="h-5 w-5" />}
                بدء المكالمة {targetId !== "none" ? "ورنّ المستخدم" : ""}
              </Button>
            </div>
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              عند اختيار مستخدم، سيظهر له إشعار «مكالمة دعم واردة» داخل النظام مباشرة (يجب أن يكون مسجّل الدخول). المكالمة تعمل بالكامل داخل هذه الصفحة.
            </div>
          </CardContent>
        </Card>
      )}

      {/* Co-browse — التحكم بشاشة العميل */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <FeatureChip icon={MousePointer2} label="تحكم بشاشة العميل" highlight onClick={() => {
          const card = document.getElementById("cobrowse-card");
          card?.scrollIntoView({ behavior: "smooth", block: "start" });
          setTimeout(() => (document.getElementById("cobrowse-start-btn") as HTMLButtonElement | null)?.click(), 250);
        }} />
        <FeatureChip icon={Video} label="فيديو + صوت" />
        <FeatureChip icon={Radio} label="مشاركة الشاشة" />
        <FeatureChip icon={Users} label="داخل النظام — بدون نوافذ خارجية" />
      </div>

      <div id="cobrowse-card"><AgentCobrowseViewer /></div>

      {/* ملاحظات */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><StickyNote className="h-4 w-4" /> ملاحظات المكالمة</CardTitle>
          <CardDescription>دوّن ما تم خلال المكالمة. الملاحظات محفوظة محليًا في هذه الجلسة.</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={5}
            placeholder="مثال: العميل لم يستطع طباعة الفاتورة — أعدنا تثبيت تعريف الطابعة وتم الحل."
            data-testid="textarea-call-notes" />
          <div className="flex justify-end mt-2">
            <Button variant="outline" size="sm" onClick={() => copy(notes, "الملاحظات")} disabled={!notes.trim()} className="gap-1">
              <Copy className="h-4 w-4" /> نسخ الملاحظات
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* سجل المكالمات */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2"><History className="h-4 w-4" /> سجل المكالمات</CardTitle>
              <CardDescription>آخر مكالمات الدعم الفني (حتى 300).</CardDescription>
            </div>
            <Button variant="outline" size="icon" onClick={() => { setLogsLoading(true); void refreshLogs(); }} title="تحديث">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {logsLoading ? (
            <div className="grid place-items-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : logs.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">لا توجد مكالمات مسجّلة بعد.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-call-logs">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-start py-1.5 px-2">#</th>
                    <th className="text-start py-1.5 px-2">الوكيل</th>
                    <th className="text-start py-1.5 px-2">المستخدم</th>
                    <th className="text-start py-1.5 px-2">الحالة</th>
                    <th className="text-start py-1.5 px-2">البداية</th>
                    <th className="text-start py-1.5 px-2">المدة</th>
                    <th className="text-start py-1.5 px-2">سبب الإنهاء</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map(c => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="py-1.5 px-2 text-muted-foreground">{c.id}</td>
                      <td className="py-1.5 px-2 font-medium">{c.agentUsername ?? "—"}</td>
                      <td className="py-1.5 px-2">{c.targetLabel ?? "غرفة مفتوحة"}</td>
                      <td className="py-1.5 px-2">
                        {c.status === "active" ? <Badge className="bg-emerald-600 text-white text-[10px]">نشطة</Badge>
                          : c.status === "pending" ? <Badge variant="outline" className="text-[10px]">بانتظار الرد</Badge>
                          : <Badge variant="secondary" className="text-[10px]">منتهية</Badge>}
                      </td>
                      <td className="py-1.5 px-2 text-muted-foreground">{fmt(c.createdAt)}</td>
                      <td className="py-1.5 px-2">{durationOf(c)}</td>
                      <td className="py-1.5 px-2 text-muted-foreground">
                        {c.endReason === "agent_ended" ? "أنهاها الوكيل" : c.endReason === "user_ended" ? "أنهاها المستخدم" : "—"}
                      </td>
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

function FeatureChip({
  icon: Icon, label, onClick, highlight = false,
}: { icon: any; label: string; onClick?: () => void; highlight?: boolean }) {
  const base = "flex items-center gap-2 rounded-md border px-3 py-2 text-sm";
  if (onClick) {
    return (
      <button type="button" onClick={onClick}
        className={`${base} ${highlight ? "bg-amber-500 hover:bg-amber-400 border-amber-600 text-white font-medium" : "bg-card hover:bg-accent"} transition-colors text-right`}>
        <Icon className={`h-4 w-4 ${highlight ? "text-white" : "text-emerald-600"}`} />
        <span>{label}</span>
      </button>
    );
  }
  return (
    <div className={`${base} bg-card`}>
      <Icon className="h-4 w-4 text-emerald-600" />
      <span>{label}</span>
    </div>
  );
}
