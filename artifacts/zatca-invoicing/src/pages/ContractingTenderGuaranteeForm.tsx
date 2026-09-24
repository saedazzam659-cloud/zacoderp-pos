import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useForm, Controller } from "react-hook-form";
import { useLocation, useSearch } from "wouter";
import { ArrowRight, Save, ShieldCheck, FileText } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { usePermission } from "@/hooks/usePermission";
import { useToast } from "@/hooks/use-toast";
import { Form } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { eligibleParties } from "@/lib/partyEligibility";

const API = import.meta.env.VITE_API_URL || "";
type Option = { id: number; code?: string; nameAr?: string; bankName?: string; partyClassification?: string | null };
type Contract = { id: number; contractNumber: string };
type Tender = { id: number; tender_number: string; title: string; awarded_contract_kind?: string | null; awarded_owner_contract_id?: number | null; awarded_subcontract_id?: number | null };
type Values = {
  tenderNumber: string; title: string; customerId: string; tenderDate: string; submissionDate: string;
  estimatedValue: string; status: string; notes: string;
  guaranteeNumber: string; guaranteeType: string; tenderId: string; parentGuaranteeId: string;
  contractKind: string; contractId: string; bankAccountId: string; beneficiaryCustomerId: string;
  amount: string; issueDate: string; expiryDate: string; purpose: string;
};
const today = new Date().toISOString().slice(0, 10);
const defaults: Values = {
  tenderNumber: "", title: "", customerId: "", tenderDate: today, submissionDate: "",
  estimatedValue: "0", status: "draft", notes: "",
  guaranteeNumber: "", guaranteeType: "initial", tenderId: "", parentGuaranteeId: "",
  contractKind: "owner", contractId: "", bankAccountId: "", beneficiaryCustomerId: "",
  amount: "", issueDate: today, expiryDate: "", purpose: "",
};
const typeItems = [
  { value: "initial", label: "ابتدائي" }, { value: "performance", label: "نهائي / حسن تنفيذ" },
  { value: "advance_payment", label: "دفعة مقدمة" }, { value: "maintenance", label: "صيانة" },
  { value: "other", label: "آخر" },
];
const tenderStatuses = [
  { value: "draft", label: "مسودة" }, { value: "submitted", label: "مقدمة" },
  { value: "under_review", label: "قيد المراجعة" }, { value: "lost", label: "غير فائزة" },
  { value: "cancelled", label: "ملغاة" },
];

async function read(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div className="space-y-1.5"><div className="text-xs font-semibold text-foreground">{label}</div>{children}{hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}</div>;
}
function Choice({ value, onChange, items, placeholder, empty, clearable = false, disabled = false, testId }: {
  value: string; onChange: (value: string) => void; items: ComboboxItem[]; placeholder: string;
  empty?: string; clearable?: boolean; disabled?: boolean; testId: string;
}) {
  return <SearchCombobox value={value} onValueChange={onChange} items={items} placeholder={placeholder}
    searchPlaceholder={`بحث: ${placeholder}`} emptyText={empty || "لا توجد نتائج"} clearable={clearable}
    disabled={disabled} testId={testId} />;
}

