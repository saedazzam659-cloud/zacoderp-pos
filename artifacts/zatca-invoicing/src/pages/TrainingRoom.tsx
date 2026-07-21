import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  GraduationCap, Plus, Radio, Copy, Users, PlayCircle, StopCircle,
  LogIn, ListChecks, Link2, RefreshCw, Loader2,
} from "lucide-react";
import LiveRoom from "@/components/livekit/LiveRoom";
import { trainingApi, type JoinInfo } from "@/lib/liveRoomApi";

// ─────────────────────────────────────────────────────────────────────────────
// قاعة التدريب المباشر — trainer console + trainee join (module: training_room)
// المدرب: إنشاء جلسة، بدء البث (كاميرا/مايك/شاشة)، نسخ الرابط العام، منح المايك
// عند رفع اليد، سجل الحضور. المتدرب المسجّل: انضمام مشاهدة فقط + دردشة + رفع يد.
// ─────────────────────────────────────────────────────────────────────────────

interface SessionRow {
  id: number; title: string; description: string | null; trainerUserId: number;
  trainerName: string | null; status: string; allowRegistered: boolean; allowPublic: boolean;
  publicToken: string | null; scheduledAt: string | null; startedAt: string | null;
  endedAt: string | null; createdAt: string;
}

function fmtDate(v: string | null): string {
  if (!v) return "—";
  try { return new Date(v).toLocaleString("ar-SA-u-nu-latn", { dateStyle: "short", timeStyle: "short" }); } catch { return v; }
}

