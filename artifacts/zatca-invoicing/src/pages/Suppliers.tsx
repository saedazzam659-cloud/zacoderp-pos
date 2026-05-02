import { useTranslation } from "react-i18next";
import { useState, useMemo, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, Search, Truck, Phone, Mail, MapPin, BadgeCheck, Building2, Package,
  Pencil, Trash2, TrendingUp, TrendingDown, Minus,
  FileSpreadsheet, X,
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
import { cn } from "@/lib/utils";
import {
  rowToneFor, SEL_TONE, DocColorLegend, buildToneTooltip, DICT_TONES, type LegendItem,
} from "@/lib/docRowTone";
import { downloadCsv, matchCol, useAuditGridLayout, useColumnResize } from "@/lib/auditGridLayout";
import {
  AuditGridBulkBar, AuditGridPagination, ColumnReorderPopover,
  FooterColorPicker, HeaderColorPicker, HeaderSelectCheckbox, RowSelectCheckbox,
} from "@/components/auditGrid/AuditGridControls";

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
  const [creating,  setCreating]  = useState(false);
  const [editForm,  setEditForm]  = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [deleteSup, setDeleteSup] = useState<any>(null);

  function openCreate() {
    setCreating(true);
    setEditSup(null);
    setEditForm(EMPTY_FORM);
  }
  function closePanel() {
    setCreating(false);
    setEditSup(null);
  }

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

  const filteredBySearch = suppliers.filter((s: any) => {
    const matchSearch =
      !search ||
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
  const cid = (user?.role === "superadmin" ? undefined : user?.companyId) ?? undefined;

  // ── Audit-grid layout ──
  type ColType = "text" | "num" | "none";
  interface ColDef { key: string; label: string; type: ColType; valueOf: (r: any) => string | number }
  const COLUMNS: ColDef[] = useMemo(() => [
    { key: "_sel",     label: "",                                  type: "none", valueOf: () => "" },
    { key: "_idx",     label: "#",                                 type: "none", valueOf: () => "" },
    { key: "name",     label: t("pages.suppliers.supplier"),       type: "text", valueOf: (s) => `${s.nameAr ?? ""} ${s.nameEn ?? ""}`.trim() },
    { key: "vat",      label: t("pages.suppliers.vatNumberLabel"), type: "text", valueOf: (s) => s.vatNumber ?? "" },
    { key: "cr",       label: t("pages.suppliers.crNumberLabel"),  type: "text", valueOf: (s) => s.crNumber ?? "" },
    { key: "city",     label: t("pages.suppliers.cityLabel"),      type: "text", valueOf: (s) => s.city ?? "" },
    { key: "phone",    label: t("pages.suppliers.phoneLabel"),     type: "text", valueOf: (s) => s.phone ?? "" },
    { key: "email",    label: t("pages.suppliers.emailLabel"),     type: "text", valueOf: (s) => s.email ?? "" },
    { key: "category", label: t("pages.suppliers.category"),       type: "text", valueOf: (s) => s.category ?? "" },
    { key: "tax",      label: t("pages.suppliers.taxStatus"),      type: "text", valueOf: (s) => s.vatNumber ? t("pages.suppliers.registered") : t("pages.suppliers.notRegisteredBadge") },
    { key: "balance",  label: t("common.balance"),                 type: "num",  valueOf: (s) => Number(balanceMap[s.id] ?? 0) },
    { key: "_act",     label: t("pages.suppliers.action"),         type: "none", valueOf: () => "" },
  ], [t, balanceMap]);
  const dataKeys = useMemo(() => COLUMNS.filter(c => !["_sel","_idx","_act"].includes(c.key)).map(c => c.key), [COLUMNS]);
  const allColKeys = useMemo(() => COLUMNS.map(c => c.key), [COLUMNS]);
  const layout = useAuditGridLayout({ screenSlug: "suppliers", cid, dataKeys, allColKeys });
  const { tableRef, gripProps } = useColumnResize(layout.setColWidths);
  const { theme, colWidths, colFilters, setColFilter, clearColFilters,
          isSelected, toggleRow, toggleAll, isAllSelected, isSomeSelected, clearSelection,
          pageSize, page, setPage } = layout;

  const filtered = useMemo(() => filteredBySearch.filter((s: any) => {
    for (const col of COLUMNS) {
      const f = colFilters[col.key];
      if (!f) continue;
      if (!matchCol(col.valueOf(s), f, col.type)) return false;
    }
    return true;
  }), [filteredBySearch, colFilters, COLUMNS]);

  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (safePage !== page) setPage(safePage); }, [safePage, page, setPage]);
  const paged = useMemo(() => pageSize === 0 ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize), [filtered, pageSize, safePage]);
  const pageStart = filtered.length === 0 ? 0 : pageSize === 0 ? 1 : (safePage - 1) * pageSize + 1;
  const pageEnd = pageSize === 0 ? filtered.length : Math.min(safePage * pageSize, filtered.length);

  const visibleColumns = useMemo(() => {
    const dataCols = layout.dataOrder.map(k => COLUMNS.find(c => c.key === k)).filter((c): c is ColDef => !!c);
    const sel = COLUMNS.find(c => c.key === "_sel")!;
    const idx = COLUMNS.find(c => c.key === "_idx")!;
    const act = COLUMNS.find(c => c.key === "_act")!;
    return [sel, idx, ...dataCols, act];
  }, [layout.dataOrder, COLUMNS]);
  const reorderableCols = useMemo(() => layout.dataOrder
    .map(k => COLUMNS.find(c => c.key === k)!)
    .map(c => ({ key: c.key, label: c.label })), [layout.dataOrder, COLUMNS]);
  const allFilteredIds = useMemo(() => filtered.map((s: any) => s.id as number), [filtered]);

  function exportCsv() {
    if (filtered.length === 0) {
      toast({ title: t("common.noResults"), variant: "destructive" });
      return;
    }
    const exportable = visibleColumns.filter(c => !["_sel","_idx","_act"].includes(c.key));
    const header = ["#", ...exportable.map(c => c.label)];
    const rows = filtered.map((s: any, i: number) => [
      i + 1,
      ...exportable.map(col => {
        const v = col.valueOf(s);
        return col.type === "num" ? Number(v).toFixed(2) : String(v ?? "");
      }),
    ]);
    downloadCsv(`suppliers-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  }

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

  const createMutation = useMutation({
    mutationFn: async (values: typeof EMPTY_FORM) => {
      const payload = {
        ...values,
        companyId: user?.companyId,
        accountId: values.accountId ? Number(values.accountId) : null,
      };
      const res = await fetch(`${API}/api/suppliers`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
      toast({ title: t("pages.suppliers.addSuccess", "تم إضافة المورد") });
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["supplier-balances"] });
      setCreating(false);
      setEditForm(EMPTY_FORM);
    },
    onError: (e: any) => toast({ title: t("pages.suppliers.addError", "تعذّر إضافة المورد"), description: e?.message, variant: "destructive" }),
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
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" />{t("common.add")} {t("pages.suppliers.supplier")}
          </Button>
        </div>
      </div>

      {(editSup || creating) && (
        <FormPanel
          icon={Truck}
          title={editSup
            ? (editSup.nameAr ?? t("pages.suppliers.editSupplier"))
            : t("pages.suppliers.newSupplier", "مورد جديد")}
          subtitle={editSup
            ? t("pages.suppliers.editSubtitle")
            : t("pages.suppliers.addSubtitle", "أدخل بيانات المورد الجديد")}
          width="4xl"
          onClose={closePanel}
          onSave={() => editSup
            ? updateMutation.mutate(editForm)
            : createMutation.mutate(editForm)}
          saving={updateMutation.isPending || createMutation.isPending}
          saveDisabled={!editForm.nameAr.trim()}
          saveLabel={editSup
            ? t("pages.suppliers.saveChanges")
            : t("common.save", "حفظ")}
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
        {/* Tabs (preserved) */}
        <div className="flex overflow-x-auto border-b">
          {TYPE_TABS.map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={`px-5 py-3 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
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

        {(() => {
          // AP balance is negative when we owe them; overLimit pre-empts "credit" so rows count once.
          const isOver = (s: any) => {
            const lim = Number(s.creditLimit ?? 0);
            const owed = Math.max(0, -Number(balanceMap[s.id] ?? 0));
            return lim > 0 && owed > lim;
          };
          const items: LegendItem[] = [
            { kind: "active",    count: filtered.filter((s: any) => Number(balanceMap[s.id] ?? 0) === 0 && s.vatNumber).length,
              labelOverride: "مسجَّل ضريبياً بدون رصيد",
              hintOverride: "مورد لديه رقم تسجيل ضريبي ورصيده صفر — جاهز للتعامل" },
            { kind: "inactive",  count: filtered.filter((s: any) => Number(balanceMap[s.id] ?? 0) === 0 && !s.vatNumber).length,
              labelOverride: "غير مسجَّل بدون رصيد",
              hintOverride: "مورد بدون تسجيل ضريبي ورصيده صفر — لا تُخصم منه ضريبة مدخلات" },
            { kind: "debit",     count: filtered.filter((s: any) => Number(balanceMap[s.id] ?? 0) > 0).length,
              labelOverride: "مدين (دفعنا له زيادة)",
              hintOverride: "موردون لنا عليهم رصيد مدين — دفعنا أكثر من المستحق" },
            { kind: "credit",    count: filtered.filter((s: any) => Number(balanceMap[s.id] ?? 0) < 0 && !isOver(s)).length,
              labelOverride: "دائن (لنا عليهم)",
              hintOverride: "موردون لهم علينا رصيد دائن ضمن حد الائتمان الممنوح لنا" },
            { kind: "overLimit", count: filtered.filter(isOver).length,
              labelOverride: "تجاوز الائتمان",
              hintOverride: "تجاوزنا حدَّ الائتمان الممنوح لنا منه — يجب السداد قبل أي شراء جديد" },
          ];
          return <div className="px-4 pt-2"><DocColorLegend items={items} separatorAfter={[3]} /></div>;
        })()}

        {/* Audit-grid toolbar */}
        <div className={cn("border-t shadow-sm transition-colors", theme.border)}>
          <div className={cn("px-3 py-2 flex items-center gap-2 flex-wrap transition-colors", theme.bar, theme.text)} dir="rtl">
            <div className={cn("flex-1 text-sm font-bold tracking-wide flex items-center gap-2", theme.text)}>
              <Truck className="h-4 w-4 opacity-90" />
              {t("pages.suppliers.title")}
            </div>
            <div className="flex items-center gap-1.5">
              <HeaderColorPicker layout={layout} isRtl={true} />
              <FooterColorPicker layout={layout} isRtl={true} />
              <ColumnReorderPopover layout={layout} isRtl={true} columns={reorderableCols} />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={cn("h-7 px-2 text-xs gap-1", theme.btn)}
                onClick={exportCsv}
                data-testid="btn-export-csv-suppliers"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                CSV
              </Button>
            </div>
          </div>
          <div className="bg-slate-50 border-t border-slate-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs" dir="rtl">
            <div className="relative">
              <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t("pages.suppliers.searchPlaceholder")}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pe-7 h-7 text-xs w-64"
              />
            </div>
            {Object.values(colFilters).some(v => v) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50"
                onClick={clearColFilters}
              >
                <X className="h-3.5 w-3.5 me-1" />
                مسح فلاتر الأعمدة
              </Button>
            )}
            <div className="flex-1" />
            <span className="text-slate-700 font-medium">
              {filtered.length} {t("pages.suppliers.itemLabel", { defaultValue: "مورد" })}
              {filtered.length !== suppliers.length && <span className="text-slate-400"> / {suppliers.length}</span>}
            </span>
          </div>
          <AuditGridBulkBar count={layout.selected.size} onClear={clearSelection}>
            <span className="text-emerald-800">تم تحديد {layout.selected.size} مورد</span>
          </AuditGridBulkBar>
        </div>

        {/* Audit-grid table */}
        <div className="overflow-x-auto bg-white">
          <table ref={tableRef} className="w-full text-[11px] border-collapse" dir="rtl">
            <colgroup>
              {visibleColumns.map((col) => (
                <col
                  key={col.key}
                  data-col-key={col.key}
                  style={colWidths[col.key] ? { width: `${colWidths[col.key]}px` } : undefined}
                />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-gradient-to-b from-slate-100 to-slate-200 text-slate-700">
                {visibleColumns.map((col, idx) => (
                  <th
                    key={col.key}
                    data-col-key={col.key}
                    className={cn(
                      "relative px-2 py-1.5 text-right font-semibold border-e border-slate-300 select-none",
                      col.key === "_sel" && "w-9 text-center px-1",
                      col.key === "_idx" && "w-10 text-center px-1",
                      col.key === "_act" && "w-24 text-center",
                      col.type === "num" && "text-end",
                    )}
                  >
                    {col.key === "_sel" ? (
                      <HeaderSelectCheckbox
                        allSelected={isAllSelected(allFilteredIds)}
                        someSelected={isSomeSelected(allFilteredIds)}
                        onToggle={() => toggleAll(allFilteredIds)}
                        disabled={allFilteredIds.length === 0}
                      />
                    ) : (
                      <span className="inline-block truncate">{col.label}</span>
                    )}
                    {col.key !== "_sel" && (
                      <span
                        {...gripProps(col.key, idx)}
                        className="absolute inset-y-0 start-0 w-1 cursor-col-resize hover:bg-blue-400/40 active:bg-blue-500/60"
                      />
                    )}
                  </th>
                ))}
              </tr>
              <tr className="bg-amber-50/80 border-b border-amber-200">
                {visibleColumns.map((col) => (
                  <th key={col.key} className="px-1 py-1 border-e border-amber-200/60">
                    {col.type === "none" ? null : (
                      <Input
                        value={colFilters[col.key] ?? ""}
                        onChange={(e) => setColFilter(col.key, e.target.value)}
                        placeholder={col.type === "num" ? ">=N" : "فلتر…"}
                        className="h-6 text-[10px] px-1.5 bg-white"
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={visibleColumns.length} className="px-3 py-2"><Skeleton className="h-5 w-full" /></td>
                  </tr>
                ))
              ) : paged.length === 0 ? (
                <tr>
                  <td colSpan={visibleColumns.length} className="py-16 text-center text-muted-foreground">
                    <Truck className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">{search ? t("common.noResults") : t("pages.suppliers.noSuppliersYet")}</p>
                    {!search && (
                      <Button onClick={openCreate} variant="outline" size="sm" className="mt-4 gap-2">
                        <Plus className="h-3.5 w-3.5" />{t("common.add")} {t("pages.suppliers.supplier")}
                      </Button>
                    )}
                  </td>
                </tr>
              ) : (
                paged.map((supplier: any, rowIdx: number) => {
                  const bal = Number(balanceMap[supplier.id] ?? 0);
                  const limit = Number(supplier.creditLimit ?? 0);
                  const owed = Math.max(0, -bal);
                  const overLimit = limit > 0 && owed > limit;
                  const dictStatus = overLimit
                    ? "overLimit"
                    : bal > 0 ? "debit"
                    : bal < 0 ? "credit"
                    : supplier.vatNumber ? "active" : "inactive";
                  const overTooltip = overLimit
                    ? `تجاوز حد الائتمان (${owed.toLocaleString()} > ${limit.toLocaleString()})`
                    : "";
                  const sel = isSelected(supplier.id);
                  return (
                    <tr key={supplier.id}
                      data-status={dictStatus}
                      data-over-limit={overLimit ? "true" : undefined}
                      className={cn(
                        "border-b border-slate-200 transition-colors group",
                        sel ? SEL_TONE : rowToneFor({ status: dictStatus, statusMap: DICT_TONES }),
                      )}
                      title={overTooltip || buildToneTooltip({ status: dictStatus, statusMap: DICT_TONES })}
                    >
                      {visibleColumns.map((col) => {
                        if (col.key === "_sel") {
                          return (
                            <td key={col.key} className="px-1 py-1 text-center border-e border-slate-200/60">
                              <RowSelectCheckbox
                                checked={sel}
                                onToggle={() => toggleRow(supplier.id)}
                                ariaLabel={`تحديد ${supplier.nameAr ?? ""}`}
                              />
                            </td>
                          );
                        }
                        if (col.key === "_idx") {
                          return (
                            <td key={col.key} className="px-1 py-1 text-center text-slate-500 font-mono border-e border-slate-200/60">
                              {pageStart + rowIdx}
                            </td>
                          );
                        }
                        if (col.key === "name") {
                          return (
                            <td key={col.key} className="px-2 py-1 border-e border-slate-200/60"
                              onDoubleClick={() => openEdit(supplier)}
                              title={t("pages.suppliers.doubleClickEdit")}>
                              <div className="flex items-center gap-2">
                                <div className="h-7 w-7 rounded-lg bg-primary/10 text-primary font-bold text-xs flex items-center justify-center shrink-0">
                                  {supplier.nameAr?.[0] ?? "م"}
                                </div>
                                <div className="min-w-0">
                                  <p className="font-medium text-foreground group-hover:text-primary transition-colors truncate">{supplier.nameAr}</p>
                                  {supplier.nameEn && <p className="text-[10px] text-muted-foreground truncate">{supplier.nameEn}</p>}
                                </div>
                              </div>
                            </td>
                          );
                        }
                        if (col.key === "vat") {
                          return (
                            <td key={col.key} className="px-2 py-1 border-e border-slate-200/60">
                              {supplier.vatNumber
                                ? <span className="font-mono text-[10px] text-foreground inline-flex items-center gap-1"><BadgeCheck className="h-3 w-3 text-green-600" />{supplier.vatNumber}</span>
                                : <span className="text-muted-foreground/40">—</span>}
                            </td>
                          );
                        }
                        if (col.key === "cr") {
                          return (
                            <td key={col.key} className="px-2 py-1 font-mono text-[10px] text-muted-foreground border-e border-slate-200/60">
                              {supplier.crNumber || "—"}
                            </td>
                          );
                        }
                        if (col.key === "city") {
                          return (
                            <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60">
                              {supplier.city ? <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{supplier.city}</span> : "—"}
                            </td>
                          );
                        }
                        if (col.key === "phone") {
                          return (
                            <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60" dir="ltr">
                              {supplier.phone ? <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{supplier.phone}</span> : <span className="text-muted-foreground/40">—</span>}
                            </td>
                          );
                        }
                        if (col.key === "email") {
                          return (
                            <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60">
                              {supplier.email ? <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{supplier.email}</span> : <span className="text-muted-foreground/40">—</span>}
                            </td>
                          );
                        }
                        if (col.key === "category") {
                          return <td key={col.key} className="px-2 py-1 text-muted-foreground border-e border-slate-200/60">{supplier.category || "—"}</td>;
                        }
                        if (col.key === "tax") {
                          return (
                            <td key={col.key} className="px-2 py-1 border-e border-slate-200/60">
                              <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border",
                                supplier.vatNumber ? "bg-green-50 text-green-700 border-green-200" : "bg-amber-50 text-amber-700 border-amber-200")}>
                                {supplier.vatNumber
                                  ? <><BadgeCheck className="h-3 w-3" />{t("pages.suppliers.registered")}</>
                                  : <><Building2 className="h-3 w-3" />{t("pages.suppliers.notRegisteredBadge")}</>}
                              </span>
                            </td>
                          );
                        }
                        if (col.key === "balance") {
                          return (
                            <td key={col.key} className="px-2 py-1 tabular-nums text-end border-e border-slate-200/60">
                              <BalanceBadge supplierId={supplier.id} />
                            </td>
                          );
                        }
                        if (col.key === "_act") {
                          return (
                            <td key={col.key} className="px-1 py-1 text-center">
                              <div className="flex items-center justify-center gap-0.5">
                                <button
                                  onClick={e => { e.stopPropagation(); openEdit(supplier); }}
                                  className="p-1 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                                  title={t("common.edit")}>
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  onClick={e => { e.stopPropagation(); setDeleteSup(supplier); }}
                                  className="p-1 rounded-md hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"
                                  title={t("common.delete")}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </td>
                          );
                        }
                        return null;
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <AuditGridPagination
          layout={layout}
          totalRows={filtered.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          totalPages={totalPages}
          unitLabel={t("pages.suppliers.itemLabel", { defaultValue: "مورد" })}
        />
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
