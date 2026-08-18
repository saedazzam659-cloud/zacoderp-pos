import { useMe } from "@/hooks/use-auth";
import { usePunch as usePunchMutation } from "@/hooks/use-hr";
import { Button } from "@/components/ui/button";
import { Fingerprint, Clock, AlertCircle, FileText, CheckCircle2, XCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useToast } from "@/components/ui/use-toast";
import { format } from "date-fns";
import { ar } from "date-fns/locale";

export default function Dashboard() {
  const { data: me, isLoading } = useMe();
  const punch = usePunchMutation();
  const { toast } = useToast();
  const [gpsLoading, setGpsLoading] = useState(false);

  const handlePunch = async (type: "in" | "out") => {
    setGpsLoading(true);
    
    if (!navigator.geolocation) {
      toast({
        variant: "destructive",
        title: "غير مدعوم",
        description: "خدمة تحديد الموقع غير مدعومة في متصفحك.",
      });
      setGpsLoading(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        punch.mutate({
          type,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setGpsLoading(false);
      },
      (err) => {
        toast({
          variant: "destructive",
          title: "فشل تحديد الموقع",
          description: "يرجى السماح بصلاحيات الموقع لتتمكن من تسجيل البصمة.",
        });
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
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

  return (
    <div className="space-y-6">
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
              يتطلب تحديد الموقع الجغرافي (GPS)
            </p>
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
    </div>
  );
}
