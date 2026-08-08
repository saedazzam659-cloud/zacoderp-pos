import { useEffect, useRef, useState } from "react";
import { useRoute } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  GraduationCap, Radio, Loader2, LogIn, Users, Hand, Send, MessageSquare, PhoneOff, Share2,
} from "lucide-react";
import LiveRoom from "@/components/livekit/LiveRoom";
import { trainingApi, type JoinInfo } from "@/lib/liveRoomApi";
import { P2PViewer, type P2PChatMsg, type ViewerState } from "@/lib/p2pTree";

// ─────────────────────────────────────────────────────────────────────────────
// صفحة الدخول العام لقاعة التدريب — /training/join/:token
// تُعرض خارج بوابات تسجيل الدخول (مثل زووم): الزائر يكتب اسمه فقط وينضم.
//
// الانضمام يجرّب أولًا شبكة البث الموزّع P2P (مجانية بالكامل — المشاهدون
// يعيدون إرسال البث لبعضهم). لو تعذّر الاتصال المباشر (جدار ناري/شبكة)
// تسقط الصفحة تلقائيًا على LiveKit. عند منح المدرب المايك لمشاهد P2P،
// ينتقل تلقائيًا لغرفة LiveKit بتصريح «مايك فقط».
// ─────────────────────────────────────────────────────────────────────────────

type Mode =
  | { kind: "idle" }
  | { kind: "p2p" }
  | { kind: "livekit"; join: JoinInfo };

