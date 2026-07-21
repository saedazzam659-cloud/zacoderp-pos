import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Room, RoomEvent, Track, ConnectionState,
  type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant,
  type LocalParticipant, type Participant, createLocalScreenTracks,
} from "livekit-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Mic, MicOff, Camera, CameraOff, MonitorUp, MonitorX,
  PhoneOff, Users, Hand, Send, MessageSquare, Radio, Loader2,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// LiveRoom — shared in-app Arabic LiveKit room UI.
//
// Used by three surfaces:
//   • قاعة التدريب المباشر (trainer = publisher, trainees = subscribe-only)
//   • public trainee join page
//   • غرفة الدعم الفني (both sides publishers)
//
// Chat + raise-hand ride the LiveKit DATA CHANNEL as small JSON messages:
//   { t: "chat", name, text }               — broadcast chat line
//   { t: "hand", identity, name, up }       — trainee raised/lowered hand
// Mic grants are SERVER-enforced (RoomService.updateParticipant) — the client
// only reflects the permission via ParticipantPermissionsChanged.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatMsg { id: string; name: string; text: string; me?: boolean; at: number }
export interface HandRaise { identity: string; name: string; at: number }

export interface LiveRoomProps {
  token: string;
  wsUrl: string;
  /** publisher = يبث كاميرا/مايك/شاشة فورًا؛ subscriber = مشاهدة فقط + رفع يد */
  role: "publisher" | "subscriber";
  title?: string;
  myName: string;
  /** يظهر زر منح المايك بجانب الأيدي المرفوعة (المدرب فقط) */
  canGrantMic?: boolean;
  onGrantMic?: (identity: string, allow: boolean) => Promise<void> | void;
  onLeave: () => void;
  /** true → ابدأ الكاميرا والمايك فور الاتصال (غرفة الدعم) */
  autoPublishAv?: boolean;
  /** إخفاء الدردشة (اختياري) */
  hideChat?: boolean;
  /** يُستدعى كلما تغيّرت مسارات النشر المحلية (للبث الموزّع P2P) */
  onLocalTracksChanged?: (tracks: MediaStreamTrack[]) => void;
}

function decodeData(payload: Uint8Array): any | null {
  try { return JSON.parse(new TextDecoder().decode(payload)); } catch { return null; }
}
const enc = new TextEncoder();

