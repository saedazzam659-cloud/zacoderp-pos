import { useEffect, useMemo, useRef, useState } from "react";
import {
  getListAdminModuleShowcaseQueryKey,
  useCreateAdminModuleShowcaseImage,
  useDeleteAdminModuleShowcaseImage,
  useGetAdminModuleShowcaseUploadUrl,
  useListAdminModuleShowcase,
  type ModuleShowcaseImage,
  type ModuleShowcaseImageModuleKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  ImagePlus, Trash2, UploadCloud, X, RefreshCw, Images, ShieldCheck,
} from "lucide-react";

const MODULES = [
  { key: "accounting", label: "المحاسبة" },
  { key: "banks", label: "البنوك والخزينة" },
  { key: "fixedAssets", label: "الأصول الثابتة" },
  { key: "inventory", label: "المخزون" },
  { key: "sales", label: "المبيعات" },
  { key: "purchases", label: "المشتريات" },
  { key: "production", label: "الإنتاج والتصنيع" },
  { key: "projects", label: "المشاريع" },
  { key: "contracting", label: "المقاولات" },
  { key: "maintenance", label: "الصيانة" },
  { key: "hr", label: "الموارد البشرية" },
  { key: "hotels", label: "الفنادق" },
  { key: "hospitals", label: "المستشفيات" },
] as const;

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
type ModuleKey = ModuleShowcaseImageModuleKey;
type Draft = { id: string; file: File; preview: string; caption: string; altText: string; status: "ready" | "uploading" };

