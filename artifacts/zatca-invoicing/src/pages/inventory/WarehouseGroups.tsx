import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Plus, Pencil, Trash2, Layers, Search } from "lucide-react";
import { cn } from "@/lib/utils";

type Group = { id: number; code: string; nameAr: string; nameEn?: string };
const EMPTY: Omit<Group, "id"> = { code: "", nameAr: "", nameEn: "" };

export default function WarehouseGroups() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`inventoryMaster.warehouseGroups.${k}`, opts) as string;
  const pickName = (ar?: string | null, en?: string | null) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<Partial<Group>>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data = [], isLoading } = useQuery({
    queryKey: ["warehouse-groups", cid],
    queryFn: () => inventoryApi.getWarehouseGroups(cid),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["warehouse-groups"] });
  const createMut = useMutation({ mutationFn: inventoryApi.createWarehouseGroup, onSuccess: () => { invalidate(); reset(); toast({ title: tr("savedToast") }); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => inventoryApi.updateWarehouseGroup(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: tr("savedToast") }); } });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteWarehouseGroup, onSuccess: () => { invalidate(); toast({ title: tr("deletedToast") }); } });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); }
  function handleEdit(g: Group) { setForm(g); setEditId(g.id); setShowForm(true); }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editId) updateMut.mutate({ id: editId, data: form });
    else        createMut.mutate(form);
  }

  const filtered = data.filter((g: Group) =>
    g.nameAr.includes(search) || g.code.includes(search) || (g.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Layers className="h-6 w-6 text-primary" />{tr("title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />{tr("newGroup")}
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={Layers}
          title={editId ? tr("editGroup") : tr("newGroup")}
          subtitle={tr("subtitle")}
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={!form.code || !form.nameAr}
          saveLabel={t("common.save") as string}
        >
          <FormGrid>
            <Field label={t("inventoryMaster.common.code") as string} required>
              <Input placeholder={tr("codePh")} value={form.code ?? ""} onChange={e => setForm(p => ({ ...p, code: e.target.value }))} />
            </Field>
            <Field label={t("inventoryMaster.common.nameAr") as string} required>
              <Input placeholder={tr("nameArPh")} value={form.nameAr ?? ""} onChange={e => setForm(p => ({ ...p, nameAr: e.target.value }))} />
            </Field>
            <Field label={t("inventoryMaster.common.nameEn") as string} className="md:col-span-2">
              <Input placeholder={tr("nameEnPh")} dir="ltr" className="text-left" value={form.nameEn ?? ""} onChange={e => setForm(p => ({ ...p, nameEn: e.target.value }))} />
            </Field>
          </FormGrid>
        </FormPanel>
      )}

      <div className="relative">
        <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
        <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={tr("searchPh")} value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground w-28`}>{tr("colCode")}</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colName")}</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden sm:table-cell`}>{isRtl ? t("inventoryMaster.common.nameEn") as string : t("inventoryMaster.common.nameAr") as string}</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground w-24`}>{t("inventoryMaster.common.actions") as string}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => (
                  <tr key={i}><td colSpan={4} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>
                ))
              : filtered.length === 0
              ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                      <Layers className="h-10 w-10 mx-auto mb-3 opacity-20" />
                      <p className="font-medium">{tr("noGroups")}</p>
                      <p className="text-xs mt-1">{tr("addFirst")}</p>
                    </td>
                  </tr>
                )
              : filtered.map((g: Group) => (
                  <tr key={g.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded font-medium">{g.code}</span>
                    </td>
                    <td className="px-4 py-3 font-medium">{pickName(g.nameAr, g.nameEn)}</td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{isRtl ? (g.nameEn ?? "—") : (g.nameAr ?? "—")}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-primary/10 hover:text-primary" onClick={() => handleEdit(g)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className={cn("h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10")} onClick={() => { if (confirm(t("inventoryMaster.common.deleteConfirm") as string)) deleteMut.mutate(g.id); }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {!isLoading && (
          <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">
            {filtered.length}
          </div>
        )}
      </div>
    </div>
  );
}
