import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { demoAnalyticsApi } from "@/lib/demoAnalyticsApi";
import { useToast } from "@/hooks/use-toast";
import { ShieldAlert, Phone } from "lucide-react";

export default function PhoneCaptureDialog({ onSuccess }: { onSuccess: () => void }) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim()) {
      setError("الرجاء إدخال رقم الجوال");
      return;
    }
    
    // basic local validation (SA format optional, but needs to be reasonable)
    if (phone.length < 9) {
      setError("رقم الجوال قصير جداً");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await demoAnalyticsApi.submitPhone(phone.trim());
      toast({ title: "تم تسجيل الرقم بنجاح" });
      onSuccess();
    } catch (err: any) {
      setError(err?.data?.error || "حدث خطأ أثناء حفظ الرقم");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" dir="rtl">
      <div className="bg-card border shadow-lg rounded-xl w-full max-w-md p-6 overflow-hidden relative">
        <div className="absolute top-0 left-0 w-full h-1 bg-primary" />
        <div className="flex justify-center mb-6">
          <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center">
            <ShieldAlert className="h-8 w-8 text-primary" />
          </div>
        </div>
        <div className="text-center mb-6 space-y-2">
          <h2 className="text-xl font-bold">مرحباً بك في النسخة التجريبية</h2>
          <p className="text-muted-foreground text-sm">
            للتمتع بكافة مزايا النظام وتجربة الخصائص، يرجى إدخال رقم الجوال للتواصل. هذه الخطوة مطلوبة لمرة واحدة فقط.
          </p>
        </div>
        
        <form onSubmit={handleSubmit} className="space-y-4" data-testid="phone-capture-form">
          <div>
            <div className="relative">
              <Phone className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                type="tel"
                dir="ltr"
                data-testid="phone-capture-input"
                placeholder="05XXXXXXXX"
                className="pr-10 text-right"
                value={phone}
                onChange={e => {
                  setPhone(e.target.value);
                  if (error) setError("");
                }}
                disabled={busy}
              />
            </div>
            {error && <p className="text-sm text-destructive mt-1.5 font-medium" data-testid="phone-capture-error">{error}</p>}
          </div>
          
          <Button type="submit" className="w-full" disabled={busy} data-testid="phone-capture-submit">
            {busy ? "جاري الحفظ..." : "متابعة واستكشاف النظام"}
          </Button>
        </form>
      </div>
    </div>
  );
}
