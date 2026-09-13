import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Download, UploadCloud, Link as LinkIcon, ShieldCheck, Server, AlertTriangle } from "lucide-react";

const API = import.meta.env.VITE_API_URL ?? "";

const SERVER_ERROR_LABELS: Record<string, string> = {
  invite_expired: "انتهت صلاحية الدعوة. أنشئ ملف دعوة جديداً من المنصة الهدف ثم أعد المحاولة.",
  link_expired: "انتهت صلاحية ملف الربط. استخدم دعوة جديدة ولا تحاول إعادة استخدام الملف القديم.",
  invite_already_consumed: "استهلكت هذه الدعوة مسبقاً. أنشئ دعوة جديدة لإكمال الربط.",
  target_mismatch: "ملف الدعوة لا يطابق المنصة الهدف أو أصل HTTPS المسجل.",
  invalid_invite: "ملف الدعوة غير صالح أو ناقص.",
  invalid_link_mac: "ملف الربط لا يطابق الدعوة؛ أعد تصديره من المصدر.",
  controller_link_already_exists: "يوجد رابط سابق لهذه المنصة. افتح إصلاح التكرار على المصدر وجدد الرابط بدعوة جديدة.",
  controller_pairing_already_present: "يوجد رابط مستورد على المنصة الهدف؛ أوقف التجديد ولا تحذف أي صف.",
  TARGET_CONTROLLER_LINK_ALREADY_EXISTS: "يوجد رابط مستورد على المنصة الهدف؛ أوقف التجديد ولا تحذف أي صف.",
  renewal_source_state_not_supported: "تغيرت حالة الرابط أو لم تعد في Epoch 0؛ أعد تحميل الحالة ولا تحذف أي صف.",
  renewal_stale_source_state: "تغيرت حالة الرابط أثناء التجديد؛ لم تتغير أي صفوف.",
  RENEWAL_ALREADY_IN_PROGRESS: "توجد عملية تجديد أخرى قيد التنفيذ؛ أعد المحاولة بعد انتهائها.",
  renewal_attestation_denied: "رفضت المنصة الهدف إثبات الدعوة الجديدة؛ لم تتغير أي صفوف.",
};

function arabicServerError(value: unknown, fallback: string): string {
  const raw = String(value ?? "");
  return SERVER_ERROR_LABELS[raw] ?? (raw || fallback);
}

async function parseServerResponse(res: Response, fallback: string): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = body?.code || body?.error || body?.serverMessage;
    throw new Error(arabicServerError(code, fallback));
  }
  return body;
}

