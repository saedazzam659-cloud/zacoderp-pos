import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { GraduationCap, Radio, Loader2, LogIn } from "lucide-react";
import LiveRoom from "@/components/livekit/LiveRoom";
import { trainingApi, type JoinInfo } from "@/lib/liveRoomApi";

// ─────────────────────────────────────────────────────────────────────────────
// صفحة الدخول العام لقاعة التدريب — /training/join/:token
// تُعرض خارج بوابات تسجيل الدخول (مثل زووم): الزائر يكتب اسمه فقط وينضم
// كمشاهد (مشاهدة + دردشة + رفع يد). لا يرى أي شيء آخر من النظام.
// ─────────────────────────────────────────────────────────────────────────────

export default function TrainingJoinPublic() {
  const [, params] = useRoute("/training/join/:token");
  const token = params?.token ?? "";

  const [info, setInfo] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState<JoinInfo | null>(null);

  useEffect(() => {
    if (!token) { setErr("رابط غير صالح"); setLoading(false); return; }
    trainingApi.publicInfo(token)
      .then(setInfo)
      .catch((e: any) => setErr(e.message ?? "الجلسة غير موجودة"))
      .finally(() => setLoading(false));
  }, [token]);

  const join = async () => {
    if (name.trim().length < 2) { setErr("يرجى كتابة اسمك (حرفان على الأقل)"); return; }
    setJoining(true); setErr(null);
    try { setJoined(await trainingApi.publicJoin(token, name.trim())); }
    catch (e: any) { setErr(e.message ?? "تعذّر الانضمام"); }
    finally { setJoining(false); }
  };

  if (joined) {
    return (
      <div dir="rtl" className="min-h-screen bg-background p-3 md:p-5">
        <LiveRoom
          token={joined.token} wsUrl={joined.wsUrl}
          role="subscriber"
          title={joined.title ?? info?.title}
          myName={name.trim()}
          onLeave={() => setJoined(null)}
        />
      </div>
    );
  }

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
