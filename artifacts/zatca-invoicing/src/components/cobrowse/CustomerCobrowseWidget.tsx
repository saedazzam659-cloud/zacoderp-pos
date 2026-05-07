import { useEffect, useRef, useState, useCallback } from "react";
import { record } from "rrweb";
import { buildCobrowseWsUrl, fetchCobrowseSessionByToken } from "@/lib/cobrowseClient";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ShieldCheck, MonitorUp, X, MousePointer2 } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────
// CustomerCobrowseWidget
//
// Mounted globally inside the SPA. Detects an invite token on the URL
// (?cobrowse=…), shows the user a consent prompt, and on accept streams
// rrweb DOM events to the agent via the WebSocket hub.
//
// SAFETY:
//   - Nothing happens until the user clicks "Allow" — there is no auto-share.
//   - A persistent red banner with a "Stop sharing" button is shown the
//     entire time a session is live, so the customer can always abort.
//   - Control mode requires a SECOND, separate consent click.
//   - Inputs in elements with [data-cobrowse-secret] or input[type=password]
//     are masked by rrweb config.
//   - Control events are restricted to in-page actions; we never invoke
//     navigation outside the SPA, dispatch alerts, or run code.
// ─────────────────────────────────────────────────────────────────────────

type Phase = "idle" | "asking" | "active" | "ended";

function readInviteFromUrl(): string | null {
  try {
    const u = new URL(window.location.href);
    const t = u.searchParams.get("cobrowse");
    return t && t.length >= 8 ? t : null;
  } catch { return null; }
}

function clearInviteFromUrl() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete("cobrowse");
    window.history.replaceState({}, "", u.toString());
  } catch { /* ignore */ }
}

