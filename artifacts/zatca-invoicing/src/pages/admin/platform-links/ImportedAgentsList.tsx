import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Server, Shield, Globe, Play, ShieldAlert } from "lucide-react";

const API = import.meta.env.VITE_API_URL ?? "";

export function ImportedAgentsList() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [confirmSwitch, setConfirmSwitch] = useState<any>(null);

  const { data: importedLinks, isLoading } = useQuery<any[]>({
    queryKey: ["agent-platform-imported"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/agent-instances/platform-links/imported`, { headers });
      if (!res.ok) throw new Error("فشل جلب الروابط المستوردة");
      return res.json();
    }
  });

  const leadMut = useMutation({
    mutationFn: async ({ linkId, activeControllerId, epoch }: { linkId: string, activeControllerId: string, epoch: number }) => {
      const res = await fetch(`${API}/api/admin/agent-instances/platform-links/${linkId}/leadership`, {
        method: "POST", headers, body: JSON.stringify({ activeControllerId, controllerEpoch: epoch })
      });
      if (!res.ok) throw new Error("فشل تبديل القيادة");
      return res.json();
    },
    onSuccess: (data) => {
      if (data.shellSyncError) {
        toast({ title: "تم التحديث مع خطأ في السيرفر", description: data.shellSyncError, variant: "destructive" });
      } else {
        toast({ title: "تم نقل قيادة التحكم بنجاح" });
      }
      qc.invalidateQueries({ queryKey: ["agent-platform-imported"] });
      setConfirmSwitch(null);
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" })
  });

  if (isLoading) return <div className="p-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (!importedLinks || importedLinks.length === 0) return (
    <div className="border rounded-xl p-10 text-center text-muted-foreground bg-slate-50 dark:bg-slate-900/30">
      <Server className="h-10 w-10 mx-auto mb-3 opacity-30" />
      لا يوجد وكلاء مستوردون بعد
    </div>
  );

  return (
    <div className="space-y-4">
      {importedLinks.map((link) => {
        const isLocalActive = link.activeControllerId === link.targetPlatformId;
        return (
          <div key={link.linkId} className="border border-slate-200 dark:border-slate-800 rounded-xl p-5 bg-white dark:bg-slate-950 shadow-sm transition-all hover:shadow-md">
            <div className="flex items-start justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-100 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                  <Server className="h-6 w-6" />
                </div>
                <div>
                  <div className="font-bold text-lg flex items-center gap-2 text-slate-800 dark:text-slate-100">
                    {link.name}
                    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px] uppercase font-bold tracking-widest px-1.5 h-5">Imported</Badge>
                  </div>
                  <div className="text-sm text-slate-500 mt-1 flex items-center gap-4">
                    <span className="flex items-center gap-1 font-mono"><Globe className="h-3.5 w-3.5" /><span dir="ltr">{link.domain}</span></span>
                    <span className="flex items-center gap-1 opacity-80"><span className="text-[10px] uppercase">SRC:</span> <span dir="ltr" className="font-mono">{link.sourceOrigin}</span></span>
                  </div>
                </div>
              </div>
              <div>
                {!isLocalActive ? (
                  <Button onClick={() => setConfirmSwitch({ ...link, toLocal: true })} disabled={leadMut.isPending} className="bg-emerald-600 hover:bg-emerald-700 text-white h-9 shadow-sm">
                    <Play className="h-4 w-4 ms-1" />
                    استحواذ على التحكم
                  </Button>
                ) : (
                  <Button variant="outline" className="text-rose-600 hover:bg-rose-50 border-rose-200 h-9 bg-white" onClick={() => setConfirmSwitch({ ...link, toLocal: false })} disabled={leadMut.isPending}>
                    إعادة التحكم للمصدر
                  </Button>
                )}
              </div>
            </div>
            
            <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-wrap gap-6 text-sm">
              <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-900 px-2 py-1 rounded">
                <Shield className={`h-4 w-4 ${isLocalActive ? "text-emerald-600" : "text-slate-400"}`} />
                <span className="text-slate-500">القيادة الحالية:</span>
                <span className={`font-bold ${isLocalActive ? "text-emerald-700" : "text-slate-600"}`}>
                  {isLocalActive ? "هذه المنصة (نشط)" : "منصة المصدر"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-900 px-2 py-1 rounded">
                <span className="text-slate-500">Epoch:</span>
                <span className="font-mono font-bold text-slate-700">{link.controllerEpoch}</span>
              </div>
              <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-900 px-2 py-1 rounded">
                <span className="text-slate-500">Install ID:</span>
                <span className="font-mono font-bold text-slate-700" dir="ltr">{link.installationId.slice(0,8)}...</span>
              </div>
            </div>
          </div>
        );
      })}

      <Dialog open={!!confirmSwitch} onOpenChange={(o) => !o && setConfirmSwitch(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-emerald-800">
              {confirmSwitch?.toLocal ? <Shield className="h-5 w-5 text-emerald-600" /> : <ShieldAlert className="h-5 w-5 text-rose-600" />}
              تأكيد نقل قيادة التحكم
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm mt-2 text-slate-600">
            {confirmSwitch?.toLocal ? (
              <p>هل أنت متأكد من الاستحواذ على قيادة هذا السيرفر المستورد؟ ستتمكن من إرسال التحديثات والأوامر بدلاً من منصة المصدر.</p>
            ) : (
              <p>هل أنت متأكد من التخلي عن إدارة هذا السيرفر وإعادة التحكم إلى منصة المصدر الأساسية؟ لن تعود قادراً على نشر التحديثات إليه.</p>
            )}
            <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border text-xs leading-relaxed">
              <span className="font-bold text-slate-800 dark:text-slate-200">تنويه آمن:</span> هذا الإجراء يقتصر فقط على سيرفر التطبيق. قاعدة بيانات الوكيل المستقلة لم ولن تتأثر بهذا الإجراء إطلاقاً.
            </div>
          </div>
          <DialogFooter className="gap-2 pt-2 border-t mt-4">
            <Button variant="ghost" onClick={() => setConfirmSwitch(null)}>إلغاء</Button>
            <Button onClick={() => {
              const activeId = confirmSwitch.toLocal ? confirmSwitch.targetPlatformId : confirmSwitch.sourcePlatformId;
              leadMut.mutate({ linkId: confirmSwitch.linkId, activeControllerId: activeId, epoch: confirmSwitch.controllerEpoch + 1 });
            }} disabled={leadMut.isPending} className={confirmSwitch?.toLocal ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-rose-600 hover:bg-rose-700 text-white"}>
              {leadMut.isPending && <Loader2 className="h-4 w-4 ms-2 animate-spin" />}
              تأكيد الإجراء
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
