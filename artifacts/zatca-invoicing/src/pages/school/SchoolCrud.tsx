import { useState, type ReactNode } from "react";
import { AlertCircle, ArrowDownUp, Plus, Pencil, Trash2, Search, RotateCw, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { usePermission } from "@/hooks/usePermission";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useSchoolCrud, useSchoolList, useSchoolLists, type Row } from "./schoolApi";

export type FieldDef = { key: string; label: string; type?: "text" | "number" | "date" | "email" | "textarea" | "select" | "relation"; options?: [string, string][]; resource?: string; labelKey?: string; required?: boolean };
export type ColumnDef = { key: string; label: string; type?: "status" | "date" | "number" | "relation"; options?: [string, string][]; resource?: string; labelKey?: string };
export type CrudConfig = { resource: string; title: string; description: string; singular: string; icon?: any; fields: FieldDef[]; columns: ColumnDef[]; defaultValues?: Record<string, any>; pageSize?: number };

const relatedRowLabel = (field: FieldDef | ColumnDef, row: Row, lookups?: Record<string, Row[]>) => {
  const resource = field.resource;
  if (resource === "enrollments") {
    const student = lookups?.students?.find(item => item.id === row.studentId);
    const schoolClass = lookups?.classes?.find(item => item.id === row.classId);
    const year = lookups?.["academic-years"]?.find(item => item.id === row.academicYearId);
    const parts = [
      student?.fullNameAr || student?.studentNumber,
      schoolClass?.name || schoolClass?.code,
      year?.name,
    ].filter(Boolean);
    if (parts.length) return parts.join(" · ");
  }
  if (resource === "classes") {
    const grade = lookups?.grades?.find(item => item.id === row.gradeId);
    const parts = [row.name || row.code, grade?.nameAr].filter(Boolean);
    if (parts.length) return parts.join(" · ");
  }
  return row[field.labelKey || "nameAr"] || row.name || row.fullNameAr || row.studentNumber || row.docNumber || (resource === "sales-invoices" ? `فاتورة #${row.id}` : `#${row.id}`);
};

const labelFor = (field: FieldDef | ColumnDef, value: any, options?: Row[], lookups?: Record<string, Row[]>) => {
  if (field.type === "relation") {
    const row = options?.find(x => String(x.id) === String(value));
    return row ? relatedRowLabel(field, row, lookups) : (value ? `#${value}` : "—");
  }
  return field.options?.find(([key]) => String(key) === String(value))?.[1] || value || "—";
};

