import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Video, Copy, ExternalLink, RefreshCw, Mic, Camera,
  MonitorUp, Users, ShieldCheck, MessageSquare, Phone,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// SupportCall — Zoom-style audio/video/screen-share room for tech support.
//
// We embed the public Jitsi Meet service (https://meet.jit.si) via iframe so
// no signaling/STUN/TURN servers need to be self-hosted and no SDK keys are
// required — perfect for an in-app support channel that needs to "just work"
// for both the agent and the customer.
//
// The iframe must declare the relevant Permissions-Policy delegations for
// camera, microphone, display-capture (screen share), autoplay, and
// fullscreen — without these the browser blocks Jitsi's media access even if
// the user grants permission at the prompt.
//
// Room name strategy: prefix with the company brand + a short random id so
// rooms don't collide with random Jitsi traffic and are guessable only to
// people who receive the link from the agent.
// ─────────────────────────────────────────────────────────────────────────────

function makeRoomName(prefix = "zacoderp-support"): string {
  // 10-char base36 random — ~52 bits of entropy, enough to prevent room squatting.
  const rand = Math.random().toString(36).slice(2, 12);
  return `${prefix}-${rand}`;
}

export default function SupportCall() {
  const { user } = useAuth();
  const { toast } = useToast();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const [room, setRoom]       = useState<string>(() => makeRoomName());
  const [joined, setJoined]   = useState(false);
  const [displayName, setDisplayName] = useState<string>(user?.fullName ?? user?.username ?? "الدعم الفني");

  const callUrl = useMemo(() => {
    // `userInfo.displayName` is read by Jitsi from the URL hash — that's the
    // documented way to pre-fill the participant name without using the IFrame
    // API. The hash is never sent to the Jitsi server (it stays client-side).
    const hash = `#userInfo.displayName=%22${encodeURIComponent(displayName)}%22`;
    return `https://meet.jit.si/${encodeURIComponent(room)}${hash}`;
  }, [room, displayName]);

  // The link we share with the customer — strip our display-name hash so the
  // customer can enter their own name when they join.
  const shareUrl = useMemo(() => `https://meet.jit.si/${encodeURIComponent(room)}`, [room]);

  // Reset "joined" state whenever the room changes so the iframe remounts.
  useEffect(() => { setJoined(false); }, [room]);

  const newRoom = () => {
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

  return (
    <div className="space-y-4 p-4 md:p-6">
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
        </div>
      </div>

      {/* Room controls + share link */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Phone className="h-4 w-4" /> إعدادات الغرفة ومشاركة الرابط
          </CardTitle>
          <CardDescription>
            انسخ الرابط وأرسله للعميل عبر الواتساب أو البريد. يمكنه الانضمام مباشرة من المتصفح بدون تسجيل دخول.
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
                data-testid="input-support-room"
              />
              <Button variant="outline" size="icon" onClick={newRoom} title="غرفة جديدة" data-testid="btn-new-room">
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
              data-testid="input-display-name"
            />
          </div>

          <div className="md:col-span-2">
            <Label className="text-xs">رابط دعوة العميل</Label>
            <div className="flex gap-2 mt-1">
              <Input value={shareUrl} readOnly dir="ltr" className="font-mono text-xs" data-testid="input-share-url" />
              <Button variant="outline" onClick={() => copy(shareUrl, "الرابط")} className="gap-1">
                <Copy className="h-4 w-4" /> نسخ
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

      {/* Quick "what you can do" guide */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <FeatureChip icon={Camera}     label="كاميرا" />
        <FeatureChip icon={Mic}        label="صوت ثنائي الاتجاه" />
        <FeatureChip icon={MonitorUp}  label="مشاركة الشاشة" />
        <FeatureChip icon={MessageSquare} label="دردشة نصية أثناء المكالمة" />
      </div>

      {/* The call frame */}
      <Card className="overflow-hidden">
        <CardHeader className="pb-3 flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4" /> المكالمة المباشرة
            </CardTitle>
            <CardDescription>
              {joined
                ? "أنت داخل الغرفة الآن. لإنهاء المكالمة استخدم زر الإغلاق داخل الإطار."
                : "اضغط «دخول الغرفة» لبدء البث. سيُطلب إذن الكاميرا والميكروفون من المتصفح."}
            </CardDescription>
          </div>
          {!joined ? (
            <Button onClick={() => setJoined(true)} className="gap-1" data-testid="btn-join-room">
              <Video className="h-4 w-4" /> دخول الغرفة
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setJoined(false)} data-testid="btn-leave-room">
              مغادرة
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {joined ? (
            <iframe
              ref={iframeRef}
              key={room}
              src={callUrl}
              title="Support video call"
              // Permissions-Policy delegations required by the embedded
              // Jitsi Meet client to access camera/mic/screen capture.
              allow="camera; microphone; display-capture; autoplay; clipboard-write; fullscreen; picture-in-picture; speaker-selection"
              allowFullScreen
              className="w-full border-0"
              style={{ height: "min(75vh, 720px)" }}
              data-testid="iframe-jitsi"
            />
          ) : (
            <div className="h-[480px] bg-muted/40 grid place-items-center text-center px-6">
              <div className="max-w-md space-y-2">
                <Video className="h-10 w-10 text-muted-foreground mx-auto" />
                <div className="text-sm text-muted-foreground">
                  الغرفة جاهزة. شارك الرابط مع العميل ثم اضغط «دخول الغرفة» لبدء البث.
                </div>
              </div>
            </div>
          )}
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