export default function TrainingJoinPublic() {
  const [, params] = useRoute("/training/join/:token");
  const token = params?.token ?? "";

  const [info, setInfo] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });

  // ── حالة مشاهد P2P ──
  const viewerRef = useRef<P2PViewer | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const chatBoxRef = useRef<HTMLDivElement>(null);
  const [p2pState, setP2pState] = useState<ViewerState>("connecting");
  const [p2pCount, setP2pCount] = useState(0);
  const [chat, setChat] = useState<P2PChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [handUp, setHandUp] = useState(false);
  const [needTap, setNeedTap] = useState(false);

  useEffect(() => {
    if (!token) { setErr("رابط غير صالح"); setLoading(false); return; }
    trainingApi.publicInfo(token)
      .then(setInfo)
      .catch((e: any) => setErr(e.message ?? "الجلسة غير موجودة"))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => () => { viewerRef.current?.stop(); viewerRef.current = null; }, []);

  useEffect(() => {
    chatBoxRef.current?.scrollTo({ top: chatBoxRef.current.scrollHeight });
  }, [chat]);

  const retriesRef = useRef(0);

  const fallbackToLivekit = async (displayName: string) => {
    try {
      const j = await trainingApi.publicJoin(token, displayName);
      setMode({ kind: "livekit", join: j });
    } catch (e: any) {
      setMode({ kind: "idle" });
      setErr(e.message ?? "تعذّر الانضمام");
    }
  };

  const join = async () => {
    const displayName = name.trim();
    if (displayName.length < 2) { setErr("يرجى كتابة اسمك (حرفان على الأقل)"); return; }
    setJoining(true); setErr(null);

    // ① جرّب شبكة البث الموزّع P2P أولًا (مجانية بالكامل)
    const v = new P2PViewer();
    viewerRef.current = v;
    v.onState = setP2pState;
    v.onViewerCount = setP2pCount;
    v.onChat = (m) => setChat(prev => [...prev.slice(-199), m]);
    v.onStream = (s) => {
      const el = videoRef.current;
      if (!el) return;
      el.srcObject = s;
      el.play().catch(() => setNeedTap(true)); // سياسات التشغيل التلقائي
    };
    v.onGranted = (g) => {
      // المدرب سمح بالمايك — انتقل لغرفة LiveKit بتصريح مايك فقط
      v.stop(); viewerRef.current = null;
      setMode({ kind: "livekit", join: { token: g.token, wsUrl: g.wsUrl, identity: g.identity, title: info?.title } });
    };
    v.onFatal = () => {
      // ② الاتصال المباشر فشل → LiveKit تلقائيًا
      viewerRef.current = null;
      void fallbackToLivekit(displayName);
    };
    v.start(token, displayName);
    setMode({ kind: "p2p" });
    setJoining(false);
  };

  const leaveP2p = () => {
    viewerRef.current?.stop(); viewerRef.current = null;
    setMode({ kind: "idle" });
    setChat([]); setHandUp(false); setP2pCount(0); setNeedTap(false);
  };

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text || !viewerRef.current) return;
    viewerRef.current.sendChat(text);
    setChat(prev => [...prev.slice(-199), { name: name.trim(), text, at: Date.now() }]);
    setChatInput("");
  };

  const toggleHand = () => {
    const up = !handUp;
    setHandUp(up);
    viewerRef.current?.raiseHand(up);
  };

  // ── غرفة LiveKit (fallback أو بعد منح المايك) ──
  if (mode.kind === "livekit") {
    return (
      <div dir="rtl" className="min-h-screen bg-background p-3 md:p-5">
        <LiveRoom
          token={mode.join.token} wsUrl={mode.join.wsUrl}
          role="subscriber"
          title={mode.join.title ?? info?.title}
          myName={name.trim()}
          onLeave={() => {
            // مغادرة مقصودة — ارجع لشاشة الانضمام
            retriesRef.current = 0;
            setMode({ kind: "idle" });
            trainingApi.publicInfo(token).then(setInfo).catch(() => {});
          }}
          onDisconnected={() => {
            // انقطاع غير مقصود — أعد المحاولة تلقائيًا (حتى 3 مرات) بدل رسالة الخطأ
            trainingApi.publicInfo(token).then(setInfo).catch(() => {});
            if (retriesRef.current < 3) {
              retriesRef.current += 1;
              setMode({ kind: "idle" });
              setErr(null);
              setTimeout(() => { void join(); }, 1500);
            } else {
              setMode({ kind: "idle" });
              setErr("انقطع الاتصال بالبث — اضغط «انضمام للجلسة» للمحاولة مرة أخرى");
            }
          }}
        />
      </div>
    );
  }

  // ── مشاهد P2P ──
  if (mode.kind === "p2p") {
    return (
      <div dir="rtl" className="min-h-screen bg-background p-3 md:p-5 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Badge className="bg-red-600 hover:bg-red-600 text-white gap-1.5">
              <Radio className="h-3.5 w-3.5 animate-pulse" />
              {p2pState === "playing" ? "مباشر" : p2pState === "waiting" ? "بانتظار المدرب..." : "جارٍ الاتصال..."}
            </Badge>
            <Badge variant="outline" className="gap-1 text-emerald-700 border-emerald-300">
              <Share2 className="h-3 w-3" /> بث موزّع
            </Badge>
            {info?.title && <span className="font-semibold text-sm">{info.title}</span>}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1"><Users className="h-3.5 w-3.5" /> {p2pCount}</Badge>
            <Button variant="destructive" size="sm" className="gap-1" onClick={leaveP2p} data-testid="btn-p2p-leave">
              <PhoneOff className="h-4 w-4" /> مغادرة
            </Button>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row gap-3 flex-1 min-h-0">
          <div className="flex-1 min-w-0 rounded-lg border bg-black/95 relative min-h-[300px] overflow-hidden">
            <video ref={videoRef} autoPlay playsInline className="w-full h-full object-contain" data-testid="video-p2p" />
            {p2pState !== "playing" && (
              <div className="absolute inset-0 grid place-items-center text-white/80 text-sm">
                <span className="flex items-center gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  {p2pState === "waiting" ? "المدرب لم يبدأ البث بعد..." : "جارٍ الاتصال بالبث الموزّع..."}
                </span>
              </div>
            )}
            {needTap && (
              <button className="absolute inset-0 grid place-items-center bg-black/70 text-white text-sm"
                onClick={() => { videoRef.current?.play().then(() => setNeedTap(false)).catch(() => {}); }}>
                اضغط لتشغيل الصوت والصورة ▶
              </button>
            )}
          </div>

          <div className="w-full lg:w-80 shrink-0 flex flex-col rounded-lg border min-h-[260px] max-h-[60vh]">
            <div className="px-2 pt-2 text-xs font-semibold flex items-center gap-1 text-muted-foreground">
              <MessageSquare className="h-3.5 w-3.5" /> الدردشة
            </div>
            <div ref={chatBoxRef} className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {chat.length === 0 && <div className="text-[11px] text-muted-foreground text-center pt-4">لا رسائل بعد</div>}
              {chat.map((m, i) => (
                <div key={i} className={`text-xs rounded-md px-2 py-1 ${m.fromTrainer ? "bg-emerald-50 border border-emerald-100" : "bg-muted/60"}`}>
                  <span className="font-semibold">{m.name}: </span>{m.text}
                </div>
              ))}
            </div>
            <div className="flex gap-1 p-2 border-t">
              <Input value={chatInput} onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); sendChat(); } }}
                placeholder="اكتب رسالة..." className="h-8 text-xs" data-testid="input-p2p-viewer-chat" />
              <Button size="sm" className="h-8 px-2" onClick={sendChat} data-testid="btn-p2p-viewer-send"><Send className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 rounded-lg border bg-card p-2">
          <Button variant={handUp ? "default" : "outline"} size="sm"
            className={`gap-1 ${handUp ? "bg-amber-500 hover:bg-amber-400" : ""}`}
            onClick={toggleHand} data-testid="btn-p2p-raise-hand">
            <Hand className="h-4 w-4" /> {handUp ? "إلغاء رفع اليد" : "رفع اليد للتحدث"}
          </Button>
          <span className="text-[11px] text-muted-foreground">عند موافقة المدرب ستنتقل تلقائيًا لوضع التحدث</span>
        </div>
      </div>
    );
  }

  // ── شاشة الانضمام ──
  return (
    <div dir="rtl" className="min-h-screen bg-muted/40 grid place-items-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-emerald-100 grid place-items-center mb-2">
            <GraduationCap className="h-6 w-6 text-emerald-700" />
          </div>
          <CardTitle className="text-lg">قاعة التدريب المباشر</CardTitle>
          <CardDescription>نظام زاكود ERP — انضمام عبر الرابط العام</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="grid place-items-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : err && !info ? (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-3 text-sm text-red-800 text-center">{err}</div>
          ) : (
            <>
              <div className="rounded-lg border p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm">{info?.title}</span>
                  {info?.status === "live" ? (
                    <Badge className="bg-red-600 hover:bg-red-600 text-white gap-1"><Radio className="h-3 w-3 animate-pulse" /> مباشر الآن</Badge>
                  ) : info?.status === "ended" ? (
                    <Badge variant="secondary">انتهت</Badge>
                  ) : (
                    <Badge variant="outline">لم تبدأ بعد</Badge>
                  )}
                </div>
                {info?.description && <p className="text-xs text-muted-foreground">{info.description}</p>}
                {info?.trainerName && <p className="text-[11px] text-muted-foreground">المدرب: {info.trainerName}</p>}
              </div>

              {info?.status === "ended" ? (
                <div className="text-sm text-center text-muted-foreground py-2">هذه الجلسة انتهت — شكرًا لاهتمامك.</div>
              ) : (
                <>
                  <div>
                    <Label className="text-xs">اسمك الظاهر في الجلسة *</Label>
                    <Input value={name} onChange={e => setName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") void join(); }}
                      className="mt-1" placeholder="مثال: أحمد محمد" data-testid="input-public-name" />
                  </div>
                  {err && <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{err}</div>}
                  <Button className="w-full gap-1 bg-emerald-600 hover:bg-emerald-500" onClick={join}
                    disabled={joining || info?.status !== "live"} data-testid="btn-public-join">
                    {joining ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                    {info?.status === "live" ? "انضمام للجلسة" : "بانتظار بدء البث..."}
                  </Button>
                  {info?.status !== "live" && (
                    <p className="text-[11px] text-center text-muted-foreground">حدّث الصفحة عندما يبدأ المدرب البث.</p>
                  )}
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
