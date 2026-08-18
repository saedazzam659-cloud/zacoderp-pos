import { useMe, useLogout } from "@/hooks/use-auth";
import { useFaceStatus } from "@/hooks/use-hr";
import { Button } from "@/components/ui/button";
import { LogOut, User as UserIcon, Building, Briefcase, Mail, Phone, Hash, ScanFace, LogIn, DoorOpen, ChevronLeft, CheckCircle2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useLocation } from "wouter";

export default function Profile() {
  const { data: me, isLoading } = useMe();
  const faceStatus = useFaceStatus();
  const logout = useLogout();
  const [, navigate] = useLocation();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-48 w-full rounded-3xl" />
        <Skeleton className="h-64 w-full rounded-3xl" />
      </div>
    );
  }

  if (!me) return null;
  const emp = me.employee;

  return (
    <div className="space-y-6">
      {/* Profile Header */}
      <div className="bg-card rounded-3xl p-6 border shadow-sm flex flex-col sm:flex-row items-center sm:items-start gap-6 text-center sm:text-start relative overflow-hidden">
        <div className="absolute top-0 end-0 w-32 h-32 bg-primary/5 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />
        
        <Avatar className="w-24 h-24 border-4 border-background shadow-lg">
          <AvatarImage src={emp.photoUrl} alt={emp.nameAr} />
          <AvatarFallback className="bg-primary/10 text-primary text-2xl font-bold">
            {emp.nameAr.charAt(0)}
          </AvatarFallback>
        </Avatar>
        
        <div className="flex-1 mt-2">
          <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-3 py-1 rounded-full text-xs font-semibold mb-3">
            <Building className="w-3.5 h-3.5" />
            {me.company.nameAr}
          </div>
          <h1 className="text-2xl font-bold mb-1">{emp.nameAr}</h1>
          <p className="text-muted-foreground">{emp.nameEn}</p>
        </div>
      </div>

      {/* Info Cards */}
      <div className="bg-card rounded-3xl border shadow-sm divide-y">
        <div className="p-4 sm:p-5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
            <Hash className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="text-xs text-muted-foreground mb-0.5">الرقم الوظيفي</p>
            <p className="font-semibold">{emp.code}</p>
          </div>
        </div>

        <div className="p-4 sm:p-5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-green-50 text-green-600 flex items-center justify-center shrink-0">
            <Briefcase className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="text-xs text-muted-foreground mb-0.5">المسمى الوظيفي</p>
            <p className="font-semibold">{emp.jobTitle}</p>
          </div>
        </div>

        <div className="p-4 sm:p-5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center shrink-0">
            <Building className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="text-xs text-muted-foreground mb-0.5">القسم</p>
            <p className="font-semibold">{emp.department}</p>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="bg-card rounded-3xl border shadow-sm divide-y overflow-hidden">
        <button
          onClick={() => navigate("/?action=enroll")}
          className="w-full p-4 sm:p-5 flex items-center gap-4 hover:bg-muted/50 active:bg-muted transition-colors text-start"
          data-testid="link-face-enroll"
        >
          <div className="w-10 h-10 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center shrink-0">
            <ScanFace className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="font-semibold">بصمة الوجه</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {faceStatus.data?.enrolled
                ? <span className="inline-flex items-center gap-1 text-green-600"><CheckCircle2 className="w-3.5 h-3.5" /> وجهك مسجّل — يتم التحقق تلقائياً</span>
                : "اضغط لفتح الكاميرا وتسجيل وجهك أول مرة"}
            </p>
          </div>
          <ChevronLeft className="w-5 h-5 text-muted-foreground" />
        </button>

        <button
          onClick={() => navigate("/?action=in")}
          className="w-full p-4 sm:p-5 flex items-center gap-4 hover:bg-muted/50 active:bg-muted transition-colors text-start"
          data-testid="link-punch-in"
        >
          <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <LogIn className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="font-semibold">تسجيل الحضور</p>
            <p className="text-xs text-muted-foreground mt-0.5">موقعك + وجهك مباشرة بضغطة واحدة</p>
          </div>
          <ChevronLeft className="w-5 h-5 text-muted-foreground" />
        </button>

        <button
          onClick={() => navigate("/?action=out")}
          className="w-full p-4 sm:p-5 flex items-center gap-4 hover:bg-muted/50 active:bg-muted transition-colors text-start"
          data-testid="link-punch-out"
        >
          <div className="w-10 h-10 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center shrink-0">
            <DoorOpen className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="font-semibold">تسجيل الانصراف</p>
            <p className="text-xs text-muted-foreground mt-0.5">موقعك + وجهك مباشرة بضغطة واحدة</p>
          </div>
          <ChevronLeft className="w-5 h-5 text-muted-foreground" />
        </button>
      </div>

      {/* Actions */}
      <div className="pt-4">
        <Button 
          variant="destructive" 
          size="lg" 
          className="w-full sm:w-auto rounded-xl gap-2 h-12 shadow-lg shadow-destructive/20"
          onClick={() => logout()}
        >
          <LogOut className="w-5 h-5" />
          تسجيل الخروج
        </Button>
      </div>
    </div>
  );
}
