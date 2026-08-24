import { useContext } from "react";
import { DemoAnalyticsContext } from "@/contexts/DemoAnalyticsContext";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

export function useDemoActionGate() {
  const ctx = useContext(DemoAnalyticsContext);
  const { toast } = useToast();
  const { user } = useAuth();

  const gate = async (actionType: "print" | "export" | "report"): Promise<boolean> => {
    // If not in demo mode or user is superadmin, allow immediately
    if (!ctx?.status?.applicable || user?.role === "superadmin") {
      return true;
    }

    try {
      await ctx.consumeAction(actionType);
      return true;
    } catch (e: any) {
      if (e.status === 429 || e.status === 402 || e.status === 428) {
        toast({ 
          title: "عفواً", 
          description: e.data?.subscriptionMessage || "انتهت الحصة التجريبية للعمليات", 
          variant: "destructive" 
        });
      } else {
        toast({ 
          title: "حدث خطأ", 
          description: "لم نتمكن من إتمام العملية", 
          variant: "destructive" 
        });
      }
      return false;
    }
  };

  return gate;
}
