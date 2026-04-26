import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { trimTrailingZeros } from "@/hooks/use-fmt";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Plus, Pencil, Trash2, Ruler, Search, Info, ArrowRight } from "lucide-react";

const EMPTY = { code: "", nameAr: "", nameEn: "", conversionFactor: "1" };

const PRESETS = [
  { code: "PCS",  nameAr: "قطعة",    nameEn: "Piece",   conversionFactor: "1" },
  { code: "BOX",  nameAr: "علبة",    nameEn: "Box",     conversionFactor: "1" },
  { code: "CTN",  nameAr: "كرتونة",  nameEn: "Carton",  conversionFactor: "1" },
  { code: "KG",   nameAr: "كيلو",    nameEn: "KG",      conversionFactor: "1" },
  { code: "LTR",  nameAr: "لتر",     nameEn: "Litre",   conversionFactor: "1" },
  { code: "MTR",  nameAr: "متر",     nameEn: "Metre",   conversionFactor: "1" },
  { code: "DZN",  nameAr: "درزينة",  nameEn: "Dozen",   conversionFactor: "12" },
  { code: "PAL",  nameAr: "بالية",   nameEn: "Pallet",  conversionFactor: "1" },
];

export default function Units() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`inventoryMaster.units.${k}`, opts) as string;
  const pickName = (ar?: string | null, en?: string | null) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data = [], isLoading } = useQuery({
    queryKey: ["units", cid],
    queryFn: () => inventoryApi.getUnits(cid),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["units"] });
  const createMut = useMutation({ mutationFn: inventoryApi.createUnit, onSuccess: () => { invalidate(); reset(); toast({ title: tr("savedToast") }); } });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => inventoryApi.updateUnit(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: tr("savedToast") }); } });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteUnit, onSuccess: () => { invalidate(); toast({ title: tr("deletedToast") }); } });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); }
  function handleEdit(u: any) { setForm({ ...u, conversionFactor: String(Math.max(1, Math.trunc(Number(u.conversionFactor) || 1))) }); setEditId(u.id); setShowForm(true); }
  function handlePreset(p: typeof PRESETS[0]) {
    setForm({ code: p.code, nameAr: p.nameAr, nameEn: p.nameEn, conversionFactor: p.conversionFactor });
    setShowForm(true);
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const factor = Math.max(1, Math.trunc(Number(form.conversionFactor) || 1));
    const payload = { ...form, conversionFactor: String(factor) };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else createMut.mutate(payload);
  }

  const filtered = data.filter((u: any) =>
    u.nameAr.includes(search) || u.code.includes(search) || (u.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Ruler className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />{tr("newUnit")}
        </Button>
      </div>

      <div className="rounded-xl border bg-blue-50 border-blue-100 p-4">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p className="text-sm font-semibold text-blue-800">{isRtl ? "كيف تعمل وحدات القياس المتعددة؟" : "How do multi-units work?"}</p>
            <p className="text-xs text-blue-700">
              {isRtl
                ? "هنا تُعرِّف الوحدات العامة (قطعة، كرتونة، كيلو...). بعدها في صفحة الأصناف، تربط كل صنف بالوحدات التي يُباع بها مع تحديد معامل التحويل والسعر لكل وحدة."
                : "Define general units here (piece, carton, kg...). Then in the items page, link each item to the units it is sold in, specifying the conversion factor and price for each unit."}
            </p>
            <div className="flex flex-wrap gap-3 mt-1">
              <div className="bg-white border border-blue-200 rounded-lg px-3 py-2 text-xs">
                <p className="font-semibold text-blue-800 mb-1">{isRtl ? "مثال — صنف: سكر" : "Example — Item: Sugar"}</p>
                <div className="space-y-1 text-blue-700">
                  <div className="flex items-center gap-2">
                    <span className="bg-green-100 text-green-700 rounded px-1.5 py-0.5 font-mono font-bold">{isRtl ? "واحدة" : "Each"}</span>
                    <ArrowRight className="h-3 w-3" />
                    <span>{isRtl ? "معامل ×1 — تكلفة 5 ر.س" : "Factor ×1 — Cost 5 SAR"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="bg-purple-100 text-purple-700 rounded px-1.5 py-0.5 font-mono font-bold">{isRtl ? "كرتونة" : "Carton"}</span>
                    <ArrowRight className="h-3 w-3" />
                    <span>{isRtl ? "معامل ×12 — تكلفة 60 ر.س" : "Factor ×12 — Cost 60 SAR"}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <p className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wide">{isRtl ? "وحدات شائعة — انقر للإضافة السريعة" : "Common Units — Click to add quickly"}</p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(p => (
            <button
              key={p.code}
              onClick={() => handlePreset(p)}
              className="flex items-center gap-1.5 rounded-full border bg-muted/30 hover:bg-muted/70 px-3 py-1.5 text-xs transition-colors"
            >
              <span className="font-mono font-bold text-primary">{p.code}</span>
              <span className="text-muted-foreground">{isRtl ? p.nameAr : p.nameEn}</span>
              {Number(p.conversionFactor) !== 1 && (
                <span className="text-[10px] bg-purple-100 text-purple-700 rounded px-1">×{p.conversionFactor}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {showForm && (
        <FormPanel
          icon={Ruler}
          title={editId ? tr("editUnit") : tr("newUnit")}
          subtitle={tr("subtitle")}
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={!form.code || !form.nameAr}
          saveLabel={t("common.save") as string}
        >
          <FormGrid>
            <Field label={t("inventoryMaster.common.code") as string} required>
              <Input placeholder={tr("codePh")} value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value.toUpperCase() }))} className="font-mono" />
            </Field>
            <Field label={t("inventoryMaster.common.nameAr") as string} required>
              <Input placeholder={tr("nameArPh")} value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} />
            </Field>
            <Field label={t("inventoryMaster.common.nameEn") as string}>
              <Input placeholder={tr("nameEnPh")} dir="ltr" className="text-left" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
            </Field>
            <Field label={tr("conversionFactor")} hint={tr("conversionHint")}>
              <Input type="number" step="1" min="1" placeholder="1" value={form.conversionFactor} onChange={e => setForm((p: any) => ({ ...p, conversionFactor: e.target.value.replace(/[^0-9]/g, "") }))} />
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
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colCode")}</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground`}>{tr("colName")}</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground hidden sm:table-cell`}>{isRtl ? t("inventoryMaster.common.nameEn") as string : t("inventoryMaster.common.nameAr") as string}</th>
              <th className={`px-4 py-3 text-center font-semibold text-muted-foreground hidden sm:table-cell`}>{tr("colFactor")}</th>
              <th className={`px-4 py-3 ${isRtl ? "text-right" : "text-left"} font-semibold text-muted-foreground w-24`}>{t("inventoryMaster.common.actions") as string}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                    <Ruler className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p>{tr("noUnits")}</p>
                    <p className="text-xs mt-1">{tr("addFirst")}</p>
                  </td>
                </tr>
              )
              : filtered.map((u: any) => (
                <tr key={u.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-mono font-bold text-primary">{u.code}</td>
                  <td className="px-4 py-3 font-medium">{pickName(u.nameAr, u.nameEn)}</td>
                  <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground">{isRtl ? (u.nameEn ?? "—") : (u.nameAr ?? "—")}</td>
                  <td className="px-4 py-3 hidden sm:table-cell text-center">
                    <span className="text-xs bg-muted rounded px-2 py-0.5 tabular-nums">×{trimTrailingZeros(u.conversionFactor)}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(u)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm(t("inventoryMaster.common.deleteConfirm") as string)) deleteMut.mutate(u.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
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
