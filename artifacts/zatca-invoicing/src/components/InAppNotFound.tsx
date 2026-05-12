import { useLocation } from "wouter";
import { ShieldAlert, Home, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";

export default function InAppNotFound() {
  const [, setLocation] = useLocation();
  const { user } = useAuth() as any;
  const path = typeof window !== "undefined" ? window.location.pathname : "";

  return (
    <div dir="rtl" className="min-h-[calc(100vh-8rem)] flex items-center justify-center px-4 py-10">
      <div className="max-w-lg w-full text-center" data-testid="inapp-not-found">
        <div className="inline-flex h-20 w-20 items-center justify-center rounded-full bg-amber-100 text-amber-600 mb-5 ring-8 ring-amber-50">
          <ShieldAlert className="h-10 w-10" />
        </div>
        <h1 className="text-2xl md:text-3xl font-extrabold mb-3">
          لا تملك صلاحية الوصول
        </h1>
        <p className="text-muted-foreground mb-2 leading-relaxed">
          الصفحة المطلوبة غير متاحة لحسابك أو غير موجودة.
        </p>
        {path && (
          <p className="text-xs text-muted-foreground/70 mb-6 font-mono ltr break-all">
            {path}
          </p>
        )}
        <div className="flex flex-wrap justify-center gap-3 mb-6">
          <Button
            size="lg"
            onClick={() => setLocation("/")}
            className="gap-1.5"
            data-testid="inapp-not-found-home"
          >
            <Home className="h-4 w-4" />
            العودة للرئيسية
          </Button>
          <Button
            size="lg"
            variant="outline"
            onClick={() => window.history.back()}
            className="gap-1.5"
            data-testid="inapp-not-found-back"
          >
            <ArrowRight className="h-4 w-4" />
            الرجوع للصفحة السابقة
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          إذا كنت تحتاج صلاحية إضافية، تواصل مع مدير النظام في شركتك
          {user?.username ? ` (${user.username})` : ""}.
        </p>
      </div>
    </div>
  );
}
