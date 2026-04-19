import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator
} from "@/components/ui/input-otp";
import {
  Smartphone, ExternalLink, ShieldCheck, CheckCircle2, Loader2,
  ArrowLeft, Globe, Building2, Hash
} from "lucide-react";

interface ZatcaOtpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string;
  vatNumber: string;
  isSandbox: boolean;
  hasCsr: boolean;
  loading: boolean;
  onSubmit: (otp: string) => void;
}

const STEPS = [
  {
    n: 1,
    icon: Globe,
    title: "ادخل إلى بوابة ZATCA",
    desc: "افتح متصفحك وانتقل إلى الموقع الرسمي لهيئة الزكاة",
  },
  {
    n: 2,
    icon: Building2,
    title: "سجّل دخولك وابحث عن الشركة",
    desc: "سجّل الدخول باستخدام بياناتك وانتقل إلى قسم ربط الأجهزة",
  },
  {
    n: 3,
    icon: Smartphone,
    title: "اطلب رمز OTP",
    desc: "اضغط على \"إضافة جهاز\" أو \"ربط جهاز\" وسيُرسَل الرمز إلى هاتفك",
  },
  {
    n: 4,
    icon: ShieldCheck,
    title: "أدخل الرمز هنا",
    desc: "أدخل الرمز المكوّن من 6 أرقام الذي وصلك عبر الرسالة النصية",
  },
];

