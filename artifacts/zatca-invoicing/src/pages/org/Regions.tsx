import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { parseError } from "@/lib/parseError";
import { useAuth } from "@/contexts/AuthContext";
import { branchesApi } from "@/lib/branchesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import {
  Plus, Pencil, Trash2, MapPin, Search,
  ChevronDown, ChevronRight, Building2, Phone,
  Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";

const EMPTY_REGION = { code: "", nameAr: "", nameEn: "", notes: "" };

export default function Regions() {
  const { t } = useTranslation();
  const { isRtl } = useFormatters();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();

  const STATUS_CFG: Record<string, { label: string; cls: string }> = {
    active:   { label: t("branches.statusActive"),   cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    inactive: { label: t("branches.statusInactive"), cls: "bg-red-50 text-red-600 border-red-200" },
  };

  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY_REGION);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: regions = [], isLoading } = useQuery({
    queryKey: ["regions", cid],
    queryFn:  () => branchesApi.getRegions(cid),
  });

  const { data: allBranches = [] } = useQuery({
    queryKey: ["branches", cid],
    queryFn:  () => branchesApi.getBranches(cid),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["regions"] });
    qc.invalidateQueries({ queryKey: ["branches"] });
  };

  const errToast = (title: string) => (e: any) => toast({ title, description: parseError(e), variant: "destructive" });
  const createMut = useMutation({ mutationFn: branchesApi.createRegion, onSuccess: () => { invalidate(); reset(); toast({ title: t("regions.addedToast") }); }, onError: errToast(t("regions.errSave")) });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => branchesApi.updateRegion(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: t("regions.updatedToast") }); }, onError: errToast(t("regions.errUpdate")) });
  const deleteMut = useMutation({ mutationFn: branchesApi.deleteRegion, onSuccess: () => { invalidate(); toast({ title: t("regions.deletedToast") }); }, onError: errToast(t("regions.errDelete")) });

  function reset() { setForm(EMPTY_REGION); setEditId(null); setShowForm(false); }
  function handleEdit(r: any) { setForm({ ...r }); setEditId(r.id); setShowForm(true); }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editId) updateMut.mutate({ id: editId, data: form });
    else        createMut.mutate({ ...form, companyId: cid });
  }

  const filtered = (regions as any[]).filter((r: any) =>
    r.nameAr.includes(search) || r.code.includes(search) || (r.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  function regionBranches(regionId: number) {
    return (allBranches as any[]).filter((b: any) => b.regionId === regionId);
  }

  const COLORS = [
    "border-r-blue-400", "border-r-emerald-400", "border-r-violet-400",
    "border-r-amber-400", "border-r-rose-400", "border-r-cyan-400",
  ];
  const borderStartColor = isRtl ? "border-r-4" : "border-l-4";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="h-6 w-6 text-primary" />{t("regions.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{t("regions.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/org/branches">
            <Button variant="outline" size="sm" className="gap-2"><Building2 className="h-4 w-4" />{t("regions.allBranches")}</Button>
          </Link>
          <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
            <Plus className="h-4 w-4" />{t("regions.addRegion")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: t("regions.totalRegions"),  value: (regions as any[]).length,      icon: MapPin,     color: "text-blue-600 bg-blue-50" },
          { label: t("regions.totalBranches"), value: (allBranches as any[]).length,   icon: Building2,  color: "text-emerald-600 bg-emerald-50" },
          { label: t("regions.mainBranches"),  value: (allBranches as any[]).filter((b: any) => b.isMain).length, icon: Star, color: "text-amber-600 bg-amber-50" },
        ].map(s => (
          <div key={s.label} className="rounded-xl border bg-card p-4 flex items-center gap-3">
            <div className={cn("rounded-lg p-2", s.color)}><s.icon className="h-5 w-5" /></div>
            <div>
              <p className="text-2xl font-bold">{s.value}</p>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <FormPanel
          icon={MapPin}
          title={editId ? t("regions.editRegion") : t("regions.addRegionLong")}
          subtitle={t("regions.formSubtitle")}
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={!form.nameAr}
          saveLabel={editId ? t("regions.saveEdit") : t("regions.save")}
        >
          <FormGrid>
            <Field label={t("regions.code")} required>
              <Input placeholder="RGN-01" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} />
            </Field>
            <Field label={t("regions.nameAr")} required>
              <Input placeholder="منطقة الرياض" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} />
            </Field>
            <Field label={t("regions.nameEn")}>
              <Input placeholder="Riyadh Region" dir="ltr" className="text-start" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
            </Field>
            <Field label={t("regions.notes")}>
              <Input placeholder={t("regions.notesPlaceholder")} value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
            </Field>
          </FormGrid>
        </FormPanel>
      )}

      <div className="relative">
        <Search className={cn("absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground", isRtl ? "right-3" : "left-3")} />
        <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={t("regions.search")} value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border bg-card py-16 text-center text-muted-foreground">
          <MapPin className="h-12 w-12 mx-auto mb-3 opacity-20" />
          <p className="font-medium text-base">{t("regions.noRegions")}</p>
          <p className="text-xs mt-1">{t("regions.noRegionsHint")}</p>
          <Button size="sm" className="mt-4 gap-1" onClick={() => { reset(); setShowForm(true); }}>
            <Plus className="h-4 w-4" />{t("regions.addRegion")}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((region: any, idx: number) => {
            const branches = regionBranches(region.id);
            const isExpanded = expandedId === region.id;
            const colorCls = COLORS[idx % COLORS.length].replace("border-r-", isRtl ? "border-r-" : "border-l-");
            return (
              <div key={region.id} className={cn("rounded-xl border bg-card overflow-hidden transition-shadow", isExpanded && "shadow-md")}>
                <div className={cn("flex items-center gap-4 p-4", borderStartColor, colorCls)}>
                  <button onClick={() => setExpandedId(isExpanded ? null : region.id)} className="text-muted-foreground hover:text-foreground transition-colors">
                    {isExpanded ? <ChevronDown className="h-5 w-5" /> : (isRtl ? <ChevronRight className="h-5 w-5 rotate-180" /> : <ChevronRight className="h-5 w-5" />)}
                  </button>
                  <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded font-bold shrink-0">{region.code}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm">{region.nameAr}</p>
                    {region.nameEn && <p className="text-xs text-muted-foreground">{region.nameEn}</p>}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className={cn("text-xs font-semibold rounded-full px-2.5 py-0.5 border", branches.length > 0 ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-muted/50 text-muted-foreground border-transparent")}>
                      {t("regions.branchCount", { count: branches.length })}
                    </span>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Link href={`/org/branches?region=${region.id}`}>
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1"><Plus className="h-3 w-3" />{t("regions.addBranch")}</Button>
                    </Link>
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-primary/10 hover:text-primary" onClick={() => handleEdit(region)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => { if (confirm(t("regions.confirmDelete", { name: region.nameAr }))) deleteMut.mutate(region.id); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="border-t bg-muted/20">
                    {branches.length === 0 ? (
                      <div className="py-8 text-center text-muted-foreground">
                        <Building2 className="h-8 w-8 mx-auto mb-2 opacity-20" />
                        <p className="text-sm">{t("regions.noBranchesInRegion")}</p>
                        <Link href={`/org/branches?region=${region.id}`}>
                          <Button size="sm" variant="outline" className="mt-3 gap-1 text-xs"><Plus className="h-3 w-3" />{t("regions.addFirstBranch")}</Button>
                        </Link>
                      </div>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="border-b bg-muted/30">
                          <tr>
                            <th className="px-6 py-2 text-start text-xs font-semibold text-muted-foreground">{t("regions.colBranch")}</th>
                            <th className="px-4 py-2 text-start text-xs font-semibold text-muted-foreground hidden sm:table-cell">{t("regions.colCity")}</th>
                            <th className="px-4 py-2 text-start text-xs font-semibold text-muted-foreground hidden md:table-cell">{t("regions.colPhone")}</th>
                            <th className="px-4 py-2 text-center text-xs font-semibold text-muted-foreground w-24">{t("regions.colStatus")}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {branches.map((b: any) => (
                            <tr key={b.id} className="hover:bg-muted/20 transition-colors">
                              <td className="px-6 py-2.5">
                                <div className="flex items-center gap-2">
                                  {b.isMain && <Star className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
                                  <div>
                                    <p className="font-medium text-sm">{b.nameAr}</p>
                                    <p className="text-[10px] font-mono text-muted-foreground">{b.code}</p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-2.5 hidden sm:table-cell text-muted-foreground text-xs">{b.city ?? "—"}</td>
                              <td className="px-4 py-2.5 hidden md:table-cell">
                                {b.phone ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><Phone className="h-3 w-3" />{b.phone}</span> : <span className="text-muted-foreground/40 text-xs">—</span>}
                              </td>
                              <td className="px-4 py-2.5 text-center">
                                <span className={cn("text-[10px] font-medium rounded-full px-2.5 py-0.5 border", STATUS_CFG[b.status]?.cls ?? STATUS_CFG.active.cls)}>
                                  {STATUS_CFG[b.status]?.label ?? STATUS_CFG.active.label}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!isLoading && filtered.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          {t("regions.summary", { regions: filtered.length, branches: (allBranches as any[]).length, count: filtered.length })}
        </p>
      )}
    </div>
  );
}
