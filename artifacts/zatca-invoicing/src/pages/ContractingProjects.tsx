import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Briefcase, Plus, Search, Pencil, Trash2, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { FormPanel } from "@/components/FormPanel";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { useCostCenters, type CostCenter } from "@/hooks/useCostCenters";
import { DateField } from "@/components/ui/date-field";
import { PROJECT_STATUS_LABEL, PROJECT_TYPE_LABEL, labelEnum } from "@/lib/contractingLabels";
import {
  ContractingProjectExportActions,
  ContractingProjectsReportExportActions,
} from "@/components/ContractingExportActions";
import type { ContractingProjectSnapshot } from "@/lib/contractingPrintExport";

const API = import.meta.env.VITE_API_URL || "";

type Project = {
  id: number; code: string; nameAr: string; nameEn: string | null;
  parentId: number | null;
  branchId: number | null;
  customerId: number | null;
  costCenterId: number | null;
  clientName: string | null; location: string | null; projectType: string;
  status: string; contractValue: string; plannedBudget: string; actualCost: string;
  plannedStartDate: string | null; plannedEndDate: string | null;
  progressPercent: string; description: string | null;
};
type ProjectBranch = { id: number; code: string; nameAr: string; nameEn: string | null; isActive?: boolean };
type IntegrityDiagnostics = {
  deferredValidation: boolean;
  offendingIds: Record<string, number[]>;
};

const STATUSES = ["draft", "study", "contract", "planning", "in_progress", "on_hold", "completed", "cancelled"] as const;
const TYPES = ["building", "road", "infrastructure", "renovation", "maintenance", "other"] as const;

const STATUS_LABEL = PROJECT_STATUS_LABEL;
const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary", in_progress: "default", on_hold: "outline",
  completed: "secondary", cancelled: "destructive",
};

const empty = (): Partial<Project> => ({
  code: "", nameAr: "", nameEn: "", parentId: null, branchId: null, customerId: null, costCenterId: null, clientName: "", location: "",
  projectType: "building", status: "draft", contractValue: "0",
  plannedBudget: "0", actualCost: "0", plannedStartDate: "", plannedEndDate: "",
  progressPercent: "0", description: "",
});

