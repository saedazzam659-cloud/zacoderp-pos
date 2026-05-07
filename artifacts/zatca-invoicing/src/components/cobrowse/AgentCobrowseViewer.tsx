import { useEffect, useRef, useState, useCallback } from "react";
import rrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";
import { apiCobrowse, buildCobrowseWsUrl } from "@/lib/cobrowseClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { Eye, MonitorUp, MousePointer2, Copy, PhoneOff } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────
// AgentCobrowseViewer
//
// Shown inside the SupportCall page. The agent clicks "Start co-browse",
// the server creates a session, and we display the invite link to copy /
// send to the customer.
//
// While active we render rrweb-player and stream events from the WS hub
// directly into player.addEvent(). When the agent has been granted
// control, clicks/keys inside the player iframe are translated to relative
// coordinates and shipped to the customer for replay.
// ─────────────────────────────────────────────────────────────────────────

type ControlState = "none" | "requested" | "granted";

interface SessionRow {
  id: number;
  inviteToken: string;
  state: string;
  controlState: ControlState | string;
  agentUsername: string | null;
}

function hasCobrowseControlPerm(user: any): boolean {
  if (!user) return false;
  if (user.role === "superadmin" || user.role === "admin") return true;
  const p = user.permissions ?? {};
  return Boolean(p?.support_cobrowse?.control);
}

