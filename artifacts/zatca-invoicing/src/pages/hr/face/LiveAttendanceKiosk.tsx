import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { faceApi, KIOSK_TOKEN_KEY, type Camera, type RecognizeResult } from "@/lib/faceAttendanceApi";
import { loadFaceApi } from "@/lib/faceapi/loader";
import { evaluateFaceQuality } from "@/lib/faceapi/quality";
import { createLivenessTracker, type LivenessTracker } from "@/lib/faceapi/liveness";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Loader2, ScanFace, CheckCircle2, XCircle, AlertTriangle, Sparkles, Clock, Users, Smartphone, Settings, LogOut } from "lucide-react";
import { KioskDeviceManager } from "@/components/hr/KioskDeviceManager";

interface RecentMatch {
  at: number;
  employeeName: string | null;
  employeeCode: string | null;
  confidence: number;
  action: string;
  status: "ok" | "unknown" | "low" | "cooldown" | "spoof";
}

export default function LiveAttendanceKiosk() {
  const { toast } = useToast();
  const { user } = useAuth() as any;
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const livenessRef = useRef<LivenessTracker | null>(null);
  const apiRef = useRef<any>(null);
  const intervalRef = useRef<number | null>(null);
  const lastEmployeeRef = useRef<{ id: number; at: number } | null>(null);

  const [modelLoading, setModelLoading] = useState(true);
  const [cameraId, setCameraId] = useState<string>("");
  const [scanning, setScanning] = useState(true);
  const [lastMatch, setLastMatch] = useState<RecognizeResult | null>(null);
  const [matches, setMatches] = useState<RecentMatch[]>([]);
  const [livenessOk, setLivenessOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // ── Kiosk pairing state ────────────────────────────────────────────────
  // The kiosk URL is reachable both with a regular admin session (the
  // operator previewing) AND from an unpaired tablet at the office
  // entrance. We detect which mode we're in and gate the camera startup
  // until either a session OR a stored kiosk token is present.
  // Safe localStorage helpers — Safari Private Mode and some kiosk
  // browsers throw on access. Pairing must degrade gracefully.
  const safeGet = (key: string): string | null => {
    try { return localStorage.getItem(key); } catch { return null; }
  };
  const safeSet = (key: string, val: string): boolean => {
    try { localStorage.setItem(key, val); return true; } catch { return false; }
  };
  const safeDel = (key: string): void => {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  };

  const [hasKioskToken, setHasKioskToken] = useState<boolean>(() =>
    typeof window !== "undefined" && !!safeGet(KIOSK_TOKEN_KEY)
  );
  const [pairProcessed, setPairProcessed] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [kioskInfo, setKioskInfo] = useState<{ id: number; label: string; companyId: number } | null>(null);
  const [showDeviceManager, setShowDeviceManager] = useState(false);

  const isAdmin = !!user;
  // For *gating UI screens* (showing the unpaired panel vs the camera UI)
  // the mere presence of a stored kiosk token is enough — we don't want
  // a brief "unpaired" flash while /kiosk/me validates.
  const isAuthed = isAdmin || hasKioskToken;
  // For *issuing API calls* (cameras query, camera startup) we wait until
  // the token has been validated via /kiosk/me. Otherwise a stale token
  // from a previous session would trigger 401-spamming until kiosk/me
  // resolves and clears it.
  const apiReady = isAdmin || !!kioskInfo;

  // Step 1: handle ?pair=<token> URL → store and clean URL.
  // We always strip `pair` from the URL (even on bad values), so a malformed
  // token never lingers in the address bar or browser history.
  useEffect(() => {
    if (pairProcessed) return;
    const url = new URL(window.location.href);
    const pair = url.searchParams.get("pair");
    if (pair) {
      if (pair.length >= 16 && pair.length <= 256) {
        if (!safeSet(KIOSK_TOKEN_KEY, pair)) {
          setPairError("تعذّر حفظ رمز الربط — تخزين المتصفح المحلي مُعطّل (الوضع الخاص؟). يرجى استخدام الوضع العادي.");
        } else {
          setHasKioskToken(true);
        }
      } else {
        setPairError("رمز الربط في الرابط غير صالح. اطلب من المدير رمزاً جديداً.");
      }
      url.searchParams.delete("pair");
      window.history.replaceState(
        null,
        "",
        url.pathname + (url.search ? url.search : "") + url.hash,
      );
    }
    setPairProcessed(true);
  }, [pairProcessed]);

  // Step 2: validate the kiosk token (if any) by hitting /kiosk/me.
  useEffect(() => {
    if (!pairProcessed) return;
    if (!hasKioskToken || isAdmin) return;
    (async () => {
      try {
        const info = await faceApi.kioskMe();
        setKioskInfo(info);
      } catch {
        // Token is invalid/revoked — clear it and force re-pairing.
        safeDel(KIOSK_TOKEN_KEY);
        setHasKioskToken(false);
      }
    })();
  }, [pairProcessed, hasKioskToken, isAdmin]);

  const unpairDevice = () => {
    if (!confirm("هل أنت متأكد من إلغاء ربط هذا الجهاز؟ سيحتاج المدير لإصدار رمز جديد.")) return;
    safeDel(KIOSK_TOKEN_KEY);
    setHasKioskToken(false);
    setKioskInfo(null);
  };

  const { data: cameras = [] } = useQuery<Camera[]>({
    queryKey: ["face-cameras"],
    queryFn: () => faceApi.cameras(),
    enabled: apiReady,
  });

  // clock tick
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // load model
  useEffect(() => {
    loadFaceApi()
      .then((api) => { apiRef.current = api; setModelLoading(false); })
      .catch((e: any) => {
        setModelLoading(false);
        toast({ title: "تعذر تحميل نماذج التعرّف", description: e?.message ?? "تأكد من الاتصال بالإنترنت", variant: "destructive" });
      });
  }, []);

  // pick first webcam if available
  useEffect(() => {
    if (cameras.length > 0 && !cameraId) {
      const wc = cameras.find((c) => c.kind === "webcam") ?? cameras[0];
      if (wc) setCameraId(String(wc.id));
    }
  }, [cameras, cameraId]);

  // start webcam + recognition loop — gated on auth so an unpaired
  // tablet never opens the camera or hits /recognize.
  useEffect(() => {
    if (modelLoading) return;
    if (!isAuthed) return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        livenessRef.current = createLivenessTracker();
        startScanLoop();
      } catch (e: any) {
        toast({ title: "تعذر فتح الكاميرا", description: e?.message ?? "", variant: "destructive" });
      }
    })();
    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelLoading]);

  function pushMatch(m: RecentMatch) {
    setMatches((prev) => [m, ...prev].slice(0, 12));
  }

  function startScanLoop() {
    intervalRef.current = window.setInterval(async () => {
      if (busy || !scanning) return;
      const video = videoRef.current;
      const api = apiRef.current;
      if (!video || !api || video.readyState < 2) return;
      try {
        const opts = new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
        const detection = await api.detectSingleFace(video, opts).withFaceLandmarks();
        const q = evaluateFaceQuality(detection ? [detection] : [], video.videoWidth, video.videoHeight);
        // overlay
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d")!;
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          if (q.box) {
            ctx.strokeStyle = q.score > 0.7 ? "#10b981" : "#f59e0b";
            ctx.lineWidth = 3;
            ctx.strokeRect(q.box.x, q.box.y, q.box.width, q.box.height);
          }
        }
        // liveness tracker
        if (livenessRef.current) {
          const stage = livenessRef.current.feed(detection ?? null);
          setLivenessOk(stage === "passed");
          if (stage === "failed") livenessRef.current.reset();
        }
        if (q.score < 0.55 || !detection) return;

        // proceed to descriptor + recognize
        setBusy(true);
        const full = await api
          .detectSingleFace(video, opts)
          .withFaceLandmarks()
          .withFaceDescriptor();
        if (!full?.descriptor) { setBusy(false); return; }
        const descriptor = Array.from(full.descriptor) as number[];
        const camId = cameraId ? Number(cameraId) : null;
        const rec = await faceApi.recognize(descriptor, camId, livenessOk);
        setLastMatch(rec);
        if (!rec.matched || !rec.employeeId || !rec.ticket) {
          pushMatch({ at: Date.now(), employeeName: null, employeeCode: null, confidence: rec.confidence ?? 0, action: "unknown", status: "unknown" });
          setBusy(false);
          return;
        }
        // dedupe within 8 seconds for same person
        const last = lastEmployeeRef.current;
        if (last && last.id === rec.employeeId && Date.now() - last.at < 8000) {
          setBusy(false);
          return;
        }
        lastEmployeeRef.current = { id: rec.employeeId, at: Date.now() };

        const checkRes = await faceApi.check({
          ticket: rec.ticket,
          deviceInfo: navigator.userAgent.slice(0, 120),
        });
        if (checkRes.ok) {
          pushMatch({
            at: Date.now(),
            employeeName: rec.employeeName,
            employeeCode: rec.employeeCode,
            confidence: rec.confidence ?? 0,
            action: checkRes.action ?? "auto",
            status: "ok",
          });
        } else {
          pushMatch({
            at: Date.now(),
            employeeName: rec.employeeName,
            employeeCode: rec.employeeCode,
            confidence: rec.confidence ?? 0,
            action: checkRes.reason ?? "skipped",
            status: checkRes.reason === "cooldown" ? "cooldown" : "low",
          });
        }
      } catch (e: any) {
        // silent — keep scanning
      } finally {
        setBusy(false);
      }
    }, 1500);
  }

  const fmtTime = (d: Date) => d.toTimeString().slice(0, 8);
  const fmtRelative = (ts: number) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s} ث`;
    if (s < 3600) return `${Math.floor(s / 60)} د`;
    return new Date(ts).toTimeString().slice(0, 5);
  };

  // ── Unpaired-device screen ─────────────────────────────────────────────
  // Shown on a tablet that has no user session AND no kiosk token.
  // Tells the operator how to get a pairing link from the admin.
  if (pairProcessed && !isAuthed) {
    return (
      <div className="min-h-screen p-4 flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white" data-testid="page-kiosk-unpaired">
        <Card className="max-w-lg w-full p-8 bg-slate-800/80 border-slate-700 text-center space-y-5">
          <div className="flex justify-center">
            <div className="h-20 w-20 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <Smartphone className="h-10 w-10 text-emerald-400" />
            </div>
          </div>
          <div>
            <h1 className="text-2xl font-bold mb-2">جهاز الكشك غير مربوط</h1>
            <p className="text-slate-300 text-sm leading-relaxed">
              هذا الجهاز يحتاج إلى ربط بحساب الشركة قبل استخدامه لتسجيل الحضور بالتعرف على الوجه.
            </p>
          </div>
          <div className="text-right text-sm space-y-3 bg-slate-900/60 rounded-lg p-4">
            <div className="font-bold text-emerald-400">خطوات الربط:</div>
            <ol className="space-y-2 list-decimal list-inside text-slate-200">
              <li>من حساب المدير، افتح: <span className="font-mono text-emerald-300">الحضور الذكي ← أجهزة الكشك</span></li>
              <li>اضغط <span className="font-bold">"ربط جهاز جديد"</span> وأدخل اسم الجهاز (مثل: تابلت المدخل).</li>
              <li>انسخ <span className="font-bold">رابط الربط</span> الذي يظهر، وأرسله إلى هذا الجهاز.</li>
              <li>افتح الرابط هنا — سيعمل الكشك تلقائياً.</li>
            </ol>
          </div>
          {pairError && (
            <div className="text-right p-3 rounded-lg bg-rose-900/30 border border-rose-700/50 text-rose-200 text-sm flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>{pairError}</div>
            </div>
          )}
          <p className="text-xs text-slate-400">
            ملاحظة: لا تستخدم هذا الجهاز لتسجيل الدخول كمستخدم. الربط مخصّص للكشك فقط.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white" data-testid="page-live-kiosk">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ScanFace className="h-7 w-7 text-emerald-400" />
            الحضور الذكي بالتعرف على الوجه
            {kioskInfo && (
              <Badge className="bg-emerald-700/60 text-xs ms-2">
                <Smartphone className="h-3 w-3 me-1" /> {kioskInfo.label}
              </Badge>
            )}
          </h1>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-3xl font-mono">{fmtTime(now)}</div>
            <div className="flex items-center gap-2">
              <Switch checked={scanning} onCheckedChange={setScanning} data-testid="switch-scanning" />
              <span className="text-sm">{scanning ? "نشط" : "متوقف"}</span>
            </div>
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="bg-slate-900/60 border-slate-700 hover:bg-slate-800"
                onClick={() => setShowDeviceManager(true)}
                data-testid="button-manage-devices"
              >
                <Settings className="h-4 w-4 me-1" /> إدارة الأجهزة
              </Button>
            )}
            {!isAdmin && hasKioskToken && (
              <Button
                variant="outline"
                size="sm"
                className="bg-slate-900/60 border-slate-700 hover:bg-slate-800"
                onClick={unpairDevice}
                data-testid="button-unpair-device"
              >
                <LogOut className="h-4 w-4 me-1" /> إلغاء الربط
              </Button>
            )}
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2 p-4 bg-slate-800/60 border-slate-700">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-sm">
                <Select value={cameraId} onValueChange={setCameraId}>
                  <SelectTrigger className="w-64 bg-slate-900 border-slate-700"><SelectValue placeholder="اختر كاميرا" /></SelectTrigger>
                  <SelectContent>
                    {cameras.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name} {c.location ? `— ${c.location}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Badge variant={livenessOk ? "default" : "secondary"} className={livenessOk ? "bg-emerald-600" : ""}>
                <Sparkles className="h-3 w-3 mr-1" /> الكشف الحي: {livenessOk ? "✓" : "..."}
              </Badge>
            </div>

            <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
              {modelLoading && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin mr-2" /> جاري التهيئة...
                </div>
              )}
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
              {lastMatch && (
                <div className={`absolute bottom-0 left-0 right-0 p-3 backdrop-blur-md ${lastMatch.matched ? "bg-emerald-500/40" : "bg-rose-500/40"}`}>
                  <div className="flex items-center gap-3">
                    {lastMatch.matched ? <CheckCircle2 className="h-8 w-8" /> : <XCircle className="h-8 w-8" />}
                    <div className="flex-1">
                      <div className="font-bold text-lg">
                        {lastMatch.matched ? lastMatch.employeeName : "وجه غير معروف"}
                      </div>
                      {lastMatch.matched && (
                        <div className="text-xs opacity-90">{lastMatch.employeeCode} — تطابق {((lastMatch.confidence ?? 0) * 100).toFixed(1)}%</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Card>

          <Card className="p-4 bg-slate-800/60 border-slate-700">
            <div className="flex items-center gap-2 mb-3 font-semibold">
              <Users className="h-4 w-4" /> آخر الحضور
            </div>
            <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
              {matches.length === 0 && (
                <p className="text-sm text-slate-400 text-center py-8">في انتظار وجوه...</p>
              )}
              {matches.map((m, i) => (
                <div key={i} className={`p-3 rounded-lg border text-sm ${
                  m.status === "ok" ? "bg-emerald-900/30 border-emerald-700/50" :
                  m.status === "cooldown" ? "bg-amber-900/30 border-amber-700/50" :
                  m.status === "spoof" ? "bg-rose-900/30 border-rose-700/50" :
                  "bg-slate-900/40 border-slate-700"
                }`}>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-medium">{m.employeeName ?? "غير معروف"}</div>
                      <div className="text-xs opacity-70">{m.employeeCode ?? "—"}</div>
                    </div>
                    <div className="text-xs opacity-70 flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {fmtRelative(m.at)}
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    {m.status === "ok" && (
                      <Badge className="bg-emerald-600">{m.action === "check_in" ? "حضور" : m.action === "check_out" ? "انصراف" : m.action}</Badge>
                    )}
                    {m.status === "cooldown" && <Badge variant="secondary">فترة انتظار</Badge>}
                    {m.status === "unknown" && <Badge variant="destructive">غير معروف</Badge>}
                    {m.status === "low" && <Badge variant="secondary">{m.action}</Badge>}
                    <span className="opacity-70">{(m.confidence * 100).toFixed(0)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {!livenessOk && (
          <div className="text-center p-3 rounded-lg bg-amber-900/30 border border-amber-700/50 text-amber-200 text-sm flex items-center justify-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            للتفعيل الكامل: ارمش بعينيك وحرّك رأسك قليلاً (الكشف الحي)
          </div>
        )}
      </div>

      {/* Admin-only: paired-device management. */}
      {isAdmin && (
        <KioskDeviceManager open={showDeviceManager} onOpenChange={setShowDeviceManager} />
      )}
    </div>
  );
}
