import { useMe } from "@/hooks/use-auth";
import { usePunch as usePunchMutation, useFaceStatus, useFaceEnroll } from "@/hooks/use-hr";
import { Button } from "@/components/ui/button";
import { Fingerprint, Clock, AlertCircle, FileText, CheckCircle2, XCircle, ScanFace, MapPin, LogOut, ShieldCheck } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/use-toast";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import FaceCapture, { type FaceCaptureResult } from "@/components/FaceCapture";

export default function Dashboard() {
  const { data: me, isLoading } = useMe();
  const punch = usePunchMutation();
  const faceStatus = useFaceStatus();
  const faceEnroll = useFaceEnroll();
  const { toast } = useToast();
  const [gpsLoading, setGpsLoading] = useState(false);
  // Camera modal: "enroll" = first-time face registration, otherwise the punch
  // type awaiting live verification.
  const [faceMode, setFaceMode] = useState<null | "enroll" | { type: "in" | "out"; lat?: number; lng?: number; accuracy?: number }>(null);

  const needsFace = !!faceStatus.data && (faceStatus.data.enrolled || faceStatus.data.required);
  const needsEnroll = !!faceStatus.data && faceStatus.data.required && !faceStatus.data.enrolled;
  const canCheckIn = me?.today.canCheckIn ?? !me?.today.checkIn;
  const canCheckOut = me?.today.canCheckOut ?? (!!me?.today.checkIn && !me?.today.checkOut);

  const getGps = () =>
    new Promise<{ lat?: number; lng?: number; accuracy?: number }>((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("خدمة تحديد الموقع غير مدعومة في متصفحك.")); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        (err) => {
          if (err.code === err.PERMISSION_DENIED)
            reject(new Error("متصفحك يمنع الوصول للموقع. افتح إعدادات الموقع في كروم (⋮ ← الإعدادات ← إعدادات المواقع ← الموقع الجغرافي) واسمح لـ zacoderp.com."));
          else if (err.code === err.POSITION_UNAVAILABLE)
            reject(new Error("تعذّر تحديد موقعك — تأكد من تشغيل خدمة الموقع (GPS) في الجوال ثم أعد المحاولة."));
          else
            reject(new Error("انتهت مهلة تحديد الموقع — تأكد أنك في مكان مكشوف أو فعّل «الدقة العالية» في إعدادات الموقع."));
        },
        // Accept a fix from the last 20s — the mount-time warm-up below usually
        // makes the punch-time read instant instead of a cold GPS lock.
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 20000 },
      );
    });

  // Live position: warms up GPS (permission prompt + chip priming, so the
  // punch-time read is instant) AND feeds the in/out-of-range indicator.
  // Stops entirely once both punches are done (no idle battery drain).
  const [livePos, setLivePos] = useState<{ lat: number; lng: number } | null>(null);
  const bothPunched = !!me?.today.checkIn && !!me?.today.checkOut;
  useEffect(() => {
    if (!navigator.geolocation || bothPunched) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => setLivePos({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [bothPunched]);

  const distanceMeters = (lat1: number, lng1: number, lat2: number, lng2: number) => {
    const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  const handlePunch = async (type: "in" | "out") => {
    if (type === "in" && !canCheckIn) {
      toast({
        title: "الحضور مسجّل بالفعل",
        description: "لا تحتاج إلى تسجيل حضور جديد بعد الاستئذان. سجّل الانصراف في نهاية الدوام فقط.",
      });
      return;
    }
    if (type === "out" && !canCheckOut) {
      toast({
        title: me?.today.checkOut ? "الانصراف مسجّل بالفعل" : "سجّل الحضور أولاً",
        description: me?.today.checkOut
          ? `تم تسجيل الانصراف الساعة ${me.today.checkOut}.`
          : "لا يمكن تسجيل الانصراف قبل تسجيل الحضور.",
      });
      return;
    }
    if (needsEnroll) { setFaceMode("enroll"); return; }
    setGpsLoading(true);
    try {
      const gps = await getGps();
      if (needsFace) setFaceMode({ type, ...gps }); // live selfie next, then submit
      else punch.mutate({ type, ...gps });
    } catch (e: any) {
      toast({ variant: "destructive", title: "فشل تحديد الموقع", description: e.message });
    } finally {
      setGpsLoading(false);
    }
  };

  // Deep-link quick actions from "حسابي": /?action=in|out|enroll — consume ONCE
  // then strip the param so refresh/back doesn't re-trigger.
  const actionConsumedRef = useRef(false);
  useEffect(() => {
    if (actionConsumedRef.current || isLoading || !me || faceStatus.isLoading) return;
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    if (!action) return;
    actionConsumedRef.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    if (action === "enroll") {
      if (faceStatus.data?.enrolled) toast({ title: "وجهك مسجّل بالفعل", description: "سيتم التحقق بالوجه تلقائياً عند كل بصمة" });
      else setFaceMode("enroll");
    } else if (action === "in" || action === "out") {
      void handlePunch(action);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, me, faceStatus.isLoading]);

  const handleFaceDone = (r: FaceCaptureResult) => {
    const mode = faceMode;
    setFaceMode(null);
    if (mode === "enroll") faceEnroll.mutate(r);
    else if (mode) punch.mutate({ ...mode, ...r });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-3xl" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (!me) return null;

  const needsCheckIn = me.today.canCheckIn;
  const needsCheckOut = me.today.canCheckOut;
  const punchDone = me.today.state === "completed";

  // Reminder: shift started and no check-in yet.
  const nowHM = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  const shiftStart = me.shift?.start ?? "08:00";
  const showReminder = needsCheckIn && nowHM >= shiftStart;

  return (
    <div className="space-y-6">
      {showReminder && (
        <div className="bg-orange-50 border border-orange-200 text-orange-800 rounded-2xl p-4 flex items-center gap-3" data-testid="banner-checkin-reminder">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <p className="text-sm font-medium">
            بدأ الدوام الساعة {shiftStart} ولم تسجّل حضورك بعد — اضغط زر البصمة الآن.
          </p>
        </div>
      )}
      {/* Greeting Card */}
      <div className="bg-gradient-to-r from-primary to-primary/80 rounded-3xl p-6 text-primary-foreground shadow-lg">
        <h2 className="text-sm font-medium opacity-90 mb-1">
          {format(new Date(), "EEEE، d MMMM yyyy", { locale: ar })}
        </h2>
        <h1 className="text-2xl font-bold mb-4">مرحباً، {me.employee.nameAr.split(" ")[0]}! 👋</h1>
        
        <div className="flex bg-black/10 rounded-2xl p-4 gap-4 backdrop-blur-sm">
          <div className="flex-1">
            <p className="text-xs opacity-80 mb-1">وقت الحضور</p>
            <p className="font-semibold">{me.today.checkIn || "—"}</p>
          </div>
          <div className="w-px bg-white/20" />
          <div className="flex-1">
            <p className="text-xs opacity-80 mb-1">وقت الانصراف</p>
            <p className="font-semibold">{me.today.checkOut || "—"}</p>
          </div>
        </div>
      </div>

      {me.today.approvedPermissions.length > 0 && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-blue-900" data-testid="approved-permission-notice">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-700" />
            <div className="space-y-1">
              <p className="font-bold">استئذان معتمد اليوم</p>
              {me.today.approvedPermissions.map((permission) => (
                <p key={permission.id} className="text-sm">
                  من {permission.startTime} إلى {permission.endTime}
                  {" — "}
                  {permission.paid ? "مدفوع" : "غير مدفوع"}
                </p>
              ))}
              <p className="text-sm font-medium">
                ستُخصم فترة الاستئذان تلقائيًا من حساب اليوم، ولا تحتاج إلى تسجيل حضور جديد بعد انتهائها.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* One workday = one employee-portal check-in and one checkout. */}
      <div className="bg-card rounded-3xl p-8 border shadow-sm flex flex-col items-center text-center">
        {me.work && livePos && !punchDone && (() => {
          const dist = Math.round(distanceMeters(livePos.lat, livePos.lng, me.work!.lat, me.work!.lng));
          const inside = dist <= me.work!.radiusM;
          return (
            <div
              className={`mb-5 flex items-center gap-1.5 text-xs font-semibold rounded-full px-3 py-1.5 border ${
                inside ? "bg-green-50 text-green-700 border-green-200" : "bg-orange-50 text-orange-700 border-orange-200"
              }`}
              data-testid="chip-geofence"
            >
              <MapPin className="w-3.5 h-3.5" />
              {inside
                ? "أنت داخل نطاق موقع العمل ✓"
                : `أنت خارج نطاق العمل — البعد ${dist >= 1000 ? `${(dist / 1000).toFixed(1)} كم` : `${dist} متر`} (المسموح ${me.work!.radiusM} متر)`}
            </div>
          );
        })()}

        <div className="grid w-full max-w-xl grid-cols-1 gap-4 sm:grid-cols-2">
          <Button
            onClick={() => handlePunch("in")}
            disabled={!needsCheckIn || gpsLoading || punch.isPending}
            className="h-28 rounded-2xl flex-col gap-2 text-base"
            data-testid="button-check-in"
          >
            {me.today.checkIn ? <CheckCircle2 className="h-8 w-8" /> : <Fingerprint className="h-8 w-8" />}
            <span>{me.today.checkIn ? `تم الحضور ${me.today.checkIn}` : "تسجيل الحضور"}</span>
          </Button>
          <Button
            onClick={() => handlePunch("out")}
            disabled={!needsCheckOut || gpsLoading || punch.isPending}
            className="h-28 rounded-2xl flex-col gap-2 bg-orange-500 text-base hover:bg-orange-600 disabled:bg-muted disabled:text-muted-foreground"
            data-testid="button-check-out"
          >
            {me.today.checkOut ? <CheckCircle2 className="h-8 w-8" /> : <LogOut className="h-8 w-8" />}
            <span>{me.today.checkOut ? `تم الانصراف ${me.today.checkOut}` : "تسجيل الانصراف"}</span>
          </Button>
        </div>

        <p className="mt-5 text-sm text-muted-foreground flex items-center gap-1.5 justify-center">
          <AlertCircle className="w-4 h-4" />
          {punchDone
            ? "اكتملت بصمات يوم العمل. يعطيك العافية!"
            : me.today.permissionActive
              ? "الاستئذان المعتمد جارٍ الآن؛ لا تسجّل انصرافًا أو حضورًا جديدًا."
            : needsCheckOut
              ? "الحضور مسجّل؛ سجّل الانصراف مرة واحدة عند نهاية الدوام."
              : needsFace
                ? "يتطلب تحديد الموقع (GPS) والتحقق بالوجه"
                : "يتطلب تحديد الموقع الجغرافي (GPS)"}
        </p>
        {me.today.state === "needs_hr_review" && (
          <p className="mt-3 text-sm font-semibold text-destructive">
            سجل اليوم يحتاج مراجعة الموارد البشرية قبل إضافة أي بصمة.
          </p>
        )}
        {needsEnroll && (
          <button
            onClick={() => setFaceMode("enroll")}
            className="mt-4 flex items-center gap-2 text-sm font-semibold text-primary bg-primary/10 rounded-full px-4 py-2"
            data-testid="button-face-enroll"
          >
            <ScanFace className="w-4 h-4" />
            سجّل وجهك أول مرة لتفعيل البصمة
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <h3 className="text-lg font-bold px-1 mt-8 mb-4">ملخص الشهر الحالي</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-card p-5 rounded-2xl border shadow-sm">
          <div className="text-green-600 bg-green-50 w-10 h-10 rounded-xl flex items-center justify-center mb-3">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <p className="text-2xl font-bold">{me.month.presentDays}</p>
          <p className="text-sm text-muted-foreground mt-1">أيام الحضور</p>
        </div>
        
        <div className="bg-card p-5 rounded-2xl border shadow-sm">
          <div className="text-red-600 bg-red-50 w-10 h-10 rounded-xl flex items-center justify-center mb-3">
            <XCircle className="w-5 h-5" />
          </div>
          <p className="text-2xl font-bold">{me.month.absentDays}</p>
          <p className="text-sm text-muted-foreground mt-1">أيام الغياب</p>
        </div>

        <div className="bg-card p-5 rounded-2xl border shadow-sm">
          <div className="text-orange-600 bg-orange-50 w-10 h-10 rounded-xl flex items-center justify-center mb-3">
            <Clock className="w-5 h-5" />
          </div>
          <p className="text-2xl font-bold">{me.month.lateCount}</p>
          <p className="text-sm text-muted-foreground mt-1">مرات التأخير</p>
        </div>

        <div className="bg-card p-5 rounded-2xl border shadow-sm">
          <div className="text-blue-600 bg-blue-50 w-10 h-10 rounded-xl flex items-center justify-center mb-3">
            <FileText className="w-5 h-5" />
          </div>
          <p className="text-2xl font-bold">{me.month.pendingRequests}</p>
          <p className="text-sm text-muted-foreground mt-1">طلبات معلقة</p>
        </div>
      </div>

      {faceMode !== null && faceStatus.data && (
        <FaceCapture
          title={faceMode === "enroll" ? "تسجيل الوجه لأول مرة" : "التحقق بالوجه"}
          requireLiveness={faceStatus.data.requireLiveness}
          minQuality={faceStatus.data.minQuality}
          onDone={handleFaceDone}
          onClose={() => setFaceMode(null)}
        />
      )}
    </div>
  );
}