export default function TrainingRoom() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  // إنشاء جلسة
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [allowRegistered, setAllowRegistered] = useState(true);
  const [allowPublic, setAllowPublic] = useState(false);
  const [saving, setSaving] = useState(false);

  // غرفة نشطة (مدرب أو متدرب)
  const [live, setLive] = useState<(JoinInfo & { session: SessionRow; asTrainer: boolean }) | null>(null);

  // سجل الحضور
  const [attFor, setAttFor] = useState<SessionRow | null>(null);
  const [attRows, setAttRows] = useState<any[]>([]);
  const [attLoading, setAttLoading] = useState(false);

  const refresh = useCallback(async () => {
    try { setRows(await trainingApi.list()); }
    catch (e: any) { toast({ title: "تعذّر تحميل الجلسات", description: e.message, variant: "destructive" }); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const publicUrl = (s: SessionRow) =>
    s.publicToken ? `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/training/join/${s.publicToken}` : null;

  const copyLink = async (s: SessionRow) => {
    const url = publicUrl(s);
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast({ title: "تم نسخ الرابط العام" }); }
    catch { toast({ title: "تعذّر النسخ", variant: "destructive" }); }
  };

  const createSession = async () => {
    if (title.trim().length < 3) { toast({ title: "عنوان الجلسة مطلوب (3 أحرف على الأقل)", variant: "destructive" }); return; }
    setSaving(true);
    try {
      await trainingApi.create({ title: title.trim(), description: description.trim() || undefined, allowRegistered, allowPublic });
      setCreateOpen(false); setTitle(""); setDescription(""); setAllowRegistered(true); setAllowPublic(false);
      toast({ title: "تم إنشاء الجلسة" });
      void refresh();
    } catch (e: any) { toast({ title: "فشل الإنشاء", description: e.message, variant: "destructive" }); }
    finally { setSaving(false); }
  };

  const startBroadcast = async (s: SessionRow) => {
    setBusyId(s.id);
    try {
      const info = await trainingApi.start(s.id);
      setLive({ ...info, session: s, asTrainer: true });
      void refresh();
    } catch (e: any) { toast({ title: "تعذّر بدء البث", description: e.message, variant: "destructive" }); }
    finally { setBusyId(null); }
  };

  const joinAsTrainee = async (s: SessionRow) => {
    setBusyId(s.id);
    try {
      const info = await trainingApi.join(s.id);
      setLive({ ...info, session: s, asTrainer: false });
    } catch (e: any) { toast({ title: "تعذّر الانضمام", description: e.message, variant: "destructive" }); }
    finally { setBusyId(null); }
  };

  const endSession = async (s: SessionRow) => {
    setBusyId(s.id);
    try {
      await trainingApi.end(s.id);
      toast({ title: "تم إنهاء الجلسة" });
      if (live?.session.id === s.id) setLive(null);
      void refresh();
    } catch (e: any) { toast({ title: "تعذّر الإنهاء", description: e.message, variant: "destructive" }); }
    finally { setBusyId(null); }
  };

  const openAttendance = async (s: SessionRow) => {
    setAttFor(s); setAttLoading(true);
    try { setAttRows(await trainingApi.attendance(s.id)); }
    catch (e: any) { toast({ title: "تعذّر تحميل الحضور", description: e.message, variant: "destructive" }); }
    finally { setAttLoading(false); }
  };

  const grantMic = useCallback(async (identity: string, allow: boolean) => {
    if (!live) return;
    try { await trainingApi.mic(live.session.id, identity, allow); }
    catch (e: any) { toast({ title: "تعذّر تحديث المايك", description: e.message, variant: "destructive" }); }
  }, [live, toast]);

  const canManage = (s: SessionRow) =>
    s.trainerUserId === user?.id || user?.role === "admin" || user?.role === "superadmin";

  const sorted = useMemo(() =>
    [...rows].sort((a, b) => (a.status === "live" ? -1 : 0) - (b.status === "live" ? -1 : 0)), [rows]);

  // ── داخل الغرفة ──
  if (live) {
    return (
      <div className="p-4 md:p-6 h-[calc(100vh-6rem)]">
        <LiveRoom
          token={live.token} wsUrl={live.wsUrl}
          role={live.asTrainer ? "publisher" : "subscriber"}
          title={live.session.title}
          myName={user?.username ?? "مشارك"}
          canGrantMic={live.asTrainer}
          onGrantMic={grantMic}
          autoPublishAv={live.asTrainer}
          onLeave={() => { setLive(null); void refresh(); }}
        />
        {live.asTrainer && (
          <div className="mt-2 flex justify-end">
            <Button variant="destructive" size="sm" className="gap-1" onClick={() => endSession(live.session)}>
              <StopCircle className="h-4 w-4" /> إنهاء الجلسة للجميع
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GraduationCap className="h-6 w-6 text-emerald-600" /> قاعة التدريب المباشر
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            بث مباشر للتدريب: المدرب يشارك الشاشة والصوت والكاميرا، والمتدربون يشاهدون ويتفاعلون بالدردشة ورفع اليد — حتى 1000 متدرب.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => { setLoading(true); void refresh(); }} title="تحديث">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button className="gap-1 bg-emerald-600 hover:bg-emerald-500" onClick={() => setCreateOpen(true)} data-testid="btn-new-session">
            <Plus className="h-4 w-4" /> جلسة جديدة
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="grid place-items-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : sorted.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">
          لا توجد جلسات بعد — أنشئ أول جلسة تدريب من زر «جلسة جديدة».
        </CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {sorted.map(s => (
            <Card key={s.id} className={s.status === "live" ? "border-emerald-300" : ""} data-testid={`session-card-${s.id}`}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{s.title}</CardTitle>
                  {s.status === "live" ? (
                    <Badge className="bg-red-600 hover:bg-red-600 text-white gap-1 shrink-0">
                      <Radio className="h-3 w-3 animate-pulse" /> مباشر
                    </Badge>
                  ) : s.status === "ended" ? (
                    <Badge variant="secondary" className="shrink-0">منتهية</Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">مجدولة</Badge>
                  )}
                </div>
                <CardDescription className="text-xs">
                  المدرب: {s.trainerName ?? "—"} · أُنشئت {fmtDate(s.createdAt)}
                  {s.startedAt && <> · بدأت {fmtDate(s.startedAt)}</>}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {s.description && <p className="text-xs text-muted-foreground line-clamp-2">{s.description}</p>}
                <div className="flex gap-1.5 flex-wrap text-[11px]">
                  {s.allowRegistered && <Badge variant="outline" className="gap-1"><Users className="h-3 w-3" /> مستخدمون مسجّلون</Badge>}
                  {s.allowPublic && <Badge variant="outline" className="gap-1"><Link2 className="h-3 w-3" /> رابط عام</Badge>}
                </div>
                <div className="flex gap-1.5 flex-wrap pt-1">
                  {s.status !== "ended" && canManage(s) && (
                    <Button size="sm" className="gap-1 bg-emerald-600 hover:bg-emerald-500" disabled={busyId === s.id}
                      onClick={() => startBroadcast(s)} data-testid={`btn-start-${s.id}`}>
                      <PlayCircle className="h-4 w-4" /> {s.status === "live" ? "العودة للبث" : "بدء البث"}
                    </Button>
                  )}
                  {s.status === "live" && !canManage(s) && s.allowRegistered && (
                    <Button size="sm" className="gap-1" disabled={busyId === s.id} onClick={() => joinAsTrainee(s)} data-testid={`btn-join-${s.id}`}>
                      <LogIn className="h-4 w-4" /> انضمام
                    </Button>
                  )}
                  {s.allowPublic && s.publicToken && (
                    <Button size="sm" variant="outline" className="gap-1" onClick={() => copyLink(s)} data-testid={`btn-copy-link-${s.id}`}>
                      <Copy className="h-3.5 w-3.5" /> نسخ الرابط العام
                    </Button>
                  )}
                  {canManage(s) && (
                    <Button size="sm" variant="outline" className="gap-1" onClick={() => openAttendance(s)}>
                      <ListChecks className="h-3.5 w-3.5" /> الحضور
                    </Button>
                  )}
                  {s.status === "live" && canManage(s) && (
                    <Button size="sm" variant="destructive" className="gap-1" disabled={busyId === s.id} onClick={() => endSession(s)}>
                      <StopCircle className="h-4 w-4" /> إنهاء
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* إنشاء جلسة */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>جلسة تدريب جديدة</DialogTitle>
            <DialogDescription>حدد عنوان الجلسة وطريقة دخول المتدربين.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">عنوان الجلسة *</Label>
              <Input value={title} onChange={e => setTitle(e.target.value)} className="mt-1" placeholder="مثال: شرح شاشة الفواتير" data-testid="input-session-title" />
            </div>
            <div>
              <Label className="text-xs">الوصف (اختياري)</Label>
              <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className="mt-1" />
            </div>
            <div className="flex items-center justify-between rounded-md border p-2.5">
              <div>
                <div className="text-sm font-medium">مستخدمون مسجّلون</div>
                <div className="text-[11px] text-muted-foreground">مستخدمو شركتك ينضمّون من داخل النظام</div>
              </div>
              <Switch checked={allowRegistered} onCheckedChange={setAllowRegistered} data-testid="switch-allow-registered" />
            </div>
            <div className="flex items-center justify-between rounded-md border p-2.5">
              <div>
                <div className="text-sm font-medium">رابط عام (مثل زووم)</div>
                <div className="text-[11px] text-muted-foreground">أي شخص لديه الرابط يدخل باسمه فقط — بدون تسجيل</div>
              </div>
              <Switch checked={allowPublic} onCheckedChange={setAllowPublic} data-testid="switch-allow-public" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>إلغاء</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-500" onClick={createSession} disabled={saving} data-testid="btn-create-session">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "إنشاء"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* سجل الحضور */}
      <Dialog open={!!attFor} onOpenChange={o => { if (!o) setAttFor(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>سجل الحضور — {attFor?.title}</DialogTitle>
            <DialogDescription>كل صف = دخول واحد للجلسة (المسجّلون والعامّون).</DialogDescription>
          </DialogHeader>
          {attLoading ? (
            <div className="grid place-items-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : attRows.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-6">لا يوجد حضور مسجّل بعد.</div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-muted-foreground">
                    <th className="text-start py-1.5 px-2">الاسم</th>
                    <th className="text-start py-1.5 px-2">النوع</th>
                    <th className="text-start py-1.5 px-2">وقت الدخول</th>
                  </tr>
                </thead>
                <tbody>
                  {attRows.map((a: any) => (
                    <tr key={a.id} className="border-b last:border-0">
                      <td className="py-1.5 px-2 font-medium">{a.displayName}</td>
                      <td className="py-1.5 px-2">{a.isPublic ? <Badge variant="outline" className="text-[10px]">رابط عام</Badge> : <Badge variant="secondary" className="text-[10px]">مسجّل</Badge>}</td>
                      <td className="py-1.5 px-2 text-muted-foreground">{fmtDate(a.joinedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
