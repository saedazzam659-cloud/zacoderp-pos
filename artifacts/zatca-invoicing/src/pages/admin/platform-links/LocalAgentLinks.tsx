import React, { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Download, UploadCloud, Link as LinkIcon, RefreshCw, AlertTriangle, Play, Shield, Globe, ShieldCheck, FileJson } from "lucide-react";

const API = import.meta.env.VITE_API_URL ?? "";

const LINK_ERROR_LABELS: Record<string, string> = {
  invite_expired: "انتهت صلاحية الدعوة. ارفع دعوة جديدة من المنصة الهدف لتجديد الرابط بأمان.",
  link_expired: "انتهت صلاحية ملف الربط. استخدم دعوة جديدة من المنصة الهدف.",
  controller_link_already_exists: "يوجد أكثر من صف للرابط نفسه؛ ارفع دعوة جديدة لإثبات عدم الاستيراد ثم إصلاح التكرار بأمان.",
  DUPLICATE_OUTBOUND_CONTROLLER_LINK: "يوجد رابط سابق لهذه المنصة. ارفع دعوة جديدة من الهدف لتجديده بدلاً من إنشاء رابط مكرر.",
  controller_pairing_not_proven: "تعذر إثبات حالة المنصة الهدف؛ لم تتغير أي صفوف.",
  controller_pairing_already_present: "وجدت المنصة الهدف رابطاً مستورداً؛ لم يتم حذف أي صف.",
  TARGET_CONTROLLER_LINK_ALREADY_EXISTS: "وجدت المنصة الهدف رابطاً مستورداً؛ لم يتم حذف أي صف.",
  renewal_attestation_not_proven: "تعذر إثبات عدم الاستيراد عبر الدعوة الجديدة؛ لم تتغير أي صفوف.",
  renewal_source_state_not_supported: "تغيرت حالة الرابط أو لم تعد في Epoch 0؛ أعد تحميل الصفحة، ولم تتغير أي صفوف.",
  renewal_stale_source_state: "تغيرت حالة الرابط أثناء التجديد؛ لم تتغير أي صفوف.",
  RENEWAL_ALREADY_IN_PROGRESS: "توجد عملية تجديد أخرى قيد التنفيذ؛ أعد المحاولة بعد انتهائها.",
  TARGET_RENEWAL_ATTESTATION_UNAVAILABLE: "تعذر الاتصال الموثق بالمنصة الهدف؛ أعد المحاولة، ولم تتغير أي صفوف.",
};

function linkErrorLabel(value: unknown, fallback: string): string {
  const raw = String(value ?? "");
  return LINK_ERROR_LABELS[raw] ?? (raw || fallback);
}

