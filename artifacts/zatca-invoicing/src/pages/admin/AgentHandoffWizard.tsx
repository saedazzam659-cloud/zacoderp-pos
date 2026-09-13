import React, { useState, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { ArrowLeftRight, UploadCloud, FileJson, Loader2, ShieldCheck, ShieldAlert, Play, CheckCircle2, Download, TerminalSquare, Undo2 } from "lucide-react";

const API = import.meta.env.VITE_API_URL ?? "";

type Props = {
  agentId: number;
  agentName: string;
  agentDomain: string;
  onComplete: () => void;
};

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) throw new Error(data.serverMessage || data.error || `HTTP ${response.status}`);
  return data;
}

export function AgentHandoffAction(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-[11px] px-2 border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100"
        onClick={() => setOpen(true)}
        data-testid={`btn-agent-handoff-${props.agentId}`}
      >
        <ArrowLeftRight className="h-3 w-3 ms-1.5" />
        نقل تحكم الوكيل
      </Button>
      {open && <AgentHandoffWizard {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function AgentHandoffWizard({ agentId, agentName, agentDomain, onClose, onComplete }: Props & { onClose: () => void }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [inviteObj, setInviteObj] = useState<any>(null);
  const [runtimeMode, setRuntimeMode] = useState<"preserve" | "target_release">("preserve");
  const [preflightData, setPreflightData] = useState<any>(null);
  const [typedPhrase, setTypedPhrase] = useState("");
  const [exportedFile, setExportedFile] = useState<any>(null);
  const [commitData, setCommitData] = useState<any>(null);

  const preflightMut = useMutation({
    mutationFn: async () => parseJsonResponse(await fetch(`${API}/api/admin/agent-instances/${agentId}/controller-handoff/preflight`, {
      method: "POST", headers,
      body: JSON.stringify({ targetPlatformId: inviteObj.targetPlatformId, targetOrigin: inviteObj.targetOrigin, runtimeMode }),
    })),
    onSuccess: setPreflightData,
    onError: (err: Error) => toast({ title: "فشل التحقق", description: err.message, variant: "destructive" }),
  });

  const exportMut = useMutation({
    mutationFn: async () => {
      const data = await parseJsonResponse(await fetch(`${API}/api/admin/agent-instances/${agentId}/controller-links/export`, {
        method: "POST", headers, body: JSON.stringify({ invite: inviteObj }),
      }));
      // A link file is usable only after the exact shell registry state was
      // written. Keep this guard for older API replicas that might still
      // return HTTP 201 with a shellSyncError field.
      if (data.shellSynced !== true || !data.file) {
        throw new Error(data.serverMessage || data.shellSyncError || "لم تتم مزامنة إعدادات سيرفر الوكيل؛ لم يتم تنزيل رابط صالح");
      }
      return data;
    },
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data.file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `controller-link-${agentId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setExportedFile(data.file);
    },
    onError: (err: Error) => toast({ title: "فشل تصدير الرابط", description: err.message, variant: "destructive" }),
  });

  const commitMut = useMutation({
    mutationFn: async () => parseJsonResponse(await fetch(`${API}/api/admin/agent-instances/${agentId}/controller-handoff/commit`, {
      method: "POST", headers,
      body: JSON.stringify({
        handoffToken: preflightData.handoffToken,
        linkId: exportedFile.linkId,
        confirmationPhrase: typedPhrase,
        confirm: true,
      }),
    })),
    onSuccess: (data) => {
      setCommitData(data);
      onComplete();
    },
    onError: (err: Error) => toast({ title: "لم يتم نقل التحكم", description: err.message, variant: "destructive" }),
  });

  const rollbackMut = useMutation({
    mutationFn: async () => parseJsonResponse(await fetch(`${API}/api/admin/agent-instances/${agentId}/controller-handoff/rollback`, {
      method: "POST", headers, body: JSON.stringify({ linkId: exportedFile.linkId, confirm: true }),
    })),
    onSuccess: () => {
      toast({ title: "تمت استعادة التحكم للمصدر" });
      onComplete();
      onClose();
    },
    onError: (err: Error) => toast({ title: "فشل الرجوع", description: err.message, variant: "destructive" }),
  });

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result ?? ""));
        if (!parsed.targetPlatformId || !parsed.targetOrigin || !parsed.inviteId || !parsed.inviteSecret) throw new Error();
        setInviteObj(parsed);
        setPreflightData(null);
        setExportedFile(null);
        setTypedPhrase("");
      } catch {
        toast({ title: "ملف دعوة غير صالح", description: "استخدم ملف الدعوة الذي تم تنزيله من منصة KARM.", variant: "destructive" });
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  const expectedPhrase = preflightData?.expectedConfirmationPhrase ?? "";
  return (
    <Dialog open onOpenChange={(value) => { if (!value && !commitMut.isPending && !rollbackMut.isPending) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 text-indigo-600" />
            نقل تحكم الوكيل — {agentName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 text-sm leading-7 text-indigo-950">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-1 h-5 w-5 shrink-0 text-indigo-700" />
              <div>
                <strong className="block">نقل قيادة التحديثات فقط</strong>
                لن تُنقل أو تُنسخ الشركات، قاعدة البيانات، ملفات العملاء، أو أسرار ZATCA. سيبقى الدومين
                <span dir="ltr" className="mx-1 font-mono">{agentDomain}</span>
                على نفس السيرفر وقاعدة البيانات.
              </div>
            </div>
          </div>

          {!inviteObj ? (
            <div className="rounded-xl border-2 border-dashed p-8 text-center">
              <FileJson className="mx-auto mb-3 h-9 w-9 text-muted-foreground" />
              <p className="mb-1 font-semibold">ابدأ بدعوة من منصة KARM</p>
              <p className="mb-4 text-xs text-muted-foreground">من تبويب «الربط الآمن» في KARM أنشئ دعوة، ثم ارفع ملف JSON هنا.</p>
              <Button variant="outline" onClick={() => fileInputRef.current?.click()} data-testid="btn-upload-controller-invite">
                <UploadCloud className="h-4 w-4 ms-2" /> رفع الدعوة
              </Button>
              <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFileUpload} />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border p-3">
                  <div className="mb-1 text-xs text-muted-foreground">المنصة الهدف</div>
                  <div className="truncate font-mono text-sm" dir="ltr">{inviteObj.targetOrigin}</div>
                  <Badge variant="outline" className="mt-2 font-mono text-[10px]" dir="ltr">{inviteObj.targetPlatformId}</Badge>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="mb-2 text-xs text-muted-foreground">طريقة التشغيل بعد النقل</div>
                  <RadioGroup value={runtimeMode} onValueChange={(value) => {
                    setRuntimeMode(value as "preserve" | "target_release");
                    setPreflightData(null);
                    setExportedFile(null);
                    setTypedPhrase("");
                  }} disabled={Boolean(preflightData)}>
                    <div className="flex items-start gap-2">
                      <RadioGroupItem id={`preserve-${agentId}`} value="preserve" className="mt-1" />
                      <Label htmlFor={`preserve-${agentId}`} className="cursor-pointer text-xs leading-5">
                        <strong className="block">الإبقاء على النسخة الحالية</strong>
                        لا تغيير للحزمة أو التشغيل؛ يتغير المتحكم فقط.
                      </Label>
                    </div>
                    <div className="flex items-start gap-2">
                      <RadioGroupItem id={`target-release-${agentId}`} value="target_release" className="mt-1" />
                      <Label htmlFor={`target-release-${agentId}`} className="cursor-pointer text-xs leading-5">
                        <strong className="block">استخدام إصدار KARM</strong>
                        للنسخة الكاملة ذات الحزمة المركزية؛ تثبيت الإصدار يتم يدويًا من KARM بعد النقل.
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              </div>

              {!preflightData && (
                <div className="flex justify-end">
                  <Button onClick={() => preflightMut.mutate()} disabled={preflightMut.isPending} data-testid="btn-controller-preflight">
                    {preflightMut.isPending ? <Loader2 className="h-4 w-4 ms-2 animate-spin" /> : <ShieldCheck className="h-4 w-4 ms-2" />}
                    فحص الجاهزية
                  </Button>
                </div>
              )}

              {preflightData && !exportedFile && (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
                  <div className="flex items-center gap-2 font-semibold">
                    {preflightData.eligible ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <ShieldAlert className="h-5 w-5 text-rose-600" />}
                    نتيجة الفحص — Epoch {preflightData.controllerEpoch}
                  </div>
                  {!preflightData.eligible ? (
                    <ul className="space-y-1 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                      {preflightData.blockers?.map((blocker: any) => <li key={blocker.code}>• {blocker.message}</li>)}
                    </ul>
                  ) : (
                    <>
                      <div className="grid gap-2 text-xs sm:grid-cols-2">
                        <div className="rounded border bg-background p-2">الحالة: {preflightData.agent?.status}</div>
                        <div className="rounded border bg-background p-2">الوضع: {preflightData.agent?.mode}</div>
                        <div className="rounded border bg-background p-2">الإصدار: {preflightData.agent?.deployedVersion || "غير مسجل"}</div>
                        <div className="rounded border bg-background p-2 font-mono" dir="ltr">ID: {preflightData.agent?.installationId}</div>
                      </div>
                      <div>
                        <p className="mb-2 text-xs">للمتابعة، اكتب العبارة التالية حرفيًا:</p>
                        <div className="mb-2 select-all rounded border bg-background p-2 text-center font-mono text-xs" dir="ltr">{expectedPhrase}</div>
                        <Input value={typedPhrase} onChange={(event) => setTypedPhrase(event.target.value)} dir="ltr"
                          className="text-center font-mono text-xs" data-testid="input-controller-confirmation" />
                      </div>
                      <div className="flex justify-end">
                        <Button onClick={() => exportMut.mutate()} disabled={typedPhrase !== expectedPhrase || exportMut.isPending}
                          data-testid="btn-export-controller-link">
                          {exportMut.isPending ? <Loader2 className="h-4 w-4 ms-2 animate-spin" /> : <Download className="h-4 w-4 ms-2" />}
                          إنشاء وتنزيل رابط النقل
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {exportedFile && !commitData && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 space-y-4">
                  <div className="flex items-start gap-3">
                    <TerminalSquare className="mt-1 h-5 w-5 shrink-0 text-amber-700" />
                    <div className="text-sm leading-7">
                      <strong className="block">استورد الملف في KARM أولًا</strong>
                      من KARM افتح «الربط الآمن» ثم استورد الملف الذي نزل الآن. بعد نجاح الاستيراد اضغط «تحقق وانقل».
                      لن يغيّر الزر شيئًا إذا لم تستطع هذه المنصة إثبات أن KARM استوردت الرابط.
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" onClick={() => exportMut.mutate()} disabled={exportMut.isPending}>إعادة التنزيل</Button>
                    <Button onClick={() => commitMut.mutate()} disabled={commitMut.isPending}
                      className="bg-emerald-700 hover:bg-emerald-800" data-testid="btn-commit-controller-handoff">
                      {commitMut.isPending ? <Loader2 className="h-4 w-4 ms-2 animate-spin" /> : <Play className="h-4 w-4 ms-2" />}
                      تحقق وانقل التحكم
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {commitData && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-center space-y-3">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-700" />
              <h3 className="font-bold text-emerald-950">تم نقل التحكم بأمان</h3>
              <p className="text-sm text-emerald-800">
                المتحكم النشط الآن هو KARM عند Epoch <span className="font-mono font-bold">{commitData.controllerEpoch}</span>.
              </p>
              <p className="text-xs text-emerald-800">
                {commitData.nextAction === "apply_target_release_manually_from_karm"
                  ? "افتح الوكيل المستورد في KARM وطبّق الإصدار يدويًا بعد مراجعة التوافق."
                  : "بقيت الحزمة والتشغيل الحاليان دون تغيير."}
              </p>
              <Button variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50"
                onClick={() => rollbackMut.mutate()} disabled={rollbackMut.isPending} data-testid="btn-rollback-controller-handoff">
                {rollbackMut.isPending ? <Loader2 className="h-4 w-4 ms-2 animate-spin" /> : <Undo2 className="h-4 w-4 ms-2" />}
                استعادة التحكم للمصدر
              </Button>
            </div>
          )}
        </div>

        <DialogFooter className="border-t pt-3">
          <Button variant="ghost" onClick={onClose} disabled={commitMut.isPending || rollbackMut.isPending}>
            {commitData ? "إغلاق" : "إلغاء"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}