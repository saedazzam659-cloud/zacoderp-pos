import { useLocation } from "wouter";
import { Clock, CheckCircle2, Mail, ArrowRight, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PendingApproval() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-background to-muted flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-md text-center space-y-6">
        {/* Icon */}
        <div className="inline-flex h-20 w-20 items-center justify-center rounded-2xl bg-amber-100 border-2 border-amber-300 text-amber-600 mx-auto">
          <Clock className="h-10 w-10" />
        </div>

        {/* Title */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">تم استلام طلبك بنجاح!</h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            شكراً لتسجيلك في نظام الفاتورة الإلكترونية. طلبك قيد المراجعة من قِبل فريق الإدارة.
          </p>
        </div>

        {/* Steps */}
        <div className="bg-card border rounded-2xl p-6 text-right space-y-4">
          <h3 className="font-semibold text-foreground">ما الذي يحدث الآن؟</h3>
          <div className="space-y-3">
            {[
              { done: true,  label: "استلام الطلب",         desc: "تم استلام بياناتك بنجاح" },
              { done: false, label: "مراجعة البيانات",       desc: "يراجع الفريق معلومات شركتك" },
              { done: false, label: "قبول أو إرسال ملاحظات", desc: "ستُبلَّغ بالقرار قريباً" },
              { done: false, label: "تفعيل الحساب",          desc: "تبدأ إصدار الفواتير فوراً" },
            ].map((s, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold mt-0.5 ${s.done ? "bg-green-100 text-green-700 border border-green-300" : "bg-muted text-muted-foreground border"}`}>
                  {s.done ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                </div>
                <div>
                  <p className={`text-sm font-medium ${s.done ? "text-green-700" : "text-foreground"}`}>{s.label}</p>
                  <p className="text-xs text-muted-foreground">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Notice */}
        <div className="flex items-start gap-2 p-4 bg-blue-50 border border-blue-200 rounded-xl text-blue-800 text-sm text-right">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
          <p>عادةً ما تتم المراجعة خلال 24-48 ساعة عمل. إذا كان لديك استفسار، تواصل مع الدعم.</p>
        </div>

        <div className="flex flex-col gap-3">
          <Button onClick={() => setLocation("/login")} className="w-full gap-2">
            <ArrowRight className="h-4 w-4" />
            العودة لتسجيل الدخول
          </Button>
          <p className="text-xs text-muted-foreground">
            بعد الموافقة، سجّل الدخول بنفس اسم المستخدم وكلمة المرور التي اخترتها
          </p>
        </div>
      </div>
    </div>
  );
}
