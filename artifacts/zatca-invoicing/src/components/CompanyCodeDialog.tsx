import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

export type CompanyCodeTarget = { id: number; name: string; code: string | null; agent?: number };

export default function CompanyCodeDialog({ company, onClose, onSaved }: {
  company: CompanyCodeTarget; onClose: () => void; onSaved: () => void;
}) {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [code, setCode] = useState(company.code ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const normalized = code.trim().toUpperCase();
  const valid = /^[A-Z0-9]{1,15}$/.test(normalized);
  async function save() {
    if (saving || !confirmed || !valid || normalized === company.code) return;
    setSaving(true); setError("");
    try {
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const response = await fetch(`${base}/api/companies/${company.id}/code${company.agent ? `?agent=${company.agent}` : ""}`, {
        method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalized, expectedCode: company.code }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "تعذّر تغيير كود الشركة");
      onSaved();
      toast({ title: "تم تغيير كود الشركة", description: `الكود الجديد لتسجيل الدخول: ${data.code}` });
      onClose();
    } catch (caught: any) { setError(caught.message || "تعذّر تغيير كود الشركة"); }
    finally { setSaving(false); }
  }
  return <AlertDialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <AlertDialogContent dir="rtl">
      <AlertDialogHeader>
        <AlertDialogTitle>تغيير كود الشركة</AlertDialogTitle>
        <AlertDialogDescription className="text-right">
          {company.name} — معرّف الشركة الداخلي: {company.id}
          <br />سيُستخدم الكود الجديد في تسجيل الدخول بدلًا من القديم. لن يتغيّر معرّف الشركة أو بياناتها وحساباتها.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div className="space-y-3">
        <label className="block text-sm">الكود الحالي<Input value={company.code ?? "—"} readOnly dir="ltr" className="mt-1 font-mono" /></label>
        <label className="block text-sm" htmlFor="new-company-code">الكود الجديد
          <Input id="new-company-code" value={code} onChange={e => { setCode(e.target.value.toUpperCase()); setError(""); }}
            disabled={saving} dir="ltr" maxLength={15} autoComplete="off" className="mt-1 font-mono"
            data-testid="input-new-company-code" />
        </label>
        <p className="text-xs text-muted-foreground">حروف إنجليزية أو أرقام فقط، حتى 15 خانة. يجب ألا يكون الكود مستخدمًا لشركة أخرى.</p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={confirmed} disabled={saving} onChange={e => setConfirmed(e.target.checked)} />
          أؤكد تغيير كود الدخول، وسأبلغ مستخدمي الشركة بالكود الجديد وأحدّث أي إعدادات اتصال تستخدم الكود القديم.
        </label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={saving}>إلغاء</AlertDialogCancel>
        <Button onClick={() => void save()} disabled={saving || !confirmed || !valid || normalized === company.code} data-testid="button-save-company-code">
          {saving ? "جارٍ الحفظ…" : "تأكيد تغيير الكود"}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}