import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreatePosItemGroup,
  useDeletePosItemGroup,
  useListPosItemGroups,
  useUpdatePosItemGroup,
  getListPosItemGroupsQueryKey,
} from "@workspace/api-client-react";
import type { PosItemGroup, PosItemGroupInput } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { uploadPosItemGroupImage } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ImagePlus,
  Layers3,
  Loader2,
  Pencil,
  Plus,
  Search,
  ShoppingBag,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";

type GroupForm = { code: string; nameAr: string; nameEn: string; imageUrl: string };
const EMPTY_FORM: GroupForm = { code: "", nameAr: "", nameEn: "", imageUrl: "" };
const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function PosItemGroups() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language?.startsWith("ar") ?? true;
  const { token } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: response, isLoading, isError, error, refetch, isFetching } = useListPosItemGroups();
  const groups = Array.isArray(response) ? response : [];
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<GroupForm>(EMPTY_FORM);
  const [editId, setEditId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PosItemGroup | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [validationError, setValidationError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const tr = (key: string, fallback: string, options?: Record<string, unknown>) =>
    t(`inventoryMaster.posItemGroups.${key}`, { defaultValue: fallback, ...options }) as string;
  const common = (key: string, fallback: string) =>
    t(`inventoryMaster.common.${key}`, { defaultValue: fallback }) as string;
  const pickName = (group: Pick<PosItemGroup, "nameAr" | "nameEn">) =>
    isRtl ? group.nameAr || group.nameEn || "" : group.nameEn || group.nameAr || "";
  const invalidateGroups = () =>
    queryClient.invalidateQueries({ queryKey: getListPosItemGroupsQueryKey() });

  const createGroup = useCreatePosItemGroup({
    mutation: {
      onSuccess: async (created) => {
        await invalidateGroups();
        closeForm();
        toast({ title: tr("createdToast", "تم إنشاء مجموعة العرض") });
        void created;
      },
    },
  });
  const updateGroup = useUpdatePosItemGroup({
    mutation: {
      onSuccess: async (updated) => {
        await invalidateGroups();
        closeForm();
        toast({ title: tr("savedToast", "تم حفظ التغييرات") });
        void updated;
      },
    },
  });
  const deleteGroup = useDeletePosItemGroup({
    mutation: {
      onSuccess: async () => {
        await invalidateGroups();
        setDeleteTarget(null);
        toast({ title: tr("deletedToast", "تم حذف المجموعة") });
      },
    },
  });

  const filteredGroups = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return groups;
    return groups.filter((group) =>
      [group.code, group.nameAr, group.nameEn]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(needle)),
    );
  }, [groups, search]);

  function closeForm() {
    setFormOpen(false);
    setForm(EMPTY_FORM);
    setEditId(null);
    setValidationError("");
    setUploadError("");
    setUploading(false);
    createGroup.reset();
    updateGroup.reset();
  }

  function openCreate() {
    closeForm();
    setFormOpen(true);
  }

  function openEdit(group: PosItemGroup) {
    createGroup.reset();
    updateGroup.reset();
    setForm({
      code: group.code ?? "",
      nameAr: group.nameAr ?? "",
      nameEn: group.nameEn ?? "",
      imageUrl: group.imageUrl ?? "",
    });
    setEditId(group.id);
    setValidationError("");
    setUploadError("");
    setFormOpen(true);
  }

  function handleFile(file?: File) {
    if (!file) return;
    setUploadError("");
    if (!file.type.startsWith("image/")) {
      setUploadError(tr("imageTypeError", "اختر ملف صورة بصيغة مدعومة."));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError(tr("imageSizeError", "يجب ألا يتجاوز حجم الصورة 5 ميجابايت."));
      return;
    }
    setUploading(true);
    uploadPosItemGroupImage(file)
      .then((imageUrl) => {
        setForm((current) => ({ ...current, imageUrl }));
        toast({ title: tr("imageUploaded", "تم رفع الصورة") });
      })
      .catch((uploadFailure: unknown) => {
        const message = uploadFailure instanceof Error ? uploadFailure.message : "";
        setUploadError(message || tr("uploadError", "تعذر رفع الصورة. حاول مرة أخرى."));
      })
      .finally(() => setUploading(false));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nameAr = form.nameAr.trim();
    if (!nameAr) {
      setValidationError(tr("nameRequired", "اسم المجموعة بالعربية مطلوب."));
      return;
    }
    setValidationError("");
    const data: PosItemGroupInput = {
      ...(form.code.trim() ? { code: form.code.trim() } : {}),
      nameAr,
      nameEn: form.nameEn.trim() || null,
      imageUrl: form.imageUrl || null,
    };
    if (editId !== null) updateGroup.mutate({ id: editId, data });
    else createGroup.mutate({ data });
  }

  const savePending = createGroup.isPending || updateGroup.isPending;
  const formError = validationError || uploadError ||
    (createGroup.isError ? tr("saveError", "تعذر حفظ المجموعة. تحقق من البيانات وحاول مرة أخرى.") : "") ||
    (updateGroup.isError ? tr("saveError", "تعذر حفظ المجموعة. تحقق من البيانات وحاول مرة أخرى.") : "");
  const previewUrl = (path: string) => {
    if (!path) return "";
    if (!path.startsWith("/objects/")) return path;
    const tokenPart = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${API_BASE}/api/storage${path}${tokenPart}`;
  };
  const displayError = (value: unknown) =>
    value instanceof Error && value.message ? value.message : tr("genericError", "حدث خطأ غير متوقع.");

  return (
    <main className="min-h-[100dvh] space-y-6 px-4 py-5 sm:px-6 lg:px-8" dir={isRtl ? "rtl" : "ltr"}>
      <header className="relative overflow-hidden rounded-2xl border border-teal-900/10 bg-[hsl(165_28%_95%)] px-5 py-6 sm:px-8 sm:py-8">
        <div className="pointer-events-none absolute -end-10 -top-16 h-56 w-56 rounded-full border-[28px] border-teal-800/[0.04]" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-teal-900/10 bg-white/70 px-3 py-1 text-xs font-semibold text-teal-900">
              <ShoppingBag className="h-3.5 w-3.5" />
              {tr("eyebrow", "نقطة البيع")}
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl" data-testid="heading-pos-item-groups">
              {tr("title", "مجموعات العرض")}
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">
              {tr("subtitle", "رتّب المنتجات في تبويبات واضحة للكاشير، مع صورة تظهر على شاشة نقطة البيع.")}
            </p>
            <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-teal-900/75">
              <Layers3 className="h-3.5 w-3.5" />
              {tr("accountingNote", "مجموعات العرض مستقلة عن فئات الأصناف المحاسبية.")}
            </p>
          </div>
          <Button onClick={openCreate} className="h-10 shrink-0 gap-2 rounded-lg px-4 shadow-sm" data-testid="button-create-pos-group">
            <Plus className="h-4 w-4" />
            {tr("newGroup", "مجموعة جديدة")}
          </Button>
        </div>
      </header>

      <section aria-label={tr("listTitle", "مجموعات العرض")} data-testid="section-pos-group-list">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-bold text-slate-900">{tr("listTitle", "مجموعات العرض")}</h2>
            {!isLoading && !isError && (
              <span className="rounded-full bg-teal-900/[0.07] px-2.5 py-0.5 font-mono text-xs font-semibold text-teal-900" data-testid="count-pos-groups">
                {groups.length}
              </span>
            )}
          </div>
          <div className="relative w-full sm:max-w-xs">
            <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400`} />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={tr("searchPlaceholder", "ابحث بالاسم أو الرمز")}
              aria-label={tr("searchPlaceholder", "ابحث بالاسم أو الرمز")}
              className={`${isRtl ? "pr-9" : "pl-9"} h-10 border-slate-200 bg-white`}
              data-testid="input-search-pos-groups"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3" aria-label={tr("loading", "جارٍ تحميل المجموعات")} data-testid="state-pos-groups-loading">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4">
                <Skeleton className="h-14 w-14 rounded-lg" />
                <div className="flex-1 space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-28" /></div>
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-5 py-8 text-center" role="alert" data-testid="state-pos-groups-error">
            <AlertCircle className="mx-auto mb-2 h-6 w-6 text-rose-700" />
            <p className="font-semibold text-rose-900">{tr("loadError", "تعذر تحميل مجموعات العرض")}</p>
            <p className="mt-1 text-sm text-rose-800">{displayError(error)}</p>
            <Button variant="outline" className="mt-4 border-rose-300 bg-white" onClick={() => void refetch()} data-testid="button-retry-pos-groups">
              {isFetching ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : null}
              {tr("retry", "إعادة المحاولة")}
            </Button>
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-teal-900/20 bg-[hsl(165_28%_98%)] px-5 py-14 text-center" data-testid="state-pos-groups-empty">
            <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-teal-900/[0.07] text-teal-900">
              <Layers3 className="h-7 w-7" />
            </div>
            <h3 className="font-bold text-slate-900">{tr("emptyTitle", "ابدأ بتنظيم تبويبات نقطة البيع")}</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
              {tr("emptyDescription", "أنشئ مجموعة عرض ثم اربط بها الأصناف من شاشة الأصناف.")}
            </p>
            <Button onClick={openCreate} className="mt-5 gap-2" data-testid="button-create-first-pos-group">
              <Plus className="h-4 w-4" />{tr("newGroup", "مجموعة جديدة")}
            </Button>
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-12 text-center" data-testid="state-pos-groups-no-results">
            <Search className="mx-auto mb-3 h-6 w-6 text-slate-400" />
            <p className="font-semibold text-slate-800">{tr("noResults", "لا توجد مجموعات تطابق البحث")}</p>
            <Button variant="link" className="mt-1 text-teal-800" onClick={() => setSearch("")} data-testid="button-clear-group-search">
              {tr("clearSearch", "مسح البحث")}
            </Button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_8px_30px_-25px_rgba(15,60,55,0.45)]" data-testid="list-pos-groups">
            <div className="hidden grid-cols-[minmax(0,1.5fr)_minmax(120px,0.8fr)_minmax(130px,0.9fr)_104px] items-center gap-4 border-b border-slate-200 bg-slate-50/80 px-5 py-3 text-[11px] font-bold uppercase tracking-[0.08em] text-slate-500 md:grid">
              <span>{tr("columnGroup", "المجموعة")}</span>
              <span>{common("code", "الرمز")}</span>
              <span>{tr("columnEnglishName", "الاسم بالإنجليزية")}</span>
              <span className="text-center">{common("actions", "الإجراءات")}</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {filteredGroups.map((group) => (
                <li key={group.id} className="grid grid-cols-1 items-center gap-3 px-4 py-4 transition-colors hover:bg-teal-50/30 sm:px-5 md:grid-cols-[minmax(0,1.5fr)_minmax(120px,0.8fr)_minmax(130px,0.9fr)_104px] md:gap-4" data-testid={`row-pos-group-${group.id}`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-[hsl(165_26%_96%)]" data-testid={`image-frame-pos-group-${group.id}`}>
                      {group.imageUrl ? (
                        <img
                          src={previewUrl(group.imageUrl)}
                          alt={pickName(group)}
                          className="h-full w-full object-cover"
                          loading="lazy"
                          data-testid={`img-pos-group-${group.id}`}
                        />
                      ) : (
                        <div className="grid h-full w-full place-items-center text-teal-900/50"><ShoppingBag className="h-5 w-5" /></div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-bold text-slate-900" data-testid={`text-pos-group-name-${group.id}`}>{pickName(group)}</p>
                      {group.nameAr && group.nameEn && (
                        <p dir={isRtl ? "ltr" : "rtl"} className={`mt-0.5 truncate text-xs text-slate-500 ${isRtl ? "text-right" : "text-left"}`} data-testid={`text-pos-group-secondary-name-${group.id}`}>
                          {isRtl ? group.nameEn : group.nameAr}
                        </p>
                      )}
                      <p className="mt-1 text-[11px] text-slate-500 md:hidden">
                        {group.code || tr("codeNotSet", "بدون رمز")}
                      </p>
                    </div>
                  </div>
                  <div className="hidden md:block">
                    <span className="inline-flex rounded-md bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700" data-testid={`text-pos-group-code-${group.id}`}>
                      {group.code || "—"}
                    </span>
                  </div>
                  <div className="hidden truncate text-sm text-slate-600 md:block" dir="ltr" data-testid={`text-pos-group-name-en-${group.id}`}>
                    {group.nameEn || "—"}
                  </div>
                  <div className="flex items-center justify-end gap-1 md:justify-center">
                    <Button variant="ghost" size="icon" className="h-9 w-9 text-slate-600 hover:bg-teal-900/[0.07] hover:text-teal-900" onClick={() => openEdit(group)} aria-label={tr("editGroup", "تعديل المجموعة")} data-testid={`button-edit-pos-group-${group.id}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-9 w-9 text-slate-500 hover:bg-rose-50 hover:text-rose-700" onClick={() => { deleteGroup.reset(); setDeleteTarget(group); }} aria-label={tr("deleteGroup", "حذف المجموعة")} data-testid={`button-delete-pos-group-${group.id}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/35 p-0 backdrop-blur-[2px] sm:items-center sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !savePending && !uploading) closeForm(); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="pos-group-form-title" className="max-h-[94dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-slate-200 bg-white shadow-2xl sm:rounded-2xl" data-testid="dialog-pos-group-form">
            <div className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-100 bg-white/95 px-5 py-4 backdrop-blur sm:px-7">
              <div>
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-teal-800"><Layers3 className="h-4 w-4" />{tr("eyebrow", "نقطة البيع")}</div>
                <h2 id="pos-group-form-title" className="text-xl font-bold text-slate-900">{editId !== null ? tr("editGroup", "تعديل المجموعة") : tr("newGroup", "مجموعة جديدة")}</h2>
                <p className="mt-1 text-sm text-slate-500">{tr("formHint", "بيانات المجموعة وصورتها ستظهر في تبويب نقطة البيع.")}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={closeForm} disabled={savePending || uploading} aria-label={common("close", "إغلاق")} data-testid="button-close-pos-group-form"><X className="h-4 w-4" /></Button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-6 px-5 py-5 sm:px-7 sm:py-6" noValidate>
              <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_190px]">
                <div className="space-y-4">
                  <label className="block space-y-1.5">
                    <span className="text-sm font-semibold text-slate-800">{tr("nameArLabel", "اسم المجموعة بالعربية")} <span className="text-rose-600">*</span></span>
                    <Input autoFocus value={form.nameAr} onChange={(event) => { setForm((current) => ({ ...current, nameAr: event.target.value })); setValidationError(""); }} placeholder={tr("nameArPlaceholder", "مثال: المشروبات")} maxLength={120} className="h-10" data-testid="input-pos-group-name-ar" />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-sm font-semibold text-slate-800">{tr("nameEnLabel", "اسم المجموعة بالإنجليزية")} <span className="font-normal text-slate-400">{tr("optional", "اختياري")}</span></span>
                    <Input dir="ltr" value={form.nameEn} onChange={(event) => setForm((current) => ({ ...current, nameEn: event.target.value }))} placeholder={tr("nameEnPlaceholder", "مثال: Beverages")} maxLength={120} className="h-10 text-left" data-testid="input-pos-group-name-en" />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-sm font-semibold text-slate-800">{common("code", "الرمز")} <span className="font-normal text-slate-400">{tr("optional", "اختياري")}</span></span>
                     <Input dir="ltr" value={form.code} onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))} placeholder={tr("codePlaceholder", "مثال: DRINKS")} maxLength={50} className="h-10 text-left font-mono text-sm" data-testid="input-pos-group-code" />
                  </label>
                </div>

                <div className="space-y-2">
                  <span className="block text-sm font-semibold text-slate-800">{tr("imageLabel", "صورة تبويب نقطة البيع")} <span className="font-normal text-slate-400">{tr("optional", "اختياري")}</span></span>
                  <div className="flex min-h-[174px] flex-col items-center justify-center rounded-xl border border-dashed border-teal-900/25 bg-[hsl(165_28%_97%)] p-3 text-center" data-testid="pos-group-image-upload">
                    {form.imageUrl ? (
                      <div className="relative mb-3 h-24 w-24 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                        <img src={previewUrl(form.imageUrl)} alt={tr("imagePreview", "معاينة صورة المجموعة")} className="h-full w-full object-cover" data-testid="img-pos-group-preview" />
                        <button type="button" onClick={() => setForm((current) => ({ ...current, imageUrl: "" }))} className="absolute end-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-slate-900/75 text-white hover:bg-rose-700" aria-label={tr("removeImage", "إزالة الصورة")} data-testid="button-remove-pos-group-image"><X className="h-3.5 w-3.5" /></button>
                      </div>
                    ) : (
                      <div className="mb-2 grid h-12 w-12 place-items-center rounded-xl bg-white text-teal-800 shadow-sm"><ImagePlus className="h-6 w-6" /></div>
                    )}
                    <p className="text-xs leading-5 text-slate-500">{tr("imageHint", "صورة مربعة، حتى 5 ميجابايت")}</p>
                    <input ref={fileRef} type="file" accept="image/*" className="sr-only" onChange={(event) => { handleFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} disabled={uploading || savePending} data-testid="input-pos-group-image-file" />
                    <Button type="button" variant="outline" size="sm" className="mt-3 h-8 gap-1.5 border-teal-900/20 bg-white text-teal-900 hover:bg-teal-50" onClick={() => fileRef.current?.click()} disabled={uploading || savePending} data-testid="button-upload-pos-group-image">
                      {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
                      {uploading ? tr("uploading", "جارٍ الرفع…") : form.imageUrl ? tr("replaceImage", "تغيير الصورة") : tr("chooseImage", "اختيار صورة")}
                    </Button>
                  </div>
                </div>
              </div>

              {formError && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800" role="alert" data-testid="status-pos-group-form-error">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{formError}</span>
                </div>
              )}
              <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:justify-between">
                <p className="flex items-center gap-1.5 text-xs text-slate-500"><ArrowUpRight className="h-3.5 w-3.5" />{tr("itemsNote", "إسناد المجموعة للأصناف يتم من شاشة الأصناف.")}</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={closeForm} disabled={savePending || uploading} data-testid="button-cancel-pos-group-form">{common("cancel", "إلغاء")}</Button>
                  <Button type="submit" className="min-w-28 gap-2" disabled={savePending || uploading} data-testid="button-save-pos-group">
                    {savePending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {savePending ? tr("saving", "جارٍ الحفظ…") : common("save", "حفظ")}
                  </Button>
                </div>
              </div>
            </form>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleteGroup.isPending) setDeleteTarget(null); }}>
          <section role="alertdialog" aria-modal="true" aria-labelledby="pos-group-delete-title" className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl sm:p-6" data-testid="dialog-delete-pos-group">
            <div className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-rose-50 text-rose-700"><Trash2 className="h-5 w-5" /></div>
            <h2 id="pos-group-delete-title" className="text-lg font-bold text-slate-900">{tr("deleteTitle", "حذف مجموعة العرض؟")}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {tr("deleteDescription", "سيتم حذف المجموعة «{{name}}». لا يمكن التراجع عن هذا الإجراء.", { name: pickName(deleteTarget) })}
            </p>
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">{tr("deleteImpact", "قد يمنع النظام الحذف إذا كانت المجموعة مرتبطة بأصناف.")}</p>
            {deleteGroup.isError && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800" role="alert" data-testid="status-pos-group-delete-error">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{displayError(deleteGroup.error)}</span>
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteGroup.isPending} data-testid="button-cancel-delete-pos-group">{common("cancel", "إلغاء")}</Button>
              <Button variant="destructive" className="gap-2" onClick={() => deleteGroup.mutate({ id: deleteTarget.id })} disabled={deleteGroup.isPending} data-testid="button-confirm-delete-pos-group">
                {deleteGroup.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {deleteGroup.isPending ? tr("deleting", "جارٍ الحذف…") : tr("confirmDelete", "حذف المجموعة")}
              </Button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
