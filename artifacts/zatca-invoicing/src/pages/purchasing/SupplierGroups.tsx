import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Plus, Pencil, Trash2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const EMPTY = { code: "", nameAr: "", nameEn: "", discountPercent: "0", notes: "", isActive: true };

export default function SupplierGroups() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`purchasingPages.supplierGroups.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [form, setForm]         = useState<any>(EMPTY);
  const [editId, setEditId]     = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data: groups = [], isLoading } = useQuery<any[]>({
    queryKey: ["supplier-groups", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/purchasing/supplier-groups?companyId=${cid}` : `${API}/api/purchasing/supplier-groups`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    },
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["supplier-groups"] });

  const createMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`${API}/api/purchasing/supplier-groups`, { method: "POST", headers, body: JSON.stringify({ ...data, companyId: cid }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      return j;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: tr("toastSaved") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, data }: any) => {
      const res = await fetch(`${API}/api/purchasing/supplier-groups/${id}`, { method: "PUT", headers, body: JSON.stringify(data) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      return j;
    },
    onSuccess: () => { invalidate(); reset(); toast({ title: tr("toastUpdated") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/purchasing/supplier-groups/${id}`, { method: "DELETE", headers });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
    },
    onSuccess: () => { invalidate(); toast({ title: tr("toastDeleted") }); },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); }
  function handleEdit(g: any) { setForm({ ...g, discountPercent: String(g.discountPercent ?? "0") }); setEditId(g.id); setShowForm(true); }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editId) updateMut.mutate({ id: editId, data: form });
    else createMut.mutate(form);
  }

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Users className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{tr("subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />{tr("addNew")}
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={Users}
          title={editId ? tr("formEdit") : tr("formNew")}
          subtitle={tr("formSubtitle")}
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={!form.code || !form.nameAr}
          saveLabel={editId ? tr("saveEdit") : tr("saveAdd")}
        >
          <FormGrid>
            <Field label={tr("fCode")} required>
              <Input placeholder={tr("fCodePh")} value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} />
            </Field>
            <Field label={tr("fNameAr")} required>
              <Input placeholder={tr("fNameArPh")} value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} />
            </Field>
            <Field label={tr("fNameEn")} className="md:col-span-2">
              <Input placeholder={tr("fNameEnPh")} dir="ltr" className="text-left" value={form.nameEn ?? ""} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
            </Field>
            <Field label={tr("fDiscount")}>
              <Input type="text" inputMode="decimal" placeholder="0.00" value={form.discountPercent} onChange={e => setForm((p: any) => ({ ...p, discountPercent: e.target.value.replace(/[^0-9.]/g, "") }))} />
            </Field>
            <Field label={tr("fStatus")}>
              <div className="flex items-center gap-2 h-9">
                <Switch checked={form.isActive} onCheckedChange={v => setForm((p: any) => ({ ...p, isActive: v }))} id="sg-active" />
                <Label htmlFor="sg-active" className="text-sm">{form.isActive ? tr("stActive") : tr("stInactive")}</Label>
              </div>
            </Field>
            <Field label={tr("fNotes")} className="md:col-span-2">
              <Input placeholder={tr("fNotesPh")} value={form.notes ?? ""} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
            </Field>
          </FormGrid>
        </FormPanel>
      )}

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground text-sm">{tr("loading")}</div>
        ) : groups.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground text-sm">
            <Users className="h-10 w-10 mx-auto mb-3 opacity-20" />
            {tr("noGroups")}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className={`${isRtl ? "text-right" : "text-left"} px-4 py-3 font-semibold text-muted-foreground`}>{tr("colCode")}</th>
                <th className={`${isRtl ? "text-right" : "text-left"} px-4 py-3 font-semibold text-muted-foreground`}>{tr("colName")}</th>
                <th className={`${isRtl ? "text-right" : "text-left"} px-4 py-3 font-semibold text-muted-foreground hidden sm:table-cell`}>{tr("colNameEn")}</th>
                <th className={`${isRtl ? "text-right" : "text-left"} px-4 py-3 font-semibold text-muted-foreground`}>{tr("colDiscount")}</th>
                <th className={`${isRtl ? "text-right" : "text-left"} px-4 py-3 font-semibold text-muted-foreground`}>{tr("colStatus")}</th>
                <th className={`${isRtl ? "text-right" : "text-left"} px-4 py-3 font-semibold text-muted-foreground`}>{tr("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g: any) => (
                <tr key={g.id} className="border-b hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs text-primary">{g.code}</td>
                  <td className="px-4 py-2.5 font-medium">{pickName(g.nameAr, g.nameEn)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">{(isRtl ? g.nameEn : g.nameAr) ?? "—"}</td>
                  <td className="px-4 py-2.5">{Number(g.discountPercent || 0).toFixed(2)}%</td>
                  <td className="px-4 py-2.5">
                    <span className={cn("text-xs rounded-full px-2 py-0.5 font-medium border",
                      g.isActive ? "bg-green-50 text-green-700 border-green-200" : "bg-muted text-muted-foreground border-border"
                    )}>
                      {g.isActive ? tr("stActive") : tr("stInactive")}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEdit(g)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => { if (confirm(tr("deleteConfirm"))) deleteMut.mutate(g.id); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}
