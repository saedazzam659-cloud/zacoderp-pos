import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { 
  Loader2, ArrowLeftRight, AlertTriangle, ShieldAlert, 
  CheckCircle2, Server, Globe, Building2, KeyRound, 
  LockKeyhole, Timer, Check, XCircle
} from "lucide-react";

const API = import.meta.env.VITE_API_URL ?? "";

export function ZatcaTransferAction({ agentId, agentName, agentDomain, onComplete }: { agentId: number; agentName: string; agentDomain: string; onComplete?: () => void }) {
  const [open, setOpen] = useState(false);
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [step, setStep] = useState<"select" | "preflight" | "prepare" | "complete">("select");
  const [sourceId, setSourceId] = useState<string>("");
  const [targetId, setTargetId] = useState<string>("");
  
  const [transferId, setTransferId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  
  const [confirmed, setConfirmed] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState("");

  const { data: companies, isLoading: loadingCompanies } = useQuery({
    queryKey: ["zatca-transfer-companies", agentId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/agent-instances/${agentId}/zatca-transfer/companies`, { headers });
      if (!r.ok) throw new Error("فشل جلب الشركات");
      return r.json();
    },
    enabled: open && step === "select"
  });

  const preflightMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/agent-instances/${agentId}/zatca-transfer/preflight`, {
        method: "POST", headers, body: JSON.stringify({ sourceCompanyId: Number(sourceId), targetCompanyId: Number(targetId) })
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "فشل الفحص المسبق");
      return j;
    },
    onSuccess: () => setStep("preflight"),
    onError: (e: any) => toast({ title: "فشل الفحص", description: e.message, variant: "destructive" })
  });

  const prepareMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/agent-instances/${agentId}/zatca-transfer/prepare`, {
        method: "POST", headers, body: JSON.stringify({ sourceCompanyId: Number(sourceId), targetCompanyId: Number(targetId) })
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "فشل التجهيز");
      return j;
    },
    onSuccess: (data) => {
      setTransferId(data.transferId);
      setExpiresAt(data.expiresAt);
      setStep("prepare");
      setTypedConfirmation("");
    },
    onError: (e: any) => toast({ title: "فشل التجهيز", description: e.message, variant: "destructive" })
  });

  const completeMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/agent-instances/${agentId}/zatca-transfer/complete`, {
        method: "POST", headers, body: JSON.stringify({ transferId })
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "فشل إكمال النقل");
      return j;
    },
    onSuccess: () => {
      setStep("complete");
      setTransferId(null);
      if (onComplete) onComplete();
    },
    onError: (e: any) => toast({ title: "فشل النقل", description: e.message, variant: "destructive" })
  });

  const cancelMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/agent-instances/${agentId}/zatca-transfer/cancel`, {
        method: "POST", headers, body: JSON.stringify({ transferId })
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "فشل الإلغاء");
      return j;
    },
    onSuccess: () => {
      toast({ title: "تم إلغاء النقل" });
      setTransferId(null);
      setStep("select");
      setConfirmed(false);
    },
    onError: (e: any) => toast({ title: "فشل الإلغاء", description: e.message, variant: "destructive" })
  });

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && transferId && step === "prepare") {
      toast({ 
        title: "عملية نقل نشطة", 
        description: "يرجى إكمال النقل أو إلغاءه قبل الإغلاق. لضمان أمان البيانات.", 
        variant: "destructive" 
      });
      return;
    }
    setOpen(newOpen);
    if (!newOpen) {
      setTimeout(() => {
        setStep("select");
        setSourceId("");
        setTargetId("");
        setTransferId(null);
        setConfirmed(false);
        setTypedConfirmation("");
        preflightMut.reset();
      }, 200);
    }
  };

  const sourceComp = companies?.sourceCompanies?.find((c: any) => String(c.id) === String(sourceId));
  const targetComp = companies?.targetCompanies?.find((c: any) => String(c.id) === String(targetId));

  return (
    <>
      <Button 
        variant="outline" 
        size="sm" 
        className="h-8 text-[11px] px-2 font-medium border-amber-200 bg-amber-50 hover:bg-amber-100 text-amber-800"
        onClick={() => setOpen(true)}
        data-testid={`btn-zatca-transfer-${agentId}`}
      >
        <ShieldAlert className="h-3 w-3 ms-1.5" />
        نقل زاتكا (EGS)
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-700">
              <ArrowLeftRight className="h-5 w-5" />
              نقل أجهزة زاتكا (EGS Transfer) — {agentName}
            </DialogTitle>
            <DialogDescription className="text-xs">
              إجراء عالي الخطورة. نقل هوية الجهاز المركزي (CSID) إلى خادم وكيل خارجي بشكل نهائي.
            </DialogDescription>
          </DialogHeader>

          <div className="py-2 space-y-4">
            {step === "select" && (
              <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
                <Alert className="bg-blue-50 text-blue-900 border-blue-200">
                  <ShieldAlert className="h-4 w-4 text-blue-700" />
                  <AlertTitle className="text-sm font-bold">معلومات النقل</AlertTitle>
                  <AlertDescription className="text-xs mt-1 leading-relaxed">
                    يسمح هذا الإجراء بنقل بيانات اعتماد زاتكا الخاصة بشركة مسجلة على السيرفر المركزي، لتصبح الشركة قادرة على إرسال الفواتير مباشرة من سيرفر الوكيل الخارجي الخاص بها.
                  </AlertDescription>
                </Alert>

                {loadingCompanies ? (
                  <div className="py-8 flex justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-xs font-semibold flex items-center gap-1.5">
                        <Building2 className="h-4 w-4 text-slate-500" />
                        الشركة المصدر (المركزي)
                      </label>
                      <Select value={sourceId} onValueChange={setSourceId}>
                        <SelectTrigger className="h-9 text-xs" data-testid="select-source">
                          <SelectValue placeholder="اختر الشركة المركزية..." />
                        </SelectTrigger>
                        <SelectContent>
                          {companies?.sourceCompanies?.map((c: any) => (
                            <SelectItem key={c.id} value={String(c.id)} className="text-xs">
                              {c.nameAr} ({c.vatNumber})
                            </SelectItem>
                          ))}
                          {(!companies?.sourceCompanies || companies.sourceCompanies.length === 0) && (
                            <div className="p-2 text-xs text-muted-foreground text-center">لا توجد شركات مركزية مسجلة</div>
                          )}
                        </SelectContent>
                      </Select>
                      {sourceComp && (
                        <div className="p-3 bg-slate-50 border rounded-md text-xs space-y-1.5">
                          <div className="flex justify-between pb-1 mb-1 border-b">
                            <span className="text-muted-foreground">الوكيل (النطاق):</span>
                            <span className="font-semibold text-slate-700">السيرفر المركزي (Central)</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">رقم الشركة (ID):</span>
                            <span className="font-mono font-medium text-slate-700">{sourceComp.id}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">الرقم الضريبي:</span>
                            <span className="font-mono">{sourceComp.vatNumber}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">البيئة:</span>
                            <Badge variant="outline" className="text-[10px] h-4 px-1">{sourceComp.environment}</Badge>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">بيانات الاعتماد:</span>
                            {sourceComp.credentialsSet ? (
                              <span className="text-emerald-600 flex items-center gap-1"><Check className="h-3 w-3" /> متوفرة</span>
                            ) : (
                              <span className="text-rose-600 flex items-center gap-1"><XCircle className="h-3 w-3" /> غير متوفرة</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-semibold flex items-center gap-1.5">
                        <Server className="h-4 w-4 text-indigo-500" />
                        الشركة الهدف (الوكيل)
                      </label>
                      <Select value={targetId} onValueChange={setTargetId}>
                        <SelectTrigger className="h-9 text-xs" data-testid="select-target">
                          <SelectValue placeholder="اختر الشركة في الوكيل..." />
                        </SelectTrigger>
                        <SelectContent>
                          {companies?.targetCompanies?.map((c: any) => (
                            <SelectItem key={c.id} value={String(c.id)} className="text-xs">
                              {c.nameAr} ({c.vatNumber})
                            </SelectItem>
                          ))}
                          {(!companies?.targetCompanies || companies.targetCompanies.length === 0) && (
                            <div className="p-2 text-xs text-muted-foreground text-center">لا توجد شركات على الوكيل</div>
                          )}
                        </SelectContent>
                      </Select>
                      {targetComp && (
                        <div className="p-3 bg-indigo-50/50 border border-indigo-100 rounded-md text-xs space-y-1.5">
                          <div className="flex justify-between pb-1 mb-1 border-b border-indigo-100/50">
                            <span className="text-muted-foreground">الوكيل (النطاق):</span>
                            <span className="font-semibold text-indigo-700">{agentName} — {agentDomain}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">رقم الشركة (ID):</span>
                            <span className="font-mono font-medium text-indigo-700">{targetComp.id}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">الرقم الضريبي:</span>
                            <span className="font-mono">{targetComp.vatNumber}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">البيئة:</span>
                            <Badge variant="outline" className="text-[10px] h-4 px-1">{targetComp.environment}</Badge>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">بيانات الاعتماد:</span>
                            {targetComp.credentialsSet ? (
                              <span className="text-amber-600 font-medium">موجودة مسبقاً — يجب أن تطابق المصدر</span>
                            ) : (
                              <span className="text-slate-600">فارغة</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {step === "preflight" && (
              <div className="space-y-4 animate-in slide-in-from-right-4 duration-200">
                <Alert className="bg-amber-50 text-amber-900 border-amber-200">
                  <AlertTriangle className="h-4 w-4 text-amber-700" />
                  <AlertTitle className="text-sm font-bold">تأكيد المطابقة (Preflight)</AlertTitle>
                  <AlertDescription className="text-xs mt-2 space-y-2">
                    <p>تم التحقق من إمكانية النقل. يرجى مراجعة التفاصيل:</p>
                    <ul className="list-disc list-inside ms-4 space-y-1">
                      <li>تطابق الرقم الضريبي: <span className="font-bold">{sourceComp?.vatNumber}</span></li>
                      <li>تطابق البيئة: <span className="font-bold">{sourceComp?.environment}</span></li>
                      <li>بيانات اعتماد الهدف: <span className="font-bold">{preflightMut.data?.targetCredentialsSameOrEmpty ? "فارغة أو مطابقة للمصدر" : "غير مطابقة"}</span></li>
                    </ul>
                  </AlertDescription>
                </Alert>

                <div className="p-3 border border-rose-200 bg-rose-50/30 rounded-lg flex items-start gap-3">
                  <Checkbox 
                    id="confirm-checkbox" 
                    checked={confirmed} 
                    onCheckedChange={(c) => setConfirmed(!!c)} 
                    data-testid="checkbox-confirm-preflight"
                    className="mt-0.5"
                  />
                  <label htmlFor="confirm-checkbox" className="text-xs leading-relaxed text-rose-900 cursor-pointer font-medium">
                    أقر بأنني على دراية بأن هذا الإجراء سيقوم بتجهيز حزمة نقل بيانات اعتماد زاتكا بالكامل إلى الوكيل الخارجي. بمجرد التجهيز، سيتم تجميد إرسال الفواتير لهذه الشركة من السيرفر المركزي لضمان عدم تعارض التسلسل (Sequence).
                  </label>
                </div>
              </div>
            )}

            {step === "prepare" && (
              <div className="space-y-4 animate-in slide-in-from-right-4 duration-200">
                <Alert className="bg-rose-50 text-rose-900 border-rose-200">
                  <LockKeyhole className="h-4 w-4 text-rose-700" />
                  <AlertTitle className="text-sm font-bold">الحزمة جاهزة للتسليم</AlertTitle>
                  <AlertDescription className="text-xs mt-2 space-y-2">
                    <p>تم إنشاء حزمة النقل المشفّرة بنجاح. الشركة المصدر الآن <strong>مجمدة</strong> ولا يمكنها إرسال فواتير.</p>
                    <p className="text-rose-700">تنبيه: يمكنك إلغاء النقل واستعادة السيرفر المركزي طالما لم يتم تفعيل الحزمة على الوكيل الخارجي.</p>
                    <div className="flex items-center gap-1.5 text-rose-700 font-mono bg-rose-100/50 p-1.5 rounded w-fit mt-2">
                      <Timer className="h-3.5 w-3.5" />
                      تنتهي الصلاحية: {expiresAt ? new Date(expiresAt).toLocaleTimeString('ar-SA') : 'للاستخدام مرة واحدة فقط (10 دقائق)'}
                    </div>
                  </AlertDescription>
                </Alert>

                <div className="p-4 border rounded-lg bg-card space-y-3">
                  <label className="text-xs font-semibold block">
                    لتأكيد النقل النهائي وإرسال الحزمة للوكيل، اكتب <span className="font-bold text-rose-600 select-all">نقل زاتكا</span> أدناه:
                  </label>
                  <Input 
                    placeholder="نقل زاتكا"
                    value={typedConfirmation}
                    onChange={(e) => setTypedConfirmation(e.target.value)}
                    className="h-9 text-center font-bold"
                    data-testid="input-typed-confirm"
                  />
                </div>
              </div>
            )}

            {step === "complete" && (
              <div className="py-6 flex flex-col items-center justify-center text-center space-y-3 animate-in zoom-in-95 duration-300">
                <div className="h-12 w-12 rounded-full bg-emerald-100 flex items-center justify-center">
                  <CheckCircle2 className="h-6 w-6 text-emerald-600" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-emerald-700">تم النقل بنجاح</h3>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                    تم نقل بيانات الاعتماد وتفعيلها على الوكيل الخارجي. تم تعطيل الإرسال من النسخة المركزية نهائياً لهذه الشركة.
                  </p>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-start">
            {step === "select" && (
              <>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={preflightMut.isPending}>إلغاء</Button>
                <div className="flex-1" />
                <Button 
                  disabled={!sourceId || !targetId || preflightMut.isPending}
                  onClick={() => preflightMut.mutate()}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white"
                  data-testid="btn-next-preflight"
                >
                  {preflightMut.isPending ? <Loader2 className="h-4 w-4 ms-2 animate-spin" /> : null}
                  التالي: فحص المطابقة
                </Button>
              </>
            )}

            {step === "preflight" && (
              <>
                <Button variant="outline" onClick={() => setStep("select")} disabled={prepareMut.isPending}>رجوع</Button>
                <div className="flex-1" />
                <Button 
                  disabled={!confirmed || prepareMut.isPending}
                  onClick={() => prepareMut.mutate()}
                  className="bg-rose-600 hover:bg-rose-700 text-white"
                  data-testid="btn-prepare-transfer"
                >
                  {prepareMut.isPending ? <Loader2 className="h-4 w-4 ms-2 animate-spin" /> : <LockKeyhole className="h-4 w-4 ms-2" />}
                  تجهيز حزمة النقل
                </Button>
              </>
            )}

            {step === "prepare" && (
              <>
                <Button 
                  variant="outline" 
                  className="text-rose-600 hover:bg-rose-50"
                  onClick={() => cancelMut.mutate()} 
                  disabled={completeMut.isPending || cancelMut.isPending}
                  data-testid="btn-cancel-transfer"
                >
                  {cancelMut.isPending ? <Loader2 className="h-4 w-4 ms-2 animate-spin" /> : <XCircle className="h-4 w-4 ms-2" />}
                  إلغاء التجهيز (استعادة المركزي)
                </Button>
                <div className="flex-1" />
                <Button 
                  disabled={typedConfirmation !== "نقل زاتكا" || completeMut.isPending || cancelMut.isPending}
                  onClick={() => completeMut.mutate()}
                  className="bg-rose-600 hover:bg-rose-700 text-white"
                  data-testid="btn-complete-transfer"
                >
                  {completeMut.isPending ? <Loader2 className="h-4 w-4 ms-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 ms-2" />}
                  تأكيد النقل النهائي
                </Button>
              </>
            )}

            {step === "complete" && (
              <Button onClick={() => setOpen(false)} className="w-full">إغلاق</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