export default function ZatcaOtpDialog({
  open,
  onOpenChange,
  companyName,
  vatNumber,
  isSandbox,
  hasCsr,
  loading,
  onSubmit,
}: ZatcaOtpDialogProps) {
  const [otp, setOtp] = useState("");
  const [currentStep, setCurrentStep] = useState(isSandbox ? 3 : 0);

  const isReady = otp.length === 6 && hasCsr;

  function handleSubmit() {
    if (isReady) onSubmit(otp);
  }

  function handleClose(open: boolean) {
    if (!open && !loading) {
      setOtp("");
      if (!isSandbox) setCurrentStep(0);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-lg w-full"
        dir="rtl"
        aria-describedby="otp-dialog-desc"
      >
        <DialogHeader className="text-right">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <DialogTitle className="text-lg">ربط الجهاز بهيئة الزكاة والدخل</DialogTitle>
          </div>
          <DialogDescription id="otp-dialog-desc" className="text-right">
            اتبع الخطوات للحصول على رمز التحقق من البوابة الرسمية
          </DialogDescription>
        </DialogHeader>

        {/* Company Info Banner */}
        <div className="flex items-center gap-3 px-4 py-3 bg-muted/60 rounded-lg text-sm">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 shrink-0">
            <Building2 className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold truncate">{companyName}</p>
            <p className="text-muted-foreground text-xs font-mono flex items-center gap-1 mt-0.5">
              <Hash className="h-3 w-3" />
              {vatNumber}
            </p>
          </div>
          {isSandbox ? (
            <Badge variant="outline" className="shrink-0 text-amber-700 border-amber-300 bg-amber-50">
              Sandbox
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 text-green-700 border-green-300 bg-green-50">
              إنتاج
            </Badge>
          )}
        </div>

        {/* No CSR Warning */}
        {!hasCsr && (
          <div className="flex items-start gap-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
            <span className="text-lg shrink-0 mt-0.5">🔑</span>
            <div>
              <p className="font-semibold">يجب توليد CSR أولاً</p>
              <p className="text-xs mt-0.5 text-red-700">
                اذهب للخطوة الأولى "المفتاح والإعدادات" وولِّد مفتاح ECDSA وطلب الشهادة (CSR) قبل المتابعة.
              </p>
            </div>
          </div>
        )}

        {/* Sandbox shortcut notice */}
        {isSandbox && hasCsr && (
          <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
            <span className="text-lg shrink-0">🧪</span>
            <div>
              <p className="font-semibold">بيئة الاختبار (Sandbox)</p>
              <p className="text-xs mt-0.5">
                استخدم رمز OTP التجريبي:{" "}
                <button
                  type="button"
                  onClick={() => setOtp("123345")}
                  className="font-mono font-bold bg-amber-200 px-2 py-0.5 rounded cursor-pointer hover:bg-amber-300 transition-colors"
                >
                  123345
                </button>
                <span className="mr-1">(انقر لنسخه تلقائياً)</span>
              </p>
            </div>
          </div>
        )}

        {/* Steps guide */}
        {!isSandbox && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground font-medium">دليل الخطوات:</p>
            <div className="grid grid-cols-2 gap-2">
              {STEPS.map(step => {
                const Icon = step.icon;
                const isDone = currentStep > step.n - 1;
                const isActive = currentStep === step.n - 1;
                return (
                  <button
                    key={step.n}
                    type="button"
                    onClick={() => setCurrentStep(step.n - 1)}
                    className={`flex items-start gap-2 p-3 rounded-lg border text-right transition-all
                      ${isActive ? "border-primary bg-primary/5 shadow-sm" :
                        isDone ? "border-green-200 bg-green-50" :
                        "border-border bg-card opacity-50"}`}
                  >
                    <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold mt-0.5
                      ${isActive ? "bg-primary text-white" :
                        isDone ? "bg-green-500 text-white" :
                        "bg-muted text-muted-foreground"}`}>
                      {isDone ? <CheckCircle2 className="h-3.5 w-3.5" /> : step.n}
                    </div>
                    <div>
                      <p className={`text-xs font-semibold ${isActive ? "text-primary" : isDone ? "text-green-700" : ""}`}>
                        {step.title}
                      </p>
                      {isActive && (
                        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                          {step.desc}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* ZATCA Portal Links */}
            <div className="flex gap-2 pt-1">
              <a
                href="https://fatoora.zatca.gov.sa"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setCurrentStep(Math.max(currentStep, 1))}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border border-primary/30 bg-primary/5 text-primary text-xs font-medium hover:bg-primary/10 transition-colors"
              >
                <Globe className="h-3.5 w-3.5" />
                فتح البوابة الرسمية
                <ExternalLink className="h-3 w-3" />
              </a>
              <button
                type="button"
                onClick={() => setCurrentStep(3)}
                className="flex items-center gap-1.5 py-2 px-3 rounded-lg border border-border text-xs text-muted-foreground hover:bg-muted transition-colors"
              >
                وصلني الرمز
                <ArrowLeft className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}

        {/* OTP Input Section */}
        <div
          className={`space-y-4 transition-all duration-300 ${
            !isSandbox && currentStep < 3 ? "opacity-40 pointer-events-none" : "opacity-100"
          }`}
        >
          <div className="text-center space-y-3">
            <div className="flex items-center gap-2 justify-center text-sm font-medium text-foreground">
              <Smartphone className="h-4 w-4 text-primary" />
              <span>أدخل الرمز المُرسَل إلى هاتفك</span>
            </div>

            {/* OTP Digit Boxes — RTL layout, shown LTR for digit entry */}
            <div className="flex justify-center" dir="ltr">
              <InputOTP
                maxLength={6}
                value={otp}
                onChange={setOtp}
                disabled={loading}
                inputMode="numeric"
                pattern="[0-9]*"
              >
                <InputOTPGroup>
                  <InputOTPSlot
                    index={0}
                    className="h-14 w-12 text-2xl font-bold border-2 focus-within:border-primary"
                  />
                  <InputOTPSlot
                    index={1}
                    className="h-14 w-12 text-2xl font-bold border-2"
                  />
                  <InputOTPSlot
                    index={2}
                    className="h-14 w-12 text-2xl font-bold border-2"
                  />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup>
                  <InputOTPSlot
                    index={3}
                    className="h-14 w-12 text-2xl font-bold border-2"
                  />
                  <InputOTPSlot
                    index={4}
                    className="h-14 w-12 text-2xl font-bold border-2"
                  />
                  <InputOTPSlot
                    index={5}
                    className="h-14 w-12 text-2xl font-bold border-2"
                  />
                </InputOTPGroup>
              </InputOTP>
            </div>

            {isReady && (
              <p className="text-xs text-green-600 font-medium flex items-center justify-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" />
                الرمز مكتمل — يمكنك إرسال الطلب
              </p>
            )}
            {!isReady && otp.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {6 - otp.length} أرقام متبقية
              </p>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 pt-2">
          <Button
            className="flex-1 gap-2 h-11 text-base"
            onClick={handleSubmit}
            disabled={!isReady || loading}
          >
            {loading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                جاري ربط الجهاز...
              </>
            ) : (
              <>
                <ShieldCheck className="h-5 w-5" />
                تأكيد الربط مع ZATCA
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={loading}
            className="h-11"
          >
            إلغاء
          </Button>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          يُستخدم هذا الرمز مرة واحدة فقط لربط الجهاز بمنظومة الفاتورة الإلكترونية
        </p>
      </DialogContent>
    </Dialog>
  );
}
