import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Radio, Users, PlayCircle, StopCircle, Share2, Hand, Mic, Send } from "lucide-react";
import LiveRoom from "@/components/livekit/LiveRoom";
import { trainingApi, type JoinInfo } from "@/lib/liveRoomApi";
import { P2PBroadcaster, type P2PChatMsg, type P2PHand } from "@/lib/p2pTree";
import { useAuth } from "@/contexts/AuthContext";

// ─────────────────────────────────────────────────────────────────────────────
// بث قاعة التدريب على مستوى التطبيق كله:
// غرفة LiveKit + محرك البث الموزّع P2P يعيشان هنا (فوق الراوتر) حتى يستمر
// البث أثناء تنقّل المدرب بين كل شاشات النظام (شجرة الحسابات، الفواتير، ...).
// عند التصغير يظهر شريط عائم ثابت أسفل الشاشة في كل الصفحات.
// ─────────────────────────────────────────────────────────────────────────────

export interface BroadcastSession {
  id: number;
  title: string;
  allowPublic: boolean;
}

type LiveState = JoinInfo & { session: BroadcastSession; asTrainer: boolean };

interface Ctx {
  live: LiveState | null;
  minimized: boolean;
  p2pCount: number;
  /** فتح الغرفة (مدرب أو متدرب) — تبقى حيّة حتى الإنهاء الصريح */
  goLive: (info: JoinInfo, session: BroadcastSession, asTrainer: boolean) => void;
  /** العودة لواجهة الغرفة الكاملة */
  restore: () => void;
  /** إنهاء الجلسة للجميع (استدعاء API ثم إغلاق الغرفة) */
  endSession: (sessionId: number) => Promise<void>;
  /** خروج المتدرب فقط (بدون إنهاء الجلسة) */
  leave: () => void;
}

const TrainingBroadcastContext = createContext<Ctx | null>(null);

export function useTrainingBroadcast(): Ctx {
  const v = useContext(TrainingBroadcastContext);
  if (!v) throw new Error("useTrainingBroadcast must be used within TrainingBroadcastProvider");
  return v;
}