function downloadPortableFile(file: any, agentId: number): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `portable-link-${agentId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function LocalAgentLinks({ agentId }: { agentId: number }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [confirmSwitch, setConfirmSwitch] = useState<any>(null);
  const [renewal, setRenewal] = useState<{ invite: any; candidates: any[]; freshInvite: any | null } | null>(null);
  const renewalInputRef = useRef<HTMLInputElement>(null);

  const linksQ = useQuery<any[]>({
    queryKey: ["agent-platform-links", agentId],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/agent-instances/${agentId}/controller-links`, { headers });
      if (!res.ok) throw new Error("فشل تحميل الروابط");
      return res.json();
    }
  });

  const exportMut = useMutation({
    mutationFn: async (fileContent: string) => {
      const invite = JSON.parse(fileContent);
      const res = await fetch(`${API}/api/admin/agent-instances/${agentId}/controller-links/export`, {
        method: "POST", headers, body: JSON.stringify({ invite })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const key = data.code || data.error || data.serverMessage;
        throw Object.assign(new Error(linkErrorLabel(key, "ملف الدعوة غير صالح أو منتهي")), { serverData: data });
      }
      if (data.shellSynced !== true || !data.file) {
        throw new Error(data.serverMessage || data.shellSyncError || "لم تتم مزامنة إعدادات سيرفر الوكيل؛ لم يتم تنزيل رابط صالح");
      }
      return data;
    },
    onSuccess: (data) => {
      downloadPortableFile(data.file, agentId);
      toast({ title: "تم تصدير ملف الربط بنجاح", description: "أرسل هذا الملف للمنصة الهدف لاستيراده." });
      qc.invalidateQueries({ queryKey: ["agent-platform-links", agentId] });
    },
    onError: (err: any, variables: string) => {
      const data = err.serverData ?? {};
      const rawInvite = (() => { try { return JSON.parse(variables); } catch { return null; } })();
      const duplicate = data.code === "DUPLICATE_OUTBOUND_CONTROLLER_LINK" ||
        data.error === "controller_link_already_exists";
      const expired = data.error === "invite_expired" || data.error === "link_expired";
      if (duplicate || expired) {
        const currentLinks = linksQ.data ?? [];
        const candidates = data.recoveryCandidates?.length
          ? data.recoveryCandidates
          : currentLinks.filter(link => link.targetPlatformId === rawInvite?.targetPlatformId);
        if (candidates.length) {
          setRenewal({ invite: rawInvite, candidates, freshInvite: null });
          return;
        }
      }
      toast({ title: "خطأ في التصدير", description: linkErrorLabel(data.code || data.error, err.message), variant: "destructive" });
    }
  });

  const renewMut = useMutation({
    mutationFn: async ({ linkId, invite }: { linkId: string; invite: any }) => {
      const res = await fetch(`${API}/api/admin/agent-instances/${agentId}/controller-links/${encodeURIComponent(linkId)}/renew`, {
        method: "POST", headers, body: JSON.stringify({ invite }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(linkErrorLabel(data.code || data.error, "تعذر تجديد الرابط بأمان")), { serverData: data });
      if (data.shellSynced !== true || !data.file) throw new Error("لم تتم مزامنة إعدادات السيرفر؛ لم يتم تنزيل رابط صالح");
      return data;
    },
    onSuccess: (data) => {
      downloadPortableFile(data.file, agentId);
      setRenewal(null);
      toast({ title: "تم تجديد الرابط بأمان", description: "أرسل الملف الجديد للمنصة الهدف ثم أكمل نقل القيادة." });
      qc.invalidateQueries({ queryKey: ["agent-platform-links", agentId] });
    },
    onError: (err: any) => toast({ title: "تعذر تجديد الرابط", description: linkErrorLabel(err.serverData?.code || err.serverData?.error, err.message), variant: "destructive" }),
  });

  const reconcileMut = useMutation({
    mutationFn: async (linkId: string) => {
      const res = await fetch(`${API}/api/admin/agent-instances/${agentId}/controller-links/${encodeURIComponent(linkId)}/reconcile`, {
        method: "POST", headers, body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(linkErrorLabel(data.code || data.error || data.serverMessage, "تعذر إثبات الرابط المقترن؛ لم تتغير الصفوف")), { serverData: data });
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "تمت مطابقة الرابط المقترن",
        description: data.removedLinkIds?.length
          ? `تم حذف ${data.removedLinkIds.length} صفوف غير موجودة على منصة الهدف ومزامنة إعدادات السيرفر.`
          : "تمت إعادة مزامنة إعدادات السيرفر دون تغيير القيادة.",
      });
      qc.invalidateQueries({ queryKey: ["agent-platform-links", agentId] });
    },
    onError: (err: any, linkId: string) => {
      if (err.serverData?.error === "controller_pairing_not_proven") {
        const selected = (linksQ.data ?? []).find(link => link.linkId === linkId);
        const candidates = selected
          ? (linksQ.data ?? []).filter(link => link.targetPlatformId === selected.targetPlatformId)
          : [];
        if (candidates.length) {
          setRenewal({ invite: null, candidates, freshInvite: null });
          return;
        }
      }
      toast({ title: "تعذر إصلاح التكرار", description: linkErrorLabel(err.serverData?.code || err.serverData?.error, err.message), variant: "destructive" });
    },
  });

  const leadMut = useMutation({
    mutationFn: async ({ linkId, activeControllerId, epoch }: { linkId: string, activeControllerId: string, epoch: number }) => {
      const res = await fetch(`${API}/api/admin/agent-instances/${agentId}/controller-leadership`, {
        method: "POST", headers, body: JSON.stringify({ activeControllerId, controllerEpoch: epoch })
      });
      if (!res.ok) throw new Error("فشل نقل القيادة");
      return res.json();
    },
    onSuccess: (data) => {
      if (data.shellSyncError) {
        toast({ title: "تم التحديث مع خطأ في السيرفر", description: data.shellSyncError, variant: "destructive" });
      } else {
        toast({ title: "تم تبديل قيادة التحكم بنجاح" });
      }
      qc.invalidateQueries({ queryKey: ["agent-platform-links", agentId] });
      setConfirmSwitch(null);
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" })
  });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const content = ev.target?.result as string;
        exportMut.mutate(content);
      } catch (err) {
        toast({ title: "ملف غير صالح", variant: "destructive" });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleRenewalInviteUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !renewal) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const invite = JSON.parse(String(reader.result ?? ""));
        if (!invite.targetPlatformId || !invite.targetOrigin || !invite.inviteId || !invite.inviteSecret) throw new Error();
        setRenewal({ ...renewal, freshInvite: invite });
      } catch {
        toast({ title: "ملف دعوة غير صالح", description: "أنشئ دعوة جديدة من المنصة الهدف ثم ارفعها هنا.", variant: "destructive" });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const links = linksQ.data ?? [];
  const duplicateCounts = links.reduce<Record<string, number>>((counts, link) => {
    counts[link.targetPlatformId] = (counts[link.targetPlatformId] ?? 0) + 1;
    return counts;
  }, {});

  return (
    <div className="mt-4 border border-indigo-100 dark:border-indigo-900/40 rounded-lg p-3 bg-indigo-50/20 dark:bg-indigo-950/10 text-xs text-slate-600 dark:text-slate-400">
      <div className="flex items-center justify-between mb-3 border-b border-indigo-100/50 pb-2">
        <div className="flex items-center gap-2 text-indigo-900 dark:text-indigo-100">
          <LinkIcon className="h-4 w-4" />
          <h4 className="font-semibold">روابط التحكم الخارجي</h4>
        </div>
        <div className="relative group">
          <Button variant="outline" size="sm" className="h-7 text-xs relative z-0 bg-white dark:bg-slate-950 border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 transition-colors" disabled={exportMut.isPending}>
            {exportMut.isPending ? <Loader2 className="h-3 w-3 ms-1 animate-spin" /> : <UploadCloud className="h-3 w-3 ms-1 text-indigo-600" />}
            تصدير إلى منصة هدف
          </Button>
          <input type="file" accept=".json" onChange={handleFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
        </div>
      </div>
      
      {linksQ.isLoading ? (
        <div className="flex items-center justify-center p-4"><Loader2 className="h-4 w-4 animate-spin text-indigo-400" /></div>
      ) : links.length === 0 ? (
        <p className="text-center py-2 opacity-70">لم يتم ربط هذا الوكيل بأي منصة خارجية أخرى.</p>
      ) : (
        <div className="space-y-2">
          {links.map((link) => {
            const isLocalActive = link.activeControllerId === link.sourcePlatformId;
            return (
              <div key={link.linkId} className="flex items-center justify-between bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-2 px-3 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200 font-mono text-[10px]" dir="ltr">
                      {link.targetOrigin}
                    </Badge>
                    {(duplicateCounts[link.targetPlatformId] ?? 0) > 1 && (
                      <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800 text-[10px]">
                        تكرار يحتاج تحقق
                      </Badge>
                    )}
                    <span className="text-[10px] text-slate-400 font-mono">Epoch: {link.controllerEpoch}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <Shield className={`h-3 w-3 ${isLocalActive ? "text-indigo-600" : "text-emerald-600"}`} />
                    <span>المتحكم النشط:</span>
                    <span className={`font-bold ${isLocalActive ? "text-indigo-700" : "text-emerald-700"}`}>
                      {isLocalActive ? "المنصة الحالية (أنت)" : link.targetOrigin}
                    </span>
                  </div>
                </div>
                 <div className="flex flex-wrap justify-end gap-1.5">
                   <Button
                     size="sm"
                     variant="outline"
                     className={`h-7 text-[10px] ${((duplicateCounts[link.targetPlatformId] ?? 0) > 1)
                       ? "border-amber-300 text-amber-800 hover:bg-amber-50"
                       : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}
                     onClick={() => reconcileMut.mutate(link.linkId)}
                     disabled={reconcileMut.isPending}
                   >
                     {reconcileMut.isPending ? <Loader2 className="h-3 w-3 ms-1 animate-spin" /> : <RefreshCw className="h-3 w-3 ms-1" />}
                     {(duplicateCounts[link.targetPlatformId] ?? 0) > 1 ? "تحقق وإصلاح آمن" : "إعادة مزامنة آمنة"}
                   </Button>
                  {!isLocalActive ? (
                    <Button size="sm" className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700 text-white" onClick={() => setConfirmSwitch({ ...link, toLocal: true })}>
                      استعادة التحكم
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 text-xs border-emerald-200 text-emerald-700 hover:bg-emerald-50" onClick={() => setConfirmSwitch({ ...link, toLocal: false })}>
                      <Play className="h-3 w-3 ms-1" />
                      تسليم القيادة للهدف
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!confirmSwitch} onOpenChange={(o) => !o && setConfirmSwitch(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-indigo-900">
              <ShieldCheck className="h-5 w-5 text-indigo-600" /> تأكيد نقل قيادة السيرفر
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm mt-2 text-slate-600">
            {confirmSwitch?.toLocal ? (
              <p>هل أنت متأكد من سحب صلاحية إدارة السيرفر وتحديثات الأكواد من <span className="font-bold font-mono" dir="ltr">{confirmSwitch.targetOrigin}</span> وإعادتها إلى منصتك؟</p>
            ) : (
              <p>هل أنت متأكد من تسليم صلاحية إدارة السيرفر وتحديثات الأكواد إلى <span className="font-bold font-mono" dir="ltr">{confirmSwitch?.targetOrigin}</span>؟</p>
            )}
            <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border text-xs leading-relaxed">
              <span className="font-bold text-slate-800 dark:text-slate-200">تنويه آمن:</span> هذا الإجراء يغير فقط الجهة المسموح لها بنشر التحديثات للسيرفر. لن تتأثر قواعد بيانات الوكيل إطلاقاً، وستظل آمنة ومعزولة كما هي. منصة واحدة فقط يمكنها التحكم في أي لحظة.
            </div>
          </div>
          <DialogFooter className="gap-2 pt-2 border-t mt-4">
            <Button variant="ghost" onClick={() => setConfirmSwitch(null)}>إلغاء</Button>
            <Button onClick={() => {
              const activeId = confirmSwitch.toLocal ? confirmSwitch.sourcePlatformId : confirmSwitch.targetPlatformId;
              leadMut.mutate({ linkId: confirmSwitch.linkId, activeControllerId: activeId, epoch: confirmSwitch.controllerEpoch + 1 });
            }} disabled={leadMut.isPending} className="bg-indigo-600 hover:bg-indigo-700 text-white">
              {leadMut.isPending && <Loader2 className="h-4 w-4 ms-2 animate-spin" />}
              تأكيد نقل القيادة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!renewal} onOpenChange={(o) => !o && !renewMut.isPending && setRenewal(null)}>
        <DialogContent className="max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-800">
              <FileJson className="h-5 w-5" /> تجديد رابط منتهي بأمان
            </DialogTitle>
            <DialogDescription>
              لم يُثبت استيراد الملف القديم. ارفع دعوة جديدة منشأة الآن من المنصة الهدف؛ سيتحقق الخادم منها عبر HTTPS قبل حذف أي صف.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 leading-6 text-amber-950">
              لا تُستخدم حالة عدم الاتصال أو غياب المصادقة كدليل على عدم الاستيراد. إذا كانت المنصة الهدف تحتوي رابطاً قائماً أو تعذر إثبات حالتها فسيتوقف الإجراء بلا تغييرات.
            </div>
            <Button variant="outline" className="w-full" onClick={() => renewalInputRef.current?.click()} disabled={renewMut.isPending}>
              <UploadCloud className="h-4 w-4 ms-2" /> رفع دعوة جديدة من المنصة الهدف
            </Button>
            <input ref={renewalInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleRenewalInviteUpload} />
            {renewal?.freshInvite && (
              <div className="space-y-2">
                <div className="rounded border bg-slate-50 p-2 text-xs font-mono" dir="ltr">{renewal.freshInvite.targetOrigin}</div>
                <p className="text-xs text-muted-foreground">اختر الصف الذي سيبقى (سيُحذف فقط ما يثبت أنه غير مستورد):</p>
                {renewal.candidates.map(candidate => (
                  <Button key={candidate.linkId} variant="outline" className="w-full justify-between" disabled={renewMut.isPending}
                    onClick={() => renewMut.mutate({ linkId: candidate.linkId, invite: renewal.freshInvite })}>
                    {renewMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    <span className="font-mono text-xs" dir="ltr">{candidate.linkId}</span>
                    <span>تجديد وإثبات عدم الاستيراد</span>
                  </Button>
                ))}
              </div>
            )}
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setRenewal(null)} disabled={renewMut.isPending}>إلغاء</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
