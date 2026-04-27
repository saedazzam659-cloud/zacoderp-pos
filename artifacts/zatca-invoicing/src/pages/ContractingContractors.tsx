import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Users, Plus, Pencil, Trash2, Star, Phone, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import ContractingAIAssistant from "@/components/ContractingAIAssistant";

const API = import.meta.env.VITE_API_URL || "";

type Contractor = {
  id: number; name: string; contactPerson: string | null;
  phone: string | null; email: string | null; address: string | null;
  specialty: string; rating: string; status: string; notes: string | null;
};

const SPECIALTIES = ["general", "civil", "mep", "finishing", "earthworks", "steel", "other"] as const;
const SPECIALTY_LABEL: Record<string, string> = {
  general: "عام", civil: "مدني", mep: "كهروميكانيكي", finishing: "تشطيبات",
  earthworks: "أعمال ترابية", steel: "حدادة", other: "أخرى",
};
const STATUSES = ["active", "blacklisted", "inactive"] as const;
const STATUS_LABEL: Record<string, string> = { active: "نشط", blacklisted: "محظور", inactive: "غير نشط" };
const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default", blacklisted: "destructive", inactive: "outline",
};

const empty = (): Partial<Contractor> => ({
  name: "", contactPerson: "", phone: "", email: "", address: "",
  specialty: "general", rating: "0", status: "active", notes: "",
});

export default function ContractingContractors() {
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<Contractor[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<Contractor> | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Contractor | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/contracting/contractors`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    } finally { setLoading(false); }
  }, [token, t, toast]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!editing) return;
    if (!editing.name?.trim()) {
      toast({ title: t("contracting.contractors.required", "اسم المقاول مطلوب"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const isEdit = (editing as any).id != null;
      const url = isEdit
        ? `${API}/api/contracting/contractors/${(editing as any).id}`
        : `${API}/api/contracting/contractors`;
      const r = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(editing),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      toast({ title: isEdit
        ? t("contracting.contractors.updated", "تم تحديث المقاول")
        : t("contracting.contractors.created", "تم إنشاء المقاول") });
      setEditing(null);
      await load();
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function doDelete() {
    if (!deleting) return;
    try {
      const r = await fetch(`${API}/api/contracting/contractors/${deleting.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast({ title: t("contracting.contractors.deleted", "تم حذف المقاول") });
      setDeleting(null);
      await load();
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 p-2 text-white shadow">
          <Users className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{t("contracting.contractors.title", "المقاولون والموردون")}</h1>
          <p className="text-sm text-slate-500">{t("contracting.contractors.subtitle", "إدارة شبكة المقاولين الفرعيين")}</p>
        </div>
        <Button onClick={() => setEditing(empty())}>
          <Plus className="h-4 w-4 mx-1" />
          {t("contracting.contractors.new", "مقاول جديد")}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <div className="rounded-lg border bg-white dark:bg-slate-900 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("contracting.contractors.name", "الاسم")}</TableHead>
                  <TableHead>{t("contracting.contractors.specialty", "التخصص")}</TableHead>
                  <TableHead>{t("contracting.contractors.contact", "التواصل")}</TableHead>
                  <TableHead>{t("contracting.contractors.rating", "التقييم")}</TableHead>
                  <TableHead>{t("contracting.contractors.status", "الحالة")}</TableHead>
                  <TableHead className="text-end">{t("common.actions", "إجراءات")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && rows.length === 0 && (
                  <TableRow><TableCell colSpan={6}><Skeleton className="h-24 w-full" /></TableCell></TableRow>
                )}
                {!loading && rows.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-sm text-slate-500 py-6">
                    {t("contracting.contractors.empty", "لا يوجد مقاولون — اضغط «مقاول جديد» لإضافة الأول")}
                  </TableCell></TableRow>
                )}
                {rows.map(c => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      {c.name}
                      {c.contactPerson && <div className="text-[11px] text-slate-500">{c.contactPerson}</div>}
                    </TableCell>
                    <TableCell><Badge variant="outline">{SPECIALTY_LABEL[c.specialty] ?? c.specialty}</Badge></TableCell>
                    <TableCell>
                      {c.phone && <div className="flex items-center gap-1 text-xs"><Phone className="h-3 w-3" />{c.phone}</div>}
                      {c.email && <div className="flex items-center gap-1 text-xs"><Mail className="h-3 w-3" />{c.email}</div>}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                        <span className="text-sm tabular-nums">{Number(c.rating).toFixed(1)}</span>
                      </div>
                    </TableCell>
                    <TableCell><Badge variant={STATUS_TONE[c.status] ?? "default"}>{STATUS_LABEL[c.status] ?? c.status}</Badge></TableCell>
                    <TableCell className="text-end">
                      <div className="inline-flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(c)}><Pencil className="h-4 w-4" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(c)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        <ContractingAIAssistant screenContext="contracting.contractors" currentAction="reviewing contractors" />
      </div>

      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing && (editing as any).id
                ? t("contracting.contractors.edit", "تعديل المقاول")
                : t("contracting.contractors.new", "مقاول جديد")}
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label={t("contracting.contractors.name", "الاسم")} required>
                <Input value={editing.name ?? ""} onChange={e => setEditing({ ...editing, name: e.target.value })} />
              </Field>
              <Field label={t("contracting.contractors.contactPerson", "الشخص المسؤول")}>
                <Input value={editing.contactPerson ?? ""} onChange={e => setEditing({ ...editing, contactPerson: e.target.value })} />
              </Field>
              <Field label={t("contracting.contractors.phone", "الهاتف")}>
                <Input value={editing.phone ?? ""} onChange={e => setEditing({ ...editing, phone: e.target.value })} />
              </Field>
              <Field label={t("contracting.contractors.email", "البريد الإلكتروني")}>
                <Input value={editing.email ?? ""} onChange={e => setEditing({ ...editing, email: e.target.value })} />
              </Field>
              <Field label={t("contracting.contractors.specialty", "التخصص")}>
                <Select value={editing.specialty ?? "general"} onValueChange={v => setEditing({ ...editing, specialty: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SPECIALTIES.map(s => <SelectItem key={s} value={s}>{SPECIALTY_LABEL[s]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("contracting.contractors.status", "الحالة")}>
                <Select value={editing.status ?? "active"} onValueChange={v => setEditing({ ...editing, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUSES.map(s => <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("contracting.contractors.rating", "التقييم (0-5)")}>
                <Input type="number" min={0} max={5} step={0.1} value={editing.rating ?? "0"}
                  onChange={e => setEditing({ ...editing, rating: e.target.value })} />
              </Field>
              <Field label={t("contracting.contractors.address", "العنوان")}>
                <Input value={editing.address ?? ""} onChange={e => setEditing({ ...editing, address: e.target.value })} />
              </Field>
              <div className="md:col-span-2">
                <Field label={t("contracting.contractors.notes", "ملاحظات")}>
                  <Input value={editing.notes ?? ""} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
                </Field>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>{t("common.cancel", "إلغاء")}</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? t("common.saving", "جاري الحفظ…") : t("common.save", "حفظ")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={open => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("contracting.contractors.confirmDelete", "تأكيد حذف المقاول")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && <div className="font-bold mt-2">{deleting.name}</div>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel", "إلغاء")}</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete} className="bg-red-600 hover:bg-red-700">
              {t("common.delete", "حذف")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-slate-600">{label}{required && <span className="text-red-500"> *</span>}</label>
      {children}
    </div>
  );
}