export default function ContractingProjects() {
  const { t } = useTranslation();
  const { token, user, actingCompanyId } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editing, setEditing] = useState<Partial<Project> | null>(null);
  // Peek the next project code from the central sequence engine when creating
  // a new project (i.e. editing exists but has no id yet).
  const isCreating = !!editing && (editing as any).id == null;
  const nextCode = useNextSequenceNumber("contracting_project", isCreating);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [customersError, setCustomersError] = useState<string | null>(null);
  const companyId = actingCompanyId ?? user?.companyId ?? user?.company?.id ?? null;
  const { data: costCenters = [], isLoading: costCentersLoading } = useCostCenters({
    companyId,
    includeInactive: true,
  });
  const [branches, setBranches] = useState<ProjectBranch[]>([]);
  const [projectOptions, setProjectOptions] = useState<Project[]>([]);
  const [integrityDiagnostics, setIntegrityDiagnostics] = useState<IntegrityDiagnostics | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const editingOpen = editing != null;
  const requestHeaders = useCallback((): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
  }), [token, actingCompanyId]);

  const loadBranches = useCallback(async () => {
    if (!token) return;
    setBranchesLoading(true);
    setBranchesError(null);
    try {
      const response = await fetch(`${API}/api/contracting/projects/options`, {
        headers: requestHeaders(),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      setBranches(Array.isArray(payload?.branches) ? payload.branches : []);
      setProjectOptions(Array.isArray(payload?.projects) ? payload.projects : []);
      setIntegrityDiagnostics(payload?.integrityDiagnostics?.deferredValidation
        ? payload.integrityDiagnostics
        : null);
    } catch (error: any) {
      setBranches([]);
      setProjectOptions([]);
      setIntegrityDiagnostics(null);
      setBranchesError(error?.message || t("contracting.projects.branchesLoadError", "تعذر تحميل الفروع"));
    } finally {
      setBranchesLoading(false);
    }
  }, [requestHeaders, t, token]);

  useEffect(() => { void loadBranches(); }, [loadBranches]);

  useEffect(() => {
    if (!editingOpen || !token || !companyId) {
      if (!editingOpen) {
        setCustomers([]);
        setCustomersError(null);
      }
      return;
    }
    let cancelled = false;
    setCustomersLoading(true);
    setCustomersError(null);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (actingCompanyId) headers["x-acting-company-id"] = String(actingCompanyId);
    const customerQuery = new URLSearchParams({ companyId: String(companyId) });
    if (editing?.branchId != null) customerQuery.set("branchId", String(editing.branchId));
    fetch(`${API}/api/customers?${customerQuery.toString()}`, { headers })
      .then(async r => {
        if (!r.ok) throw new Error(r.status === 403
          ? t("contracting.projects.customerPermission", "لا تملك صلاحية عرض العملاء")
          : `HTTP ${r.status}`);
        return r.json();
      })
      .then(rows => {
        if (!cancelled) setCustomers(Array.isArray(rows) ? rows : []);
      })
      .catch(error => {
        if (!cancelled) {
          setCustomers([]);
          setCustomersError(error?.message ?? t("common.errorOccurred", "حدث خطأ"));
        }
      })
      .finally(() => {
        if (!cancelled) setCustomersLoading(false);
      });
    return () => { cancelled = true; };
  }, [editingOpen, editing?.branchId, token, companyId, actingCompanyId, t]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (statusFilter !== "all") qs.set("status", statusFilter);
      if (search.trim()) qs.set("search", search.trim());
      const r = await fetch(`${API}/api/contracting/projects?${qs}`, {
        headers: requestHeaders(),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    } finally { setLoading(false); }
  }, [token, statusFilter, search, t, toast, requestHeaders]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!editing) return;
    if (!editing.nameAr?.trim()) {
      toast({ title: t("contracting.projects.nameRequired", "الاسم مطلوب"), variant: "destructive" });
      return;
    }
    if (isCreating && !editing.branchId) {
      toast({ title: t("contracting.projects.branchRequired", "الفرع مطلوب للمشروع الجديد"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const isEdit = (editing as any).id != null;
      const url = isEdit
        ? `${API}/api/contracting/projects/${(editing as any).id}`
        : `${API}/api/contracting/projects`;
      const method = isEdit ? "PUT" : "POST";
      const body = { ...editing };
      // strip empty date strings
      if (!body.plannedStartDate) delete body.plannedStartDate;
      if (!body.plannedEndDate)   delete body.plannedEndDate;
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...requestHeaders() },
        body: JSON.stringify(body),
      });
       if (!r.ok) {
         const payload = await r.json().catch(() => ({}));
         const error = new Error(payload?.error || `HTTP ${r.status}`) as Error & { status?: number };
         error.status = r.status;
         throw error;
       }
      toast({ title: isEdit
        ? t("contracting.projects.updated", "تم تحديث المشروع")
        : t("contracting.projects.created", "تم إنشاء المشروع") });
      setEditing(null);
      await load();
     } catch (e: any) {
       toast({
         title: e?.status === 409
           ? t("contracting.projects.branchChangeBlocked", "تعذر تغيير فرع المشروع")
           : t("common.errorOccurred", "حدث خطأ"),
         description: e?.message,
         variant: "destructive",
       });
    } finally { setSaving(false); }
  }

  async function doDelete() {
    if (!deleting) return;
    try {
      const r = await fetch(`${API}/api/contracting/projects/${deleting.id}`, {
        method: "DELETE",
        headers: requestHeaders(),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast({ title: t("contracting.projects.deleted", "تم حذف المشروع") });
      setDeleting(null);
      await load();
    } catch (e: any) {
      toast({ title: t("common.errorOccurred", "حدث خطأ"), description: e?.message, variant: "destructive" });
    }
  }

  const customerItems: ComboboxItem[] = useMemo(() => {
    const currentId = editing?.customerId == null ? null : Number(editing.customerId);
    const seen = new Set<number>();
    const items: ComboboxItem[] = [];
    for (const customer of customers) {
      const id = Number(customer?.id);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      const active = customer?.isActive !== false;
      items.push({
        value: String(id),
        label: customer?.nameAr || customer?.nameEn || `#${id}`,
        labelEn: customer?.nameEn || undefined,
        description: [customer?.vatNumber, customer?.phone].filter(Boolean).join(" · ") || undefined,
        disabled: !active && id !== currentId,
        disabledReason: !active ? t("contracting.projects.customerInactive", "العميل غير نشط") : undefined,
      });
    }
    // A project may retain a customer that is no longer returned by the
    // branch-scoped picker. Keep it visible as a disabled current value so
    // editing/saving does not silently unlink it.
    if (currentId != null && !seen.has(currentId)) {
      items.unshift({
        value: String(currentId),
        label: editing?.clientName || `#${currentId}`,
        disabled: true,
        disabledReason: t("contracting.projects.customerLinkedUnavailable", "العميل المرتبط الحالي غير متاح للاختيار"),
      });
    }
    return items;
  }, [customers, editing?.customerId, editing?.clientName, t]);

  const costCenterItems: ComboboxItem[] = useMemo(() => {
    const currentId = editing?.costCenterId == null ? null : Number(editing.costCenterId);
    const seen = new Set<number>();
    const items: ComboboxItem[] = [];
    for (const center of costCenters as CostCenter[]) {
      const id = Number(center.id);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      const active = center.isActive !== false;
      items.push({
        value: String(id),
        label: `${center.code} — ${center.nameAr || center.nameEn || `#${id}`}`,
        labelEn: center.nameEn || undefined,
        disabled: !active && id !== currentId,
        disabledReason: !active
          ? t("contracting.projects.costCenterInactive", "مركز التكلفة غير نشط")
          : undefined,
      });
    }
    if (currentId != null && !seen.has(currentId)) {
      items.unshift({
        value: String(currentId),
        label: `#${currentId}`,
        disabled: true,
        disabledReason: t("contracting.projects.costCenterUnavailable", "مركز التكلفة المرتبط الحالي غير متاح للاختيار"),
      });
    }
    return items;
  }, [costCenters, editing?.costCenterId, t]);

  const branchItems: ComboboxItem[] = useMemo(() => {
    const currentId = editing?.branchId == null ? null : Number(editing.branchId);
    const seen = new Set<number>();
    const items: ComboboxItem[] = [];
    for (const branch of branches) {
      const id = Number(branch.id);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      const active = branch.isActive !== false;
      // Inactive branches remain visible only when they are the historical
      // value of the record being edited; they cannot be selected for a new
      // project or used to move an existing project to an inactive branch.
      if (!active && id !== currentId) continue;
      items.push({
        value: String(id),
        label: `${branch.code} — ${branch.nameAr || branch.nameEn || `#${id}`}${!active ? ` (${t("contracting.projects.branchInactive", "غير نشط")})` : ""}`,
        labelEn: branch.nameEn || undefined,
        disabled: !active,
        disabledReason: !active ? t("contracting.projects.branchInactive", "الفرع غير نشط") : undefined,
      });
    }
    // Preserve a historical selection if it is no longer returned by the
    // authorized branch catalogue.
    if (currentId != null && !seen.has(currentId)) {
      items.unshift({
        value: String(currentId),
        label: `#${currentId} (${t("contracting.projects.branchUnavailable", "الفرع المرتبط الحالي غير متاح للاختيار")})`,
        disabled: true,
        disabledReason: t("contracting.projects.branchUnavailable", "الفرع المرتبط الحالي غير متاح للاختيار"),
      });
    }
    return items;
  }, [branches, editing?.branchId, t]);

  const parentItems: ComboboxItem[] = useMemo(() => {
    const editingId = Number((editing as any)?.id || 0);
    const descendants = new Set<number>();
    if (editingId) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const project of projectOptions) {
          if (project.parentId === editingId || (project.parentId != null && descendants.has(project.parentId))) {
            if (!descendants.has(project.id)) {
              descendants.add(project.id);
              changed = true;
            }
          }
        }
      }
    }
    return [
      { value: "__root__", label: t("contracting.projects.rootProject", "مشروع رئيسي (بدون مشروع أب)") },
      ...projectOptions
        .filter(project =>
          project.id !== editingId
          && !descendants.has(project.id)
          && (editing?.branchId == null || project.branchId === editing.branchId))
        .map(project => ({
          value: String(project.id),
          label: `${project.code} — ${project.nameAr}`,
        })),
    ];
  }, [editing, projectOptions, t]);

  const exportProjects: ContractingProjectSnapshot[] = rows.map(project => ({
    ...project,
    branchName: project.branchId == null
      ? null
      : branches.find(branch => branch.id === project.branchId)?.nameAr || `#${project.branchId}`,
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 p-2 text-white shadow">
          <Briefcase className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{t("contracting.projects.title", "مشاريع المقاولات")}</h1>
          <p className="text-sm text-slate-500">{t("contracting.projects.subtitle", "إدارة جميع المشاريع الإنشائية")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ContractingProjectsReportExportActions rows={exportProjects} />
          <Button onClick={() => setEditing(empty())}>
            <Plus className="h-4 w-4 mx-1" />
            {t("contracting.projects.new", "مشروع جديد")}
          </Button>
        </div>
      </div>

      {integrityDiagnostics?.deferredValidation && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100" data-testid="contracting-integrity-warning">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-bold">{t("contracting.projects.deferredIntegrityTitle", "توجد مستخلصات قديمة بلا عقد مرتبط")}</p>
              <p>
                {t("contracting.projects.deferredIntegrityHelp", "البيانات القديمة ما زالت متاحة للقراءة. افتح المستخلصات، وأنشئ أو اختر العقد الصحيح داخل مشروع المستخلص، ثم عدّل المستخلص واربطه بالعقد. لا تخمّن الربط.")}
              </p>
              <p className="font-mono text-xs">
                {Object.entries(integrityDiagnostics.offendingIds ?? {})
                  .filter(([, ids]) => Array.isArray(ids) && ids.length > 0)
                  .map(([kind, ids]) => `${kind}: ${ids.join(", ")}`)
                  .join(" · ")}
              </p>
              <Link href="/contracting/bills" className="inline-flex font-semibold text-amber-800 underline dark:text-amber-200">
                {t("contracting.projects.openBillsToRepair", "فتح المستخلصات لاختيار المشروع والعقد الصحيح")}
              </Link>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <FormPanel
          icon={Briefcase}
          title={(editing as any).id
            ? t("contracting.projects.edit", "تعديل المشروع")
            : t("contracting.projects.new", "مشروع جديد")}
          subtitle={t("contracting.projects.subtitle", "إدارة جميع المشاريع الإنشائية")}
          width="4xl"
          onClose={() => setEditing(null)}
          onSave={save}
          saving={saving}
           saveDisabled={!editing.nameAr?.trim() || (isCreating && !editing.branchId)}
        >
           <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-4">
            <Field label={t("contracting.projects.code", "الكود")}>
              <Input
                value={
                  isCreating
                    ? (nextCode.number ?? (nextCode.loading ? "..." : t("contracting.projects.autoCode", "تلقائي")))
                    : (editing.code ?? "")
                }
                readOnly
                disabled
                className="font-mono text-sm bg-muted/30"
                data-testid="input-project-code"
              />
            </Field>
            <Field label={t("contracting.projects.nameAr", "الاسم بالعربية")} required>
              <Input value={editing.nameAr ?? ""} onChange={e => setEditing({ ...editing, nameAr: e.target.value })} />
            </Field>
            <Field label={t("contracting.projects.nameEn", "الاسم بالإنجليزية")}>
              <Input value={editing.nameEn ?? ""} onChange={e => setEditing({ ...editing, nameEn: e.target.value })} />
            </Field>
            <Field label={t("contracting.projects.parentProject", "المشروع الأب")}>
              <SearchCombobox
                items={parentItems}
                value={editing.parentId == null ? "__root__" : String(editing.parentId)}
                onValueChange={value => setEditing({
                  ...editing,
                  parentId: value === "__root__" ? null : Number(value),
                })}
                placeholder={t("contracting.projects.rootProject", "مشروع رئيسي (بدون مشروع أب)")}
                searchPlaceholder={t("contracting.projects.parentSearch", "بحث بكود أو اسم المشروع...")}
                emptyText={t("contracting.projects.noParentProjects", "لا توجد مشاريع متاحة")}
                testId="project-parent-picker"
                openOnFocus={false}
              />
              <p className="text-[11px] text-muted-foreground">
                {t("contracting.projects.parentHint", "المشروع الفرعي يحتفظ بعقوده ومستخلصاته وتكاليفه بشكل مستقل.")}
              </p>
            </Field>
            <Field label={t("contracting.projects.branch", "الفرع")} required={isCreating}>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <SearchCombobox
                    className="flex-1"
                    items={branchItems}
                    value={editing.branchId == null ? "" : String(editing.branchId)}
                    onValueChange={value => {
                      const branchId = value ? Number(value) : null;
                      const changed = Number(editing.branchId ?? 0) !== Number(branchId ?? 0);
                      const selectedParent = projectOptions.find(project => project.id === editing.parentId);
                      setEditing({
                        ...editing,
                        branchId,
                        ...(changed
                          ? {
                              customerId: null,
                              clientName: "",
                              costCenterId: null,
                              ...(selectedParent && selectedParent.branchId !== branchId ? { parentId: null } : {}),
                            }
                          : {}),
                      });
                    }}
                    placeholder={isCreating
                      ? t("contracting.projects.branchPlaceholder", "اختر فرع المشروع")
                      : t("contracting.projects.branchOptionalPlaceholder", "بدون فرع")}
                    searchPlaceholder={t("contracting.projects.branchSearchPlaceholder", "بحث بكود أو اسم الفرع...")}
                    emptyText={branchesError
                      ? t("contracting.projects.branchUnavailable", "تعذر تحميل الفروع")
                      : t("contracting.projects.noBranches", "لا توجد فروع متاحة")}
                    disabled={branchesLoading || !!branchesError}
                    openOnFocus={false}
                    testId="project-branch-picker"
                  />
                  {!isCreating && editing.branchId != null && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title={t("contracting.projects.clearBranch", "إلغاء ربط الفرع")}
                      aria-label={t("contracting.projects.clearBranch", "إلغاء ربط الفرع")}
                      onClick={() => setEditing({
                        ...editing,
                        branchId: null,
                        customerId: null,
                        clientName: "",
                        costCenterId: null,
                      })}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {branchesLoading && <p className="text-[11px] text-muted-foreground">{t("contracting.projects.loadingBranches", "جارٍ تحميل الفروع...")}</p>}
                {branchesError && (
                  <div className="flex items-center justify-between gap-2 text-[11px] text-destructive">
                    <span>{t("contracting.projects.branchesLoadError", "تعذر تحميل الفروع")}</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => void loadBranches()}>{t("common.retry", "إعادة المحاولة")}</Button>
                  </div>
                )}
              </div>
            </Field>
            <Field label={t("contracting.projects.client", "العميل")}>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <SearchCombobox
                    className="flex-1"
                    items={customerItems}
                    value={editing.customerId == null ? "" : String(editing.customerId)}
                    onValueChange={value => {
                      const selected = customers.find(c => String(c?.id) === value);
                      if (!selected) return;
                      setEditing({
                        ...editing,
                        customerId: Number(value),
                        clientName: selected.nameAr || selected.nameEn || editing.clientName || "",
                      });
                    }}
                    placeholder={t("contracting.projects.customerPlaceholder", "اختر عميلاً من العملاء")}
                    searchPlaceholder={t("contracting.projects.customerSearchPlaceholder", "بحث باسم العميل أو الرقم...")}
                    emptyText={customersError
                      ? t("contracting.projects.customerUnavailable", "تعذر تحميل العملاء")
                      : t("contracting.projects.noCustomers", "لا توجد نتائج")}
                    disabled={customersLoading || !!customersError}
                    openOnFocus={false}
                    testId="project-customer-picker"
                  />
                  {editing.customerId != null && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title={t("contracting.projects.clearCustomer", "إلغاء ارتباط العميل")}
                      aria-label={t("contracting.projects.clearCustomer", "إلغاء ارتباط العميل")}
                      onClick={() => setEditing({ ...editing, customerId: null })}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {editing.customerId == null && editing.clientName && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("contracting.projects.legacyClientName", "اسم قديم غير مرتبط محفوظ كما هو:")}{" "}
                    <span className="font-medium">{editing.clientName}</span>
                  </p>
                )}
                {customersLoading && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("contracting.projects.loadingCustomers", "جارٍ تحميل العملاء...")}
                  </p>
                )}
                {customersError && (
                  <p className="text-[11px] text-destructive">{customersError}</p>
                )}
              </div>
            </Field>
            <Field label={t("contracting.projects.costCenter", "مركز التكلفة")}>
              <div className="flex items-center gap-2">
                <SearchCombobox
                  className="flex-1"
                  items={costCenterItems}
                  value={editing.costCenterId == null ? "" : String(editing.costCenterId)}
                  onValueChange={value => setEditing({
                    ...editing,
                    costCenterId: value ? Number(value) : null,
                  })}
                  placeholder={t("contracting.projects.costCenterPlaceholder", "بدون مركز تكلفة")}
                  searchPlaceholder={t("contracting.projects.costCenterSearchPlaceholder", "بحث بالكود أو الاسم...")}
                  emptyText={t("contracting.projects.noCostCenters", "لا توجد مراكز تكلفة")}
                  disabled={costCentersLoading}
                  openOnFocus={false}
                  testId="project-cost-center-picker"
                />
                {editing.costCenterId != null && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    title={t("contracting.projects.clearCostCenter", "إلغاء ارتباط مركز التكلفة")}
                    aria-label={t("contracting.projects.clearCostCenter", "إلغاء ارتباط مركز التكلفة")}
                    onClick={() => setEditing({ ...editing, costCenterId: null })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </Field>
            <Field label={t("contracting.projects.location", "الموقع")}>
              <Input value={editing.location ?? ""} onChange={e => setEditing({ ...editing, location: e.target.value })} />
            </Field>
            <Field label={t("contracting.projects.type", "نوع المشروع")}>
              <SearchCombobox
                items={TYPES.map(ty => ({ value: ty, label: labelEnum(PROJECT_TYPE_LABEL, ty) }))}
                value={editing.projectType ?? "building"}
                onValueChange={projectType => setEditing({ ...editing, projectType })}
                placeholder={t("contracting.projects.typePlaceholder", "اختر نوع المشروع")}
                searchPlaceholder={t("contracting.projects.typeSearchPlaceholder", "بحث في أنواع المشاريع...")}
                testId="project-type-picker"
                openOnFocus={false}
              />
            </Field>
            <Field label={t("contracting.projects.status", "الحالة")}>
              <SearchCombobox
                items={STATUSES.map(s => ({ value: s, label: STATUS_LABEL[s] }))}
                value={editing.status ?? "draft"}
                onValueChange={status => setEditing({ ...editing, status })}
                placeholder={t("contracting.projects.statusPlaceholder", "اختر الحالة")}
                searchPlaceholder={t("contracting.projects.statusSearchPlaceholder", "بحث في الحالات...")}
                testId="project-status-picker"
                openOnFocus={false}
              />
            </Field>
            <Field label={t("contracting.projects.contractValue", "قيمة العقد (ر.س)")}>
              <Input type="number" value={editing.contractValue ?? "0"}
                onChange={e => setEditing({ ...editing, contractValue: e.target.value })} />
            </Field>
            <Field label={t("contracting.projects.plannedBudget", "الميزانية المخططة (ر.س)")}>
              <Input type="number" value={editing.plannedBudget ?? "0"}
                onChange={e => setEditing({ ...editing, plannedBudget: e.target.value })} />
            </Field>
            <Field label={t("contracting.projects.plannedStartDate", "تاريخ البداية المخطط")}>
              <DateField value={editing.plannedStartDate ?? ""}
                onChange={e => setEditing({ ...editing, plannedStartDate: e.target.value })} />
            </Field>
            <Field label={t("contracting.projects.plannedEndDate", "تاريخ النهاية المخطط")}>
              <DateField value={editing.plannedEndDate ?? ""}
                onChange={e => setEditing({ ...editing, plannedEndDate: e.target.value })} />
            </Field>
            <Field label={t("contracting.projects.progress", "نسبة الإنجاز %")}>
              <Input type="number" min={0} max={100} value={editing.progressPercent ?? "0"}
                onChange={e => setEditing({ ...editing, progressPercent: e.target.value })} />
            </Field>
            <div className="md:col-span-2">
              <Field label={t("contracting.projects.description", "الوصف")}>
                <Input value={editing.description ?? ""} onChange={e => setEditing({ ...editing, description: e.target.value })} />
              </Field>
            </div>
          </div>
        </FormPanel>
      )}

      <div className="rounded-lg border bg-white dark:bg-slate-900 p-3 flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute end-2 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            placeholder={t("contracting.projects.searchPlaceholder", "بحث بالاسم/الكود/الموقع…")}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <SearchCombobox
          className="w-[180px]"
          items={[
            { value: "all", label: t("contracting.projects.allStatuses", "كل الحالات") },
            ...STATUSES.map(s => ({ value: s, label: STATUS_LABEL[s] })),
          ]}
          value={statusFilter}
          onValueChange={setStatusFilter}
          placeholder={t("contracting.projects.allStatuses", "كل الحالات")}
          searchPlaceholder={t("contracting.projects.statusSearchPlaceholder", "بحث في الحالات...")}
          testId="project-status-filter"
          openOnFocus={false}
        />
      </div>

      {/* Mobile cards (md-hidden) */}
      <div className="md:hidden space-y-3">
        {loading && rows.length === 0 && <Skeleton className="h-32 w-full" />}
        {!loading && rows.length === 0 && (
          <div className="text-center py-8 text-sm text-slate-500">{t("contracting.projects.empty", "لا توجد مشاريع — اضغط «مشروع جديد» للبدء")}</div>
        )}
        {rows.map(p => (
          <div key={p.id} className="rounded-2xl bg-white border border-amber-100 shadow-sm overflow-hidden">
            <div className="bg-gradient-to-r from-amber-500 to-amber-600 px-4 py-2.5 flex items-center justify-between">
              <span className="text-white font-mono text-sm font-bold">{p.code}</span>
              <Badge variant={STATUS_TONE[p.status] ?? "default"} className="bg-white/95 text-amber-900">{labelEnum(STATUS_LABEL, p.status)}</Badge>
            </div>
            <div className="p-3 space-y-2">
              <div className="flex items-start gap-2">
                <div className="h-10 w-10 rounded-lg bg-amber-100 grid place-items-center text-amber-700 shrink-0"><Briefcase className="h-5 w-5" /></div>
                <div className="flex-1 min-w-0">
                  <Link href={`/contracting/projects/${p.id}`} className="font-bold text-sm hover:underline text-amber-900 block truncate">{p.nameAr}</Link>
                  {p.parentId != null && <p className="text-[11px] text-indigo-600 truncate">{t("contracting.projects.subprojectOf", "فرعي من")}: {projectOptions.find(project => project.id === p.parentId)?.nameAr || `#${p.parentId}`}</p>}
                  {p.location && <p className="text-[11px] text-slate-500 truncate">{p.location}</p>}
                   <p className="text-[11px] text-slate-500 truncate">{t("contracting.projects.branch", "الفرع")}: {p.branchId == null ? "—" : branches.find(branch => branch.id === p.branchId)?.nameAr || `#${p.branchId}`}</p>
                  {p.clientName && <p className="text-xs text-slate-700 truncate">{p.clientName}</p>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-center text-xs">
                <div className="bg-amber-50 rounded-lg p-1.5"><div className="text-[10px] text-muted-foreground">قيمة العقد</div><div className="font-mono font-bold text-amber-800">{Number(p.contractValue).toLocaleString("en-US")}</div></div>
                <div className="bg-rose-50 rounded-lg p-1.5"><div className="text-[10px] text-muted-foreground">التكلفة الفعلية</div><div className="font-mono font-bold text-rose-800">{Number(p.actualCost).toLocaleString("en-US")}</div></div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-1 text-[11px] text-muted-foreground">
                  <span>الإنجاز</span>
                  <span className="font-bold text-amber-700">{Number(p.progressPercent).toFixed(0)}%</span>
                </div>
                <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div className="h-2 bg-gradient-to-l from-amber-500 to-amber-600 rounded-full" style={{ width: `${Math.min(100, Number(p.progressPercent))}%` }} />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 border-t divide-x divide-slate-100 [direction:ltr]">
               <button onClick={() => setDeleting(p)} className="py-2.5 text-rose-600 text-xs font-semibold hover:bg-rose-50 flex items-center justify-center gap-1"><Trash2 className="h-3.5 w-3.5" />حذف</button>
              <Link href={`/contracting/projects/${p.id}`} className="py-2.5 text-slate-700 text-xs font-semibold hover:bg-slate-50 flex items-center justify-center gap-1"><ExternalLink className="h-3.5 w-3.5" />فتح</Link>
              <button onClick={() => setEditing(p)} className="py-2.5 text-amber-700 text-xs font-semibold hover:bg-amber-50 flex items-center justify-center gap-1"><Pencil className="h-3.5 w-3.5" />تعديل</button>
            </div>
          </div>
        ))}
      </div>

      {/* Mobile FAB */}
      <button onClick={() => setEditing(empty())} className="md:hidden fixed bottom-6 end-6 z-40 group" aria-label="مشروع جديد">
        <span className="absolute inset-0 rounded-full bg-amber-400/40 animate-ping" />
        <span className="relative h-14 w-14 rounded-full bg-gradient-to-br from-amber-500 to-amber-600 ring-4 ring-white shadow-2xl grid place-items-center text-white">
          <Plus className="h-7 w-7" />
        </span>
      </button>

      <div className="hidden md:block rounded-lg border bg-white dark:bg-slate-900 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("contracting.projects.code", "الكود")}</TableHead>
              <TableHead>{t("contracting.projects.name", "الاسم")}</TableHead>
             <TableHead>{t("contracting.projects.branch", "الفرع")}</TableHead>
             <TableHead>{t("contracting.projects.client", "العميل")}</TableHead>
              <TableHead>{t("contracting.projects.status", "الحالة")}</TableHead>
              <TableHead>{t("contracting.projects.contractValue", "قيمة العقد")}</TableHead>
              <TableHead>{t("contracting.projects.actualCost", "التكلفة الفعلية")}</TableHead>
              <TableHead>{t("contracting.projects.progress", "الإنجاز")}</TableHead>
              <TableHead className="text-end">{t("common.actions", "إجراءات")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
             {loading && rows.length === 0 && (
              <TableRow><TableCell colSpan={9}><Skeleton className="h-32 w-full" /></TableCell></TableRow>
            )}
             {!loading && rows.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center text-sm text-slate-500 py-6">
                {t("contracting.projects.empty", "لا توجد مشاريع — اضغط «مشروع جديد» للبدء")}
              </TableCell></TableRow>
            )}
            {rows.map(p => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs">{p.code}</TableCell>
                <TableCell className="font-medium">
                  <Link href={`/contracting/projects/${p.id}`} className="hover:underline text-primary">
                    {p.nameAr}
                  </Link>
                  {p.parentId != null && <div className="text-[11px] text-indigo-600">{t("contracting.projects.subprojectOf", "فرعي من")}: {projectOptions.find(project => project.id === p.parentId)?.nameAr || `#${p.parentId}`}</div>}
                  {p.location && <div className="text-[11px] text-slate-500">{p.location}</div>}
                </TableCell>
                 <TableCell>{p.branchId == null ? "—" : branches.find(branch => branch.id === p.branchId)?.nameAr || `#${p.branchId}`}</TableCell>
                 <TableCell>{p.clientName || "—"}</TableCell>
                <TableCell><Badge variant={STATUS_TONE[p.status] ?? "default"}>{labelEnum(STATUS_LABEL, p.status)}</Badge></TableCell>
                <TableCell className="tabular-nums">{Number(p.contractValue).toLocaleString("en-US")}</TableCell>
                <TableCell className="tabular-nums">{Number(p.actualCost).toLocaleString("en-US")}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-20 bg-slate-200 dark:bg-slate-700 rounded">
                      <div className="h-2 bg-emerald-500 rounded" style={{ width: `${Math.min(100, Number(p.progressPercent))}%` }} />
                    </div>
                    <span className="text-xs tabular-nums">{Number(p.progressPercent).toFixed(0)}%</span>
                  </div>
                </TableCell>
                <TableCell className="text-end">
                  <div className="inline-flex gap-1">
                     <ContractingProjectExportActions
                       compact
                       project={exportProjects.find(project => project.id === p.id) ?? p}
                     />
                    <Link href={`/contracting/projects/${p.id}`}>
                      <Button size="sm" variant="ghost"><ExternalLink className="h-4 w-4" /></Button>
                    </Link>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}><Pencil className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(p)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!deleting} onOpenChange={open => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("contracting.projects.confirmDelete", "تأكيد الحذف")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("contracting.projects.confirmDeleteDesc", "سيتم حذف المشروع وجميع بنوده ومستخلصاته ومخاطره. لا يمكن التراجع.")}
              {deleting && <div className="mt-2 font-bold">{deleting.nameAr} ({deleting.code})</div>}
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
