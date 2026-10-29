import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Loader2, PackageCheck } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const KEY = ["admin", "purchase-vat-cost-default"];

export default function PurchaseInventoryCostDefault() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const { data, isLoading } = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const response = await fetch(`${API}/api/admin/system-settings/purchase-vat-cost-default`, { headers });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || "تعذر تحميل الإعداد");
      return body as { enabled: boolean };
    },
    enabled: !!token,
  });

  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const response = await fetch(`${API}/api/admin/system-settings/purchase-vat-cost-default`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ enabled }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || "تعذر حفظ الإعداد");
      return body as { enabled: boolean };
    },
    onSuccess: (result) => {
      qc.setQueryData(KEY, result);
      toast({ title: "تم حفظ افتراضي الشركات الجديدة" });
    },
    onError: (error: Error) => toast({ title: error.message, variant: "destructive" }),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold">افتراضات الشركات الجديدة</h1>
        <p className="mt-1 text-sm text-muted-foreground">تُنسخ هذه القيمة عند إنشاء شركة جديدة فقط؛ لا تغيّر إعدادات الشركات القائمة.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><PackageCheck className="h-5 w-5" />ضريبة مشتريات المخزون</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />جارٍ التحميل…</div>
          ) : (
            <>
              <label className="flex items-start gap-3 rounded-lg border p-4">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={data?.enabled === true}
                  disabled={save.isPending}
                  onChange={(event) => save.mutate(event.target.checked)}
                />
                <span>
                  <span className="block font-medium">إضافة الضريبة إلى تكلفة المخزون افتراضيًا</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    عند إيقافه، تبدأ الشركات الجديدة باستبعاد ضريبة المدخلات من تكلفة المخزون. تغيير هذا الافتراضي لا يؤثر على الشركات القائمة.
                  </span>
                </span>
              </label>
              <p className="text-xs text-muted-foreground">تستطيع إدارة كل شركة قائمة بشكل مستقل من الإعدادات العامة للشركة.</p>
            </>
          )}
        </CardContent>
      </Card>
      {save.isPending && <Button disabled size="sm"><Loader2 className="me-2 h-4 w-4 animate-spin" />جارٍ الحفظ</Button>}
    </div>
  );
}
