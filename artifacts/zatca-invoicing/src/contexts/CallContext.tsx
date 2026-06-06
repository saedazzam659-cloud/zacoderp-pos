// ─────────────────────────────────────────────────────────────────────────
// CallProvider — global WebRTC voice/video/screen-share engine for chat.
//
// Topology: full-mesh peer-to-peer, capped at 4 participants (≤3 remote peers
// per node). Media flows browser↔browser; the server only relays signaling
// (offer/answer/ICE/join) through the SSE stream (see chatApi call* methods +
// AuthContext call_* forwarding → callSignal bus).
//
// Peers are kept in a Map keyed by the remote user id. Each entry owns its own
// RTCPeerConnection, ICE buffer and remote MediaStream.
//
// Mesh discovery + glare-free negotiation:
//   • Whoever is "in the call" broadcasts a `join` signal (no toUserId).
//   • On receiving a `join` from an unknown peer X (while joined):
//       register X, send a point-to-point `join` ack back to X (so X learns
//       us too), then maybe-offer.
//   • Deterministic offerer = the LOWER userId of the pair, so exactly one
//     side creates the offer and there is never glare.
//   • A callee, on accept, also connects directly to the inviter (known from
//     the invite) and broadcasts its own `join`.
//   • Offer/answer/ICE are point-to-point. ICE arriving before the remote
//     description is buffered per-peer and flushed afterwards.
//
// Screen share (Phase 3): getDisplayMedia → replaceTrack on every peer's video
// sender; the original camera track is restored when sharing stops (either via
// the in-app button or the browser's native "stop sharing").
// ─────────────────────────────────────────────────────────────────────────
import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import { chatApi } from "@/lib/chatApi";
import {
  onCall, type CallInviteEvent, type CallSignalEvent, type CallEndEvent,
  type CallMedia,
} from "@/lib/callSignal";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Phone, PhoneOff, Mic, MicOff, Video as VideoIcon, VideoOff, PhoneCall,
  MonitorUp, MonitorOff,
} from "lucide-react";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

// Total participants cap (this node + remote peers).
const MAX_PARTICIPANTS = 4;

type Phase = "idle" | "outgoing" | "incoming" | "connecting" | "active";

interface ActiveCall {
  callId: string;
  conversationId: number;
  media: CallMedia;
  role: "caller" | "callee";
}

interface Peer {
  pc: RTCPeerConnection;
  name: string;
  pending: RTCIceCandidateInit[];
}

interface StartCallArgs {
  conversationId: number;
  media: CallMedia;
  participants: { userId: number; name: string }[];
}

interface CallContextValue {
  phase: Phase;
  startCall: (args: StartCallArgs) => void;
  busy: boolean;
}

