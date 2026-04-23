import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { branchesApi } from "@/lib/branchesApi";
import { parseError } from "@/lib/parseError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import {
  Plus, Pencil, Trash2, Building2, Search, X,
  MapPin, Phone, Star, CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Link, useSearch } from "wouter";

const EMPTY_BRANCH = {
  code: "", nameAr: "", nameEn: "", regionId: "", city: "",
  address: "", phone: "", email: "", isMain: false, status: "active", notes: "",
};

export default function Branches() {
  const { t } = useTranslation();
  const { isRtl } = useFormatters();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const search = useSearch();

  const STATUS_CFG: Record<string, { label: string; cls: string }> = {
    active:   { label: t("branches.statusActive"),   cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    inactive: { label: t("branches.statusInactive"), cls: "bg-red-50 text-red-600 border-red-200" },
  };

  const [textSearch,   setTextSearch]   = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [form,         setForm]         = useState<any>(EMPTY_BRANCH);
  const [editId,       setEditId]       = useState<number | null>(null);
  const [showForm,     setShowForm]     = useState(false);
  const [activeTab,    setActiveTab]    = useState("basic");

  useEffect(() => {
    const params = new URLSearchParams(search);
    const rid = params.get("region");
    if (rid) {
      setRegionFilter(rid);
      setForm((p: any) => ({ ...p, regionId: rid }));
      setShowForm(true);
    }
  }, [search]);

  const { data: regions = [] } = useQuery({
    queryKey: ["regions", cid],
    queryFn:  () => branchesApi.getRegions(cid),
  });

  const { data: branches = [], isLoading } = useQuery({
    queryKey: ["branches", cid],
    queryFn:  () => branchesApi.getBranches(cid),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["branches"] });
    qc.invalidateQueries({ queryKey: ["regions"] });
  };

  const errToast = (title: string) => (e: any) => toast({ title, description: parseError(e), variant: "destructive" });
  const createMut = useMutation({ mutationFn: branchesApi.createBranch, onSuccess: () => { invalidate(); reset(); toast({ title: t("branches.addedToast") }); }, onError: errToast(t("branches.errSave")) });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => branchesApi.updateBranch(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: t("branches.updatedToast") }); }, onError: errToast(t("branches.errUpdate")) });
  const deleteMut = useMutation({ mutationFn: branchesApi.deleteBranch, onSuccess: () => { invalidate(); toast({ title: t("branches.deletedToast") }); }, onError: errToast(t("branches.errDelete")) });

  function reset() { setForm(EMPTY_BRANCH); setEditId(null); setShowForm(false); setActiveTab("basic"); }
  function handleEdit(b: any) {
    setForm({ ...b, regionId: b.regionId ? String(b.regionId) : "" });
    setEditId(b.id); setShowForm(true); setActiveTab("basic");
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = { ...form, regionId: form.regionId ? Number(form.regionId) : null, companyId: cid };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }

  const regionMap: Record<number, any> = {};
  for (const r of regions as any[]) regionMap[r.id] = r;

  const filtered = (branches as any[]).filter(b => {
    const matchRegion = !regionFilter || String(b.regionId) === regionFilter;
    const matchText   = !textSearch || b.nameAr.includes(textSearch) || b.code.includes(textSearch) || (b.city ?? "").includes(textSearch);
    return matchRegion && matchText;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Building2 className="h-6 w-6 text-primary" />{t("branches.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("branches.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/org/regions">
            <Button variant="outline" size="sm" className="gap-2"><MapPin className="h-4 w-4" />{t("branches.regionsLink")}</Button>
          </Link>
          <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
            <Plus className="h-4 w-4" />{t("branches.addBranch")}
          </Button>
        </div>
      </div>

      {showForm && (
        <FormPanel
          icon={Building2}
          title={
            <span className="flex items-center gap-2">
              {editId ? t("branches.editBranch") : t("branches.addBranchLong")}
              {form.regionId && (
                <span className="text-[11px] bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 flex items-center gap-1">
                  <MapPin className="h-3 w-3" />{regionMap[Number(form.regionId)]?.nameAr ?? t("branches.regionFallback")}
                </span>
              )}
            </span>
          }
          subtitle={t("branches.formSubtitle")}
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={!form.nameAr}
          saveLabel={editId ? t("branches.saveEdit") : t("branches.save")}
        >
          <Tabs value={activeTab} onValueChange={setActiveTab} dir={isRtl ? "rtl" : "ltr"}>
            <TabsList className="w-full h-9 mb-5">
              <TabsTrigger value="basic"   className="flex-1 text-xs gap-1"><Building2 className="h-3.5 w-3.5" />{t("branches.tabBasic")}</TabsTrigger>
              <TabsTrigger value="contact" className="flex-1 text-xs gap-1"><Phone     className="h-3.5 w-3.5" />{t("branches.tabContact")}</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="mt-0">
              <FormGrid>
                <Field label={t("branches.code")} required>
                  <Input placeholder="BR-01" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} />
                </Field>
                <Field label={t("branches.nameAr")} required>
                  <Input placeholder="الفرع الرئيسي" value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} />
                </Field>
                <Field label={t("branches.nameEn")} className="md:col-span-2">
                  <Input placeholder="Main Branch" dir="ltr" className="text-start" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
                </Field>
                <Field label={t("branches.region")}>
                  <SearchCombobox
                    items={[{ value: "", label: t("branches.noRegion") }, ...(regions as any[]).map((r: any) => ({ value: String(r.id), code: r.code, label: r.nameAr, labelEn: r.nameEn }))]}
                    value={form.regionId}
                    onValueChange={v => setForm((p: any) => ({ ...p, regionId: v }))}
                    placeholder={t("branches.selectRegion")}
                  />
                </Field>
                <Field label={t("branches.status")}>
                  <SearchCombobox
                    items={[{ value: "active", label: t("branches.statusActive") }, { value: "inactive", label: t("branches.statusInactive") }]}
                    value={form.status}
                    onValueChange={v => setForm((p: any) => ({ ...p, status: v }))}
                    placeholder={t("branches.status")}
                  />
                </Field>
                <div className="md:col-span-2 flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
                  <Switch checked={form.isMain} onCheckedChange={v => setForm((p: any) => ({ ...p, isMain: v }))} id="is-main" />
                  <div>
                    <Label htmlFor="is-main" className="flex items-center gap-1 text-sm"><Star className="h-3.5 w-3.5 text-amber-500" />{t("branches.isMain")}</Label>
                    <p className="text-[10px] text-muted-foreground">{t("branches.isMainHint")}</p>
                  </div>
                </div>
              </FormGrid>
            </TabsContent>

            <TabsContent value="contact" className="mt-0">
              <FormGrid>
                <Field label={t("branches.city")}>
                  <Input placeholder="الرياض" value={form.city} onChange={e => setForm((p: any) => ({ ...p, city: e.target.value }))} />
                </Field>
                <Field label={t("branches.phone")}>
                  <Input placeholder="0512345678" dir="ltr" className="text-start" value={form.phone} onChange={e => setForm((p: any) => ({ ...p, phone: e.target.value }))} />
                </Field>
                <Field label={t("branches.email")} className="md:col-span-2">
                  <Input type="email" placeholder="branch@company.com" dir="ltr" className="text-start" value={form.email} onChange={e => setForm((p: any) => ({ ...p, email: e.target.value }))} />
                </Field>
                <Field label={t("branches.address")} className="md:col-span-2">
                  <Input placeholder="شارع الملك عبدالعزيز، حي العليا" value={form.address} onChange={e => setForm((p: any) => ({ ...p, address: e.target.value }))} />
                </Field>
                <Field label={t("branches.notes")} className="md:col-span-2">
                  <Input placeholder={t("branches.notesPlaceholder")} value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
                </Field>
              </FormGrid>
            </TabsContent>
          </Tabs>
        </FormPanel>
      )}

      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className={cn("absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground", isRtl ? "right-3" : "left-3")} />
          <Input className={isRtl ? "pr-9" : "pl-9"} placeholder={t("branches.search")} value={textSearch} onChange={e => setTextSearch(e.target.value)} />
        </div>
        <div className="w-52">
          <SearchCombobox
            items={[{ value: "", label: t("branches.filterAllRegions") }, ...(regions as any[]).map((r: any) => ({ value: String(r.id), code: r.code, label: r.nameAr }))]}
            value={regionFilter}
            onValueChange={setRegionFilter}
            placeholder={t("branches.filterByRegion")}
          />
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground w-28">{t("branches.colCode")}</th>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground">{t("branches.colBranch")}</th>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground hidden sm:table-cell">{t("branches.colRegion")}</th>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground hidden md:table-cell">{t("branches.colCity")}</th>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground hidden lg:table-cell">{t("branches.colPhone")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-20">{t("branches.colMain")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-24">{t("branches.colStatus")}</th>
              <th className="px-4 py-3 text-start font-semibold text-muted-foreground w-24">{t("branches.colActions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? (
                <tr>
                  <td colSpan={8} className="py-14 text-center text-muted-foreground">
                    <Building2 className="h-10 w-10 mx-auto mb-3 opacity-20" />
                    <p className="font-medium">{regionFilter ? t("branches.noBranchesInRegion") : t("branches.noBranches")}</p>
                    <Button size="sm" className="mt-4 gap-1" onClick={() => { reset(); setShowForm(true); }}><Plus className="h-4 w-4" />{t("branches.addBranch")}</Button>
                  </td>
                </tr>
              )
              : filtered.map((b: any) => {
                  const st  = STATUS_CFG[b.status] ?? STATUS_CFG.active;
                  const rgn = b.regionId ? regionMap[b.regionId] : null;
                  return (
                    <tr key={b.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3"><span className="font-mono text-xs bg-muted px-2 py-0.5 rounded font-medium">{b.code}</span></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {b.isMain && <Star className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
                          <div>
                            <p className="font-medium">{b.nameAr}</p>
                            {b.nameEn && <p className="text-xs text-muted-foreground">{b.nameEn}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        {rgn
                          ? <span className="flex items-center gap-1 text-xs text-blue-700 bg-blue-50 rounded-full px-2 py-0.5 w-fit border border-blue-200"><MapPin className="h-3 w-3" />{rgn.nameAr}</span>
                          : <span className="text-muted-foreground/40 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-sm">{b.city ?? "—"}</td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {b.phone ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><Phone className="h-3 w-3" />{b.phone}</span> : <span className="text-muted-foreground/40 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {b.isMain ? <CheckCircle2 className="h-4 w-4 text-amber-500 mx-auto" /> : <span className="text-muted-foreground/20 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={cn("text-[10px] font-medium rounded-full px-2.5 py-0.5 border", st.cls)}>{st.label}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-primary/10 hover:text-primary" onClick={() => handleEdit(b)}><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => { if (confirm(t("branches.confirmDelete", { name: b.nameAr }))) deleteMut.mutate(b.id); }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && (
          <div className="px-4 py-2 border-t bg-muted/20 flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("branches.branchCount", { count: filtered.length })}</span>
            {regionFilter && (
              <button onClick={() => setRegionFilter("")} className="flex items-center gap-1 hover:text-foreground transition-colors">
                <X className="h-3 w-3" />{t("branches.clearRegionFilter")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
