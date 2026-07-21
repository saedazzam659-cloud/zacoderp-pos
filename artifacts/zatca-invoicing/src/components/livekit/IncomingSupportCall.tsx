// ── نافذة "مكالمة دعم واردة" العامة ──────────────────────────────────────
// تُركَّب مرة واحدة في جذر التطبيق. تستمع لأحداث النافذة التي يبثّها
// AuthContext من قناة SSE:
//   • "support-call:invite"    { callId, agentUsername }
//   • "support-call:cancelled" { callId }
// عند الرد: joinCall → فتح غرفة LiveKit داخل نافذة ملء الشاشة.
import { useEffect, useState } from "react";
import { Phone, PhoneOff, Headset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supportRoomApi, type JoinInfo } from "@/lib/liveRoomApi";
import LiveRoom from "@/components/livekit/LiveRoom";
import { useAuth } from "@/contexts/AuthContext";

interface Invite { callId: number; agentUsername?: string }

export default function IncomingSupportCall() {
  const { user, isAuthenticated } = useAuth() as any;
  const [invite, setInvite] = useState<Invite | null>(null);
  const [joining, setJoining] = useState(false);
  const [room, setRoom] = useState<JoinInfo | null>(null);
  const [activeCallId, setActiveCallId] = useState<number | null>(null);

  useEffect(() => {
    const onInvite = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (typeof d.callId === "number") setInvite({ callId: d.callId, agentUsername: d.agentUsername });
    };
    const onCancel = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      setInvite(prev => (prev && (d.callId == null || d.callId === prev.callId) ? null : prev));
    };
    window.addEventListener("support-call:invite", onInvite);
    window.addEventListener("support-call:cancelled", onCancel);
    return () => {
      window.removeEventListener("support-call:invite", onInvite);
      window.removeEventListener("support-call:cancelled", onCancel);
    };
  }, []);

  if (!isAuthenticated) return null;

  // غرفة نشطة — ملء الشاشة فوق كل شيء
  if (room) {
    return (
      <div className="fixed inset-0 z-[100] bg-background" dir="rtl">
        <LiveRoom
          token={room.token}
          wsUrl={room.wsUrl}
          role="publisher"
          autoPublishAv
          title="مكالمة الدعم الفني"
          myName={user?.username ?? "مستخدم"}
          onLeave={() => {
            if (activeCallId != null) supportRoomApi.endCall(activeCallId).catch(() => {});
            setRoom(null);
            setActiveCallId(null);
          }}
        />
      </div>
    );
  }

  if (!invite) return null;

  const answer = async () => {
    setJoining(true);
    try {
      const j = await supportRoomApi.joinCall(invite.callId);
      setActiveCallId(invite.callId);
      setRoom(j);
      setInvite(null);
    } catch {
      setInvite(null);
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="fixed bottom-6 left-6 z-[100] w-80 rounded-2xl border bg-card shadow-2xl p-4 space-y-3 animate-in slide-in-from-bottom-4"
         dir="rtl" data-testid="incoming-support-call">
      <div className="flex items-center gap-3">
        <span className="relative inline-flex h-11 w-11 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <Headset className="h-5 w-5" />
          <span className="absolute inset-0 rounded-full border-2 border-emerald-400 animate-ping" />
        </span>
        <div className="min-w-0">
          <div className="font-semibold text-sm">مكالمة دعم فني واردة</div>
          <div className="text-xs text-muted-foreground truncate">
            من: {invite.agentUsername || "الدعم الفني"}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700" onClick={answer} disabled={joining}
                data-testid="answer-support-call">
          <Phone className="h-4 w-4 ms-1" /> {joining ? "جارٍ الاتصال…" : "رد"}
        </Button>
        <Button variant="outline" className="flex-1" onClick={() => setInvite(null)} disabled={joining}
                data-testid="decline-support-call">
          <PhoneOff className="h-4 w-4 ms-1" /> تجاهل
        </Button>
      </div>
    </div>
  );
}
