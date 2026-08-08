// ─────────────────────────────────────────────────────────────────────────────
// محرك البث الموزّع (P2P Relay Tree) — الطرف الأمامي.
//
// البث ينتقل من المدرب لعدد صغير من المشاهدين مباشرة (WebRTC)، وكل مشاهد
// يعيد إرسال المسارات لأبنائه في الشجرة. السيرفر يقوم بالتعارف فقط
// (WebSocket signaling) — لا فيديو يمر عبره إطلاقًا.
//
// STUN عام مجاني فقط (لا TURN) — المتصفح الذي يفشل في الاتصال المباشر
// يسقط تلقائيًا على LiveKit (تتكفل به صفحة الانضمام).
// ─────────────────────────────────────────────────────────────────────────────

const ICE: RTCConfiguration = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    // TURN مجاني (Open Relay) — ضروري لشبكات الجوال/NAT الصارم حيث يفشل STUN وحده
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turns:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function wsBase(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${API_BASE}/api/training-room/p2p/ws`;
}

type Json = Record<string, unknown>;

export interface P2PChatMsg { name: string; text: string; fromTrainer?: boolean; at: number }
export interface P2PHand { peerId: string; name: string }

// ═══ مشترك: قناة إشارات فوق WebSocket ═══
class SignalSocket {
  ws: WebSocket | null = null;
  onMessage: (msg: any) => void = () => {};
  onClose: () => void = () => {};
  onOpen: () => void = () => {};
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  connect(url: string) {
    this.stopPing();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.closed) return;
      // keep-alive: وسيط النشر يقطع اتصالات WS الخاملة — نرسل ping كل 25 ثانية
      this.stopPing();
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), 25000);
      this.onOpen();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg?.type === "pong") return;
        this.onMessage(msg);
      } catch { /* ignore */ }
    };
    ws.onclose = () => { this.stopPing(); if (!this.closed) this.onClose(); };
    ws.onerror = () => { /* onclose يتكفل */ };
  }
  private stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
  send(msg: Json) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }
  close() {
    this.closed = true;
    this.stopPing();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}

/** اتصال WebRTC هابط (نحو طفل): نعرض عليه مساراتنا الحالية. */
async function makeOfferPc(opts: {
  tracks: MediaStreamTrack[];
  stream: MediaStream;
  signal: (data: Json) => void;
  onFail: () => void;
}): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection(ICE);
  for (const t of opts.tracks) pc.addTrack(t, opts.stream);
  pc.onicecandidate = (e) => { if (e.candidate) opts.signal({ ice: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") opts.onFail();
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  opts.signal({ sdp: pc.localDescription });
  return pc;
}

async function handleAnswerSide(pc: RTCPeerConnection, data: any) {
  if (data?.sdp) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  else if (data?.ice) { try { await pc.addIceCandidate(new RTCIceCandidate(data.ice)); } catch { /* ignore */ } }
}

// ═══════════════════════════════ المدرب ═══════════════════════════════
export class P2PBroadcaster {
  private sock = new SignalSocket();
  private children = new Map<string, RTCPeerConnection>();
  private stream: MediaStream = new MediaStream();

  onViewerCount: (n: number) => void = () => {};
  onChat: (m: P2PChatMsg) => void = () => {};
  onHand: (h: P2PHand, up: boolean) => void = () => {};
  onError: (msg: string) => void = () => {};
  /** حالة اتصال قناة البث الموزّع — للعرض في واجهة المدرب. */
  onStatus: (s: "connected" | "reconnecting") => void = () => {};

  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  start(sessionId: number) {
    this.sock.onMessage = (msg) => void this.handle(msg);
    this.sock.onOpen = () => this.onStatus("connected");
    // انقطاع الشبكة أو قطع الوسيط — أعد الاتصال تلقائيًا ما دام المدرب داخل الغرفة
    this.sock.onClose = () => {
      if (this.stopped) return;
      this.onStatus("reconnecting");
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => { if (!this.stopped) this.dial(sessionId); }, 2000);
    };
    this.dial(sessionId);
  }

  private dial(sessionId: number) {
    const auth = localStorage.getItem("zatca_token") ?? "";
    this.sock.connect(`${wsBase()}?role=broadcaster&session=${sessionId}&auth=${encodeURIComponent(auth)}`);
  }

  /** يستبدل مسارات البث الحالية (كاميرا/مايك/شاشة) ويحدّث كل الأبناء. */
  async setStream(tracks: MediaStreamTrack[]) {
    this.stream = new MediaStream(tracks);
    for (const [childId, pc] of this.children) {
      try {
        await this.syncTracks(pc, tracks, childId);
      } catch { /* اتصال الطفل سيعاد بناؤه عند فشله */ }
    }
  }

  private async syncTracks(pc: RTCPeerConnection, tracks: MediaStreamTrack[], childId: string) {
    const senders = pc.getSenders();
    const used = new Set<RTCRtpSender>();
    for (const t of tracks) {
      const s = senders.find(x => !used.has(x) && x.track?.kind === t.kind);
      if (s) { used.add(s); if (s.track !== t) await s.replaceTrack(t); }
      else pc.addTrack(t, this.stream);
    }
    for (const s of senders) {
      if (!used.has(s) && s.track) { try { pc.removeTrack(s); } catch { /* ignore */ } }
    }
    // إعادة تفاوض
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.sock.send({ type: "signal", to: childId, data: { sdp: pc.localDescription } });
  }

  sendChat(text: string) { this.sock.send({ type: "chat", text }); }
  grantMic(peerId: string) { this.sock.send({ type: "grant", peerId }); }

  private async handle(msg: any) {
    switch (msg?.type) {
      case "viewer-count": this.onViewerCount(Number(msg.n) || 0); break;
      case "chat": this.onChat({ name: String(msg.name ?? "مشاهد"), text: String(msg.text ?? ""), fromTrainer: !!msg.fromTrainer, at: Date.now() }); break;
      case "hand": this.onHand({ peerId: String(msg.peerId), name: String(msg.name ?? "") }, msg.up === true); break;
      case "error": this.onError(String(msg.message ?? "خطأ")); break;
      case "add-child": {
        const childId = String(msg.childId);
        this.closeChild(childId);
        try {
          const pc = await makeOfferPc({
            tracks: this.stream.getTracks(), stream: this.stream,
            signal: (data) => this.sock.send({ type: "signal", to: childId, data }),
            onFail: () => this.closeChild(childId),
          });
          this.children.set(childId, pc);
        } catch { /* ignore */ }
        break;
      }
      case "child-gone": this.closeChild(String(msg.childId)); break;
      case "signal": {
        const pc = this.children.get(String(msg.from));
        if (pc) await handleAnswerSide(pc, msg.data);
        break;
      }
    }
  }

  private closeChild(childId: string) {
    const pc = this.children.get(childId);
    if (pc) { try { pc.close(); } catch { /* ignore */ } this.children.delete(childId); }
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const [, pc] of this.children) { try { pc.close(); } catch { /* ignore */ } }
    this.children.clear();
    this.sock.close();
  }
}

// ═══════════════════════════════ المشاهد ═══════════════════════════════
export type ViewerState = "connecting" | "waiting" | "playing" | "failed";

export class P2PViewer {
  private sock = new SignalSocket();
  private upstream: RTCPeerConnection | null = null;
  private downstream = new Map<string, RTCPeerConnection>();
  private remoteStream = new MediaStream();
  private parentId: string | null = null;
  private stopped = false;
  private playTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  peerId = "";
  onState: (s: ViewerState) => void = () => {};
  onStream: (s: MediaStream) => void = () => {};
  onViewerCount: (n: number) => void = () => {};
  onChat: (m: P2PChatMsg) => void = () => {};
  onGranted: (g: { token: string; wsUrl: string; identity: string }) => void = () => {};
  onFatal: (reason: string) => void = () => {};

  private timeoutMs = 12000;

  /** timeoutMs: مهلة الوصول لأول فيديو بعد تعيين الأب قبل إعلان الفشل (fallback لـ LiveKit). */
  start(publicToken: string, name: string, timeoutMs = 12000) {
    this.timeoutMs = timeoutMs;
    this.onState("connecting");
    this.sock.onMessage = (msg) => void this.handle(msg);
    this.sock.onClose = () => {
      if (this.stopped) return;
      // إن كنا ما زلنا ننتظر البث (لا فيديو بعد) فأعد الاتصال بصمت بدل الفشل —
      // وسيط النشر قد يقطع الاتصال الخامل أثناء الانتظار الطويل
      if (this.remoteStream.getTracks().length === 0) {
        this.clearPlayTimer();
        this.onState("waiting");
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          if (!this.stopped) this.sock.connect(`${wsBase()}?role=viewer&token=${encodeURIComponent(publicToken)}&name=${encodeURIComponent(name)}`);
        }, 2000);
        return;
      }
      this.fail("انقطع الاتصال بالخادم");
    };
    this.sock.connect(`${wsBase()}?role=viewer&token=${encodeURIComponent(publicToken)}&name=${encodeURIComponent(name)}`);
    // لا مؤقّت فشل هنا — يبدأ فقط عند parent-assigned (أي عندما يكون المدرب متصلًا فعلًا)
  }

  /** مؤقّت الفشل يعمل فقط عندما يكون المدرب متصلًا فعلًا — لا نفشل أثناء «بانتظار المدرب». */
  private armPlayTimer(ms = this.timeoutMs) {
    if (this.playTimer) clearTimeout(this.playTimer);
    this.playTimer = setTimeout(() => {
      if (this.remoteStream.getTracks().length === 0) this.fail("تعذّر الوصول للبث الموزّع في الوقت المحدد");
    }, ms);
  }

  private clearPlayTimer() {
    if (this.playTimer) { clearTimeout(this.playTimer); this.playTimer = null; }
  }

  sendChat(text: string) { this.sock.send({ type: "chat", text }); }
  raiseHand(up: boolean) { this.sock.send({ type: "hand", up }); }

  private fail(reason: string) {
    if (this.stopped) return;
    this.stop();
    this.onState("failed");
    this.onFatal(reason);
  }

  private async handle(msg: any) {
    switch (msg?.type) {
      case "welcome":
        this.peerId = String(msg.peerId ?? "");
        if (!msg.broadcasterOnline) {
          // المدرب غير متصل بعد — انتظر بلا مهلة فشل؛ السيرفر سيعلّقنا عندما يدخل
          this.clearPlayTimer();
          this.onState("waiting");
        }
        break;
      case "no-parent":
      case "broadcaster-gone":
        // لا مكان في الشجرة أو المدرب خرج — انتظر عودته بدون مهلة فشل
        this.clearPlayTimer();
        this.onState("waiting");
        this.closeUpstream();
        break;
      case "parent-assigned":
        this.parentId = String(msg.parentId);
        this.closeUpstream(); // سيصلنا offer جديد من الأب
        this.onState("connecting");
        this.armPlayTimer(); // الآن المدرب متصل — مهلة الوصول للفيديو تبدأ من هنا
        break;
      case "viewer-count": this.onViewerCount(Number(msg.n) || 0); break;
      case "chat": this.onChat({ name: String(msg.name ?? "مشاهد"), text: String(msg.text ?? ""), fromTrainer: !!msg.fromTrainer, at: Date.now() }); break;
      case "granted": this.onGranted({ token: String(msg.token), wsUrl: String(msg.wsUrl), identity: String(msg.identity) }); break;
      case "error": this.fail(String(msg.message ?? "خطأ")); break;
      case "add-child": await this.addChild(String(msg.childId)); break;
      case "child-gone": {
        const pc = this.downstream.get(String(msg.childId));
        if (pc) { try { pc.close(); } catch { /* ignore */ } this.downstream.delete(String(msg.childId)); }
        break;
      }
      case "signal": {
        const from = String(msg.from);
        if (from === this.parentId || from === "__root__") {
          await this.handleUpstreamSignal(msg.data);
        } else {
          const pc = this.downstream.get(from);
          if (pc) await handleAnswerSide(pc, msg.data);
        }
        break;
      }
    }
  }

  // ── الاتجاه الصاعد (من الأب إلينا): نستقبل offer ونرد answer ──
  private async handleUpstreamSignal(data: any) {
    if (data?.sdp && data.sdp.type === "offer") {
      if (!this.upstream) {
        const pc = new RTCPeerConnection(ICE);
        this.upstream = pc;
        pc.onicecandidate = (e) => {
          if (e.candidate && this.parentId) this.sock.send({ type: "signal", to: this.parentId, data: { ice: e.candidate.toJSON() } });
        };
        pc.ontrack = (e) => {
          for (const t of e.streams[0]?.getTracks() ?? [e.track]) {
            if (!this.remoteStream.getTracks().includes(t)) this.remoteStream.addTrack(t);
            t.onended = () => { try { this.remoteStream.removeTrack(t); } catch { /* ignore */ } this.onStream(this.remoteStream); };
          }
          if (this.playTimer) { clearTimeout(this.playTimer); this.playTimer = null; }
          this.onState("playing");
          this.onStream(this.remoteStream);
          void this.refreshDownstream();
        };
        pc.onconnectionstatechange = () => {
          if ((pc.connectionState === "failed" || pc.connectionState === "disconnected") && !this.stopped) {
            // الأب سقط — السيرفر سيعيد تعليقنا؛ لو لم يحدث خلال مهلة نفشل
            this.closeUpstream();
            this.onState("connecting");
            if (!this.playTimer) {
              this.playTimer = setTimeout(() => this.fail("انقطع البث ولم تنجح إعادة الاتصال"), 15000);
            }
          }
        };
      }
      const pc = this.upstream;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (this.parentId) this.sock.send({ type: "signal", to: this.parentId, data: { sdp: pc.localDescription } });
    } else if (data?.ice && this.upstream) {
      try { await this.upstream.addIceCandidate(new RTCIceCandidate(data.ice)); } catch { /* ignore */ }
    }
  }

  private closeUpstream() {
    if (this.upstream) { try { this.upstream.close(); } catch { /* ignore */ } this.upstream = null; }
    // أفرغ المسارات القديمة
    for (const t of this.remoteStream.getTracks()) { try { this.remoteStream.removeTrack(t); } catch { /* ignore */ } }
  }

  // ── الاتجاه الهابط (منا لطفل): نعيد إرسال ما نستقبله ──
  private async addChild(childId: string) {
    const old = this.downstream.get(childId);
    if (old) { try { old.close(); } catch { /* ignore */ } }
    try {
      const pc = await makeOfferPc({
        tracks: this.remoteStream.getTracks(), stream: this.remoteStream,
        signal: (data) => this.sock.send({ type: "signal", to: childId, data }),
        onFail: () => {
          const cur = this.downstream.get(childId);
          if (cur) { try { cur.close(); } catch { /* ignore */ } this.downstream.delete(childId); }
        },
      });
      this.downstream.set(childId, pc);
    } catch {
      // لا نستطيع إعادة الإرسال — نعلن أننا ورقة
      this.sock.send({ type: "relay-capacity", canRelay: false });
    }
  }

  /** عند تغيّر مساراتنا المستقبلة، حدّث كل الأبناء (إعادة تفاوض). */
  private async refreshDownstream() {
    const tracks = this.remoteStream.getTracks();
    for (const [childId, pc] of this.downstream) {
      try {
        const senders = pc.getSenders();
        const used = new Set<RTCRtpSender>();
        for (const t of tracks) {
          const s = senders.find(x => !used.has(x) && x.track?.kind === t.kind);
          if (s) { used.add(s); if (s.track !== t) await s.replaceTrack(t); }
          else pc.addTrack(t, this.remoteStream);
        }
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.sock.send({ type: "signal", to: childId, data: { sdp: pc.localDescription } });
      } catch { /* ignore */ }
    }
  }

  stop() {
    this.stopped = true;
    if (this.playTimer) { clearTimeout(this.playTimer); this.playTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.closeUpstream();
    for (const [, pc] of this.downstream) { try { pc.close(); } catch { /* ignore */ } }
    this.downstream.clear();
    this.sock.close();
  }
}