const CallContext = createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within CallProvider");
  return ctx;
}

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const myId = user?.id ?? 0;
  const myName = user?.username ?? "مستخدم";

  const [phase, setPhase] = useState<Phase>("idle");
  const [incoming, setIncoming] = useState<CallInviteEvent | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  // Rendered remote tiles, keyed by remote user id. Stored as plain object so
  // React re-renders on identity change.
  const [remoteStreams, setRemoteStreams] = useState<Record<number, MediaStream>>({});
  const [remoteNames, setRemoteNames] = useState<Record<number, string>>({});

  // Mutable refs so the once-registered SSE handlers always read current state.
  const callRef = useRef<ActiveCall | null>(null);
  const peersRef = useRef<Map<number, Peer>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const joinedRef = useRef(false);
  const invitedCountRef = useRef(0);
  // Invitees (caller side) not yet resolved as a peer or a decline. Lets an
  // outgoing group call auto-end when everyone declines before connecting.
  const pendingInviteesRef = useRef(0);
  // ICE candidates that arrive before their peer connection exists, keyed by
  // remote user id. Seeded into the peer's buffer when it's created (signaling
  // is relayed over independent requests, so ICE can beat the offer/join).
  const pendingIceRef = useRef<Map<number, RTCIceCandidateInit[]>>(new Map());
  const everConnectedRef = useRef(false);
  const myIdRef = useRef(0);
  const myNameRef = useRef("مستخدم");

  useEffect(() => { myIdRef.current = myId; myNameRef.current = myName; }, [myId, myName]);

  const setPhaseSafe = useCallback((p: Phase) => { phaseRef.current = p; setPhase(p); }, []);

  // ── Teardown — close every peer + stop all local tracks ──────────────────
  const teardown = useCallback(() => {
    for (const [, peer] of peersRef.current) { try { peer.pc.close(); } catch { /* ignore */ } }
    peersRef.current.clear();
    if (localStreamRef.current) {
      for (const t of localStreamRef.current.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
    }
    localStreamRef.current = null;
    if (screenStreamRef.current) {
      for (const t of screenStreamRef.current.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
    }
    screenStreamRef.current = null;
    cameraTrackRef.current = null;
    callRef.current = null;
    joinedRef.current = false;
    invitedCountRef.current = 0;
    pendingInviteesRef.current = 0;
    pendingIceRef.current.clear();
    everConnectedRef.current = false;
    setRemoteStreams({});
    setRemoteNames({});
    setMicOn(true);
    setCamOn(true);
    setSharing(false);
    setIncoming(null);
    setPhaseSafe("idle");
  }, [setPhaseSafe]);

  // Remove a single peer; tear the whole call down once the mesh empties out
  // (1:1 always; group only after at least one peer ever connected, so an
  // early reject before others answer doesn't cancel the call).
  const removePeer = useCallback((peerId: number) => {
    const peer = peersRef.current.get(peerId);
    if (peer) { try { peer.pc.close(); } catch { /* ignore */ } peersRef.current.delete(peerId); }
    setRemoteStreams((prev) => { const n = { ...prev }; delete n[peerId]; return n; });
    setRemoteNames((prev) => { const n = { ...prev }; delete n[peerId]; return n; });
    if (peersRef.current.size === 0) {
      if (invitedCountRef.current <= 1 || everConnectedRef.current || pendingInviteesRef.current <= 0) teardown();
    }
  }, [teardown]);

  // ── Acquire local mic/camera ─────────────────────────────────────────────
  const getLocalMedia = useCallback(async (media: CallMedia): Promise<MediaStream> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: media === "video" ? { width: 640, height: 480 } : false,
    });
    localStreamRef.current = stream;
    cameraTrackRef.current = stream.getVideoTracks()[0] ?? null;
    return stream;
  }, []);

  const flushCandidates = useCallback(async (peerId: number) => {
    const peer = peersRef.current.get(peerId);
    if (!peer || !peer.pc.remoteDescription) return;
    const queued = peer.pending;
    peer.pending = [];
    for (const c of queued) {
      try { await peer.pc.addIceCandidate(c); } catch { /* ignore bad candidate */ }
    }
  }, []);

  // ── Build (or fetch) the peer connection toward a remote user ────────────
  const ensurePeer = useCallback((peerId: number, name: string): Peer => {
    const existing = peersRef.current.get(peerId);
    if (existing) {
      if (name && existing.name !== name) {
        existing.name = name;
        setRemoteNames((prev) => ({ ...prev, [peerId]: name }));
      }
      return existing;
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer: Peer = { pc, name, pending: [] };
    peersRef.current.set(peerId, peer);
    // This invitee is now a real peer → no longer "pending decline".
    pendingInviteesRef.current = Math.max(0, pendingInviteesRef.current - 1);
    // Drain any ICE that arrived before this connection existed.
    const earlyIce = pendingIceRef.current.get(peerId);
    if (earlyIce && earlyIce.length) { peer.pending.push(...earlyIce); pendingIceRef.current.delete(peerId); }
    if (name) setRemoteNames((prev) => ({ ...prev, [peerId]: name }));

    const local = localStreamRef.current;
    if (local) for (const track of local.getTracks()) pc.addTrack(track, local);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const c = callRef.current;
      if (!c) return;
      chatApi.callSignal(c.conversationId, {
        callId: c.callId, toUserId: peerId,
        signal: { kind: "ice", candidate: ev.candidate.toJSON() },
      }).catch(() => { /* ignore transient relay errors */ });
    };

    pc.ontrack = (ev) => {
      const [stream] = ev.streams;
      if (stream) setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }));
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") { everConnectedRef.current = true; setPhaseSafe("active"); }
      else if (st === "failed" || st === "closed") {
        if (phaseRef.current !== "idle") removePeer(peerId);
      }
    };

    return peer;
  }, [setPhaseSafe, removePeer]);

  // The lower userId of a pair is the deterministic offerer (glare-free).
  const maybeOffer = useCallback(async (peerId: number) => {
    if (myIdRef.current >= peerId) return; // higher id waits for the offer
    const call = callRef.current;
    const peer = peersRef.current.get(peerId);
    if (!call || !peer) return;
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await chatApi.callSignal(call.conversationId, {
        callId: call.callId, toUserId: peerId,
        signal: { kind: "offer", sdp: offer.sdp },
      });
    } catch { /* a renegotiation will be retried on next signal */ }
  }, []);

  // Establish a connection to a peer we just discovered.
  const connect = useCallback(async (peerId: number, name: string) => {
    if (peerId === myIdRef.current) return;
    if (peersRef.current.has(peerId)) return;
    if (peersRef.current.size + 1 >= MAX_PARTICIPANTS) return; // cap reached
    ensurePeer(peerId, name);
    await maybeOffer(peerId);
  }, [ensurePeer, maybeOffer]);

  // Announce our presence to everyone already in the call (broadcast join).
  const broadcastJoin = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    chatApi.callSignal(call.conversationId, {
      callId: call.callId,
      signal: { kind: "join", name: myNameRef.current },
    }).catch(() => { /* ignore */ });
  }, []);

  // ── Outgoing: start a call ───────────────────────────────────────────────
  const startCall = useCallback((args: StartCallArgs) => {
    if (phaseRef.current !== "idle") {
      toast({ title: "مكالمة جارية", description: "أنهِ المكالمة الحالية أولاً.", variant: "destructive" });
      return;
    }
    if (args.participants.length === 0) {
      toast({ title: "لا يوجد مشاركون", description: "لا يوجد طرف آخر في هذه المحادثة.", variant: "destructive" });
      return;
    }
    if (args.participants.length > MAX_PARTICIPANTS - 1) {
      toast({ title: "عدد كبير من المشاركين", description: `الحد الأقصى ${MAX_PARTICIPANTS} مشاركين في المكالمة.`, variant: "destructive" });
      return;
    }
    const callId = (crypto as any).randomUUID?.() ?? `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    callRef.current = { callId, conversationId: args.conversationId, media: args.media, role: "caller" };
    invitedCountRef.current = args.participants.length;
    pendingInviteesRef.current = args.participants.length;
    // Seed names so tiles show the right label before tracks arrive.
    setRemoteNames(Object.fromEntries(args.participants.map((p) => [p.userId, p.name])));
    setPhaseSafe("outgoing");
    (async () => {
      try {
        await getLocalMedia(args.media);
        setCamOn(args.media === "video");
        await chatApi.callInvite(args.conversationId, { callId, media: args.media });
        joinedRef.current = true;
        broadcastJoin();
      } catch (e: any) {
        toast({ title: "تعذّر بدء المكالمة", description: e?.message ?? "تحقق من إذن الميكروفون/الكاميرا.", variant: "destructive" });
        teardown();
      }
    })();
  }, [getLocalMedia, setPhaseSafe, teardown, broadcastJoin]);

  // ── Incoming: accept / reject ────────────────────────────────────────────
  const acceptIncoming = useCallback(() => {
    const inv = incoming;
    if (!inv) return;
    callRef.current = {
      callId: inv.callId, conversationId: inv.conversationId,
      media: inv.media, role: "callee",
    };
    invitedCountRef.current = 1; // at least the inviter; group joins grow the mesh
    pendingInviteesRef.current = 0; // callee isn't waiting on any invitees
    setIncoming(null);
    setPhaseSafe("connecting");
    (async () => {
      try {
        await getLocalMedia(inv.media);
        setCamOn(inv.media === "video");
        joinedRef.current = true;
        // Connect to the inviter directly, then announce ourselves so any other
        // already-joined participants discover us too.
        await connect(inv.fromUserId, inv.fromName);
        broadcastJoin();
      } catch (e: any) {
        toast({ title: "تعذّر الانضمام للمكالمة", description: e?.message ?? "تحقق من إذن الميكروفون/الكاميرا.", variant: "destructive" });
        try { await chatApi.callEnd(inv.conversationId, { callId: inv.callId, reason: "media_error" }); } catch { /* ignore */ }
        teardown();
      }
    })();
  }, [incoming, getLocalMedia, setPhaseSafe, teardown, connect, broadcastJoin]);

  const rejectIncoming = useCallback(() => {
    const inv = incoming;
    if (!inv) return;
    chatApi.callEnd(inv.conversationId, { callId: inv.callId, reason: "rejected" }).catch(() => { /* ignore */ });
    setIncoming(null);
    if (!callRef.current) setPhaseSafe("idle");
  }, [incoming, setPhaseSafe]);

  // ── Hang up — tell the mesh we're leaving, then tear down locally ────────
  const hangup = useCallback(() => {
    const c = callRef.current;
    if (c) chatApi.callEnd(c.conversationId, { callId: c.callId, reason: "hangup" }).catch(() => { /* ignore */ });
    teardown();
  }, [teardown]);

  // ── Media toggles ────────────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    const s = localStreamRef.current; if (!s) return;
    const next = !micOn;
    for (const t of s.getAudioTracks()) t.enabled = next;
    setMicOn(next);
  }, [micOn]);

  const toggleCam = useCallback(() => {
    const s = localStreamRef.current; if (!s) return;
    const next = !camOn;
    for (const t of s.getVideoTracks()) t.enabled = next;
    setCamOn(next);
  }, [camOn]);

  // Swap the outgoing video track on every peer to `track` (camera or screen).
  const replaceVideoTrackOnPeers = useCallback((track: MediaStreamTrack | null) => {
    for (const [, peer] of peersRef.current) {
      const sender = peer.pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) sender.replaceTrack(track).catch(() => { /* ignore */ });
    }
  }, []);

  const stopScreenShare = useCallback(() => {
    const cam = cameraTrackRef.current;
    replaceVideoTrackOnPeers(cam ?? null);
    if (screenStreamRef.current) {
      for (const t of screenStreamRef.current.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
    }
    screenStreamRef.current = null;
    setSharing(false);
  }, [replaceVideoTrackOnPeers]);

  const toggleScreenShare = useCallback(async () => {
    if (sharing) { stopScreenShare(); return; }
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current = screen;
      const screenTrack = screen.getVideoTracks()[0];
      if (!screenTrack) { stopScreenShare(); return; }
      // Native "Stop sharing" → restore camera.
      screenTrack.onended = () => stopScreenShare();
      replaceVideoTrackOnPeers(screenTrack);
      setSharing(true);
    } catch (e: any) {
      if (e?.name !== "NotAllowedError") {
        toast({ title: "تعذّرت مشاركة الشاشة", description: e?.message ?? "تعذّر بدء مشاركة الشاشة.", variant: "destructive" });
      }
    }
  }, [sharing, stopScreenShare, replaceVideoTrackOnPeers]);

  // ── SSE → bus handlers (registered once while signed in) ─────────────────
  useEffect(() => {
    if (!myId) return;

    const offInvite = onCall("invite", (inv: CallInviteEvent) => {
      // Already on a call → if it's the SAME call (a group join announcement
      // arriving as a fresh invite) ignore; otherwise auto-reject as busy.
      if (phaseRef.current !== "idle") {
        if (callRef.current?.callId !== inv.callId) {
          chatApi.callEnd(inv.conversationId, { callId: inv.callId, reason: "busy" }).catch(() => { /* ignore */ });
        }
        return;
      }
      setIncoming(inv);
      setPhaseSafe("incoming");
    });

    const offSignal = onCall("signal", (ev: CallSignalEvent) => {
      const call = callRef.current;
      if (!call || ev.callId !== call.callId) return;
      const from = ev.fromUserId;
      void (async () => {
        try {
          if (ev.signal.kind === "join") {
            // Someone announced themselves. Only react once joined ourselves.
            if (!joinedRef.current) return;
            if (from === myIdRef.current) return;
            if (peersRef.current.has(from)) return; // already connected/connecting
            // Ack point-to-point so they learn about us, then connect.
            chatApi.callSignal(call.conversationId, {
              callId: call.callId, toUserId: from,
              signal: { kind: "join", name: myNameRef.current },
            }).catch(() => { /* ignore */ });
            await connect(from, ev.signal.name ?? "");
          } else if (ev.signal.kind === "offer") {
            // Create the PC lazily if we hadn't discovered them yet.
            const peer = peersRef.current.get(from) ?? ensurePeer(from, ev.signal.name ?? "");
            await peer.pc.setRemoteDescription({ type: "offer", sdp: ev.signal.sdp });
            await flushCandidates(from);
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            await chatApi.callSignal(call.conversationId, {
              callId: call.callId, toUserId: from,
              signal: { kind: "answer", sdp: answer.sdp },
            });
          } else if (ev.signal.kind === "answer") {
            const peer = peersRef.current.get(from);
            if (peer) {
              await peer.pc.setRemoteDescription({ type: "answer", sdp: ev.signal.sdp });
              await flushCandidates(from);
            }
          } else if (ev.signal.kind === "ice") {
            const cand = ev.signal.candidate as RTCIceCandidateInit | undefined;
            if (!cand) return;
            const peer = peersRef.current.get(from);
            if (peer && peer.pc.remoteDescription) {
              try { await peer.pc.addIceCandidate(cand); } catch { /* ignore */ }
            } else if (peer) {
              peer.pending.push(cand);
            } else {
              // ICE beat the offer/join → buffer until the peer is created.
              const arr = pendingIceRef.current.get(from) ?? [];
              arr.push(cand);
              pendingIceRef.current.set(from, arr);
            }
          } else if (ev.signal.kind === "accept") {
            // Legacy 1:1 path: peer accepted directly → connect to them.
            if (!joinedRef.current) return;
            await connect(from, "");
          } else if (ev.signal.kind === "reject") {
            const name = peersRef.current.get(from)?.name ?? remoteNames[from] ?? "الطرف الآخر";
            toast({ title: "تم رفض المكالمة", description: `${name} رفض المكالمة.` });
            removePeer(from);
          }
        } catch {
          toast({ title: "خطأ في المكالمة", description: "حدث خطأ أثناء تأسيس الاتصال.", variant: "destructive" });
        }
      })();
    });

    const offEnd = onCall("end", (ev: CallEndEvent) => {
      const call = callRef.current;
      if (call && ev.callId === call.callId) {
        // A specific peer left the mesh; only fully end when the mesh empties.
        if (peersRef.current.has(ev.fromUserId)) {
          removePeer(ev.fromUserId);
          return;
        }
        // No matching peer yet (declined / busy before connecting). Account
        // for the lost invitee so an outgoing group call can auto-end once
        // every invitee has declined and nobody ever connected.
        pendingInviteesRef.current = Math.max(0, pendingInviteesRef.current - 1);
        pendingIceRef.current.delete(ev.fromUserId);
        if (peersRef.current.size === 0) {
          if (ev.reason === "rejected") toast({ title: "تم رفض المكالمة" });
          else if (ev.reason === "busy") toast({ title: "الطرف الآخر مشغول" });
          else toast({ title: "انتهت المكالمة" });
          if (invitedCountRef.current <= 1 || (!everConnectedRef.current && pendingInviteesRef.current <= 0)) {
            teardown();
          }
        }
        return;
      }
      setIncoming((cur) => (cur && cur.callId === ev.callId ? null : cur));
    });

    return () => { offInvite(); offSignal(); offEnd(); };
  }, [myId, ensurePeer, flushCandidates, connect, removePeer, setPhaseSafe, teardown, remoteNames]);

  // Tear the call down if the user signs out.
  useEffect(() => { if (!myId && phaseRef.current !== "idle") teardown(); }, [myId, teardown]);

  const value: CallContextValue = { phase, startCall, busy: phase !== "idle" };

  return (
    <CallContext.Provider value={value}>
      {children}
      {incoming && phase === "incoming" && (
        <IncomingCallDialog invite={incoming} onAccept={acceptIncoming} onReject={rejectIncoming} />
      )}
      {phase !== "idle" && phase !== "incoming" && callRef.current && (
        <CallOverlay
          call={callRef.current}
          phase={phase}
          localStream={localStreamRef.current}
          remoteStreams={remoteStreams}
          remoteNames={remoteNames}
          micOn={micOn}
          camOn={camOn}
          sharing={sharing}
          onToggleMic={toggleMic}
          onToggleCam={toggleCam}
          onToggleShare={toggleScreenShare}
          onHangup={hangup}
        />
      )}
    </CallContext.Provider>
  );
}

// ─── A <video> that binds a MediaStream via srcObject ────────────────────────
function VideoTile({ stream, muted, mirror, className }: {
  stream: MediaStream | null; muted?: boolean; mirror?: boolean; className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={className}
      style={mirror ? { transform: "scaleX(-1)" } : undefined}
    />
  );
}

// ─── Incoming call dialog ────────────────────────────────────────────────────
function IncomingCallDialog({ invite, onAccept, onReject }: {
  invite: CallInviteEvent; onAccept: () => void; onReject: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" dir="rtl">
      <div className="bg-card rounded-xl shadow-2xl p-6 w-[20rem] text-center space-y-4 border">
        <div className="mx-auto h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center animate-pulse">
          <PhoneCall className="h-8 w-8 text-primary" />
        </div>
        <div>
          <div className="font-bold text-lg" data-testid="text-incoming-name">{invite.fromName}</div>
          <div className="text-sm text-muted-foreground">
            {invite.media === "video" ? "مكالمة فيديو واردة…" : "مكالمة صوتية واردة…"}
          </div>
        </div>
        <div className="flex items-center justify-center gap-4">
          <Button data-testid="button-reject-call" onClick={onReject} variant="destructive" size="lg" className="rounded-full h-14 w-14 p-0">
            <PhoneOff className="h-6 w-6" />
          </Button>
          <Button data-testid="button-accept-call" onClick={onAccept} size="lg" className="rounded-full h-14 w-14 p-0 bg-green-600 hover:bg-green-700">
            <Phone className="h-6 w-6" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── In-call overlay ─────────────────────────────────────────────────────────
function CallOverlay({
  call, phase, localStream, remoteStreams, remoteNames, micOn, camOn, sharing,
  onToggleMic, onToggleCam, onToggleShare, onHangup,
}: {
  call: ActiveCall;
  phase: Phase;
  localStream: MediaStream | null;
  remoteStreams: Record<number, MediaStream>;
  remoteNames: Record<number, string>;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onToggleShare: () => void;
  onHangup: () => void;
}) {
  const isVideo = call.media === "video";
  const statusText =
    phase === "outgoing" ? "جارٍ الاتصال…"
    : phase === "connecting" ? "جارٍ التأسيس…"
    : "متصل";

  const peerIds = Object.keys(remoteStreams).map(Number);
  // Tile grid sizing: 1 remote → single, 2-3 → 2 cols.
  const cols = peerIds.length >= 2 ? "grid-cols-2" : "grid-cols-1";

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-neutral-950 text-white" dir="rtl">
      {/* Remote tiles */}
      <div className="relative flex-1 min-h-0 p-2">
        {peerIds.length === 0 ? (
          <div className="h-full w-full flex items-center justify-center">
            <div className="text-center space-y-3">
              <div className="mx-auto h-24 w-24 rounded-full bg-white/10 flex items-center justify-center text-4xl font-bold">
                {(Object.values(remoteNames)[0] || "?").slice(0, 1)}
              </div>
              <div className="text-xl font-semibold" data-testid="text-call-peer">
                {Object.values(remoteNames).join("، ") || "…"}
              </div>
            </div>
          </div>
        ) : (
          <div className={`grid ${cols} gap-2 h-full w-full`}>
            {peerIds.map((pid) => (
              <div key={pid} className="relative rounded-lg overflow-hidden bg-black flex items-center justify-center">
                {isVideo ? (
                  <VideoTile stream={remoteStreams[pid]} className="h-full w-full object-cover" />
                ) : (
                  <div className="text-center space-y-2">
                    <div className="mx-auto h-20 w-20 rounded-full bg-white/10 flex items-center justify-center text-3xl font-bold">
                      {(remoteNames[pid] || "?").slice(0, 1)}
                    </div>
                    {/* Hidden element keeps the remote audio playing. */}
                    <VideoTile stream={remoteStreams[pid]} className="hidden" />
                  </div>
                )}
                <div className="absolute bottom-1 right-2 text-xs bg-black/50 rounded px-2 py-0.5">
                  {remoteNames[pid] || "مشارك"}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="absolute top-4 inset-x-0 text-center text-sm text-white/80" data-testid="text-call-status">
          {statusText}
        </div>

        {/* Local picture-in-picture (video / screen share) */}
        {(isVideo || sharing) && (
          <div className="absolute bottom-4 left-4 h-32 w-24 rounded-lg overflow-hidden border border-white/20 bg-black shadow-lg">
            {(camOn || sharing)
              ? <VideoTile stream={localStream} muted mirror={!sharing} className="h-full w-full object-cover" />
              : <div className="h-full w-full flex items-center justify-center text-white/50"><VideoOff className="h-6 w-6" /></div>}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-4 py-6 bg-black/40">
        <Button
          data-testid="button-toggle-mic"
          onClick={onToggleMic}
          variant={micOn ? "secondary" : "destructive"}
          size="lg"
          className="rounded-full h-14 w-14 p-0"
        >
          {micOn ? <Mic className="h-6 w-6" /> : <MicOff className="h-6 w-6" />}
        </Button>

        {isVideo && (
          <Button
            data-testid="button-toggle-cam"
            onClick={onToggleCam}
            variant={camOn ? "secondary" : "destructive"}
            size="lg"
            className="rounded-full h-14 w-14 p-0"
          >
            {camOn ? <VideoIcon className="h-6 w-6" /> : <VideoOff className="h-6 w-6" />}
          </Button>
        )}

        {/* Screen share rides the camera's video sender, so it's only offered
            on video calls (audio-only calls have no video track to replace). */}
        {isVideo && (
          <Button
            data-testid="button-toggle-share"
            onClick={onToggleShare}
            variant={sharing ? "destructive" : "secondary"}
            size="lg"
            className="rounded-full h-14 w-14 p-0"
            title={sharing ? "إيقاف مشاركة الشاشة" : "مشاركة الشاشة"}
          >
            {sharing ? <MonitorOff className="h-6 w-6" /> : <MonitorUp className="h-6 w-6" />}
          </Button>
        )}

        <Button
          data-testid="button-hangup"
          onClick={onHangup}
          variant="destructive"
          size="lg"
          className="rounded-full h-16 w-16 p-0"
        >
          <PhoneOff className="h-7 w-7" />
        </Button>
      </div>
    </div>
  );
}
