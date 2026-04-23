import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, Search, Truck, Phone, Mail, MapPin, BadgeCheck, Building2, Package,
  Pencil, Trash2, TrendingUp, TrendingDown, Minus,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import ExportButtons from "@/components/ExportButtons";
import { FormPanel } from "@/components/FormPanel";
import { AccountCombobox } from "@/components/AccountCombobox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const buildSupplierExportCols = (t: (k: string) => string) => [
  { key: "nameAr",     header: t("pages.suppliers.nameArHeader"),    width: 28 },
  { key: "nameEn",     header: t("pages.suppliers.nameEnHeader"),    width: 28 },
  { key: "vatNumber",  header: t("pages.suppliers.vatNumberHeader"), width: 20 },
  { key: "crNumber",   header: t("pages.suppliers.crNumberHeader"),  width: 18 },
  { key: "phone",      header: t("pages.suppliers.phoneHeader"),     width: 18 },
  { key: "email",      header: t("pages.suppliers.emailHeader"),     width: 28 },
  { key: "city",       header: t("pages.suppliers.cityHeader"),      width: 16 },
  { key: "balance",    header: t("common.balance"),                  width: 16 },
];

const buildTypeTabs = (t: (k: string) => string) => [
  { key: "all",     label: t("common.all") },
  { key: "withVat", label: t("pages.suppliers.taxRegistered") },
  { key: "noVat",   label: t("pages.suppliers.notRegistered") },
];

const EMPTY_FORM = {
  code: "",
  nameAr: "", nameEn: "", vatNumber: "", crNumber: "",
  email: "", phone: "", city: "", district: "",
  street: "", buildingNumber: "", postalCode: "", country: "SA",
  accountId: "" as string,
};

