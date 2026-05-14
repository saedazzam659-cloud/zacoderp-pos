import { useEffect, useRef, useState } from "react";
import { faceApi } from "@/lib/faceAttendanceApi";
import { loadFaceApi } from "@/lib/faceapi/loader";
import { evaluateFaceQuality } from "@/lib/faceapi/quality";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, MapPin, ScanFace, CheckCircle2, AlertTriangle, LogIn, LogOut,
  Camera as CameraIcon,
} from "lucide-react";

interface GpsState {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  error: string | null;
  busy: boolean;
}

const initialGps: GpsState = { lat: null, lng: null, accuracy: null, error: null, busy: false };

const STATUS_LABEL: Record<string, { ar: string; tone: "ok" | "warn" | "err" }> = {
  ok:               { ar: "داخل النطاق المسموح", tone: "ok" },
  no_gps:           { ar: "لم يُحدّد موقع عمل لهذا الموظف", tone: "warn" },
  out_of_geofence:  { ar: "خارج النطاق — يحتاج موافقة المدير", tone: "warn" },
  low_accuracy:     { ar: "دقة GPS منخفضة — يحتاج موافقة المدير", tone: "warn" },
  mock_suspected:   { ar: "موقع مزيّف مشكوك به — يحتاج موافقة المدير", tone: "err" },
  denied:           { ar: "إذن الموقع مرفوض — يحتاج موافقة المدير", tone: "err" },
};

