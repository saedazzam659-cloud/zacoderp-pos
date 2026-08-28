import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { demoAnalyticsApi } from "@/lib/demoAnalyticsApi";
import {
  Card, CardContent, CardHeader, CardTitle
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowRight, Activity, ShieldAlert, Target, Save, MousePointerClick
} from "lucide-react";

export default function DemoAnalyticsDetail() {
  const [, params] = useRoute("/admin/demo-analytics/:id");
  const profileId = params?.id ? parseInt(params.id) : 0;
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["demo-admin-profile", profileId],
    queryFn: () => demoAnalyticsApi.getAdminProfile(profileId),
    enabled: !!profileId
  });

  const [leadForm, setLeadForm] = useState({
    status: "",
    notes: "",
    followUpAt: ""
  });

  const [policyForm, setPolicyForm] = useState({
    enabled: true,
    limitEnabled: false,
    actionLimit: 100,
    warningRemaining: 20,
    subscriptionMessage: ""
  });

  React.useEffect(() => {
    if (data?.profile) {
      setLeadForm({
        status: data.profile.leadStatus || "new",
        notes: data.profile.leadNotes || "",
        followUpAt: data.profile.followUpAt ? data.profile.followUpAt.substring(0, 16) : ""
      });
    }
    if (data?.policy) {
      setPolicyForm({
        enabled: data.policy.enabled !== false,
        limitEnabled: data.policy.limitEnabled === true,
        actionLimit: data.policy.actionLimit ?? 100,
        warningRemaining: data.policy.warningRemaining ?? 20,
        subscriptionMessage: data.policy.subscriptionMessage ?? ""
      });
    }
  }, [data]);

  const updateLead = useMutation({
    mutationFn: (vars: any) => demoAnalyticsApi.updateLead(profileId, vars),
    onSuccess: () => {
      toast({ title: "تم حفظ بيانات المبيعات" });
      qc.invalidateQueries({ queryKey: ["demo-admin-profile", profileId] });
      qc.invalidateQueries({ queryKey: ["demo-admin-profiles"] });
    },
    onError: (error: any) => toast({ title: "تعذر حفظ بيانات المبيعات", description: error?.message, variant: "destructive" }),
  });

  const updatePolicy = useMutation({
    mutationFn: (vars: any) => demoAnalyticsApi.updatePolicy(profileId, vars),
    onSuccess: (persisted: any, submitted: any) => {
      if (
        persisted?.actionLimit !== submitted.actionLimit ||
        persisted?.limitEnabled !== submitted.limitEnabled ||
        persisted?.warningRemaining !== submitted.warningRemaining ||
        persisted?.enabled !== submitted.enabled
      ) {
        toast({ title: "تعذر تأكيد حفظ السياسة", variant: "destructive" });
        return;
      }
      setPolicyForm({
        enabled: persisted.enabled !== false,
        limitEnabled: persisted.limitEnabled === true,
        actionLimit: persisted.actionLimit ?? 100,
        warningRemaining: persisted.warningRemaining ?? 20,
        subscriptionMessage: persisted.subscriptionMessage ?? "",
      });
      toast({ title: "تم تحديث سياسة الحساب التجريبي" });
      qc.invalidateQueries({ queryKey: ["demo-admin-profile", profileId] });
    },
    onError: (error: any) => toast({ title: "تعذر تحديث سياسة الحساب التجريبي", description: error?.message, variant: "destructive" }),
  });

  if (isLoading || !data) {
    return <div className="p-6 text-center text-muted-foreground">جاري تحميل بيانات الحساب التجريبي...</div>;
  }

  const { profile, policy, actionsUsed, remaining, sessions, events } = data;

  const handleLeadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateLead.mutate({
      status: leadForm.status,
      notes: leadForm.notes,
      followUpAt: leadForm.followUpAt ? new Date(leadForm.followUpAt).toISOString() : null
    });
  };

  const handlePolicySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updatePolicy.mutate({
      enabled: policyForm.enabled,
      actionLimit: policyForm.limitEnabled ? Number(policyForm.actionLimit) : null,
      warningRemaining: Number(policyForm.warningRemaining),
      subscriptionMessage: policyForm.subscriptionMessage
    });
  };

  const formatDuration = (ms: number) => {
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins} دقيقة`;
    const hrs = Math.floor(mins / 60);
    return `${hrs} س ${mins % 60} د`;
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto" dir="rtl">
      <div className="flex items-center gap-3 mb-2">
        <Button variant="outline" size="icon" asChild className="h-8 w-8 rounded-full">
          <Link href="/admin/demo-analytics"><ArrowRight className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            تفاصيل الحساب التجريبي
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            مراجعة نشاط وتفضيلات الحساب {profile.phone ? <span dir="ltr" className="font-mono text-foreground px-1">{profile.phone}</span> : "غير معروف"}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-lg flex items-center gap-2">
                <Target className="h-5 w-5 text-primary" />
                متابعة المبيعات
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <form onSubmit={handleLeadSubmit} className="space-y-4" data-testid="lead-form">
                <div className="space-y-2">
                  <Label>حالة العميل</Label>
                  <Select value={leadForm.status} onValueChange={(v) => setLeadForm(f => ({ ...f, status: v }))}>
                    <SelectTrigger data-testid="lead-status-trigger">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">جديد</SelectItem>
                      <SelectItem value="contacted">تم التواصل</SelectItem>
                      <SelectItem value="qualified">مؤهل</SelectItem>
                      <SelectItem value="converted">تحول لعميل</SelectItem>
                      <SelectItem value="lost">مستبعد</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="space-y-2">
                  <Label>موعد المتابعة القادم</Label>
                  <Input 
                    type="datetime-local" 
                    value={leadForm.followUpAt}
                    onChange={(e) => setLeadForm(f => ({ ...f, followUpAt: e.target.value }))}
                    data-testid="lead-followup"
                  />
                </div>

                <div className="space-y-2">
                  <Label>ملاحظات المبيعات</Label>
                  <Textarea 
                    rows={4}
                    placeholder="ملاحظات من المكالمات..."
                    value={leadForm.notes}
                    onChange={(e) => setLeadForm(f => ({ ...f, notes: e.target.value }))}
                    data-testid="lead-notes"
                  />
                </div>

                <Button type="submit" className="w-full gap-2" disabled={updateLead.isPending} data-testid="save-lead-btn">
                  <Save className="h-4 w-4" /> حفظ بيانات المبيعات
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-lg flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-amber-600" />
                سياسة الحصة (Quota)
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <form onSubmit={handlePolicySubmit} className="space-y-4" data-testid="policy-form">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>تفعيل التجربة</Label>
                    <div className="text-xs text-muted-foreground">حظر جميع الإجراءات عند الإيقاف</div>
                  </div>
                  <Switch 
                    checked={policyForm.enabled} 
                    onCheckedChange={(c) => setPolicyForm(f => ({ ...f, enabled: c }))}
                    data-testid="policy-enabled"
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2 flex items-center justify-between rounded-md border p-3">
                    <div>
                      <Label>تحديد سقف للعمليات</Label>
                      <div className="text-xs text-muted-foreground">غير مفعّل افتراضيًا؛ العمليات مفتوحة بدون قفل تلقائي</div>
                    </div>
                    <Switch
                      checked={policyForm.limitEnabled}
                      onCheckedChange={(c) => setPolicyForm(f => ({ ...f, limitEnabled: c }))}
                      data-testid="policy-limit-enabled"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>سقف العمليات</Label>
                    <Input 
                      type="number" 
                      min="1"
                      value={policyForm.actionLimit}
                      disabled={!policyForm.limitEnabled}
                      onChange={(e) => setPolicyForm(f => ({ ...f, actionLimit: Number(e.target.value) }))}
                      data-testid="policy-limit"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>حد التنبيه</Label>
                    <Input 
                      type="number" 
                      min="0"
                      value={policyForm.warningRemaining}
                      disabled={!policyForm.limitEnabled}
                      onChange={(e) => setPolicyForm(f => ({ ...f, warningRemaining: Number(e.target.value) }))}
                      data-testid="policy-warning"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>رسالة انتهاء الحصة</Label>
                  <Textarea 
                    rows={2}
                    placeholder="رسالة تظهر للعميل عند استنفاد العمليات..."
                    value={policyForm.subscriptionMessage}
                    onChange={(e) => setPolicyForm(f => ({ ...f, subscriptionMessage: e.target.value }))}
                    data-testid="policy-message"
                  />
                </div>

                <Button type="submit" variant="secondary" className="w-full gap-2" disabled={updatePolicy.isPending} data-testid="save-policy-btn">
                  <Save className="h-4 w-4" /> تحديث السياسة
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="bg-primary/5 border-primary/20">
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">نقاط الاهتمام</p>
                <p className="text-3xl font-extrabold text-primary" data-testid="detail-score">{profile.interestScore || 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">إجمالي الجلسات</p>
                <p className="text-2xl font-bold" data-testid="detail-sessions">{profile.loginCount}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">وقت الاستخدام</p>
                <p className="text-xl font-bold" data-testid="detail-duration">{formatDuration(profile.totalDurationMs || 0)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">عمليات الحصة</p>
                <p className="text-xl font-bold text-amber-700" data-testid="detail-quota">
                  {actionsUsed || 0} / {policy?.actionLimit ?? "مفتوح"}
                </p>
                {remaining != null && <p className="text-[10px] text-muted-foreground mt-1">متبقي: {remaining}</p>}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                سجل الجلسات ({sessions?.length || 0})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted sticky top-0">
                    <tr>
                      <th className="p-3 text-right text-xs text-muted-foreground font-medium">البداية</th>
                      <th className="p-3 text-right text-xs text-muted-foreground font-medium">المدة</th>
                      <th className="p-3 text-right text-xs text-muted-foreground font-medium">الجهاز</th>
                      <th className="p-3 text-right text-xs text-muted-foreground font-medium">النظام/المتصفح</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {sessions?.length === 0 && (
                      <tr><td colSpan={4} className="p-6 text-center text-muted-foreground text-xs">لا توجد جلسات مسجلة</td></tr>
                    )}
                    {sessions?.map((s: any, idx: number) => (
                      <tr key={s.id} data-testid={`session-row-${idx}`}>
                        <td className="p-3 text-xs" dir="ltr">{new Date(s.startedAt).toLocaleString("ar-SA-u-ca-gregory-nu-latn")}</td>
                        <td className="p-3 text-xs text-muted-foreground">{formatDuration(s.durationMs || 0)}</td>
                        <td className="p-3 text-xs capitalize">{s.deviceType || "Desktop"}</td>
                        <td className="p-3 text-xs">{s.os} / {s.browser}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-base flex items-center gap-2">
                <MousePointerClick className="h-4 w-4 text-primary" />
                آخر الأحداث ({events?.length || 0})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted sticky top-0">
                    <tr>
                      <th className="p-3 text-right text-xs text-muted-foreground font-medium">الوقت</th>
                      <th className="p-3 text-right text-xs text-muted-foreground font-medium">النوع</th>
                      <th className="p-3 text-right text-xs text-muted-foreground font-medium">القسم / الشاشة</th>
                      <th className="p-3 text-right text-xs text-muted-foreground font-medium">التفاصيل</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {events?.length === 0 && (
                      <tr><td colSpan={4} className="p-6 text-center text-muted-foreground text-xs">لا توجد أحداث مسجلة</td></tr>
                    )}
                    {events?.map((ev: any, idx: number) => (
                      <tr key={ev.id} className="hover:bg-muted/50" data-testid={`event-row-${idx}`}>
                        <td className="p-3 text-xs text-muted-foreground whitespace-nowrap" dir="ltr">
                          {new Date(ev.occurredAt).toLocaleTimeString("ar-SA-u-ca-gregory-nu-latn", { hour: '2-digit', minute:'2-digit' })}
                        </td>
                        <td className="p-3 text-xs">
                          <span className={`px-2 py-0.5 rounded font-medium ${
                            ev.type === 'action' ? 'bg-amber-100 text-amber-700' :
                            ev.type === 'screen_view' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'
                          }`}>
                            {ev.type === 'screen_view' ? 'زيارة' : ev.type === 'action' ? 'إجراء' : ev.type}
                          </span>
                        </td>
                        <td className="p-3 text-xs font-mono" dir="ltr">
                          <div className="truncate max-w-[200px]" title={ev.route || ev.moduleKey}>
                            {ev.route || ev.screenKey || ev.moduleKey || "-"}
                          </div>
                        </td>
                        <td className="p-3 text-xs text-muted-foreground">
                          {ev.actionKey ? `أكشن: ${ev.actionKey}` : ev.durationMs ? `مكث: ${formatDuration(ev.durationMs)}` : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