export default function Suppliers() {
  const { user, token } = useAuth();
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const SUPPLIER_EXPORT_COLS = buildSupplierExportCols(t);
  const TYPE_TABS = buildTypeTabs(t);

  const [search,    setSearch]    = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [editSup,   setEditSup]   = useState<any>(null);
  const [editForm,  setEditForm]  = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [deleteSup, setDeleteSup] = useState<any>(null);

  const headers = { Authorization: `Bearer ${token}` };

  const { data: suppliers = [], isLoading } = useQuery({
    queryKey: ["suppliers", user?.companyId],
    queryFn: async () => {
      const url = user?.companyId
        ? `${API}/api/suppliers?companyId=${user.companyId}`
        : `${API}/api/suppliers`;
      const res = await fetch(url, { headers });
      return res.json();
    },
    enabled: !!user,
  });

  const { data: balances = [] } = useQuery({
    queryKey: ["supplier-balances", user?.companyId],
    queryFn: async () => {
      const res = await fetch(
        `${API}/api/suppliers/balances?companyId=${user!.companyId}`,
        { headers }
      );
      return res.json();
    },
    enabled: !!user?.companyId,
  });

  const balanceMap: Record<number, number> = Object.fromEntries(
    (balances as any[]).map((b: any) => [b.supplierId, b.balance])
  );

  const filtered = suppliers.filter((s: any) => {
    const matchSearch =
      s.nameAr?.includes(search) ||
      s.nameEn?.toLowerCase().includes(search.toLowerCase()) ||
      s.vatNumber?.includes(search) ||
      s.city?.includes(search) ||
      s.email?.includes(search);
    const matchTab =
      activeTab === "all" ||
      (activeTab === "withVat" && s.vatNumber) ||
      (activeTab === "noVat"   && !s.vatNumber);
    return matchSearch && matchTab;
  });

  const withVat = suppliers.filter((s: any) => s.vatNumber).length;

  function openEdit(sup: any) {
    setEditSup(sup);
    setEditForm({
      code:           sup.code           ?? "",
      nameAr:         sup.nameAr         ?? "",
      nameEn:         sup.nameEn         ?? "",
      vatNumber:      sup.vatNumber      ?? "",
      crNumber:       sup.crNumber       ?? "",
      email:          sup.email          ?? "",
      phone:          sup.phone          ?? "",
      city:           sup.city           ?? "",
      district:       sup.district       ?? "",
      street:         sup.street         ?? "",
      buildingNumber: sup.buildingNumber ?? "",
      postalCode:     sup.postalCode     ?? "",
      country:        sup.country        ?? "SA",
      accountId:      sup.accountId      ? String(sup.accountId) : "",
    });
  }

  const updateMutation = useMutation({
    mutationFn: async (values: typeof EMPTY_FORM) => {
      const res = await fetch(`${API}/api/suppliers/${editSup.id}`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const txt = await res.text();
        let msg = txt;
        try { msg = JSON.parse(txt).error ?? txt; } catch {}
        throw new Error(msg || t("pages.suppliers.updateFailed"));
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: t("pages.suppliers.updateSuccess") });
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      setEditSup(null);
    },
    onError: (e: any) => toast({ title: t("pages.suppliers.updateError"), description: e?.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API}/api/suppliers/${id}`, {
        method: "DELETE", headers,
      });
      if (!res.ok) throw new Error(t("pages.suppliers.deleteFailed"));
    },
    onSuccess: () => {
      toast({ title: t("pages.suppliers.deleteSuccess") });
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["supplier-balances"] });
      setDeleteSup(null);
    },
    onError: () => toast({ title: t("pages.suppliers.deleteErrorRelated"), variant: "destructive" }),
  });

  function BalanceBadge({ supplierId }: { supplierId: number }) {
    const bal = balanceMap[supplierId] ?? 0;
    if (bal === 0) return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="h-3 w-3" />—
      </span>
    );
    if (bal > 0) return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200 whitespace-nowrap" dir="ltr">
        <TrendingUp className="h-3 w-3 shrink-0" />
        {bal.toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t("pages.suppliers.creditor")}
      </span>
    );
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full border border-green-200 whitespace-nowrap" dir="ltr">
        <TrendingDown className="h-3 w-3 shrink-0" />
        {Math.abs(bal).toLocaleString("ar-SA-u-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t("pages.suppliers.debtor")}
      </span>
    );
  }

  function Field({ label, name, placeholder, dir: d }: { label: string; name: keyof typeof EMPTY_FORM; placeholder?: string; dir?: string }) {
    return (
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{label}</label>
        <Input
          placeholder={placeholder}
          dir={d}
          className={d === "ltr" ? "text-left font-mono" : undefined}
          value={(editForm as any)[name]}
          onChange={e => setEditForm(f => ({ ...f, [name]: e.target.value }))}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Truck className="h-6 w-6 text-primary" />{t("pages.suppliers.title")}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">{t("pages.suppliers.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons
            rows={filtered.map((s: any) => ({
              nameAr:     s.nameAr     ?? "",
              nameEn:     s.nameEn     ?? "",
              vatNumber:  s.vatNumber  ?? "",
              crNumber:   s.crNumber   ?? "",
              phone:      s.phone      ?? "",
              email:      s.email      ?? "",
              city:       s.city       ?? "",
              balance:    (balanceMap[s.id] ?? 0).toFixed(2),
            }))}
            columns={SUPPLIER_EXPORT_COLS}
            filename={`${t("pages.suppliers.title")}-${new Date().toISOString().slice(0, 10)}`}
            title={t("pages.suppliers.exportTitle")}
            subtitle={`${t("pages.suppliers.eInvoiceSystem")} — ${new Date().toLocaleDateString("ar-SA-u-nu-latn")}`}
          />
          <Button asChild className="gap-2">
            <Link href="/suppliers/new"><Plus className="h-4 w-4" />{t("common.add")} {t("pages.suppliers.supplier")}</Link>
          </Button>
        </div>
      </div>

      {editSup && (
        <FormPanel
          icon={Truck}
          title={editSup?.nameAr ?? t("pages.suppliers.editSupplier")}
          subtitle={t("pages.suppliers.editSubtitle")}
          width="4xl"
          onClose={() => setEditSup(null)}
          onSave={() => updateMutation.mutate(editForm)}
          saving={updateMutation.isPending}
          saveDisabled={!editForm.nameAr.trim()}
          saveLabel={t("pages.suppliers.saveChanges")}
        >
          <div className="space-y-6">
            <div className="space-y-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 border-b pb-2"><Truck className="h-3.5 w-3.5" />{t("pages.suppliers.commercialIdentity")}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
                <Field label="رقم المورد" name="code" placeholder="SUP-001" dir="ltr" />
                <Field label={`${t("pages.suppliers.supplierNameAr")} *`} name="nameAr" placeholder={t("pages.suppliers.supplierNameArPlaceholder")} />
                <div className="md:col-span-2"><Field label={t("pages.suppliers.nameEnLabel")} name="nameEn" placeholder={t("pages.suppliers.nameEnPlaceholder")} dir="ltr" /></div>
                <Field label={t("pages.suppliers.vatNumberLabel")} name="vatNumber" placeholder="310000000000003" dir="ltr" />
                <Field label={t("pages.suppliers.crNumberLabel")} name="crNumber" placeholder="1010000001" dir="ltr" />
                <Field label={t("pages.suppliers.emailLabel")} name="email" placeholder="info@supplier.com" dir="ltr" />
                <Field label={t("pages.suppliers.phoneLabel")} name="phone" placeholder="0500000000" dir="ltr" />
              </div>
            </div>
            <div className="space-y-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 border-b pb-2"><MapPin className="h-3.5 w-3.5" />{t("pages.suppliers.nationalAddress")}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
                <Field label={t("pages.suppliers.streetName")} name="street" placeholder={t("pages.suppliers.streetPlaceholder")} />
                <Field label={t("pages.suppliers.buildingNumber")} name="buildingNumber" placeholder="1234" dir="ltr" />
                <Field label={t("pages.suppliers.district")} name="district" placeholder={t("pages.suppliers.districtPlaceholder")} />
                <Field label={t("pages.suppliers.cityLabel")} name="city" placeholder={t("pages.suppliers.cityPlaceholder")} />
                <Field label={t("pages.suppliers.postalCode")} name="postalCode" placeholder="12345" dir="ltr" />
              </div>
            </div>
            <div className="space-y-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 border-b pb-2">{t("pages.suppliers.accountingLink")}</p>
              <div className="max-w-sm space-y-1.5">
                <label className="text-sm font-medium">حساب الدائنين (المورد)</label>
                <AccountCombobox
                  value={editForm.accountId}
                  onValueChange={(v) => setEditForm(f => ({ ...f, accountId: v }))}
                  placeholder={`— ${t("pages.suppliers.selectAccountsPayable")} —`}
                  filterTypes={["liability"]}
                  grouped={false}
                />
                <p className="text-xs text-muted-foreground">{t("pages.suppliers.accountingLinkHelp")}</p>
              </div>
            </div>
          </div>
        </FormPanel>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Truck className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? "—" : suppliers.length}</p>
            <p className="text-xs text-muted-foreground">{t("pages.suppliers.totalSuppliers")}</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-green-100 flex items-center justify-center shrink-0">
            <BadgeCheck className="h-5 w-5 text-green-600" />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? "—" : withVat}</p>
            <p className="text-xs text-muted-foreground">{t("pages.suppliers.taxRegistered")}</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
            <Package className="h-5 w-5 text-amber-600" />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? "—" : suppliers.length - withVat}</p>
            <p className="text-xs text-muted-foreground">{t("pages.suppliers.notRegistered")}</p>
          </div>
        </div>
      </div>

      {/* Table card */}
      <div className="rounded-xl border bg-card overflow-hidden">
        {/* Tabs + Search */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b">
          <div className="flex overflow-x-auto">
            {TYPE_TABS.map(tab => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={`px-5 py-3.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
                  activeTab === tab.key
                    ? "border-primary text-primary bg-primary/5"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40"
                }`}>
                {tab.label}
                {!isLoading && (
                  <span className="mr-1.5 text-xs bg-muted px-1.5 py-0.5 rounded-full">
                    {tab.key === "all" ? suppliers.length : tab.key === "withVat" ? withVat : suppliers.length - withVat}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="relative px-4 py-3">
            <Search className="absolute right-7 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder={t("pages.suppliers.searchPlaceholder")}
              className="pl-4 pr-10 w-full sm:w-64 h-9"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">{t("pages.suppliers.supplier")}</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden sm:table-cell">{t("pages.suppliers.vatNumberLabel")}</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden md:table-cell">{t("pages.suppliers.cityLabel")}</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden lg:table-cell">{t("pages.suppliers.phoneEmail")}</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden md:table-cell">{t("pages.suppliers.category")}</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">{t("pages.suppliers.taxStatus")}</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden sm:table-cell">{t("common.balance")}</th>
                <th className="h-10 px-4 text-center font-medium text-muted-foreground text-xs tracking-wide w-20">{t("pages.suppliers.action")}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b">
                    {Array.from({ length: 8 }).map((_, j) => (
                      <td key={j} className="px-5 py-4"><Skeleton className="h-4 w-full max-w-32" /></td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-16 text-center text-muted-foreground">
                    <Truck className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">{search ? t("common.noResults") : t("pages.suppliers.noSuppliersYet")}</p>
                    {!search && (
                      <Button asChild variant="outline" size="sm" className="mt-4 gap-2">
                        <Link href="/suppliers/new"><Plus className="h-3.5 w-3.5" />{t("common.add")} {t("pages.suppliers.supplier")}</Link>
                      </Button>
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((supplier: any) => (
                  <tr key={supplier.id}
                    className="border-b transition-colors hover:bg-muted/30 cursor-pointer group">
                    {/* Name — double-click to edit */}
                    <td className="px-5 py-3.5"
                      onDoubleClick={() => openEdit(supplier)}
                      title={t("pages.suppliers.doubleClickEdit")}>
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0">
                          {supplier.nameAr?.[0] ?? "م"}
                        </div>
                        <div>
                          <p className="font-medium text-foreground group-hover:text-primary transition-colors">
                            {supplier.nameAr}
                          </p>
                          {supplier.nameEn && <p className="text-xs text-muted-foreground">{supplier.nameEn}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 hidden sm:table-cell">
                      {supplier.vatNumber
                        ? <span className="font-mono text-xs text-foreground flex items-center gap-1"><BadgeCheck className="h-3.5 w-3.5 text-green-600" />{supplier.vatNumber}</span>
                        : <span className="text-muted-foreground/50 text-xs">—</span>}
                    </td>
                    <td className="px-5 py-3.5 hidden md:table-cell text-sm text-muted-foreground">
                      {supplier.city
                        ? <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5 shrink-0" />{supplier.city}</span>
                        : "—"}
                    </td>
                    <td className="px-5 py-3.5 hidden lg:table-cell">
                      <div className="space-y-0.5">
                        {supplier.phone && <p className="text-xs text-muted-foreground flex items-center gap-1" dir="ltr"><Phone className="h-3 w-3" />{supplier.phone}</p>}
                        {supplier.email && <p className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="h-3 w-3" />{supplier.email}</p>}
                        {!supplier.phone && !supplier.email && <span className="text-muted-foreground/50 text-xs">—</span>}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 hidden md:table-cell text-xs text-muted-foreground">
                      {supplier.category || "—"}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
                        supplier.vatNumber
                          ? "bg-green-50 text-green-700 border-green-200"
                          : "bg-amber-50 text-amber-700 border-amber-200"
                      }`}>
                        {supplier.vatNumber
                          ? <><BadgeCheck className="h-3 w-3" />{t("pages.suppliers.registered")}</>
                          : <><Building2 className="h-3 w-3" />{t("pages.suppliers.notRegisteredBadge")}</>}
                      </span>
                    </td>
                    {/* Balance column */}
                    <td className="px-5 py-3.5 hidden sm:table-cell">
                      <BalanceBadge supplierId={supplier.id} />
                    </td>
                    {/* Actions */}
                    <td className="px-4 py-3.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={e => { e.stopPropagation(); openEdit(supplier); }}
                          className="p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                          title={t("common.edit")}>
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setDeleteSup(supplier); }}
                          className="p-1.5 rounded-md hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"
                          title={t("common.delete")}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-5 py-2.5 text-xs text-muted-foreground">
            {t("pages.suppliers.resultsCount")}: <strong>{filtered.length}</strong>
          </div>
        )}
      </div>


      {/* ────────── Delete Confirm ────────── */}
      <AlertDialog open={!!deleteSup} onOpenChange={open => { if (!open) setDeleteSup(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />{t("common.delete")} {t("pages.suppliers.supplier")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.suppliers.deleteConfirm")} <strong>{deleteSup?.nameAr}</strong>؟
              {t("pages.suppliers.deleteWarning")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteMutation.mutate(deleteSup.id)}
              disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? t("pages.suppliers.deleting") : t("pages.suppliers.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
