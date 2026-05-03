import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings as SettingsIcon, Save, Sparkles } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function InstallmentSettings() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [form, setForm] = useState({
    minScoreApproval: "80",
    minScoreReview: "60",
    defaultInterestRate: "12",
    maxInstallments: "36",
    aiEnabled: true,
    notes: "",
  });

  const { data, isLoading } = useQuery<any>({
    queryKey: ["installment-settings", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/installments/settings?companyId=${cid}`, { headers });
      if (!r.ok) throw new Error("فشل التحميل");
      return r.json();
    },
    enabled: !!cid,
  });

  useEffect(() => {
    if (data) setForm({
      minScoreApproval: String(data.minScoreApproval ?? 80),
      minScoreReview: String(data.minScoreReview ?? 60),
      defaultInterestRate: String(data.defaultInterestRate ?? "12"),
      maxInstallments: String(data.maxInstallments ?? 36),
      aiEnabled: !!data.aiEnabled,
      notes: data.notes ?? "",
    });
  }, [data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/installments/settings?companyId=${cid}`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          minScoreApproval: Number(form.minScoreApproval),
          minScoreReview: Number(form.minScoreReview),
          defaultInterestRate: Number(form.defaultInterestRate),
          maxInstallments: Number(form.maxInstallments),
          aiEnabled: form.aiEnabled,
          notes: form.notes || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "فشل الحفظ");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installment-settings", cid] });
      toast({ title: "تم حفظ الإعدادات" });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="p-6"><Skeleton className="h-64" /></div>;

  return (
    <div className="space-y-4 p-4 max-w-2xl" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <SettingsIcon className="h-6 w-6 text-slate-600" />
          إعدادات التقسيط
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          ضوابط التقييم الذكي والقيم الافتراضية للعقود الجديدة.
        </p>
      </div>

      <div className="rounded-lg border bg-white p-5 space-y-4">
        <div className="rounded bg-indigo-50 border border-indigo-200 p-3 text-sm text-indigo-900 flex items-start gap-2">
          <Sparkles className="h-4 w-4 mt-0.5" />
          <span>
            الدرجات أعلى من <b>{form.minScoreApproval}</b> تُعتمد تلقائياً، بين <b>{form.minScoreReview}</b> و <b>{form.minScoreApproval}</b> تُحال للمراجعة، أقل من <b>{form.minScoreReview}</b> تُرفض.
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label>حد الاعتماد التلقائي (الدرجة)</Label>
            <Input type="number" min="0" max="100" value={form.minScoreApproval}
              onChange={e => setForm({...form, minScoreApproval: e.target.value})} data-testid="input-approval" />
          </div>
          <div>
            <Label>حد المراجعة اليدوية (الدرجة)</Label>
            <Input type="number" min="0" max="100" value={form.minScoreReview}
              onChange={e => setForm({...form, minScoreReview: e.target.value})} data-testid="input-review" />
          </div>
          <div>
            <Label>نسبة الفائدة الافتراضية %</Label>
            <Input type="number" step="0.01" min="0" max="100" value={form.defaultInterestRate}
              onChange={e => setForm({...form, defaultInterestRate: e.target.value})} data-testid="input-rate" />
          </div>
          <div>
            <Label>الحد الأقصى لعدد الأقساط</Label>
            <Input type="number" min="1" max="120" value={form.maxInstallments}
              onChange={e => setForm({...form, maxInstallments: e.target.value})} data-testid="input-max" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input id="ai-enabled" type="checkbox" className="h-4 w-4"
            checked={form.aiEnabled}
            onChange={e => setForm({...form, aiEnabled: e.target.checked})} />
          <Label htmlFor="ai-enabled" className="cursor-pointer">تفعيل التقييم الذكي للملاءة</Label>
        </div>

        <div>
          <Label>ملاحظات داخلية</Label>
          <Input value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} />
        </div>

        <div className="flex justify-end pt-2">
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} data-testid="btn-save-settings">
            <Save className="h-4 w-4 ms-2" />
            {saveMut.isPending ? "جارٍ الحفظ…" : "حفظ الإعدادات"}
          </Button>
        </div>
      </div>
    </div>
  );
}