export default function ModuleShowcase() {
  const { toast } = useToast();
  const [moduleKey, setModuleKey] = useState<ModuleKey>("accounting");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [working, setWorking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const draftUrls = useRef(new Set<string>());
  const queryClient = useQueryClient();
  const listQuery = useListAdminModuleShowcase();
  const createImage = useCreateAdminModuleShowcaseImage();
  const getUploadUrl = useGetAdminModuleShowcaseUploadUrl();
  const deleteImageMutation = useDeleteAdminModuleShowcaseImage();
  const images = listQuery.data?.images ?? [];
  const selectedModule = MODULES.find(item => item.key === moduleKey)!;
  const currentImages = useMemo(
    () => images.filter(image => image.moduleKey === moduleKey).sort((a, b) => a.sortOrder - b.sortOrder),
    [images, moduleKey],
  );
  const loading = listQuery.isLoading;
  const error = listQuery.isError ? "تعذر تحميل صور الوحدات" : "";
  useEffect(() => () => draftUrls.current.forEach(url => URL.revokeObjectURL(url)), []);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const accepted = Array.from(files).filter(file =>
      ["image/png", "image/jpeg", "image/webp"].includes(file.type) && file.size <= 12 * 1024 * 1024,
    );
    if (accepted.length !== files.length) toast({ title: "استخدم PNG أو JPG أو WebP بحجم لا يتجاوز 12 ميغابايت للصورة", variant: "destructive" });
    const next = accepted.map(file => {
      const preview = URL.createObjectURL(file);
      draftUrls.current.add(preview);
      return {
        id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
        file,
        preview,
        caption: "",
        altText: file.name.replace(/\.[^.]+$/, ""),
        status: "ready" as const,
      };
    });
    setDrafts(prev => [...prev, ...next]);
  };

  const updateDraft = (id: string, field: "caption" | "altText", value: string) =>
    setDrafts(prev => prev.map(draft => draft.id === id ? { ...draft, [field]: value } : draft));

  const removeDraft = (id: string) => {
    const target = drafts.find(draft => draft.id === id);
    if (target) {
      URL.revokeObjectURL(target.preview);
      draftUrls.current.delete(target.preview);
    }
    setDrafts(prev => prev.filter(draft => draft.id !== id));
  };

  const uploadAll = async () => {
    if (!drafts.length || working) return;
    setWorking(true);
    let uploaded = 0;
    try {
      for (const draft of drafts) {
        setDrafts(prev => prev.map(item => item.id === draft.id ? { ...item, status: "uploading" } : item));
        if (draft.file.name.length > 180 || draft.altText.trim().length > 180 || draft.caption.trim().length > 160) {
          throw new Error("تأكد من أن اسم الملف لا يتجاوز 180 حرفًا، والوصف 180 حرفًا، والعنوان 160 حرفًا");
        }
        const { uploadURL, objectPath } = await getUploadUrl.mutateAsync({
          data: { name: draft.file.name, size: draft.file.size, contentType: draft.file.type as "image/png" | "image/jpeg" | "image/webp" },
        });
        const uploadResponse = await fetch(uploadURL, {
          method: "PUT",
          headers: { "Content-Type": draft.file.type },
          body: draft.file,
        });
        if (!uploadResponse.ok) throw new Error(`تعذر رفع ${draft.file.name}`);
        await createImage.mutateAsync({
          data: {
            moduleKey,
            objectPath,
            caption: draft.caption.trim(),
            altText: draft.altText.trim() || draft.file.name.slice(0, 180),
          },
        });
        uploaded++;
        removeDraft(draft.id);
      }
      toast({ title: `تم رفع ${uploaded} صورة بنجاح` });
      await queryClient.invalidateQueries({ queryKey: getListAdminModuleShowcaseQueryKey() });
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "تعذر رفع الصور", variant: "destructive" });
      await queryClient.invalidateQueries({ queryKey: getListAdminModuleShowcaseQueryKey() });
    } finally {
      setWorking(false);
    }
  };

  const deleteImage = async (image: ModuleShowcaseImage) => {
    if (!window.confirm("هل تريد إزالة هذه الصورة من معرض الوحدة؟")) return;
    try {
      await deleteImageMutation.mutateAsync({ id: image.id });
      await queryClient.invalidateQueries({ queryKey: getListAdminModuleShowcaseQueryKey() });
      toast({ title: "تمت إزالة الصورة" });
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "تعذر حذف الصورة", variant: "destructive" });
    }
  };

  return (
    <main dir="rtl" className="mx-auto max-w-7xl space-y-6 pb-12" data-testid="page-module-showcase">
      <header className="relative overflow-hidden rounded-[1.75rem] bg-[linear-gradient(120deg,#123d3a_0%,#17685d_60%,#b9d6b1_160%)] px-6 py-7 text-white shadow-lg sm:px-8">
        <div className="pointer-events-none absolute -start-12 -top-16 h-56 w-56 rounded-full border border-white/15" />
        <div className="pointer-events-none absolute -start-3 -top-7 h-40 w-40 rounded-full border border-white/10" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold">
              <ShieldCheck className="h-3.5 w-3.5" /> إدارة المحتوى العام
            </span>
            <h1 className="mt-4 text-2xl font-extrabold sm:text-3xl">معرض لقطات الوحدات</h1>
             <p className="mt-2 max-w-xl text-sm leading-7 text-white/80">اعرض واجهات Zacod ERP الحقيقية للزوار. اختر الوحدة وأضف صورًا متعددة مع وصف واضح لكل لقطة.</p>
          </div>
          <div className="flex shrink-0 items-center gap-3 rounded-2xl border border-white/15 bg-white/10 px-4 py-3">
            <Images className="h-5 w-5 text-emerald-100" />
            <div><div className="text-2xl font-bold leading-none">{images.length}</div><div className="mt-1 text-xs text-white/75">صورة منشورة</div></div>
          </div>
        </div>
      </header>

      <section className="grid gap-5 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.7fr)]">
        <aside className="rounded-3xl border border-border bg-card p-4 shadow-sm sm:p-5">
          <div className="mb-3 flex items-center justify-between">
            <div><p className="text-xs font-bold text-primary">الخطوة الأولى</p><h2 className="mt-1 font-bold">اختر الوحدة</h2></div>
            <span className="rounded-xl bg-primary/10 p-2 text-primary"><Images className="h-4 w-4" /></span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-1">
            {MODULES.map((item, index) => {
              const count = images.filter(image => image.moduleKey === item.key).length;
              return <button key={item.key} type="button" data-testid={`button-module-${item.key}`} onClick={() => setModuleKey(item.key)}
                className={`flex min-h-11 items-center justify-between gap-2 rounded-xl border px-3 py-2 text-right text-sm transition-colors ${moduleKey === item.key ? "border-primary bg-primary/8 font-bold text-primary" : "border-border bg-background hover:border-primary/40"}`}>
                <span className="flex min-w-0 items-center gap-2"><span className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg text-[10px] ${moduleKey === item.key ? "bg-primary text-white" : "bg-muted text-muted-foreground"}`}>{String(index + 1).padStart(2, "0")}</span><span className="truncate">{item.label}</span></span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{count}</span>
              </button>;
            })}
          </div>
        </aside>

        <div className="space-y-5">
          <section className="rounded-3xl border border-border bg-card p-5 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><p className="text-xs font-bold text-primary">الخطوة الثانية</p><h2 className="mt-1 text-lg font-bold">إضافة صور · {selectedModule.label}</h2><p className="mt-1 text-sm text-muted-foreground">PNG أو JPG أو WebP. أضف وصفًا بديلًا واضحًا لكل لقطة.</p></div>
              <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} data-testid="button-select-showcase-images"><ImagePlus className="ms-2 h-4 w-4" />اختيار صور</Button>
              <input ref={fileInput} type="file" multiple accept="image/*" className="hidden" data-testid="input-showcase-images" onChange={event => { addFiles(event.target.files); event.currentTarget.value = ""; }} />
            </div>
            <button type="button" onClick={() => fileInput.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); addFiles(event.dataTransfer.files); }}
              className="mt-5 flex min-h-36 w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-primary/25 bg-primary/[0.035] px-4 text-center transition-colors hover:border-primary/50 hover:bg-primary/[0.06]" data-testid="dropzone-showcase-images">
              <span className="grid h-11 w-11 place-items-center rounded-2xl bg-primary/10 text-primary"><UploadCloud className="h-5 w-5" /></span>
              <span className="mt-3 text-sm font-bold">اسحب الصور إلى هنا أو اخترها من جهازك</span>
              <span className="mt-1 text-xs text-muted-foreground">يمكن اختيار عدة صور دفعة واحدة</span>
            </button>
            {drafts.length > 0 && <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between gap-3"><h3 className="font-bold">جاهزة للإضافة <span className="text-muted-foreground">({drafts.length})</span></h3><Button type="button" onClick={uploadAll} disabled={working} data-testid="button-upload-showcase">{working ? "جارٍ الرفع…" : `رفع ${drafts.length} صورة`}<UploadCloud className="me-2 h-4 w-4" /></Button></div>
              <div className="grid gap-3 sm:grid-cols-2">
                {drafts.map(draft => <article key={draft.id} className="overflow-hidden rounded-2xl border border-border bg-background" data-testid={`card-showcase-draft-${draft.id}`}>
                  <div className="relative aspect-[16/9] bg-muted"><img src={draft.preview} alt={draft.altText} className="h-full w-full object-cover" /><button type="button" aria-label="إزالة من قائمة الرفع" onClick={() => removeDraft(draft.id)} className="absolute end-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-slate-950/70 text-white hover:bg-rose-700" data-testid={`button-remove-draft-${draft.id}`}><X className="h-4 w-4" /></button></div>
                  <div className="space-y-2 p-3"><Input value={draft.caption} onChange={event => updateDraft(draft.id, "caption", event.target.value)} placeholder="عنوان اللقطة (اختياري)" aria-label="عنوان اللقطة" data-testid={`input-caption-${draft.id}`} /><Input value={draft.altText} onChange={event => updateDraft(draft.id, "altText", event.target.value)} placeholder="وصف الصورة لقارئات الشاشة" aria-label="الوصف البديل" data-testid={`input-alt-${draft.id}`} /></div>
                </article>)}
              </div>
            </div>}
          </section>

          <section className="rounded-3xl border border-border bg-card p-5 shadow-sm sm:p-6">
            <div className="mb-4 flex items-center justify-between gap-3"><div><p className="text-xs font-bold text-primary">الخطوة الثالثة</p><h2 className="mt-1 text-lg font-bold">الصور المنشورة</h2></div><span className="text-sm text-muted-foreground">{currentImages.length} لقطة · {selectedModule.label}</span></div>
            {loading ? <div className="grid gap-3 sm:grid-cols-2"><div className="h-44 animate-pulse rounded-2xl bg-muted" /><div className="h-44 animate-pulse rounded-2xl bg-muted" /></div>
              : error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-center"><p className="text-sm text-rose-800">{error}</p><Button variant="outline" className="mt-3" onClick={() => void listQuery.refetch()} data-testid="button-retry-showcase"><RefreshCw className="ms-2 h-4 w-4" />إعادة المحاولة</Button></div>
              : currentImages.length === 0 ? <div className="rounded-2xl border border-dashed border-border bg-muted/25 px-5 py-10 text-center"><div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary"><Images className="h-5 w-5" /></div><h3 className="mt-3 font-bold">لا توجد لقطات لهذه الوحدة بعد</h3><p className="mt-1 text-sm text-muted-foreground">ابدأ بإضافة صور واضحة تعرّف الزائر على تجربة {selectedModule.label}.</p></div>
              : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{currentImages.map(image => <article key={image.id} className="group overflow-hidden rounded-2xl border border-border bg-background" data-testid={`card-showcase-image-${image.id}`}><div className="relative aspect-[16/10] overflow-hidden bg-muted"><img src={`${API_BASE}${image.url}`} alt={image.altText} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.025]" /><button type="button" aria-label="حذف الصورة" onClick={() => void deleteImage(image)} className="absolute end-2 top-2 grid h-9 w-9 place-items-center rounded-xl bg-slate-950/75 text-white hover:bg-rose-700" data-testid={`button-delete-showcase-${image.id}`}><Trash2 className="h-4 w-4" /></button></div><div className="p-3"><p className="truncate text-sm font-bold">{image.caption || image.altText || selectedModule.label}</p><p className="mt-1 truncate text-xs text-muted-foreground">{image.altText}</p></div></article>)}</div>}
          </section>
        </div>
      </section>
    </main>
  );
}