export default function ContractingTenderGuaranteeForm() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const segments = location.split("/").filter(Boolean);
  const projectId = Number(segments[2]);
  const entity = segments[3] as "tenders" | "guarantees";
  const editId = segments[4] === "new" ? null : Number(segments[4]);
  const isGuarantee = entity === "guarantees";
  const query = new URLSearchParams(search);
  const { token, user, actingCompanyId } = useAuth();
  const { toast } = useToast();
  const canSave = usePermission("contracting", editId ? "edit" : "create");
  const canViewCustomers = usePermission("customers", "view");
  const companyId = actingCompanyId ?? user?.companyId ?? user?.company?.id;
  const form = useForm<Values>({ defaultValues: defaults });
  const { control, reset, watch, setValue, handleSubmit } = form;
  const guaranteeType = watch("guaranteeType");
  const contractKind = watch("contractKind");
  const [project, setProject] = useState<{ nameAr: string; code: string; customerId: number | null } | null>(null);
  const [banks, setBanks] = useState<Option[]>([]);
  const [customers, setCustomers] = useState<Option[]>([]);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [owners, setOwners] = useState<Contract[]>([]);
  const [subs, setSubs] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const back = `/contracting/projects/${projectId}?tab=guarantees&records=${entity}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
  };

  useEffect(() => {
    if (!companyId) {
      setProject(null); setError("اختر الشركة أولاً لعرض بنوكها وعملائها ومشاريعها."); setLoading(false); return;
    }
    if (!token || !Number.isSafeInteger(projectId) || projectId <= 0 || (editId !== null && (!Number.isSafeInteger(editId) || editId <= 0))) {
      setError("رابط النموذج غير صالح"); setLoading(false); return;
    }
    let active = true;
    setLoading(true);
    setError("");
    setProject(null);
    const auth = {
      Authorization: `Bearer ${token}`,
      ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
    };
    const get = (path: string) => fetch(`${API}/api/contracting${path}`, { headers: auth }).then(read);
    const optionQuery = new URLSearchParams({ companyId: String(companyId) });
    Promise.all([
      get(`/projects/${projectId}`),
      get(`/guarantees/options?${optionQuery}`),
      isGuarantee ? get(`/tenders?projectId=${projectId}`) : Promise.resolve([]),
      isGuarantee ? get(`/projects/${projectId}/owner-contracts`) : Promise.resolve([]),
      isGuarantee ? get(`/projects/${projectId}/sub-contracts`) : Promise.resolve([]),
      editId ? get(`/${entity}/${editId}`) : Promise.resolve(null),
      !editId && isGuarantee && query.get("parent") ? get(`/guarantees/${query.get("parent")}`) : Promise.resolve(null),
    ]).then(([p, options, ts, os, ss, row, parent]) => {
      if (!active) return;
      if (row && Number(row.project_id) !== projectId) throw new Error("السجل لا يتبع هذا المشروع");
      if (parent && Number(parent.project_id) !== projectId) throw new Error("الضمان الأب لا يتبع هذا المشروع");
      if (!p || typeof p !== "object" || Number(p.id) !== projectId
        || !Array.isArray(options?.banks) || !Array.isArray(options?.customers)
        || !Array.isArray(ts) || !Array.isArray(os) || !Array.isArray(ss))
        throw new Error("استجابة بيانات المشروع أو خيارات المناقصات والضمانات غير صالحة");
      setProject(p);
      setBanks(options.banks);
      setCustomers(options.customers);
      setTenders(ts);
      setOwners(os);
      setSubs(ss);
      if (row) {
        reset(isGuarantee ? {
          ...defaults, guaranteeNumber: row.guarantee_number, guaranteeType: row.guarantee_type,
          tenderId: row.tender_id ? String(row.tender_id) : "",
          contractKind: row.contract_kind || "owner",
          contractId: String(row.owner_contract_id || row.subcontract_id || ""),
          bankAccountId: String(row.bank_account_id), beneficiaryCustomerId: row.beneficiary_customer_id ? String(row.beneficiary_customer_id) : "",
          amount: row.amount, issueDate: row.issue_date, expiryDate: row.expiry_date,
          purpose: row.purpose || "", notes: row.notes || "",
        } : {
          ...defaults, tenderNumber: row.tender_number, title: row.title,
          customerId: row.customer_id ? String(row.customer_id) : "", tenderDate: row.tender_date,
          submissionDate: row.submission_date || "", estimatedValue: row.estimated_value,
          status: row.status, notes: row.notes || "",
        });
      } else if (isGuarantee) {
        const parentTender = (ts as Tender[]).find(t => t.id === Number(parent?.tender_id));
        reset({
          ...defaults,
          guaranteeType: parent ? "performance" : query.get("contractId") ? "performance" : "initial",
          tenderId: parent?.tender_id ? String(parent.tender_id) : "",
          parentGuaranteeId: parent ? String(parent.id) : "",
          contractKind: parentTender?.awarded_contract_kind || query.get("contractKind") || "owner",
          contractId: String((parentTender?.awarded_contract_kind === "subcontract"
            ? parentTender.awarded_subcontract_id : parentTender?.awarded_owner_contract_id) || query.get("contractId") || ""),
        });
      } else {
        reset({ ...defaults, customerId: p.customerId ? String(p.customerId) : "" });
      }
    }).catch(e => { if (active) setError(e?.message || "تعذر تحميل النموذج"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, companyId, actingCompanyId, projectId, entity, editId, isGuarantee, search, reset]);

  const optionItems = (rows: Option[]): ComboboxItem[] => rows.map(row => ({
    value: String(row.id), code: row.code,
    label: row.nameAr || row.bankName || `#${row.id}`,
  }));
  const bankId = watch("bankAccountId");
  const customerId = watch("customerId");
  const beneficiaryId = watch("beneficiaryCustomerId");
  // Keep a persisted/project-linked ID visible even when the options endpoint
  // hides it (inactive bank, branch restriction, or missing customers:view).
  const withSelected = (items: ComboboxItem[], id: string, name: string): ComboboxItem[] =>
    id && !items.some(item => item.value === id)
      ? [{ value: id, label: `${name} (#${id}) — غير متاح ضمن الخيارات الحالية`, disabled: true }, ...items]
      : items;
  const customerHint = !canViewCustomers
    ? "لا تملك صلاحية عرض العملاء؛ لا يمكن إضافة ربط عميل جديد. امسح الربط الحالي أو اطلب الصلاحية."
    : !customers.length
      ? "لا يوجد عملاء مسجلون في الشركة. يمكن ترك هذا الحقل فارغاً."
      : undefined;
  const bankHint = !banks.length
    ? "لا توجد حسابات بنكية نشطة متاحة لهذه الشركة ضمن صلاحيات فروعك؛ تحقق من إعداد الحسابات البنكية وربط الفروع."
    : bankId && !banks.some(bank => String(bank.id) === bankId)
      ? "البنك المحدد غير متاح ضمن الحسابات البنكية النشطة أو فروعك؛ اختر بنكاً متاحاً."
      : undefined;
  const controlChoice = (name: keyof Values, items: ComboboxItem[], placeholder: string, empty?: string, clearable = false, disabled = false) =>
    <Controller control={control} name={name} render={({ field }) =>
      <Choice value={field.value} onChange={field.onChange} items={items} placeholder={placeholder}
        empty={empty} clearable={clearable} disabled={disabled} testId={`combobox-${name}`} />} />;
  const controlInput = (name: keyof Values, type = "text", required = false) =>
    <Controller control={control} name={name} rules={{ required: required ? "هذا الحقل مطلوب" : false }}
      render={({ field, fieldState }) => <><Input {...field} type={type} min={type === "number" ? "0" : undefined}
        step={type === "number" ? "0.01" : undefined} data-testid={`input-${name}`} />
        {fieldState.error && <p role="alert" className="text-xs text-destructive">{fieldState.error.message}</p>}</>} />;
  const controlDate = (name: keyof Values) =>
    <Controller control={control} name={name} render={({ field }) =>
      <DateField value={field.value} onChange={field.onChange} />} />;

  async function save(values: Values) {
    if (!canSave) return;
    setError("");
    if (isGuarantee && (!values.bankAccountId || !values.guaranteeNumber.trim() || !values.issueDate || !values.expiryDate
      || Number(values.amount) <= 0 || (values.guaranteeType === "initial" ? !values.tenderId : !values.contractId))) {
      setError("أكمل رقم الخطاب والبنك والقيمة والتواريخ ورابط المناقصة أو العقد."); return;
    }
    if (!isGuarantee && (!values.tenderNumber.trim() || !values.title.trim() || !values.tenderDate)) {
      setError("رقم المناقصة والعنوان والتاريخ مطلوبة."); return;
    }
    const body = isGuarantee
      ? editId ? {
          guaranteeNumber: values.guaranteeNumber, bankAccountId: values.bankAccountId,
          ...(form.formState.dirtyFields.beneficiaryCustomerId ? { beneficiaryCustomerId: values.beneficiaryCustomerId || null } : {}),
          amount: values.amount, issueDate: values.issueDate, expiryDate: values.expiryDate,
          purpose: values.purpose, notes: values.notes,
        } : {
          projectId, guaranteeNumber: values.guaranteeNumber, guaranteeType: values.guaranteeType,
          tenderId: values.tenderId || null, parentGuaranteeId: values.parentGuaranteeId || null,
          contractKind: values.guaranteeType === "initial" ? null : values.contractKind,
          contractId: values.guaranteeType === "initial" ? null : values.contractId || null,
          bankAccountId: values.bankAccountId, beneficiaryCustomerId: values.beneficiaryCustomerId || null,
          amount: values.amount, issueDate: values.issueDate, expiryDate: values.expiryDate,
          status: "draft", purpose: values.purpose, notes: values.notes,
        }
      : {
          projectId, tenderNumber: values.tenderNumber, title: values.title,
          ...(editId && !form.formState.dirtyFields.customerId ? {} : { customerId: values.customerId || null }),
          tenderDate: values.tenderDate,
          submissionDate: values.submissionDate || null, estimatedValue: values.estimatedValue,
          status: values.status, notes: values.notes,
        };
    setSaving(true);
    try {
      await fetch(`${API}/api/contracting/${entity}${editId ? `/${editId}` : ""}`, {
        method: editId ? "PUT" : "POST", headers, body: JSON.stringify(body),
      }).then(read);
      toast({ title: editId ? "تم حفظ التعديلات" : "تم إنشاء السجل" });
      navigate(back);
    } catch (e: any) {
      setError(e?.message || "تعذر حفظ البيانات");
    } finally {
      setSaving(false);
    }
  }

  const title = isGuarantee ? "خطاب ضمان" : "مناقصة";
  return <div dir="rtl" className="mx-auto max-w-5xl space-y-4 px-4 py-5 pb-28 sm:px-6">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" onClick={() => navigate(back)} aria-label="العودة للمشروع" data-testid="button-back-project"><ArrowRight className="h-4 w-4" /></Button>
        <span className="rounded-lg bg-primary/10 p-2 text-primary">{isGuarantee ? <ShieldCheck className="h-5 w-5" /> : <FileText className="h-5 w-5" />}</span>
        <div><p className="text-xs text-muted-foreground">المقاولات / {project?.code || `مشروع #${projectId}`} / {project?.nameAr || ""}</p>
          <h1 className="text-xl font-bold">{editId ? `تعديل ${title}` : `${title} جديد`}</h1></div>
      </div>
      <Button onClick={handleSubmit(save)} disabled={loading || saving || !canSave} data-testid="button-save-contracting-record"><Save className="me-2 h-4 w-4" />{saving ? "جارٍ الحفظ..." : "حفظ"}</Button>
    </div>
    {loading ? <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">جارٍ تحميل بيانات النموذج...</div> : <>
      {error && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" data-testid="error-contracting-form">{error}</div>}
      {!canSave && <div role="alert" className="rounded-md border p-3 text-sm">لا تملك صلاحية {editId ? "تعديل" : "إنشاء"} هذا السجل.</div>}
      {project && !(!editId && isGuarantee && query.get("parent") && !watch("parentGuaranteeId")) && <Form {...form}><form id="contracting-record-form" onSubmit={handleSubmit(save)} className="space-y-4">
        <section className="rounded-lg border bg-card p-4 shadow-sm sm:p-5">
          <h2 className="mb-1 text-sm font-bold">{isGuarantee ? "البيانات الأساسية للضمان" : "بيانات المناقصة"}</h2>
          <p className="mb-4 text-xs text-muted-foreground">الحقول والروابط هنا تخص هذا المشروع فقط.</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {isGuarantee ? <>
              <Field label="رقم الخطاب *">{controlInput("guaranteeNumber", "text", true)}</Field>
              <Field label="نوع الضمان"><Controller control={control} name="guaranteeType" render={({ field }) =>
                <Choice value={field.value} onChange={value => { field.onChange(value); setValue("contractId", ""); setValue("tenderId", ""); }}
                  items={typeItems} placeholder="اختر النوع" disabled={!!editId || !!watch("parentGuaranteeId")} testId="combobox-guaranteeType" />} /></Field>
              <Field label="البنك *" hint={bankHint}>
                {controlChoice("bankAccountId", withSelected(optionItems(banks), bankId, "بنك مرتبط سابقاً"), "اختر البنك", "لا توجد بنوك نشطة متاحة")}</Field>
              <Field label="المستفيد (عميل مسجل)" hint={customerHint || "اختياري، اتركه فارغاً إذا لم يكن المستفيد عميلاً مسجلاً."}>
                {controlChoice("beneficiaryCustomerId", withSelected(optionItems(eligibleParties(customers, "projectOwner", beneficiaryId)), beneficiaryId, "مستفيد مرتبط سابقاً"), "اختر المستفيد", canViewCustomers ? "لا يوجد عملاء مسجلون" : "لا تملك صلاحية عرض العملاء", true)}</Field>
              <Field label="القيمة *">{controlInput("amount", "number", true)}</Field>
              <Field label="تاريخ الإصدار *">{controlDate("issueDate")}</Field>
              <Field label="تاريخ الانتهاء *">{controlDate("expiryDate")}</Field>
            </> : <>
              <Field label="رقم المناقصة *">{controlInput("tenderNumber", "text", true)}</Field>
              <Field label="العنوان *">{controlInput("title", "text", true)}</Field>
              <Field label="العميل / المالك" hint={customerHint || "يُحدد عميل المشروع المسجل تلقائياً فقط، ويمكن تغييره هنا."}>
                {controlChoice("customerId", withSelected(optionItems(eligibleParties(customers, "projectOwner", customerId)), customerId, "عميل المشروع المسجل"), "اختر العميل", canViewCustomers ? "لا يوجد عملاء مسجلون" : "لا تملك صلاحية عرض العملاء", true)}</Field>
              <Field label="تاريخ المناقصة *">{controlDate("tenderDate")}</Field>
              <Field label="آخر موعد للتقديم">{controlDate("submissionDate")}</Field>
              <Field label="القيمة التقديرية">{controlInput("estimatedValue", "number")}</Field>
              <Field label="الحالة">{controlChoice("status", tenderStatuses, "اختر الحالة")}</Field>
            </>}
          </div>
        </section>
        {isGuarantee && <section className="rounded-lg border bg-card p-4 shadow-sm sm:p-5">
          <h2 className="mb-1 text-sm font-bold">ارتباط الضمان</h2>
          <p className="mb-4 text-xs text-muted-foreground">{editId ? "نوع الضمان وروابطه ثابتة بعد الإنشاء؛ يمكن تعديل بيانات الخطاب أعلاه." : "الابتدائي يرتبط بمناقصة؛ الأنواع الأخرى ترتبط بعقد في هذا المشروع."}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {guaranteeType === "initial" ? <Field label="المناقصة *" hint={!tenders.length ? "لا توجد مناقصات في هذا المشروع؛ أنشئ مناقصة أولاً." : undefined}>
              {controlChoice("tenderId", tenders.map(t => ({ value: String(t.id), label: `${t.tender_number} — ${t.title}` })), "اختر المناقصة", "لا توجد مناقصات", false, !!editId)}</Field> : <>
              <Field label="جهة العقد"><Controller control={control} name="contractKind" render={({ field }) =>
                <Choice value={field.value} onChange={value => { field.onChange(value); setValue("contractId", ""); }}
                  items={[{ value: "owner", label: "عقد مالك" }, { value: "subcontract", label: "عقد باطن" }]}
                  placeholder="اختر الجهة" disabled={!!editId || !!watch("parentGuaranteeId")} testId="combobox-contractKind" />} /></Field>
              <Field label="العقد *" hint={!(contractKind === "owner" ? owners : subs).length ? "لا توجد عقود من هذا النوع في المشروع." : undefined}>
                {controlChoice("contractId", (contractKind === "owner" ? owners : subs).map(c => ({ value: String(c.id), label: c.contractNumber })), "اختر العقد", "لا توجد عقود", false, !!editId || !!watch("parentGuaranteeId"))}</Field>
              {watch("parentGuaranteeId") && <p className="text-xs text-muted-foreground sm:col-span-2">ضمان نهائي ناتج عن ضمان ابتدائي #{watch("parentGuaranteeId")}؛ العقد محدد حسب ترسية المناقصة.</p>}
            </>}
          </div>
        </section>}
        <section className="rounded-lg border bg-card p-4 shadow-sm sm:p-5">
          <h2 className="mb-4 text-sm font-bold">تفاصيل إضافية</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {isGuarantee && <Field label="الغرض">{controlInput("purpose")}</Field>}
            <Field label="ملاحظات">{controlInput("notes")}</Field>
          </div>
        </section>
      </form></Form>}
    </>}
    <div className="fixed bottom-0 left-0 right-0 z-20 border-t bg-background/95 px-4 py-3 shadow-lg backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <span className="hidden text-xs text-muted-foreground sm:block">تأكد من البيانات قبل الحفظ.</span>
        <div className="flex gap-2"><Button variant="outline" onClick={() => navigate(back)}>إلغاء</Button>
          <Button onClick={handleSubmit(save)} disabled={loading || saving || !canSave || !project} data-testid="button-save-contracting-footer"><Save className="me-2 h-4 w-4" />{saving ? "جارٍ الحفظ..." : "حفظ"}</Button></div>
      </div>
    </div>
  </div>;
}