export default function MobileCheckIn() {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const apiRef = useRef<any>(null);

  const [modelLoading, setModelLoading] = useState(true);
  const [cameraOn, setCameraOn] = useState(false);
  const [gps, setGps] = useState<GpsState>(initialGps);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<{
    action: string;
    locationStatus: string;
    distanceM: number | null;
    flagged: boolean;
    employeeName?: string | null;
  } | null>(null);

  // ── Camera ────────────────────────────────────────────────────────────
  // Open the front-facing webcam on mount and stop it on unmount so the
  // browser's mic/camera indicator clears when the user navigates away.
  useEffect(() => {
    loadFaceApi()
      .then((api) => { apiRef.current = api; setModelLoading(false); })
      .catch((e: any) => {
        setModelLoading(false);
        toast({ title: "تعذر تحميل نماذج التعرّف", description: e?.message ?? "", variant: "destructive" });
      });
  }, [toast]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 640 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch (e: any) {
      toast({ title: "تعذر فتح الكاميرا", description: e?.message ?? "", variant: "destructive" });
    }
  };

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  // ── GPS ───────────────────────────────────────────────────────────────
  const captureLocation = () => {
    if (!("geolocation" in navigator)) {
      setGps({ ...initialGps, error: "جهازك لا يدعم تحديد الموقع" });
      return;
    }
    setGps({ ...initialGps, busy: true });
    navigator.geolocation.getCurrentPosition(
      (pos) => setGps({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        error: null,
        busy: false,
      }),
      (e) => {
        let msg = "حدث خطأ في تحديد الموقع";
        if (e.code === 1) msg = "تم رفض إذن الموقع — سيتم وضع علامة 'يحتاج موافقة المدير'";
        else if (e.code === 2) msg = "تعذر تحديد الموقع — تأكد من تفعيل GPS";
        else if (e.code === 3) msg = "انتهت مهلة GPS — حاول مجدداً";
        setGps({ lat: null, lng: null, accuracy: null, error: msg, busy: false });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  // Try to grab a quick GPS reading on mount so the user sees an early
  // signal of whether they're in range — they can re-fetch right before
  // submitting.
  useEffect(() => { captureLocation(); }, []);

  // ── Submit (face → recognize → check) ─────────────────────────────────
  const submit = async (action: "check_in" | "check_out") => {
    if (busy) return;
    const video = videoRef.current;
    const api = apiRef.current;
    if (!cameraOn || !video || !api || video.readyState < 2) {
      toast({ title: "افتح الكاميرا أولاً", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const opts = new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
      const detection = await api
        .detectSingleFace(video, opts)
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!detection?.descriptor) {
        toast({ title: "لم يُعثر على وجه", description: "تأكد من إضاءة وجهك واتجه نحو الكاميرا", variant: "destructive" });
        setBusy(false); return;
      }
      const q = evaluateFaceQuality([detection], video.videoWidth, video.videoHeight);
      if (q.score < 0.45) {
        toast({ title: "جودة الصورة منخفضة", description: "اقترب من الكاميرا في إضاءة جيدة", variant: "destructive" });
        setBusy(false); return;
      }
      const descriptor = Array.from(detection.descriptor) as number[];
      const rec = await faceApi.recognize(descriptor, null, true);
      if (!rec.matched || !rec.ticket) {
        toast({
          title: "لم نتعرف على وجهك",
          description: "إن لم تكن مسجَّلاً، اطلب من قسم الموارد البشرية تسجيل بصمتك أولاً.",
          variant: "destructive",
        });
        setBusy(false); return;
      }
      const checkRes = await faceApi.check({
        ticket: rec.ticket,
        action,
        deviceInfo: navigator.userAgent.slice(0, 120),
        location: {
          lat: gps.lat,
          lng: gps.lng,
          accuracy: gps.accuracy,
          mocked: false,
        },
      });
      if (!checkRes.ok) {
        const reason = checkRes.reason === "cooldown"
          ? `يجب الانتظار قليلاً قبل المحاولة مجدداً`
          : checkRes.reason ?? "تعذّر التسجيل";
        toast({ title: "لم يُسجّل", description: reason, variant: "destructive" });
        setBusy(false); return;
      }
      const loc = checkRes.location;
      const ok = !loc?.flagged;
      setLastResult({
        action: checkRes.action ?? action,
        locationStatus: loc?.status ?? "no_gps",
        distanceM: loc?.distanceM ?? null,
        flagged: !!loc?.flagged,
        employeeName: rec.employeeName,
      });
      toast({
        title: ok ? "تم التسجيل بنجاح" : "تم التسجيل — يحتاج موافقة المدير",
        description: ok
          ? `${rec.employeeName ?? ""} — ${action === "check_in" ? "حضور" : "انصراف"}`
          : STATUS_LABEL[loc?.status ?? "no_gps"]?.ar,
      });
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message ?? "", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const accuracyTone = gps.accuracy == null ? "muted"
    : gps.accuracy < 30 ? "ok"
    : gps.accuracy < 75 ? "warn"
    : "err";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-4 pb-12">
      <div className="max-w-md mx-auto space-y-4">
        <div className="text-center pt-4">
          <div className="inline-flex h-16 w-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 items-center justify-center mb-3 shadow-xl">
            <ScanFace className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold">تسجيل الحضور والانصراف</h1>
          <p className="text-sm text-slate-400 mt-1">
            تحقّق من الوجه + الموقع الجغرافي للموظف
          </p>
        </div>

        {/* Camera card */}
        <Card className="bg-slate-800/60 border-slate-700 p-3 space-y-2">
          <div className="relative bg-black rounded-xl overflow-hidden aspect-[3/4]" data-testid="video-container">
            {!cameraOn && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-slate-400">
                <CameraIcon className="h-12 w-12 opacity-60" />
                <Button
                  onClick={startCamera}
                  disabled={modelLoading}
                  className="gap-2"
                  data-testid="button-start-camera"
                >
                  {modelLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CameraIcon className="h-4 w-4" />}
                  {modelLoading ? "جاري تحميل نماذج التعرف..." : "افتح الكاميرا"}
                </Button>
              </div>
            )}
            <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
            {/* On-screen face oval to guide the user's framing. */}
            {cameraOn && (
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-44 h-56 rounded-[50%] border-2 border-emerald-400/60 border-dashed" />
              </div>
            )}
          </div>
        </Card>

        {/* GPS card */}
        <Card className={`p-4 border ${
          gps.error ? "bg-rose-900/20 border-rose-700/50" :
          gps.lat != null ? (accuracyTone === "ok" ? "bg-emerald-900/20 border-emerald-700/50"
                            : accuracyTone === "warn" ? "bg-amber-900/20 border-amber-700/50"
                            : "bg-rose-900/20 border-rose-700/50")
          : "bg-slate-800/60 border-slate-700"
        }`}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <MapPin className={`h-5 w-5 shrink-0 ${
                gps.error ? "text-rose-400" :
                gps.lat != null ? "text-emerald-400" : "text-slate-400"
              }`} />
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  {gps.busy ? "جاري تحديد الموقع..." :
                   gps.error ? "الموقع غير متاح" :
                   gps.lat != null ? "تم تحديد الموقع" : "الموقع غير محدد"}
                </div>
                <div className="text-xs text-slate-300/80">
                  {gps.error ?? (gps.accuracy != null
                    ? `دقة: ±${Math.round(gps.accuracy)} م`
                    : "اضغط لتحديث الموقع")}
                </div>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={captureLocation}
              disabled={gps.busy}
              className="bg-slate-900/40 border-slate-700"
              data-testid="button-refresh-gps"
            >
              {gps.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "تحديث"}
            </Button>
          </div>
        </Card>

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-3">
          <Button
            size="lg"
            onClick={() => submit("check_in")}
            disabled={busy || !cameraOn}
            className="h-16 text-lg gap-2 bg-emerald-600 hover:bg-emerald-700"
            data-testid="button-check-in"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogIn className="h-5 w-5" />}
            حضور
          </Button>
          <Button
            size="lg"
            onClick={() => submit("check_out")}
            disabled={busy || !cameraOn}
            variant="outline"
            className="h-16 text-lg gap-2 bg-slate-800 border-slate-600 hover:bg-slate-700"
            data-testid="button-check-out"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogOut className="h-5 w-5" />}
            انصراف
          </Button>
        </div>

        {/* Last result */}
        {lastResult && (
          <Card className={`p-4 border ${
            lastResult.flagged
              ? "bg-amber-900/20 border-amber-700/60"
              : "bg-emerald-900/20 border-emerald-700/60"
          }`} data-testid="last-result">
            <div className="flex items-start gap-3">
              {lastResult.flagged
                ? <AlertTriangle className="h-6 w-6 text-amber-400 shrink-0" />
                : <CheckCircle2 className="h-6 w-6 text-emerald-400 shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="font-bold">
                  {lastResult.action === "check_in" ? "تم تسجيل الحضور" : "تم تسجيل الانصراف"}
                </div>
                {lastResult.employeeName && (
                  <div className="text-sm text-slate-300 mt-0.5">{lastResult.employeeName}</div>
                )}
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <Badge className={lastResult.flagged ? "bg-amber-700" : "bg-emerald-700"}>
                    {STATUS_LABEL[lastResult.locationStatus]?.ar ?? lastResult.locationStatus}
                  </Badge>
                  {lastResult.distanceM != null && (
                    <Badge variant="outline" className="border-slate-600 text-slate-200">
                      المسافة من الموقع: {Math.round(lastResult.distanceM)} م
                    </Badge>
                  )}
                </div>
                {lastResult.flagged && (
                  <p className="text-xs text-amber-200/80 mt-2 leading-relaxed">
                    تم حفظ السجل وسيتم إخطار المدير لمراجعة الموقع والموافقة عليه.
                  </p>
                )}
              </div>
            </div>
          </Card>
        )}

        <p className="text-center text-xs text-slate-500 pt-2">
          اسمح للمتصفح بالوصول للكاميرا والموقع لضمان دقة التسجيل.
        </p>
      </div>
    </div>
  );
}
