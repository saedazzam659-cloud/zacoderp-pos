import React from "react";
import { AlertTriangle, AlertCircle } from "lucide-react";
import { DemoAnalyticsStatus } from "@/contexts/DemoAnalyticsContext";

export default function DemoQuotaBanner({ status }: { status: DemoAnalyticsStatus }) {
  if (status.remaining === undefined || status.warningRemaining === undefined) return null;

  if (status.remaining > status.warningRemaining && !status.blocked) return null;

  const isBlocked = status.blocked || status.remaining <= 0;

  if (isBlocked) {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-destructive/90 text-destructive-foreground px-4 py-2.5 flex items-center justify-center gap-2 font-medium text-sm z-[100] shadow-lg backdrop-blur-sm" dir="rtl" data-testid="demo-quota-blocked">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>{status.subscriptionMessage || "انتهت الحصة التجريبية. يمكنك تصفح النظام ولكن لا يمكن إجراء عمليات إضافية."}</span>
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-amber-500/90 text-amber-50 px-4 py-2.5 flex items-center justify-center gap-2 font-medium text-sm z-[100] shadow-lg backdrop-blur-sm" dir="rtl" data-testid="demo-quota-warning">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        تبقى لديك {status.remaining} عملية فقط من حصتك التجريبية (إجمالي {status.actionLimit}).
      </span>
    </div>
  );
}