export function TrainingBroadcastProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [live, setLive] = useState<LiveState | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [ending, setEnding] = useState(false);

  // البث الموزّع P2P (الرابط العام)
  const p2pRef = useRef<P2PBroadcaster | null>(null);
  const [p2pCount, setP2pCount] = useState(0);
  const [p2pStatus, setP2pStatus] = useState<"connected" | "reconnecting">("reconnecting");
  const [p2pChat, setP2pChat] = useState<P2PChatMsg[]>([]);
  const [p2pHands, setP2pHands] = useState<P2PHand[]>([]);
  const [p2pInput, setP2pInput] = useState("");
  const p2pChatBoxRef = useRef<HTMLDivElement>(null);

  const goLive = useCallback((info: JoinInfo, session: BroadcastSession, asTrainer: boolean) => {
    setLive({ ...info, session, asTrainer });
    setMinimized(false);
  }, []);

  const restore = useCallback(() => setMinimized(false), []);

  const leave = useCallback(() => { setLive(null); setMinimized(false); }, []);

  const endSession = useCallback(async (sessionId: number) => {
    setEnding(true);
    try {
      await trainingApi.end(sessionId);
      toast({ title: "تم إنهاء الجلسة" });
      setLive(prev => (prev?.session.id === sessionId ? null : prev));
      setMinimized(false);
    } catch (e: any) {
      toast({ title: "تعذّر الإنهاء", description: e.message, variant: "destructive" });
    } finally { setEnding(false); }
  }, [toast]);

  const grantMic = useCallback(async (identity: string, allow: boolean) => {
    if (!live) return;
    try { await trainingApi.mic(live.session.id, identity, allow); }
    catch (e: any) { toast({ title: "تعذّر تحديث المايك", description: e.message, variant: "destructive" }); }
  }, [live, toast]);

  // إذا سجّل المستخدم خروجه — أغلق الغرفة
  useEffect(() => { if (!user && live) { setLive(null); setMinimized(false); } }, [user, live]);

  // ── تشغيل/إيقاف محرك البث الموزّع مع دخول/خروج المدرب من الغرفة ──
  useEffect(() => {
    if (!live?.asTrainer || !live.session.allowPublic) return;
    const eng = new P2PBroadcaster();
    eng.onViewerCount = setP2pCount;
    eng.onChat = (m) => setP2pChat(prev => [...prev.slice(-199), m]);
    eng.onHand = (h, up) => setP2pHands(prev => up
      ? (prev.some(x => x.peerId === h.peerId) ? prev : [...prev, h])
      : prev.filter(x => x.peerId !== h.peerId));
    eng.onError = (m) => toast({ title: m, variant: "destructive" });
    eng.onStatus = setP2pStatus;
    eng.start(live.session.id);
    p2pRef.current = eng;
    return () => {
      eng.stop();
      if (p2pRef.current === eng) p2pRef.current = null;
      setP2pCount(0); setP2pChat([]); setP2pHands([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.session.id, live?.asTrainer, live?.session.allowPublic]);

  useEffect(() => {
    p2pChatBoxRef.current?.scrollTo({ top: p2pChatBoxRef.current.scrollHeight });
  }, [p2pChat]);

  const sendP2pChat = () => {
    const text = p2pInput.trim();
    if (!text || !p2pRef.current) return;
    p2pRef.current.sendChat(text);
    setP2pInput("");
  };

  const p2pActive = !!live && live.asTrainer && live.session.allowPublic;

  return (
    <TrainingBroadcastContext.Provider value={{ live, minimized, p2pCount, goLive, restore, endSession, leave }}>
      {children}

      {/* ── الغرفة الكاملة — طبقة فوق كل الصفحات، تبقى محمّلة (مخفية فقط) عند التصغير ── */}
      {live && (
        <div className={minimized
          ? "hidden"
          : "fixed inset-0 z-40 bg-background overflow-y-auto p-4 md:p-6 flex flex-col gap-2"}>
          <div className="flex-1 min-h-0">
            <LiveRoom
              token={live.token} wsUrl={live.wsUrl}
              role={live.asTrainer ? "publisher" : "subscriber"}
              title={live.session.title}
              myName={user?.username ?? "مشارك"}
              canGrantMic={live.asTrainer}
              onGrantMic={grantMic}
              autoPublishAv={live.asTrainer}
              onLocalTracksChanged={p2pActive ? (tracks) => { void p2pRef.current?.setStream(tracks); } : undefined}
              onLeave={() => {
                if (live.asTrainer) {
                  // لا نغلق الغرفة — البث يستمر أثناء التنقل بين كل الشاشات
                  setMinimized(true);
                  toast({
                    title: "البث مستمر في الخلفية",
                    description: "تنقّل بين أي شاشة بحرّية — البث لن ينقطع. استخدم الشريط الأخضر أسفل الشاشة للعودة أو الإنهاء.",
                  });
                } else {
                  leave();
                }
              }}
            />
          </div>
          {p2pActive && (
            <div className="rounded-lg border bg-card p-2 shrink-0">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <Share2 className="h-3.5 w-3.5 text-emerald-600" />
                  البث الموزّع (الرابط العام)
                  <Badge variant="outline" className="gap-1"><Users className="h-3 w-3" /> {p2pCount} مشاهد</Badge>
                  {p2pStatus === "connected"
                    ? <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600 text-white" data-testid="badge-p2p-status">متصل</Badge>
                    : <Badge variant="destructive" className="gap-1 animate-pulse" data-testid="badge-p2p-status">جارٍ الاتصال…</Badge>}
                </div>
                {p2pHands.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] text-amber-700 font-medium flex items-center gap-1">
                      <Hand className="h-3 w-3" /> أيدي مرفوعة:
                    </span>
                    {p2pHands.map(h => (
                      <Button key={h.peerId} size="sm" variant="outline" className="h-6 px-2 text-[11px] gap-1"
                        onClick={() => { p2pRef.current?.grantMic(h.peerId); setP2pHands(prev => prev.filter(x => x.peerId !== h.peerId)); }}
                        data-testid={`btn-p2p-grant-${h.peerId}`}>
                        <Mic className="h-3 w-3" /> {h.name}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              <div ref={p2pChatBoxRef} className="mt-1.5 max-h-24 overflow-y-auto space-y-1">
                {p2pChat.map((m, i) => (
                  <div key={i} className={`text-[11px] rounded px-2 py-0.5 ${m.fromTrainer ? "bg-emerald-50" : "bg-muted/60"}`}>
                    <span className="font-semibold">{m.name}: </span>{m.text}
                  </div>
                ))}
              </div>
              <div className="flex gap-1 mt-1.5">
                <Input value={p2pInput} onChange={e => setP2pInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); sendP2pChat(); } }}
                  placeholder="رسالة لمشاهدي الرابط العام..." className="h-7 text-xs" data-testid="input-p2p-chat" />
                <Button size="sm" className="h-7 px-2" onClick={sendP2pChat} data-testid="btn-p2p-send"><Send className="h-3 w-3" /></Button>
              </div>
            </div>
          )}
          {live.asTrainer && (
            <div className="flex justify-end shrink-0">
              <Button variant="destructive" size="sm" className="gap-1" disabled={ending}
                onClick={() => { void endSession(live.session.id); }}>
                <StopCircle className="h-4 w-4" /> إنهاء الجلسة للجميع
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── شريط عائم في كل الصفحات أثناء البث المصغّر ── */}
      {live && minimized && (
        <div className="fixed bottom-3 inset-x-3 md:inset-x-auto md:left-6 md:right-auto z-40 rounded-lg border border-emerald-300 bg-emerald-50 dark:bg-emerald-950 shadow-lg p-2.5 flex items-center gap-3 flex-wrap"
          data-testid="floating-broadcast-bar">
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-200">
            <Radio className="h-4 w-4 animate-pulse text-red-600" />
            {live.asTrainer ? "البث مستمر" : "أنت في الجلسة"} — «{live.session.title}»
            {live.asTrainer && live.session.allowPublic && (
              <Badge variant="outline" className="gap-1"><Users className="h-3 w-3" /> {p2pCount}</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" className="gap-1 h-7 bg-emerald-600 hover:bg-emerald-500" onClick={restore} data-testid="btn-restore-broadcast">
              <PlayCircle className="h-4 w-4" /> العودة للبث
            </Button>
            {live.asTrainer ? (
              <Button size="sm" variant="destructive" className="gap-1 h-7" disabled={ending}
                onClick={() => { void endSession(live.session.id); }}>
                <StopCircle className="h-4 w-4" /> إنهاء
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="gap-1 h-7" onClick={leave}>
                <StopCircle className="h-4 w-4" /> مغادرة
              </Button>
            )}
          </div>
        </div>
      )}
    </TrainingBroadcastContext.Provider>
  );
}
