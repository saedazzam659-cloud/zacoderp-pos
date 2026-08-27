import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Download, UploadCloud, Link as LinkIcon, RefreshCw, AlertTriangle, Play, Shield, Globe, ShieldCheck } from "lucide-react";

const API = import.meta.env.VITE_API_URL ?? "";

export function LocalAgentLinks({ agentId }: { agentId: number }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [confirmSwitch, setConfirmSwitch] = useState<any>(null);

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
      if (!res.ok) throw new Error("ملف الدعوة غير صالح أو منتهي");
      return res.json();
    },
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data.file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `portable-link-${agentId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      
      if (data.shellSyncError) {
        toast({ title: "تم التصدير مع خطأ في تزامن السيرفر", description: data.shellSyncError, variant: "destructive" });
      } else {
        toast({ title: "تم تصدير ملف الربط بنجاح", description: "أرسل هذا الملف للمنصة الهدف لاستيراده." });
      }
      qc.invalidateQueries({ queryKey: ["agent-platform-links", agentId] });
    },
    onError: (err: any) => toast({ title: "خطأ في التصدير", description: err.message, variant: "destructive" })
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

  const links = linksQ.data ?? [];

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
                <div>
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
    </div>
  );
}