export default function AgentCobrowseViewer() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [session, setSession] = useState<SessionRow | null>(null);
  const [customerLabel, setCustomerLabel] = useState("");
  const [peerJoined, setPeerJoined] = useState(false);
  const [controlState, setControlState] = useState<ControlState>("none");
  const [busy, setBusy] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<any>(null);
  const playerHostRef = useRef<HTMLDivElement | null>(null);
  const eventBufferRef = useRef<any[]>([]);
  const playerReadyRef = useRef(false);

  const inviteUrl = session
    ? `${window.location.origin}${import.meta.env.BASE_URL}?cobrowse=${encodeURIComponent(session.inviteToken)}`
    : "";

  const canControl = hasCobrowseControlPerm(user);

  const tearDown = useCallback(() => {
    try { wsRef.current?.close(); } catch { /* ignore */ }
    wsRef.current = null;
    try { playerRef.current?.pause?.(); } catch { /* ignore */ }
    playerRef.current = null;
    if (playerHostRef.current) playerHostRef.current.innerHTML = "";
    eventBufferRef.current = [];
    playerReadyRef.current = false;
    setPeerJoined(false);
    setControlState("none");
  }, []);

  // ── Start a new co-browse session ──────────────────────────────────
  const startSession = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const row = await apiCobrowse<SessionRow>("/sessions", {
        method: "POST",
        body: JSON.stringify({ customerLabel: customerLabel || null }),
      });
      setSession(row);
      setControlState("none");
      setPeerJoined(false);

      const ws = new WebSocket(buildCobrowseWsUrl(row.inviteToken, "agent"));
      wsRef.current = ws;
      ws.onmessage = (m) => {
        let msg: any; try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.type === "peer_joined" && msg.role === "customer") {
          setPeerJoined(true);
        } else if (msg.type === "peer_left" && msg.role === "customer") {
          setPeerJoined(false);
        } else if (msg.type === "control_grant") {
          setControlState("granted");
          toast({ title: "تم منح التحكم", description: "يمكنك الآن النقر داخل شاشة العميل." });
        } else if (msg.type === "control_revoke") {
          setControlState("none");
        } else if (msg.type === "rrweb_event" && msg.event) {
          handleRrwebEvent(msg.event);
        }
      };
      ws.onclose = () => { /* leave the session row visible so agent can copy link again */ };
    } catch (e: any) {
      toast({ title: "فشل بدء جلسة المشاركة", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }, [busy, customerLabel, toast]);

  // ── Buffer rrweb events until the player is ready, then stream ─────
  const handleRrwebEvent = useCallback((event: any) => {
    // type 2 = FullSnapshot — wait for the first one before initializing the player.
    if (!playerReadyRef.current) {
      eventBufferRef.current.push(event);
      // We need at least 2 events to construct rrweb-player (it requires
      // events.length >= 2). The very first batch usually has Meta + FullSnapshot.
      if (eventBufferRef.current.length < 2) return;
      const host = playerHostRef.current;
      if (!host) return;
      try {
        host.innerHTML = "";
        playerRef.current = new rrwebPlayer({
          target: host,
          props: {
            events: eventBufferRef.current.slice(),
            width: host.clientWidth || 800,
            height: 480,
            autoPlay: true,
            showController: false,
            mouseTail: false,
            liveMode: true,
          } as any,
        });
        playerReadyRef.current = true;
      } catch (e) {
        // If init failed (rare — some events are out of order), keep buffering.
        // eslint-disable-next-line no-console
        console.warn("[cobrowse] player init failed, will retry", e);
        return;
      }
      return;
    }
    try { playerRef.current?.addEvent?.(event); } catch { /* ignore */ }
  }, []);

  // ── Capture clicks on the player iframe and forward as control_event ──
  // rrweb-player renders the mirrored DOM inside an iframe added to our
  // host div. We attach a single capture-phase listener on the iframe
  // contentDocument when control is granted, translate the click point
  // into a fraction of the customer's viewport, and ship it.
  useEffect(() => {
    if (controlState !== "granted") return;
    const host = playerHostRef.current;
    if (!host) return;
    const iframe = host.querySelector("iframe") as HTMLIFrameElement | null;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return;

    const onClick = (ev: MouseEvent) => {
      const w = iframe.clientWidth || 1; const h = iframe.clientHeight || 1;
      const x = ev.clientX / w; const y = ev.clientY / h;
      try { wsRef.current?.send(JSON.stringify({ type: "control_event", kind: "click", x, y })); } catch { /* ignore */ }
    };
    const onKey = (ev: KeyboardEvent) => {
      const k = ev.key;
      if (!k) return;
      try { wsRef.current?.send(JSON.stringify({ type: "control_event", kind: "key", key: k })); } catch { /* ignore */ }
    };
    const onWheel = (ev: WheelEvent) => {
      try { wsRef.current?.send(JSON.stringify({ type: "control_event", kind: "scroll", dy: ev.deltaY })); } catch { /* ignore */ }
    };

    doc.addEventListener("click", onClick, true);
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("wheel", onWheel, true);
    };
  }, [controlState, peerJoined]);

  const requestControl = useCallback(() => {
    if (!canControl) return;
    try { wsRef.current?.send(JSON.stringify({ type: "control_request" })); } catch { /* ignore */ }
    setControlState("requested");
    toast({ title: "تم إرسال طلب التحكم", description: "بانتظار موافقة العميل." });
  }, [canControl, toast]);

  const releaseControl = useCallback(() => {
    try { wsRef.current?.send(JSON.stringify({ type: "control_revoke" })); } catch { /* ignore */ }
    setControlState("none");
  }, []);

  const endSession = useCallback(async () => {
    if (!session) return;
    try { await apiCobrowse(`/sessions/${session.id}/end`, { method: "POST", body: JSON.stringify({ reason: "agent_ended" }) }); } catch { /* ignore */ }
    tearDown();
    setSession(null);
  }, [session, tearDown]);

  useEffect(() => () => tearDown(), [tearDown]);

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast({ title: "تم نسخ رابط الدعوة" });
    } catch {
      toast({ title: "تعذّر النسخ — انسخه يدويًا", variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <MonitorUp className="h-4 w-4 text-emerald-600" />
          مشاركة شاشة العميل (Co-browse)
          {session && (
            <Badge variant={peerJoined ? "default" : "outline"} className={peerJoined ? "bg-emerald-600 hover:bg-emerald-600" : ""}>
              {peerJoined ? "متصل" : "بانتظار العميل"}
            </Badge>
          )}
          {controlState === "granted" && (
            <Badge className="bg-amber-500 hover:bg-amber-500 gap-1">
              <MousePointer2 className="h-3 w-3" /> تحكم
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          مشاركة شاشة بدون تثبيت برامج خارجية — يرى الفني صفحة العميل داخل النظام فقط.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!session ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[200px]">
              <Label className="text-xs">اسم العميل (اختياري — للتوثيق فقط)</Label>
              <Input
                value={customerLabel}
                onChange={(e) => setCustomerLabel(e.target.value)}
                placeholder="مثال: شركة ABC — محمد"
                className="mt-1"
              />
            </div>
            <Button onClick={startSession} disabled={busy} className="gap-1 bg-emerald-600 hover:bg-emerald-500">
              <Eye className="h-4 w-4" /> ابدأ جلسة المشاركة
            </Button>
          </div>
        ) : (
          <>
            <div>
              <Label className="text-xs">رابط دعوة العميل لمشاركة الشاشة</Label>
              <div className="flex gap-2 mt-1">
                <Input value={inviteUrl} readOnly dir="ltr" className="font-mono text-xs" />
                <Button variant="outline" onClick={copyInvite} className="gap-1">
                  <Copy className="h-4 w-4" /> نسخ
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                أرسل هذا الرابط للعميل. عند فتحه ستظهر له رسالة موافقة، وعند قبولها ترى شاشته هنا.
              </p>
            </div>

            <div className="rounded-md border bg-muted/20" style={{ minHeight: 480 }}>
              <div ref={playerHostRef} className="w-full" style={{ minHeight: 480 }} />
              {!playerReadyRef.current && (
                <div className="text-center text-xs text-muted-foreground py-10">
                  {peerJoined ? "جاري استقبال شاشة العميل…" : "بانتظار قبول العميل لرابط الدعوة…"}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {canControl ? (
                controlState === "granted" ? (
                  <Button variant="outline" onClick={releaseControl} className="gap-1">
                    <MousePointer2 className="h-4 w-4" /> إيقاف التحكم
                  </Button>
                ) : (
                  <Button
                    onClick={requestControl}
                    disabled={!peerJoined || controlState === "requested"}
                    className="gap-1 bg-amber-600 hover:bg-amber-500"
                  >
                    <MousePointer2 className="h-4 w-4" />
                    {controlState === "requested" ? "بانتظار موافقة العميل…" : "طلب التحكم بالشاشة"}
                  </Button>
                )
              ) : (
                <span className="text-xs text-muted-foreground">
                  ليست لديك صلاحية «التحكم بالشاشة» — يمكنك المشاهدة فقط.
                </span>
              )}
              <div className="flex-1" />
              <Button variant="destructive" onClick={endSession} className="gap-1">
                <PhoneOff className="h-4 w-4" /> إنهاء جلسة المشاركة
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
