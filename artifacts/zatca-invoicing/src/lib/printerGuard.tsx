import { ToastAction } from "@/components/ui/toast";
import { getPreferredPrinter } from "./preferredPrinter";

// Loosely-typed toast callable: matches the signature returned by
// useToast() without forcing a specific React-types version. Each
// caller already has a strongly-typed `toast` from useToast(); this
// helper just needs a callable that accepts `title/description/etc`.
type ToastFn = (props: any) => unknown;

export function isPrinterReady(): boolean {
  return getPreferredPrinter().trim().length > 0;
}

export function showNoPrinterToast(
  toast: ToastFn,
  navigate: (path: string) => void,
): void {
  toast({
    title: "⚠️ لا توجد طابعة موصولة بهذا الجهاز",
    description:
      "لم يتم تسجيل أي طابعة افتراضية لهذا الجهاز. افتح الإعدادات العامة > إعدادات الطباعة لتسجيل الطابعة، ثم حاول مرة أخرى.",
    variant: "destructive",
    action: (
      <ToastAction
        altText="افتح الإعدادات"
        onClick={() => navigate("/general-settings")}
      >
        افتح الإعدادات
      </ToastAction>
    ),
  });
}

export function ensurePrinterReady(
  toast: ToastFn,
  navigate: (path: string) => void,
): boolean {
  if (isPrinterReady()) return true;
  showNoPrinterToast(toast, navigate);
  return false;
}