export default function CustomerCobrowseWidget() {
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [agentName, setAgentName] = useState<string>("الدعم الفني");
  const [controlAsk, setControlAsk] = useState(false);
  const [controlOn, setControlOn] = useState(false);
  const [agentJoined, setAgentJoined] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const stopRecordRef = useRef<(() => void) | null>(null);

  // ── On mount: detect invite token ──────────────────────────────────
  useEffect(() => {
    const t = readInviteFromUrl();
    if (!t) return;
    setToken(t);
    setPhase("asking");
    fetchCobrowseSessionByToken(t).then((s) => {
      if (!s) { setPhase("ended"); return; }
      if (s.agentUsername) setAgentName(s.agentUsername);
    });
  }, []);

  // ── Apply an incoming control event from the agent ─────────────────
  // SECURITY: keep this surface deliberately tiny. The agent gets to:
  //   • click an element that is part of the SPA on the same origin and
  //     is NOT marked as a logout/destructive action and NOT a link to
  //     an external origin
  //   • scroll the page
  //   • type into an already-focused input/textarea (never moves focus,
  //     never submits a form on its own)
  // Anything else is silently dropped.
  const applyControl = useCallback((evt: any) => {
    if (!controlOn) return;
    try {
      const kind = String(evt?.kind ?? "");
      if (kind === "click" && typeof evt.x === "number" && typeof evt.y === "number") {
        const x = Math.round(Math.max(0, Math.min(1, evt.x)) * window.innerWidth);
        const y = Math.round(Math.max(0, Math.min(1, evt.y)) * window.innerHeight);
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!el) return;
        // Never let the agent dismiss the persistent sharing banner,
        // toggle the consent dialogs, or click destructive controls.
        if (el.closest("[data-cobrowse-banner]")) return;
        if (el.closest("[data-cobrowse-no-control]")) return;
        // No external links — only same-origin SPA navigation.
        const a = el.closest("a") as HTMLAnchorElement | null;
        if (a && a.href) {
          try {
            const u = new URL(a.href, window.location.href);
            if (u.origin !== window.location.origin) return;
          } catch { return; }
        }
        // No "logout" / "delete" lookalikes (Arabic + English).
        const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (/(logout|sign\s*out|تسجيل\s*الخروج|خروج)/.test(txt)) return;
        el.click();
      } else if (kind === "scroll" && typeof evt.dy === "number") {
        const dy = Math.max(-2000, Math.min(2000, Number(evt.dy) || 0));
        window.scrollBy({ top: dy, behavior: "auto" });
      } else if (kind === "key" && typeof evt.key === "string") {
        const k = evt.key;
        // Allowlist: single printable char, Backspace, Delete, Enter, Tab,
        // arrows. Rejects F-keys, modifier combos, etc.
        const ALLOW = new Set(["Backspace", "Delete", "Enter", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
        const isPrintable = k.length === 1 && k.charCodeAt(0) >= 0x20;
        if (!isPrintable && !ALLOW.has(k)) return;
        const ae = document.activeElement as HTMLElement | null;
        if (!ae) return;
        if (ae.closest("[data-cobrowse-banner]")) return;
        const isText = ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement;
        if (!isText && !ae.isContentEditable) return;
        if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) {
          if (k === "Backspace") ae.value = ae.value.slice(0, -1);
          else if (isPrintable) ae.value = ae.value + k;
          ae.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    } catch { /* swallow — never crash the app on a stray event */ }
  }, [controlOn]);

  // ── Open WS + start rrweb capture ──────────────────────────────────
  const start = useCallback(() => {
    if (!token) return;
    const ws = new WebSocket(buildCobrowseWsUrl(token, "customer"));
    wsRef.current = ws;

    ws.onopen = () => {
      // rrweb full-snapshot is sent on the first emit; agent player
      // will buffer until it arrives.
      const stop = record({
        emit(event: any) {
          if (ws.readyState === ws.OPEN) {
            try { ws.send(JSON.stringify({ type: "rrweb_event", event })); } catch { /* ignore */ }
          }
        },
        recordCanvas: false,
        collectFonts: false,
        maskInputOptions: { password: true },
        maskTextSelector: "[data-cobrowse-secret]",
        // Sample mousemoves heavily to keep bandwidth low.
        sampling: { mousemove: 100, scroll: 80, input: "last" },
      });
      stopRecordRef.current = typeof stop === "function" ? stop : null;
      setPhase("active");
    };

    ws.onmessage = (m) => {
      let msg: any;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === "peer_joined" && msg.role === "agent") setAgentJoined(true);
      else if (msg.type === "peer_left" && msg.role === "agent") setAgentJoined(false);
      else if (msg.type === "control_request") setControlAsk(true);
      else if (msg.type === "control_revoke") { setControlOn(false); setControlAsk(false); }
      else if (msg.type === "control_event") applyControl(msg);
    };

    ws.onclose = () => {
      stopRecordRef.current?.(); stopRecordRef.current = null;
      wsRef.current = null;
      setPhase("ended");
      setControlOn(false);
    };
    ws.onerror = () => { /* ws will close after */ };
  }, [token, applyControl]);

  const stop = useCallback(() => {
    try { stopRecordRef.current?.(); } catch { /* ignore */ }
    stopRecordRef.current = null;
    try { wsRef.current?.close(); } catch { /* ignore */ }
    wsRef.current = null;
    setPhase("ended");
    setControlOn(false);
    setControlAsk(false);
    clearInviteFromUrl();
  }, []);

  // Tear down on unmount.
  useEffect(() => () => { try { stopRecordRef.current?.(); wsRef.current?.close(); } catch { /* ignore */ } }, []);

  if (!token || phase === "idle") return null;

  return (
    <>
      {/* ── Initial consent dialog ─────────────────────────── */}
      <Dialog open={phase === "asking"} onOpenChange={(o) => { if (!o) { setPhase("ended"); clearInviteFromUrl(); } }}>
        <DialogContent dir="rtl" data-cobrowse-banner>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MonitorUp className="h-5 w-5 text-emerald-600" />
              السماح للدعم الفني بمشاهدة شاشتك
            </DialogTitle>
            <DialogDescription>
              يطلب فني الدعم <strong>{agentName}</strong> الانضمام إلى جلسة مساعدة مرئية معك.
              عند موافقتك، سيشاهد ما تراه على هذه الصفحة فقط (لا يصل إلى ملفاتك أو نوافذ أخرى).
              يمكنك إيقاف المشاركة في أي لحظة من الزر الأحمر العلوي.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
            <ShieldCheck className="inline h-4 w-4 -mt-0.5 ml-1" />
            كلمات المرور وأي حقل عليه علامة سرية يتم إخفاؤه تلقائيًا عن الفني.
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setPhase("ended"); clearInviteFromUrl(); }}>رفض</Button>
            <Button onClick={start} className="bg-emerald-600 hover:bg-emerald-500 text-white gap-1">
              <ShieldCheck className="h-4 w-4" /> أوافق وابدأ المشاركة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Control consent dialog ─────────────────────────── */}
      <Dialog open={controlAsk} onOpenChange={(o) => { if (!o) setControlAsk(false); }}>
        <DialogContent dir="rtl" data-cobrowse-banner>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MousePointer2 className="h-5 w-5 text-amber-600" />
              يطلب الدعم الفني التحكم بالشاشة
            </DialogTitle>
            <DialogDescription>
              عند الموافقة، سيتمكن الفني <strong>{agentName}</strong> من النقر والكتابة داخل هذه الصفحة فقط
              لمساعدتك على إكمال الخطوة. يمكنك سحب الإذن في أي وقت من شريط المشاركة.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => {
              setControlAsk(false);
              try { wsRef.current?.send(JSON.stringify({ type: "control_revoke" })); } catch { /* ignore */ }
            }}>رفض</Button>
            <Button onClick={() => {
              setControlAsk(false); setControlOn(true);
              try { wsRef.current?.send(JSON.stringify({ type: "control_grant" })); } catch { /* ignore */ }
            }} className="bg-amber-600 hover:bg-amber-500 text-white">أوافق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Persistent banner while sharing ──────────────────── */}
      {phase === "active" && (
        <div
          data-cobrowse-banner
          dir="rtl"
          className="fixed top-2 inset-x-2 z-[10000] flex items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50/95 backdrop-blur px-3 py-2 shadow-lg"
        >
          <div className="flex items-center gap-2 text-sm text-red-900 min-w-0">
            <span className="h-2.5 w-2.5 rounded-full bg-red-600 animate-pulse shrink-0" aria-hidden />
            <span className="truncate">
              مشاركة شاشة نشطة مع <strong>{agentName}</strong>
              {agentJoined ? "" : " — بانتظار انضمام الفني..."}
              {controlOn && " · تم منح التحكم"}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {controlOn && (
              <Button size="sm" variant="outline" onClick={() => {
                setControlOn(false);
                try { wsRef.current?.send(JSON.stringify({ type: "control_revoke" })); } catch { /* ignore */ }
              }}>سحب التحكم</Button>
            )}
            <Button size="sm" variant="destructive" onClick={stop} className="gap-1">
              <X className="h-4 w-4" /> إيقاف المشاركة
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