export function SchoolCrudPage({ config, headingExtra }: { config: CrudConfig; headingExtra?: ReactNode }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(config.columns[0]?.key || "id");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [editing, setEditing] = useState<Row | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [del, setDel] = useState<Row | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [formValidationError, setFormValidationError] = useState("");
  const { data, isLoading, isError, error, refetch } = useSchoolList<Row>(config.resource, { page, limit: config.pageSize ?? 20, q, sort, dir });
  const { save, remove } = useSchoolCrud(config.resource);
  const canCreate = usePermission("school", "create");
  const canEdit = usePermission("school", "edit");
  const canDelete = usePermission("school", "delete");
  const rows = data?.items ?? [];
  const relationFields = [...config.fields, ...config.columns].filter(field => field.type === "relation" && field.resource);
  const nestedResources = new Set<string>();
  if (relationFields.some(field => field.resource === "enrollments")) {
    ["students", "classes", "academic-years", "grades"].forEach(resource => nestedResources.add(resource));
  }
  if (relationFields.some(field => field.resource === "classes")) nestedResources.add("grades");
  const lookupResources = Array.from(new Set([...relationFields.map(field => field.resource!), ...nestedResources]));
  const lookupQueries = useSchoolLists<Row>(lookupResources, { page: 1, limit: 100 });
  const lookups = Object.fromEntries(lookupResources.map((resource, index) => [
    resource,
    lookupQueries[index]?.data?.items ?? [],
  ])) as Record<string, Row[]>;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize || config.pageSize || 20)));

  const openNew = () => {
    setFormValidationError("");
    setEditing(null);
    setForm(Object.fromEntries(config.fields.map(f => [f.key, config.defaultValues?.[f.key] ?? ""])));
    setFormOpen(true);
  };
  const openEdit = (row: Row) => {
    setFormValidationError("");
    setEditing(row);
    setForm(Object.fromEntries(config.fields.map(f => [f.key, row[f.key] == null ? "" : String(row[f.key])])));
    setFormOpen(true);
  };
  const saveRow = () => {
    const missing = config.fields.filter(f => f.required && (form[f.key] == null || String(form[f.key]).trim() === ""));
    if (missing.length) {
      setFormValidationError(`أكمل الحقول المطلوبة: ${missing.map(f => f.label).join("، ")}`);
      return;
    }
    setFormValidationError("");
    const body = Object.fromEntries(config.fields.flatMap(f => {
      const val = form[f.key];
      // Omit untouched optional fields so database defaults remain active;
      // nullable values are null by default, while updates leave them intact.
      if (val === "" || val == null) return [];
      return [[f.key, f.type === "number" || f.type === "relation" ? Number(val) : f.type === "select" && (val === "true" || val === "false") ? val === "true" : val]];
    }));
    save.mutate({ id: editing?.id, body }, { onSuccess: () => setFormOpen(false) });
  };
  return (
    <main className="space-y-4 p-4 sm:p-5" dir="rtl">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-1 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><BookOpen className="h-5 w-5" /></span>
          <div><h1 className="text-xl font-bold tracking-tight sm:text-2xl">{config.title}</h1><p className="mt-1 text-sm text-muted-foreground">{config.description}</p></div>
        </div>
         <div className="flex items-center gap-2">{headingExtra}{canCreate && <Button onClick={openNew} className="gap-2"><Plus className="h-4 w-4" />إضافة {config.singular}</Button>}</div>
      </header>
      <section className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/20 p-3">
          <div className="relative w-full max-w-sm"><Search className="absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="بحث" placeholder={`بحث في ${config.title}...`} value={q} onChange={e => { setQ(e.target.value); setPage(1); }} className="pe-9" /></div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{data?.total ?? 0} سجل</span><Button variant="outline" size="sm" onClick={() => refetch()} aria-label="تحديث"><RotateCw className="h-3.5 w-3.5" /></Button></div>
        </div>
        {formOpen && <div className="p-3 sm:p-4"><FormPanel icon={editing ? Pencil : Plus} title={editing ? `تعديل ${config.singular}` : `إضافة ${config.singular}`} subtitle={config.title} width="4xl" onClose={() => setFormOpen(false)} onSave={saveRow} saving={save.isPending} saveLabel="حفظ" cancelLabel="إلغاء">
           {(formValidationError || save.isError) && <div role="alert" className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{formValidationError || (save.error as Error).message || "تعذر حفظ البيانات"}</div>}
          <FormGrid cols={2}>{config.fields.map(f => <Field key={f.key} label={f.label} required={f.required} className={f.type === "textarea" ? "md:col-span-2" : ""}>
             {f.type === "relation" ? <SearchCombobox items={(lookups[f.resource!] ?? []).map((r: Row) => ({ value: String(r.id), label: relatedRowLabel(f, r, lookups), description: r.code || r.jobTitle || r.phone || r.city || r.invoiceDate || "" }))} value={String(form[f.key] ?? "")} onValueChange={v => { setForm(prev => ({ ...prev, [f.key]: v })); setFormValidationError(""); }} placeholder="اختر من القائمة" searchPlaceholder="ابحث..." clearable />
             : f.type === "select" ? <select aria-label={f.label} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={form[f.key] ?? ""} onChange={e => { setForm(prev => ({ ...prev, [f.key]: e.target.value })); setFormValidationError(""); }}><option value="">— اختر —</option>{f.options?.map(([v, l]) => <option value={v} key={v}>{l}</option>)}</select>
             : f.type === "textarea" ? <textarea aria-label={f.label} className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form[f.key] ?? ""} onChange={e => { setForm(prev => ({ ...prev, [f.key]: e.target.value })); setFormValidationError(""); }} />
             : <Input aria-label={f.label} type={f.type || "text"} value={form[f.key] ?? ""} onChange={e => { setForm(prev => ({ ...prev, [f.key]: e.target.value })); setFormValidationError(""); }} required={f.required} />}</Field>)}</FormGrid>
        </FormPanel></div>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground"><tr>{config.columns.map(c => <th key={c.key} className="px-3 py-3 text-start"><button className="inline-flex items-center gap-1 font-semibold hover:text-foreground" onClick={() => { setSort(c.key); setDir(sort === c.key && dir === "asc" ? "desc" : "asc"); }} aria-label={`ترتيب حسب ${c.label}`}>{c.label}<ArrowDownUp className="h-3 w-3" /></button></th>)}<th className="px-3 py-3 text-center">إجراءات</th></tr></thead>
            <tbody className="divide-y">
              {isLoading && Array.from({ length: 4 }, (_, i) => <tr key={i}><td colSpan={config.columns.length + 1} className="px-3 py-3"><div className="h-5 animate-pulse rounded bg-muted" /></td></tr>)}
              {isError && <tr><td colSpan={config.columns.length + 1} className="px-4 py-10 text-center"><AlertCircle className="mx-auto mb-2 h-5 w-5 text-destructive" /><p className="text-sm">{(error as Error)?.message || "تعذر تحميل البيانات"}</p><Button className="mt-3" size="sm" variant="outline" onClick={() => refetch()}>إعادة المحاولة</Button></td></tr>}
              {!isLoading && !isError && rows.length === 0 && <tr><td colSpan={config.columns.length + 1} className="px-4 py-12 text-center"><div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-muted"><Search className="h-4 w-4 text-muted-foreground" /></div><p className="font-medium">لا توجد سجلات</p><p className="mt-1 text-xs text-muted-foreground">يمكنك إضافة سجل جديد أو تغيير عبارة البحث.</p></td></tr>}
              {!isLoading && rows.map(row => <tr key={row.id} className="hover:bg-muted/30">
                {config.columns.map(c => <td key={c.key} className="px-3 py-3">
                  {c.type === "status" ? <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${["active", "enrolled", "present", "passed", "current", "paid", "true"].includes(String(row[c.key])) ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{c.options?.find(([k]) => k === String(row[c.key]))?.[1] ?? row[c.key] ?? "—"}</span>
                   : c.type === "date" ? (row[c.key] ? new Date(row[c.key]).toLocaleDateString("ar-SA") : "—")
                  : c.type === "number" ? (row[c.key] ?? "—")
                   : c.type === "relation" ? labelFor(c, row[c.key], lookups[c.resource || ""], lookups)
                  : String(row[c.key] ?? "—")}</td>)}
                 <td className="px-3 py-2"><div className="flex justify-center gap-1">{canEdit && <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(row)} aria-label="تعديل"><Pencil className="h-4 w-4" /></Button>}{canDelete && <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => setDel(row)} aria-label="حذف"><Trash2 className="h-4 w-4" /></Button>}</div></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t px-3 py-2 text-xs"><span className="text-muted-foreground">صفحة {page} من {totalPages}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>السابق</Button><Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>التالي</Button></div></div>
      </section>
      <AlertDialog open={!!del} onOpenChange={open => !open && setDel(null)}><AlertDialogContent dir="rtl"><AlertDialogHeader><AlertDialogTitle>تأكيد الحذف</AlertDialogTitle><AlertDialogDescription>سيتم حذف السجل المحدد نهائياً. هل تريد المتابعة؟</AlertDialogDescription></AlertDialogHeader>{remove.isError && <p role="alert" className="text-sm text-destructive">{(remove.error as Error).message || "تعذر حذف السجل"}</p>}<AlertDialogFooter><AlertDialogCancel>إلغاء</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground" disabled={remove.isPending} onClick={() => del && remove.mutate(del.id, { onSuccess: () => setDel(null) })}>حذف السجل</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </main>
  );
}
