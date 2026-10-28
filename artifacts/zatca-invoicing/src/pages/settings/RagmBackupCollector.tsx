import { useMemo, useState } from "react";
import JSZip from "jszip";
import { AlertTriangle, Archive, Download, FilePlus2, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type CategoryId =
  | "master_data"
  | "sales"
  | "sales_returns"
  | "purchases"
  | "purchase_returns"
  | "journal_entries"
  | "receipts"
  | "payments"
  | "account_notes"
  | "inventory"
  | "hr_payroll"
  | "fixed_assets"
  | "attachments"
  | "other";

type Category = {
  id: CategoryId;
  ar: string;
  en: string;
  currentSupport: "supported" | "partial" | "not_verified";
};

const CATEGORIES: Category[] = [
  { id: "master_data", ar: "البيانات التأسيسية", en: "Master data", currentSupport: "partial" },
  { id: "sales", ar: "فواتير المبيعات", en: "Sales invoices", currentSupport: "supported" },
  { id: "sales_returns", ar: "مرتجعات المبيعات", en: "Sales returns", currentSupport: "supported" },
  { id: "purchases", ar: "فواتير المشتريات", en: "Purchase invoices", currentSupport: "supported" },
  { id: "purchase_returns", ar: "مرتجعات المشتريات", en: "Purchase returns", currentSupport: "supported" },
  { id: "journal_entries", ar: "قيود اليومية", en: "Journal entries", currentSupport: "supported" },
  { id: "receipts", ar: "سندات القبض", en: "Receipt vouchers", currentSupport: "partial" },
  { id: "payments", ar: "سندات الصرف", en: "Payment vouchers", currentSupport: "partial" },
  { id: "account_notes", ar: "الإشعارات المدينة والدائنة", en: "Debit and credit notes", currentSupport: "partial" },
  { id: "inventory", ar: "الأرصدة وحركات المخزون", en: "Inventory balances and movements", currentSupport: "not_verified" },
  { id: "hr_payroll", ar: "الموظفون والرواتب", en: "Employees and payroll", currentSupport: "not_verified" },
  { id: "fixed_assets", ar: "الأصول الثابتة", en: "Fixed assets", currentSupport: "not_verified" },
  { id: "attachments", ar: "المرفقات والوثائق", en: "Attachments and documents", currentSupport: "not_verified" },
  { id: "other", ar: "بيانات أخرى", en: "Other data", currentSupport: "not_verified" },
];

type CollectedFile = { id: string; file: File; categoryId: CategoryId };

const labelFor = (categoryId: CategoryId, isAr: boolean) => {
  const category = CATEGORIES.find((item) => item.id === categoryId)!;
  return isAr ? category.ar : category.en;
};

function safeFileName(name: string) {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "export";
}

function uniqueArchivePath(path: string, used: Set<string>) {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash + 1);
  const filename = path.slice(slash + 1);
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  let index = 2;
  let candidate = "";
  do {
    candidate = `${folder}${stem} (${index++})${extension}`;
  } while (used.has(candidate));
  used.add(candidate);
  return candidate;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RagmBackupCollector({ isAr }: { isAr: boolean }) {
  const [files, setFiles] = useState<CollectedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  const categoryCounts = useMemo(() => {
    const counts = new Map<CategoryId, number>();
    for (const item of files) counts.set(item.categoryId, (counts.get(item.categoryId) ?? 0) + 1);
    return counts;
  }, [files]);

  function addFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    const additions = Array.from(fileList).map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
      file,
      categoryId: "other" as CategoryId,
    }));
    setFiles((current) => [...current, ...additions]);
    setComplete(false);
    setError("");
  }

  function updateCategory(id: string, categoryId: CategoryId) {
    setFiles((current) => current.map((item) => item.id === id ? { ...item, categoryId } : item));
    setComplete(false);
  }

  function removeFile(id: string) {
    setFiles((current) => current.filter((item) => item.id !== id));
    setComplete(false);
  }

  async function createArchive() {
    if (!files.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const zip = new JSZip();
      const usedPaths = new Set<string>();
      const manifestFiles = await Promise.all(files.map(async ({ file, categoryId }) => {
        const path = uniqueArchivePath(
          `${categoryId}/${safeFileName(file.name)}`,
          usedPaths,
        );
        zip.file(path, file);
        let sha256: string | null = null;
        if (globalThis.crypto?.subtle) {
          const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
          sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        }
        return {
          path,
          originalName: file.name,
          category: categoryId,
          sizeBytes: file.size,
          lastModified: new Date(file.lastModified).toISOString(),
          sha256,
        };
      }));

      const manifest = {
        format: "ragm-company-backup-collection",
        formatVersion: 1,
        sourceSystem: "RAGM Cloud",
        sourceUrl: "https://erp.ragmcloud.net/",
        createdAt: new Date().toISOString(),
        collectionMethod: "User-downloaded files; no login automation or source-system connection.",
        completeness: "Not verified. This package contains only the files selected by the user.",
        files: manifestFiles,
        categories: CATEGORIES.map((category) => ({
          id: category.id,
          label: labelFor(category.id, isAr),
          fileCount: categoryCounts.get(category.id) ?? 0,
          importSupport: category.currentSupport,
        })),
      };

      zip.file("manifest.json", JSON.stringify(manifest, null, 2));
      zip.file(
        "README.txt",
        isAr
          ? [
              "حزمة جمع ملفات شركة من RAGM Cloud",
              "",
              "تحتوي هذه الحزمة على الملفات التي اختارها المستخدم يدويًا فقط.",
              "هذه ليست نسخة احتياطية مؤكدة أو كاملة من قاعدة بيانات RAGM.",
              "لم تسجل الأداة الدخول إلى RAGM ولم تتصل بخوادمه.",
              "راجع manifest.json وقائمة الملفات والفئات قبل استخدامها في الاستيراد.",
              "احتفظ بنسخة النظام القديم حتى اكتمال مطابقة الأعداد والأرصدة والمرفقات.",
            ].join("\n")
          : [
              "RAGM Cloud company file collection",
              "",
              "This package contains only the files manually selected by the user.",
              "It is not a verified or complete backup of the RAGM database.",
              "The tool did not sign in to RAGM or connect to its servers.",
              "Review manifest.json and the file/category list before importing.",
              "Keep the legacy system available until counts, balances, and attachments reconcile.",
            ].join("\n"),
      );

      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 4 } });
      downloadBlob(blob, `ragm-company-collection-${new Date().toISOString().slice(0, 10)}.zip`);
      setComplete(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (isAr ? "تعذر إنشاء الحزمة." : "Could not create the archive."));
    } finally {
      setBusy(false);
    }
  }

  const text = isAr ? {
    title: "جمع ملفات RAGM يدويًا",
    intro: "سجّل الدخول إلى RAGM بنفسك، واستخدم خيارات التنزيل المتاحة في شاشاته. أضف الملفات هنا وصنّفها، ثم نزّل حزمة ZIP تحتوي الملفات الأصلية وبيانًا لفحصها.",
    safety: "تعمل هذه الخطوة داخل المتصفح فقط. لا تطلب كلمة مرور أو ملفات جلسة، ولا تتصل بـRAGM.",
    warning: "هذه حزمة للملفات التي أضفتها فقط، وليست نسخة كاملة مؤكدة من الشركة. غياب ملف من فئة لا يعني أن تلك البيانات غير موجودة في RAGM.",
    supportTitle: "حالة مسارات الاستيراد الحالية",
    supports: {
      supported: "مسار استيراد موجود",
      partial: "دعم جزئي أو بقيود",
      not_verified: "غير مغطى/غير متحقق",
    },
    add: "إضافة الملفات",
    files: "الملفات المضافة",
    empty: "لم تضف ملفات بعد.",
    category: "فئة الملف",
    remove: "إزالة الملف",
    make: "إنشاء وتنزيل ZIP",
    making: "جارٍ إنشاء الحزمة…",
    done: "تم تنزيل الحزمة. راجع manifest.json داخلها.",
    fileCount: "عدد الملفات",
    bytes: "الحجم",
  } : {
    title: "Collect RAGM files manually",
    intro: "Sign in to RAGM yourself and use the download options available in its screens. Add and categorize the files here, then download a ZIP with the originals and a review manifest.",
    safety: "This runs in your browser only. It does not ask for passwords or session files, and it does not connect to RAGM.",
    warning: "This package contains only the files you added; it is not a verified full-company backup. A missing category does not mean that data is absent from RAGM.",
    supportTitle: "Current import-flow coverage",
    supports: {
      supported: "Import flow available",
      partial: "Partial or constrained",
      not_verified: "Not covered/verified",
    },
    add: "Add files",
    files: "Added files",
    empty: "No files added yet.",
    category: "File category",
    remove: "Remove file",
    make: "Build and download ZIP",
    making: "Building archive…",
    done: "Archive downloaded. Review manifest.json inside it.",
    fileCount: "Files",
    bytes: "Size",
  };

  return (
    <div className="space-y-4" data-testid="ragm-backup-collector">
      <Card className="border-sky-200 bg-gradient-to-br from-sky-50 via-background to-indigo-50 p-4 md:p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-sky-100 p-3 text-sky-800"><Archive className="h-6 w-6" /></div>
          <div className="min-w-0">
            <h2 className="text-lg font-bold">{text.title}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{text.intro}</p>
          </div>
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{text.safety}</p>
        </div>
      </Card>

      <Card className="border-amber-200 bg-amber-50/70 p-4" role="note">
        <div className="flex items-start gap-2 text-amber-950">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="text-sm leading-6">{text.warning}</p>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">{text.supportTitle}</h3>
            <p className="text-xs text-muted-foreground">
              {isAr ? "التصنيف يصف مسارات ERP الحالية ولا يضمن توافق ملف RAGM بعينه." : "Coverage describes existing ERP flows; it does not guarantee a specific RAGM file will match."}
            </p>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted">
            <FilePlus2 className="h-4 w-4" />
            {text.add}
            <input
              type="file"
              multiple
              className="sr-only"
              data-testid="ragm-collection-file-input"
              onChange={(event) => {
                addFiles(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["supported", "partial", "not_verified"] as const).map((status) => (
            <Badge key={status} variant="outline" className="font-normal">
              {text.supports[status]} · {CATEGORIES.filter((category) => category.currentSupport === status).length}
            </Badge>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORIES.map((category) => (
            <div key={category.id} className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm">
              <span>{isAr ? category.ar : category.en}</span>
              <Badge variant={categoryCounts.has(category.id) ? "secondary" : "outline"}>{categoryCounts.get(category.id) ?? 0}</Badge>
            </div>
          ))}
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{text.files}</h3>
          <div className="text-xs text-muted-foreground">
            {text.fileCount}: {files.length} · {text.bytes}: {files.reduce((sum, item) => sum + item.file.size, 0).toLocaleString()}
          </div>
        </div>
        {files.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{text.empty}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {files.map(({ id, file, categoryId }) => (
              <li key={id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium" title={file.name}>{file.name}</div>
                  <div className="text-xs text-muted-foreground">{file.size.toLocaleString()} bytes</div>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <span className="sr-only">{text.category}</span>
                  <select
                    className="h-9 max-w-full rounded-md border bg-background px-2 text-sm"
                    aria-label={`${text.category}: ${file.name}`}
                    value={categoryId}
                    onChange={(event) => updateCategory(id, event.target.value as CategoryId)}
                  >
                    {CATEGORIES.map((category) => (
                      <option key={category.id} value={category.id}>{isAr ? category.ar : category.en}</option>
                    ))}
                  </select>
                </label>
                <Button type="button" size="icon" variant="ghost" aria-label={text.remove} title={text.remove} onClick={() => removeFile(id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {complete && <p role="status" className="text-sm text-emerald-700">{text.done}</p>}
        <Button type="button" onClick={createArchive} disabled={!files.length || busy} className="gap-2">
          {busy ? <Archive className="h-4 w-4 animate-pulse" /> : <Download className="h-4 w-4" />}
          {busy ? text.making : text.make}
        </Button>
      </Card>
    </div>
  );
}
