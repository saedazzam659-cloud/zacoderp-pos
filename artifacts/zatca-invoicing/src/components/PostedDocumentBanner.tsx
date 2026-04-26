import { Lock, Unlock } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface Props {
  status: string | null | undefined;
  unpostUrl: string;
  unpostMethod?: "PATCH" | "POST";
  onUnposted?: () => void;
  invalidateKeys?: (string | (string | number | null)[])[];
}

export function PostedDocumentBanner({
  status, unpostUrl, unpostMethod = "PATCH", onUnposted, invalidateKeys = [],
}: Props) {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const canUnpost =
    user?.role === "admin" ||
    user?.role === "superadmin" ||
    user?.role === "manager";

  const isPosted = status === "posted";

  const mut = useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(unpostUrl, { method: unpostMethod, headers });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || res.statusText);
      return j;
    },
    onSuccess: () => {
      toast({ title: "تم فك الترحيل بنجاح" });
      for (const k of invalidateKeys) {
        qc.invalidateQueries({ queryKey: (Array.isArray(k) ? k : [k]) as readonly unknown[] });
      }
      setConfirmOpen(false);
      onUnposted?.();
    },
    onError: (e: any) => {
      toast({ title: "تعذّر فك الترحيل", description: e?.message, variant: "destructive" });
    },
  });

  if (!isPosted) return null;

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 shrink-0" />
          <div className="text-sm font-medium leading-tight">
            هذا المستند <span className="font-bold">مُرحَّل</span> ولا يمكن تعديله.
            <span className="block text-xs opacity-80 font-normal">
              لإجراء تعديلات يجب فك الترحيل أولاً (للمدير أو المشرف فقط).
            </span>
          </div>
        </div>
        {canUnpost && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5 border-emerald-300 bg-white/60 text-emerald-800 hover:bg-white"
            onClick={() => setConfirmOpen(true)}
            disabled={mut.isPending}
          >
            <Unlock className="h-3.5 w-3.5" />
            فك الترحيل
          </Button>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Unlock className="h-5 w-5 text-amber-600" />
              تأكيد فك الترحيل
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 text-right">
              <span className="block">
                سيتم إعادة المستند إلى حالة "مسودة" وسيتم عكس القيود المحاسبية وحركات المخزون
                المرتبطة به.
              </span>
              <span className="block font-medium text-amber-700">
                هذه العملية مسجَّلة في سجل التدقيق. هل أنت متأكد؟
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mut.isPending}>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); mut.mutate(); }}
              disabled={mut.isPending}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {mut.isPending ? "جارٍ فك الترحيل..." : "تأكيد"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
