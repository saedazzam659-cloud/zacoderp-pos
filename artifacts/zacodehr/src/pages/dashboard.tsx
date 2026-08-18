import { useMe } from "@/hooks/use-auth";
import { usePunch as usePunchMutation, useFaceStatus, useFaceEnroll } from "@/hooks/use-hr";
import { Button } from "@/components/ui/button";
import { Fingerprint, Clock, AlertCircle, FileText, CheckCircle2, XCircle, ScanFace } from "lucide-react";
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

  const getGps = () =>
    new Promise<{ lat?: number; lng?: number; accuracy?: number }>((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("خدمة تحديد الموقع غير مدعومة في متصفحك.")); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        () => reject(new Error("يرجى السماح بصلاحيات الموقع لتتمكن من تسجيل البصمة.")),
        // Accept a fix from the last 20s — the mount-time warm-up below usually
        // makes the punch-time read instant instead of a cold GPS lock.
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 20000 },
      );
    });

  // Warm up GPS on page load: triggers the permission prompt early and primes
  // the GPS chip so the actual punch gets a cached high-accuracy fix instantly.
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(() => {}, () => {}, {
      enableHighAccuracy: true, timeout: 15000, maximumAge: 60000,
    });
  }, []);

  const handlePunch = async (type: "in" | "out") => {
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

  const needsCheckIn = !me.today.checkIn;
  const needsCheckOut = !!me.today.checkIn && !me.today.checkOut;
  const punchDone = !!me.today.checkIn && !!me.today.checkOut;

  // Reminder: shift started and no check-in yet.
  const nowHM = format(new Date(), "HH:mm");
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

      {/* Big Punch Button Area */}
      <div className="bg-card rounded-3xl p-8 border shadow-sm flex flex-col items-center text-center">
        {!punchDone ? (
          <>
            <div className="mb-6 relative">
              <div className="absolute inset-0 bg-primary/20 rounded-full animate-ping" />
              <Button
                size="icon"
                onClick={() => handlePunch(needsCheckIn ? "in" : "out")}
                disabled={gpsLoading || punch.isPending}
                className={`w-32 h-32 rounded-full shadow-2xl transition-transform hover:scale-105 active:scale-95 ${
                  needsCheckIn 
                    ? "bg-primary hover:bg-primary/90 shadow-primary/30" 
                    : "bg-orange-500 hover:bg-orange-600 shadow-orange-500/30"
                }`}
              >
                <Fingerprint className="w-16 h-16 text-white" />
              </Button>
            </div>
            <h3 className="text-xl font-bold mb-2">
              {needsCheckIn ? "تسجيل الحضور" : "تسجيل الانصراف"}
            </h3>
            <p className="text-muted-foreground text-sm flex items-center gap-1.5 justify-center">
              <AlertCircle className="w-4 h-4" />
              {needsFace ? "يتطلب تحديد الموقع (GPS) والتحقق بالوجه" : "يتطلب تحديد الموقع الجغرافي (GPS)"}
            </p>
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
          </>
        ) : (
          <div className="py-8 flex flex-col items-center">
            <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-4">
              <CheckCircle2 className="w-10 h-10" />
            </div>
            <h3 className="text-xl font-bold mb-2">اكتملت بصمات اليوم</h3>
            <p className="text-muted-foreground">يعطيك العافية، نراكم غداً!</p>
          </div>
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