export function PlatformLinksTopLevel() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  
  const [inviteLifetime, setInviteLifetime] = useState(3600);
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewFile, setPreviewFile] = useState<any>(null);

  const inviteMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/admin/agent-instances/platform-links/invites`, {
        method: "POST", headers, body: JSON.stringify({ lifetimeSeconds: inviteLifetime })
      });
      return parseServerResponse(res, "فشل إنشاء الدعوة");
    },
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invite-${data.inviteId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "تم إنشاء وحفظ الدعوة بنجاح", description: "تنبيه: يُستخدم هذا الملف لمرة واحدة فقط ويحتوي على مفاتيح حساسة." });
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" })
  });

  const previewMut = useMutation({
    mutationFn: async (fileContent: string) => {
      const res = await fetch(`${API}/api/admin/agent-instances/platform-links/preview`, {
        method: "POST", headers, body: JSON.stringify({ file: JSON.parse(fileContent) })
      });
      return parseServerResponse(res, "ملف الربط غير صالح أو تم التلاعب به");
    },
    onSuccess: (data, variables) => {
      setPreviewData(data);
      setPreviewFile(JSON.parse(variables));
    },
    onError: (err: any) => {
      toast({ title: "خطأ في قراءة الملف", description: err.message, variant: "destructive" });
      setPreviewData(null);
      setPreviewFile(null);
    }
  });

  const importMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/api/admin/agent-instances/platform-links/import`, {
        method: "POST", headers, body: JSON.stringify({ file: previewFile })
      });
      return parseServerResponse(res, "فشل استيراد وكيل");
    },
    onSuccess: () => {
      toast({ title: "تم استيراد الوكيل بنجاح", description: "يمكنك الآن إدارة السيرفر وتحديثاته من هذه المنصة." });
      setPreviewData(null);
      setPreviewFile(null);
      qc.invalidateQueries({ queryKey: ["agent-platform-imported"] });
    },
    onError: (err: any) => toast({ title: "خطأ في الاستيراد", description: err.message, variant: "destructive" })
  });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const content = ev.target?.result as string;
        previewMut.mutate(content);
      } catch (err) {
        toast({ title: "ملف غير صالح", variant: "destructive" });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Source Platform Area */}
        <div className="border border-indigo-100 dark:border-indigo-900/40 rounded-xl p-5 bg-indigo-50/20 dark:bg-indigo-950/10 shadow-sm transition-colors hover:bg-indigo-50/30">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-indigo-100 dark:bg-indigo-900/50 rounded-lg text-indigo-700 dark:text-indigo-400">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-indigo-950 dark:text-indigo-100">استقبال وكيل (إنشاء دعوة)</h3>
              <p className="text-xs text-indigo-700/70 dark:text-indigo-300/70 mt-0.5">اسمح لمنصة أخرى بربط وكيلها للتحكم من هنا</p>
            </div>
          </div>
          <div className="text-sm text-slate-600 dark:text-slate-400 mb-5 leading-relaxed space-y-2">
            <p>
              يولّد النظام ملف تشفير يُحمّل تلقائياً. أرسل هذا الملف لمشرف المنصة الأخرى ليقوم برفعه وتصدير الوكيل.
            </p>
            <div className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400 text-xs bg-rose-50 dark:bg-rose-900/20 p-2 rounded">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>يُستخدم هذا الملف لمرة واحدة فقط لضمان الأمان العالي.</span>
            </div>
          </div>
          <Button onClick={() => inviteMut.mutate()} disabled={inviteMut.isPending} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm h-10">
            {inviteMut.isPending ? <Loader2 className="h-4 w-4 ms-2 animate-spin" /> : <Download className="h-4 w-4 ms-2" />}
            إنشاء وتحميل ملف الدعوة
          </Button>
        </div>

        {/* Target Platform Area */}
        <div className="border border-emerald-100 dark:border-emerald-900/40 rounded-xl p-5 bg-emerald-50/20 dark:bg-emerald-950/10 shadow-sm transition-colors hover:bg-emerald-50/30">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-emerald-100 dark:bg-emerald-900/50 rounded-lg text-emerald-700 dark:text-emerald-400">
              <LinkIcon className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-emerald-950 dark:text-emerald-100">استيراد وكيل (رفع ملف الربط)</h3>
              <p className="text-xs text-emerald-700/70 dark:text-emerald-300/70 mt-0.5">استحوذ على إدارة وكيل من منصة مصدر</p>
            </div>
          </div>
          <div className="text-sm text-slate-600 dark:text-slate-400 mb-5 leading-relaxed space-y-2">
            <p>
              قم برفع ملف الربط (Portable Link) المُصدّر من المنصة التي تستضيف الوكيل حالياً. هذا سينشئ قناة تحكم آمنة.
            </p>
            <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 text-xs bg-emerald-50/50 dark:bg-emerald-900/20 p-2 rounded">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>لن يتم نقل أي بيانات تجارية، الاستيراد خاص بالتحكم فقط.</span>
            </div>
          </div>
          <div className="relative">
            <Button variant="outline" disabled={previewMut.isPending} className="w-full h-10 relative z-0 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 shadow-sm">
              {previewMut.isPending ? <Loader2 className="h-4 w-4 ms-2 animate-spin" /> : <UploadCloud className="h-4 w-4 ms-2" />}
              استيراد ملف الربط (JSON)
            </Button>
            <input type="file" accept=".json" onChange={handleFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
          </div>
        </div>
      </div>

      <Dialog open={!!previewData} onOpenChange={(o) => !o && setPreviewData(null)}>
        <DialogContent className="max-w-md border-emerald-100 shadow-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-emerald-800"><Server className="h-5 w-5" /> تأكيد استيراد الوكيل</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm mt-2">
            <div className="bg-slate-50 dark:bg-slate-900/50 p-4 rounded-lg border border-slate-100 text-slate-600 leading-relaxed text-xs">
              سيتم إنشاء مرجع لهذا الوكيل يسمح لك بتحديث نسخته وإدارة أوامر التحكم، مع ضمان بقاء <span className="font-bold text-slate-800">قاعدة بيانات أعماله بعيدة عن أي تدخل</span>. لن يتم طلب أو حفظ كلمات مرور قاعدة بيانات الوكيل هنا.
            </div>
            {previewData?.link && (
              <div className="grid grid-cols-2 gap-y-3 gap-x-4 border border-slate-100 rounded-lg p-4 bg-white dark:bg-slate-950 text-xs shadow-sm">
                <div className="text-slate-500 font-medium">اسم الوكيل</div>
                <div className="font-bold text-slate-900">{previewData.link.name}</div>
                
                <div className="text-slate-500 font-medium">النطاق</div>
                <div className="font-bold text-slate-900" dir="ltr">{previewData.link.domain}</div>
                
                <div className="text-slate-500 font-medium">منصة المصدر</div>
                <div className="font-medium text-slate-700 bg-slate-50 px-1.5 py-0.5 rounded w-fit" dir="ltr">{previewData.link.sourceOrigin}</div>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 pt-2 border-t mt-4">
            <Button variant="ghost" onClick={() => setPreviewData(null)}>إلغاء</Button>
            <Button onClick={() => importMut.mutate()} disabled={importMut.isPending} className="bg-emerald-600 hover:bg-emerald-700 text-white shadow">
              {importMut.isPending && <Loader2 className="h-4 w-4 ms-2 animate-spin" />}
              تأكيد الاستيراد
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
