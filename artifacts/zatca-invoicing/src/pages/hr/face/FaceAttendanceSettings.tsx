import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { faceApi, type FaceSettings } from "@/lib/faceAttendanceApi";
import { useToast } from "@/hooks/use-toast";
import { parseError } from "@/lib/parseError";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Settings2, Save, Loader2 } from "lucide-react";

export default function FaceAttendanceSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<FaceSettings>({ queryKey: ["face-settings"], queryFn: () => faceApi.getSettings() });

  const [form, setForm] = useState<Partial<FaceSettings>>({});

  useEffect(() => { if (data) setForm(data); }, [data]);

  const saveMut = useMutation({
    mutationFn: (data: Partial<FaceSettings>) => faceApi.updateSettings(data),
    onSuccess: () => {
      toast({ title: "تم حفظ الإعدادات ✓" });
      qc.invalidateQueries({ queryKey: ["face-settings"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: parseError(e), variant: "destructive" }),
  });

  if (isLoading) return <div className="p-6"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="p-6 space-y-6 max-w-3xl" data-testid="page-face-settings">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings2 className="h-6 w-6 text-primary" /> إعدادات الحضور بالذكاء الاصطناعي
        </h1>
        <p className="text-sm text-muted-foreground mt-1">ضبط حساسية التعرف وسياسات الحضور الذكي</p>
      </div>

      <Card className="p-5 space-y-4">
        <h2 className="font-semibold">حساسية التعرف</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>حد التطابق (0.4 — صارم، 0.7 — مرن)</Label>
            <Input type="number" step="0.05" min="0.3" max="0.8"
              value={form.matchThreshold ?? ""}
              onChange={(e) => setForm({ ...form, matchThreshold: e.target.value })}
              data-testid="input-match-threshold" />
            <p className="text-xs text-muted-foreground mt-1">المسافة الإقليدية القصوى المقبولة لاعتبار الوجه مطابقاً</p>
          </div>
          <div>
            <Label>الحد الأدنى لجودة الصورة عند التسجيل</Label>
            <Input type="number" step="0.05" min="0.3" max="0.95"
              value={form.minQualityScore ?? ""}
              onChange={(e) => setForm({ ...form, minQualityScore: e.target.value })} />
          </div>
        </div>
      </Card>

      <Card className="p-5 space-y-4">
        <h2 className="font-semibold">سياسات الحضور</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>بداية الدوام</Label>
            <Input type="time" value={form.workdayStart ?? ""}
              onChange={(e) => setForm({ ...form, workdayStart: e.target.value })} />
          </div>
          <div>
            <Label>نهاية الدوام</Label>
            <Input type="time" value={form.workdayEnd ?? ""}
              onChange={(e) => setForm({ ...form, workdayEnd: e.target.value })} />
          </div>
          <div>
            <Label>سماحية التأخير (دقائق)</Label>
            <Input type="number" min="0" value={form.lateToleranceMin ?? 0}
              onChange={(e) => setForm({ ...form, lateToleranceMin: Number(e.target.value) })} />
          </div>
          <div>
            <Label>فترة الانتظار بين العمليات (ثانية)</Label>
            <Input type="number" min="30" value={form.cooldownSeconds ?? 0}
              onChange={(e) => setForm({ ...form, cooldownSeconds: Number(e.target.value) })} />
            <p className="text-xs text-muted-foreground mt-1">منع تسجيل دخول/خروج متكرر خلال نفس الفترة</p>
          </div>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">إعدادات الأمان والذكاء</h2>
        <div className="flex items-center justify-between">
          <div>
            <Label>اشتراط الكشف الحي (Liveness)</Label>
            <p className="text-xs text-muted-foreground">يحمي من محاولات التزوير بالصور</p>
          </div>
          <Switch checked={!!form.requireLiveness}
            onCheckedChange={(v) => setForm({ ...form, requireLiveness: v })} />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label>الانصراف التلقائي</Label>
            <p className="text-xs text-muted-foreground">تسجيل آخر تعرف خلال اليوم كانصراف</p>
          </div>
          <Switch checked={!!form.autoCheckOut}
            onCheckedChange={(v) => setForm({ ...form, autoCheckOut: v })} />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label>تنبيه عند ظهور وجه غير مسجل</Label>
            <p className="text-xs text-muted-foreground">إنشاء تنبيه أمني عند رصد شخص غير معروف</p>
          </div>
          <Switch checked={!!form.notifyOnUnknown}
            onCheckedChange={(v) => setForm({ ...form, notifyOnUnknown: v })} />
        </div>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => saveMut.mutate(form)} disabled={saveMut.isPending} data-testid="btn-save-settings">
          {saveMut.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          حفظ الإعدادات
        </Button>
      </div>
    </div>
  );
}
