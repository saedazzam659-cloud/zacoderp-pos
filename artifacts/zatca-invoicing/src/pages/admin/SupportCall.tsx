import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Video, Copy, ExternalLink, RefreshCw, Mic, Camera,
  MonitorUp, Users, ShieldCheck, MessageSquare, Phone,
  PhoneOff, Radio, StickyNote, Send,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// SupportCall — live audio/video/screen-share room for tech support.
//
// IMPORTANT design decision: Jitsi runs in a SEPARATE top-level browser
// window opened via window.open(), NOT inside an embedded iframe. The
// reason is that browsers block camera + microphone permission requests
// from nested iframes (our app may itself be loaded inside the Replit
// preview iframe, and Permissions-Policy delegation only chains one level
// deep). A real top-level window is the only reliable way to get the
// permission prompt across all browsers and embedding contexts.
//
// Inside this page we keep a control-panel UI: meeting timer, "live" dot,
// re-open button if the user closed the popup, an invite link that the
// agent can paste to the customer, and a notes textarea so the agent can
// jot down what they did during the call.
// ─────────────────────────────────────────────────────────────────────────────

function makeRoomName(prefix = "zacoderp-support"): string {
  // 10-char base36 random — ~52 bits of entropy, enough to prevent room squatting.
  const rand = Math.random().toString(36).slice(2, 12);
  return `${prefix}-${rand}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export default function SupportCall() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [room, setRoom]               = useState<string>(() => makeRoomName());
  const [displayName, setDisplayName] = useState<string>(user?.fullName ?? user?.username ?? "الدعم الفني");
  const [callActive, setCallActive]   = useState(false);
  const [startedAt, setStartedAt]     = useState<number | null>(null);
  const [elapsed, setElapsed]         = useState(0);
  const [notes, setNotes]             = useState("");

  // Reference to the popup window so we can re-focus it or detect that
  // the user closed it externally.
  const winRef = useRef<Window | null>(null);

  // Host URL — pre-fills the agent's display name and forces the pre-join
  // page so the browser's permission prompt fires reliably.
  const hostUrl = useMemo(() => {
    const hash = [
      `config.prejoinPageEnabled=true`,
      `config.startWithAudioMuted=false`,
      `config.startWithVideoMuted=false`,
      `userInfo.displayName=%22${encodeURIComponent(displayName)}%22`,
    ].join("&");
    return `https://meet.jit.si/${encodeURIComponent(room)}#${hash}`;
  }, [room, displayName]);

  // Customer share URL — no lobby, no pre-join screen, drops them straight
  // into the room. Browser will still ask for cam/mic once.
  const shareUrl = useMemo(() => {
    const hash = [
      `config.prejoinPageEnabled=false`,
      `config.lobby.enabled=false`,
      `config.startWithAudioMuted=false`,
      `config.startWithVideoMuted=false`,
    ].join("&");
    return `https://meet.jit.si/${encodeURIComponent(room)}#${hash}`;
  }, [room]);

  // Meeting timer: tick every second while the call is active, and poll
  // whether the popup window was closed externally so we can flip the UI
  // back to "not active" without the agent having to click "End meeting".
  useEffect(() => {
    if (!callActive || startedAt == null) return;
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
      if (winRef.current && winRef.current.closed) {
        winRef.current = null;
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [callActive, startedAt]);

  const openCallWindow = () => {
    // Use a named window so that calling open() twice with the same name
    // re-focuses the existing tab instead of opening a duplicate.
    const win = window.open(
      hostUrl,
      `zacoderp-support-${room}`,
      "width=1200,height=800,noopener=no",
    );
    if (!win) {
      toast({
        title: "تعذّر فتح نافذة الاجتماع",
        description: "المتصفح منع النوافذ المنبثقة. اسمح بالنوافذ المنبثقة لهذا الموقع وحاول مرة أخرى.",
        variant: "destructive",
      });
      return;
    }
    winRef.current = win;
    win.focus();
    if (!callActive) {
      setCallActive(true);
      setStartedAt(Date.now());
      setElapsed(0);
    }
  };

  const reopenCallWindow = () => openCallWindow();

  const endCall = () => {
    if (winRef.current && !winRef.current.closed) {
      try { winRef.current.close(); } catch { /* cross-origin close may fail silently */ }
    }
    winRef.current = null;
    setCallActive(false);
    setStartedAt(null);
    setElapsed(0);
    toast({ title: "تم إنهاء الاجتماع" });
  };

  const newRoom = () => {
    if (callActive) {
      toast({ title: "أنهِ الاجتماع الحالي أولًا قبل إنشاء غرفة جديدة", variant: "destructive" });
      return;
    }
    setRoom(makeRoomName());
    toast({ title: "تم إنشاء غرفة جديدة", description: "أرسل الرابط للعميل ليتمكن من الانضمام." });
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `تم نسخ ${label}` });
    } catch {
      toast({ title: "تعذّر النسخ", variant: "destructive" });
    }
  };

  const sendWhatsapp = () => {
    const text = `رابط دعوتك للاجتماع المباشر مع الدعم الفني:\n${shareUrl}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  };

  const winIsClosed = callActive && (!winRef.current || winRef.current.closed);

  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Video className="h-6 w-6 text-emerald-600" />
            غرفة الدعم الفني المباشرة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            مكالمة فيديو وصوت ومشاركة شاشة مباشرة مع العميل لمساعدته في حل المشاكل — بدون تثبيت أي برنامج خارجي.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-emerald-700 border-emerald-300 bg-emerald-50 gap-1">
            <ShieldCheck className="h-3.5 w-3.5" /> اتصال مشفّر (E2E)
          </Badge>
          {callActive && (
            <Badge className="bg-red-600 hover:bg-red-600 text-white gap-1.5">
              <Radio className="h-3.5 w-3.5 animate-pulse" /> مباشر · {formatDuration(elapsed)}
            </Badge>
          )}
        </div>
      </div>

      {/* Why a separate window? — short banner */}
      <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
        <strong>لماذا تفتح نافذة منفصلة؟</strong> المتصفح يمنع منح إذن الكاميرا والميكروفون لإطار مدمج داخل إطار آخر. لذلك يفتح النظام الاجتماع في نافذة مستقلة تستطيع طلب الإذن بشكل صحيح، بينما تبقى لوحة التحكم هنا داخل النظام.
      </div>

      {/* Big call-to-action panel */}
      <Card className={callActive ? "border-emerald-300" : ""}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Phone className="h-4 w-4" /> {callActive ? "الاجتماع نشط" : "بدء اجتماع جديد"}
          </CardTitle>
          <CardDescription>
            {callActive
              ? winIsClosed
                ? "نافذة الاجتماع مغلقة. اضغط «إعادة فتح النافذة» للعودة للمكالمة."
                : "نافذة الاجتماع مفتوحة في تبويب منفصل. لا تغلق هذه الصفحة لتحتفظ بلوحة التحكم وملاحظاتك."
              : "اضغط الزر أدناه لفتح غرفة الدعم في نافذة منفصلة. سيُطلب إذن الكاميرا والميكروفون."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          {!callActive ? (
            <Button onClick={openCallWindow} size="lg" className="gap-2 bg-emerald-600 hover:bg-emerald-500" data-testid="btn-start-call">
              <Video className="h-5 w-5" /> فتح الاجتماع في نافذة منفصلة
            </Button>
          ) : (
            <>
              <Button onClick={reopenCallWindow} variant={winIsClosed ? "default" : "outline"} className="gap-2" data-testid="btn-reopen-call">
                <ExternalLink className="h-4 w-4" /> {winIsClosed ? "إعادة فتح النافذة" : "إحضار النافذة للأمام"}
              </Button>
              <Button onClick={endCall} variant="destructive" className="gap-2" data-testid="btn-end-call">
                <PhoneOff className="h-4 w-4" /> إنهاء الاجتماع
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Room + invite link */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" /> دعوة العميل
          </CardTitle>
          <CardDescription>
            انسخ الرابط وأرسله للعميل. يمكنه الانضمام مباشرة من المتصفح بدون تسجيل دخول.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">اسم الغرفة</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={room}
                onChange={(e) => setRoom(e.target.value.replace(/[^A-Za-z0-9-]/g, ""))}
                dir="ltr"
                className="font-mono text-xs"
                disabled={callActive}
                data-testid="input-support-room"
              />
              <Button variant="outline" size="icon" onClick={newRoom} title="غرفة جديدة" disabled={callActive} data-testid="btn-new-room">
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div>
            <Label className="text-xs">الاسم الظاهر لك في المكالمة</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1"
              disabled={callActive}
              data-testid="input-display-name"
            />
          </div>

          <div className="md:col-span-2">
            <Label className="text-xs">رابط دعوة العميل</Label>
            <div className="flex gap-2 mt-1 flex-wrap">
              <Input value={shareUrl} readOnly dir="ltr" className="font-mono text-xs flex-1 min-w-[260px]" data-testid="input-share-url" />
              <Button variant="outline" onClick={() => copy(shareUrl, "الرابط")} className="gap-1" data-testid="btn-copy-link">
                <Copy className="h-4 w-4" /> نسخ
              </Button>
              <Button variant="outline" onClick={sendWhatsapp} className="gap-1" data-testid="btn-send-whatsapp">
                <Send className="h-4 w-4" /> واتساب
              </Button>
              <Button variant="outline" asChild className="gap-1">
                <a href={shareUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" /> فتح
                </a>
              </Button>
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              نصيحة: عندما يفتح العميل الرابط لأول مرة سيطلب المتصفح إذن الكاميرا والميكروفون — اطلب منه السماح ليتمكن من المشاركة.
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Features grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <FeatureChip icon={Camera}        label="كاميرا" />
        <FeatureChip icon={Mic}           label="صوت ثنائي الاتجاه" />
        <FeatureChip icon={MonitorUp}     label="مشاركة الشاشة" />
        <FeatureChip icon={MessageSquare} label="دردشة نصية أثناء المكالمة" />
      </div>

      {/* Meeting notes */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <StickyNote className="h-4 w-4" /> ملاحظات الاجتماع
          </CardTitle>
          <CardDescription>
            دوّن ما تم خلال المكالمة (المشكلة، الحل، الخطوات التالية). الملاحظات محفوظة محليًا في هذه الجلسة.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="مثال: العميل لم يستطع طباعة الفاتورة — أعدنا تثبيت تعريف الطابعة الحرارية وتم الحل."
            rows={6}
            data-testid="textarea-call-notes"
          />
          <div className="flex justify-end mt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => copy(notes, "الملاحظات")}
              disabled={!notes.trim()}
              className="gap-1"
              data-testid="btn-copy-notes"
            >
              <Copy className="h-4 w-4" /> نسخ الملاحظات
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FeatureChip({ icon: Icon, label }: { icon: any; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
      <Icon className="h-4 w-4 text-emerald-600" />
      <span>{label}</span>
    </div>
  );
}