export default function LiveRoom(props: LiveRoomProps) {
  const { token, wsUrl, role, title, myName, canGrantMic, onGrantMic, onLeave, autoPublishAv, hideChat, onLocalTracksChanged } = props;
  const localTracksCbRef = useRef(onLocalTracksChanged);
  localTracksCbRef.current = onLocalTracksChanged;

  const roomRef = useRef<Room | null>(null);
  const [connState, setConnState] = useState<"connecting" | "connected" | "reconnecting" | "failed">("connecting");
  const [participants, setParticipants] = useState<number>(0);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [canPublishMic, setCanPublishMic] = useState(role === "publisher");
  const [handUp, setHandUp] = useState(false);
  const [hands, setHands] = useState<HandRaise[]>([]);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [videoEls, setVideoEls] = useState<{ id: string; kind: "camera" | "screen"; name: string; el: HTMLMediaElement }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const chatBoxRef = useRef<HTMLDivElement>(null);
  const audioHostRef = useRef<HTMLDivElement>(null);
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;

  const refreshCount = useCallback((room: Room) => {
    setParticipants(room.remoteParticipants.size + 1);
  }, []);

  const attachTrack = useCallback((track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.setAttribute("data-lk-audio", pub.trackSid);
      audioHostRef.current?.appendChild(el);
      return;
    }
    const el = track.attach();
    el.style.width = "100%"; el.style.height = "100%"; el.style.objectFit = "contain";
    const kind = pub.source === Track.Source.ScreenShare ? "screen" : "camera";
    setVideoEls(prev => [...prev.filter(v => v.id !== pub.trackSid),
      { id: pub.trackSid, kind, name: p.name || p.identity, el }]);
  }, []);

  const detachTrack = useCallback((_track: RemoteTrack, pub: RemoteTrackPublication) => {
    _track.detach().forEach(e => e.remove());
    setVideoEls(prev => prev.filter(v => v.id !== pub.trackSid));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room
      .on(RoomEvent.TrackSubscribed, attachTrack)
      .on(RoomEvent.TrackUnsubscribed, detachTrack)
      .on(RoomEvent.ParticipantConnected, () => refreshCount(room))
      .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
        refreshCount(room);
        setHands(prev => prev.filter(h => h.identity !== p.identity));
      })
      .on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
        if (s === ConnectionState.Connected) setConnState("connected");
        else if (s === ConnectionState.Reconnecting) setConnState("reconnecting");
      })
      .on(RoomEvent.Disconnected, () => { if (!cancelled) leaveRef.current(); })
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p: Participant) => {
        if (p === room.localParticipant) {
          const can = !!room.localParticipant.permissions?.canPublish;
          setCanPublishMic(can || role === "publisher");
          if (!can && role === "subscriber") {
            // المدرب سحب المايك — أوقف النشر محليًا
            room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
            setMicOn(false);
          }
        }
      })
      .on(RoomEvent.LocalTrackPublished, () => emitLocalTracks(room))
      .on(RoomEvent.LocalTrackUnpublished, () => emitLocalTracks(room))
      .on(RoomEvent.DataReceived, (payload, p) => {
        const msg = decodeData(payload);
        if (!msg) return;
        if (msg.t === "chat") {
          setChat(prev => [...prev.slice(-199), {
            id: `${Date.now()}-${Math.random()}`, name: String(msg.name ?? p?.name ?? "مشارك"),
            text: String(msg.text ?? "").slice(0, 500), at: Date.now(),
          }]);
        } else if (msg.t === "hand") {
          const identity = String(msg.identity ?? p?.identity ?? "");
          if (!identity) return;
          setHands(prev => msg.up
            ? (prev.some(h => h.identity === identity) ? prev
              : [...prev, { identity, name: String(msg.name ?? identity), at: Date.now() }])
            : prev.filter(h => h.identity !== identity));
        }
      });

    (async () => {
      try {
        await room.connect(wsUrl, token);
        if (cancelled) { room.disconnect(); return; }
        setConnState("connected");
        refreshCount(room);
        if (role === "publisher" && autoPublishAv) {
          try {
            await room.localParticipant.setMicrophoneEnabled(true);
            setMicOn(true);
          } catch { /* المستخدم رفض إذن المايك */ }
          try {
            await room.localParticipant.setCameraEnabled(true);
            setCamOn(true);
            attachLocalCamera(room.localParticipant);
          } catch { /* رفض إذن الكاميرا */ }
        }
      } catch (e: any) {
        if (!cancelled) { setConnState("failed"); setErr(String(e?.message ?? e)); }
      }
    })();

    return () => {
      cancelled = true;
      try { room.disconnect(); } catch { /* ignore */ }
      roomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, wsUrl]);

  const emitLocalTracks = (room: Room) => {
    const cb = localTracksCbRef.current;
    if (!cb) return;
    const tracks: MediaStreamTrack[] = [];
    for (const pub of room.localParticipant.trackPublications.values()) {
      const mst = pub.track?.mediaStreamTrack;
      if (mst && mst.readyState === "live") tracks.push(mst);
    }
    cb(tracks);
  };

  const attachLocalCamera = (lp: LocalParticipant) => {
    const pub = lp.getTrackPublication(Track.Source.Camera);
    const track = pub?.track;
    if (!track) return;
    const el = track.attach();
    el.style.width = "100%"; el.style.height = "100%"; el.style.objectFit = "contain";
    (el as HTMLVideoElement).muted = true;
    setVideoEls(prev => [...prev.filter(v => v.id !== "local-cam"),
      { id: "local-cam", kind: "camera", name: `${myName} (أنت)`, el }]);
  };

  const toggleMic = async () => {
    const room = roomRef.current; if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!micOn);
      setMicOn(!micOn);
    } catch { setErr("تعذّر تشغيل الميكروفون — تحقق من إذن المتصفح"); }
  };

  const toggleCam = async () => {
    const room = roomRef.current; if (!room) return;
    try {
      await room.localParticipant.setCameraEnabled(!camOn);
      if (!camOn) attachLocalCamera(room.localParticipant);
      else setVideoEls(prev => prev.filter(v => v.id !== "local-cam"));
      setCamOn(!camOn);
    } catch { setErr("تعذّر تشغيل الكاميرا — تحقق من إذن المتصفح"); }
  };

  const toggleScreen = async () => {
    const room = roomRef.current; if (!room) return;
    try {
      if (!screenOn) {
        const tracks = await createLocalScreenTracks({ audio: false });
        for (const t of tracks) await room.localParticipant.publishTrack(t, { source: Track.Source.ScreenShare });
        setScreenOn(true);
      } else {
        const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
        if (pub?.track) { await room.localParticipant.unpublishTrack(pub.track); pub.track.stop(); }
        setScreenOn(false);
      }
    } catch { /* المستخدم ألغى نافذة اختيار الشاشة */ }
  };

  const sendData = (obj: Record<string, unknown>) => {
    const room = roomRef.current; if (!room) return;
    room.localParticipant.publishData(enc.encode(JSON.stringify(obj)), { reliable: true }).catch(() => {});
  };

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    sendData({ t: "chat", name: myName, text });
    setChat(prev => [...prev.slice(-199), { id: `${Date.now()}-me`, name: myName, text, me: true, at: Date.now() }]);
    setChatInput("");
  };

  const toggleHand = () => {
    const room = roomRef.current; if (!room) return;
    const up = !handUp;
    setHandUp(up);
    sendData({ t: "hand", identity: room.localParticipant.identity, name: myName, up });
  };

  useEffect(() => {
    chatBoxRef.current?.scrollTo({ top: chatBoxRef.current.scrollHeight });
  }, [chat]);

  // ترتيب العرض: الشاشة المشاركة أولًا (أكبر)، ثم الكاميرات
  const ordered = useMemo(
    () => [...videoEls].sort((a, b) => (a.kind === "screen" ? -1 : 0) - (b.kind === "screen" ? -1 : 0)),
    [videoEls],
  );

  return (
    <div className="flex flex-col gap-3 h-full min-h-[60vh]" data-testid="live-room">
      {/* شريط الحالة */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Badge className="bg-red-600 hover:bg-red-600 text-white gap-1.5">
            <Radio className="h-3.5 w-3.5 animate-pulse" />
            {connState === "connected" ? "مباشر" : connState === "reconnecting" ? "إعادة اتصال..." : connState === "failed" ? "فشل الاتصال" : "جارٍ الاتصال..."}
          </Badge>
          {title && <span className="font-semibold text-sm">{title}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1"><Users className="h-3.5 w-3.5" /> {participants}</Badge>
          <Button variant="destructive" size="sm" className="gap-1" onClick={onLeave} data-testid="btn-leave-room">
            <PhoneOff className="h-4 w-4" /> مغادرة
          </Button>
        </div>
      </div>

      {err && <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{err}</div>}

      <div className="flex flex-col lg:flex-row gap-3 flex-1 min-h-0">
        {/* منطقة الفيديو */}
        <div className="flex-1 min-w-0 rounded-lg border bg-black/95 p-2 relative min-h-[300px]">
          {connState === "connecting" && (
            <div className="absolute inset-0 grid place-items-center text-white/80 text-sm gap-2">
              <span className="flex items-center gap-2"><Loader2 className="h-5 w-5 animate-spin" /> جارٍ الاتصال بالبث...</span>
            </div>
          )}
          {connState === "connected" && ordered.length === 0 && (
            <div className="absolute inset-0 grid place-items-center text-white/60 text-sm">
              لا يوجد بث فيديو حاليًا — الصوت يعمل تلقائيًا عند توفره
            </div>
          )}
          <div className={`grid gap-2 h-full ${ordered.length <= 1 ? "grid-cols-1" : ordered.length <= 4 ? "grid-cols-2" : "grid-cols-3"}`}>
            {ordered.map(v => (
              <div key={v.id} className={`relative rounded overflow-hidden bg-black ${v.kind === "screen" && ordered.length > 1 ? "col-span-full row-span-2" : ""}`}
                ref={node => { if (node && v.el.parentElement !== node) { node.innerHTML = ""; node.appendChild(v.el); } }}>
                <span className="absolute bottom-1 start-1 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
                  {v.kind === "screen" ? `🖥️ ${v.name}` : v.name}
                </span>
              </div>
            ))}
          </div>
          <div ref={audioHostRef} className="hidden" />
        </div>

        {/* اللوحة الجانبية: دردشة + أيدي مرفوعة */}
        {!hideChat && (
          <div className="w-full lg:w-80 shrink-0 flex flex-col rounded-lg border min-h-[260px] max-h-[60vh]">
            {canGrantMic && hands.length > 0 && (
              <div className="border-b p-2 space-y-1 bg-amber-50/60">
                <div className="text-xs font-semibold flex items-center gap-1 text-amber-800">
                  <Hand className="h-3.5 w-3.5" /> أيدي مرفوعة ({hands.length})
                </div>
                {hands.map(h => (
                  <div key={h.identity} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">{h.name}</span>
                    <span className="flex gap-1">
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                        onClick={() => onGrantMic?.(h.identity, true)} data-testid={`btn-grant-mic-${h.identity}`}>
                        <Mic className="h-3 w-3 me-1" /> سماح
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
                        onClick={() => { onGrantMic?.(h.identity, false); setHands(prev => prev.filter(x => x.identity !== h.identity)); }}>
                        <MicOff className="h-3 w-3" />
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="px-2 pt-2 text-xs font-semibold flex items-center gap-1 text-muted-foreground">
              <MessageSquare className="h-3.5 w-3.5" /> الدردشة
            </div>
            <div ref={chatBoxRef} className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {chat.length === 0 && <div className="text-[11px] text-muted-foreground text-center pt-4">لا رسائل بعد</div>}
              {chat.map(m => (
                <div key={m.id} className={`text-xs rounded-md px-2 py-1 ${m.me ? "bg-emerald-50 border border-emerald-100" : "bg-muted/60"}`}>
                  <span className="font-semibold">{m.name}: </span>{m.text}
                </div>
              ))}
            </div>
            <div className="flex gap-1 p-2 border-t">
              <Input value={chatInput} onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); sendChat(); } }}
                placeholder="اكتب رسالة..." className="h-8 text-xs" data-testid="input-chat" />
              <Button size="sm" className="h-8 px-2" onClick={sendChat} data-testid="btn-send-chat"><Send className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        )}
      </div>

      {/* شريط التحكم السفلي */}
      <div className="flex items-center justify-center gap-2 flex-wrap rounded-lg border bg-card p-2">
        {(role === "publisher" || canPublishMic) && (
          <Button variant={micOn ? "default" : "outline"} size="sm" className="gap-1" onClick={toggleMic} data-testid="btn-toggle-mic">
            {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />} {micOn ? "المايك يعمل" : "تشغيل المايك"}
          </Button>
        )}
        {role === "publisher" && (
          <>
            <Button variant={camOn ? "default" : "outline"} size="sm" className="gap-1" onClick={toggleCam} data-testid="btn-toggle-cam">
              {camOn ? <Camera className="h-4 w-4" /> : <CameraOff className="h-4 w-4" />} {camOn ? "الكاميرا تعمل" : "تشغيل الكاميرا"}
            </Button>
            <Button variant={screenOn ? "default" : "outline"} size="sm" className="gap-1" onClick={toggleScreen} data-testid="btn-toggle-screen">
              {screenOn ? <MonitorX className="h-4 w-4" /> : <MonitorUp className="h-4 w-4" />} {screenOn ? "إيقاف مشاركة الشاشة" : "مشاركة الشاشة"}
            </Button>
          </>
        )}
        {role === "subscriber" && (
          <Button variant={handUp ? "default" : "outline"} size="sm" className={`gap-1 ${handUp ? "bg-amber-500 hover:bg-amber-400" : ""}`}
            onClick={toggleHand} data-testid="btn-raise-hand">
            <Hand className="h-4 w-4" /> {handUp ? "إلغاء رفع اليد" : "رفع اليد للتحدث"}
          </Button>
        )}
        {role === "subscriber" && canPublishMic && !micOn && (
          <span className="text-[11px] text-emerald-700 font-medium">✓ المدرب سمح لك بالتحدث — شغّل المايك</span>
        )}
      </div>
    </div>
  );
}
