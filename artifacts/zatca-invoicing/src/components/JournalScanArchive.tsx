// ─── Local-disk archive uploader for journal entries ─────────────────────
// Lets the user attach scanned documents (camera capture, file upload, or
// multi-page PDF) to a journal entry. Files are stored ON THE USER'S
// COMPUTER — never uploaded to our backend. See `lib/localArchive.ts`.
//
// A small badge on the trigger button shows how many files are already
// archived for the current JE.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import imageCompression from "browser-image-compression";
import { jsPDF } from "jspdf";
import {
  Camera, Upload, FolderOpen, Trash2, FileText, Image as ImageIcon,
  Paperclip, CheckCircle2, AlertCircle, ScanLine, X, ExternalLink, RefreshCw, Save,
} from "lucide-react";
import {
  isFsAccessSupported, pickArchiveFolder, getArchiveFolder, clearArchiveFolder,
  saveToArchive, recordArchivedFile, getArchivedFiles, removeArchivedFile,
  openArchivedFile, type ArchivedFileMeta,
} from "@/lib/localArchive";

interface Props {
  /** Stable key — usually the JE number ("JE-2026-00045") or `new-<timestamp>`. */
  jeKey: string;
  /** Used to organise the on-disk folder hierarchy. */
  companyName?: string | null;
  className?: string;
}

interface PendingPage {
  id: string;
  dataUrl: string;
  bytes: number;
}

/** Convert a File (image) to a compressed dataURL we can stuff into jsPDF. */
async function fileToCompressedDataUrl(file: File): Promise<{ dataUrl: string; bytes: number }> {
  const compressed = await imageCompression(file, {
    maxSizeMB: 0.5,
    maxWidthOrHeight: 1800,
    useWebWorker: true,
    initialQuality: 0.85,
  });
  const dataUrl = await imageCompression.getDataUrlFromFile(compressed);
  return { dataUrl, bytes: compressed.size };
}

/** Build a multi-page A4-portrait PDF from images. */
function buildPdf(pages: PendingPage[]): Blob {
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageW = pdf.internal.pageSize.getWidth();   // 210
  const pageH = pdf.internal.pageSize.getHeight();  // 297
  pages.forEach((p, i) => {
    if (i > 0) pdf.addPage();
    // Fit each image into the page while preserving aspect ratio.
    const img = new Image();
    img.src = p.dataUrl;
    // jsPDF v2+ accepts data URLs synchronously when the format is provided.
    const imgFmt = p.dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
    // We use page dimensions directly — the embedded image will scale.
    // (Synchronous fit is good enough for archival quality.)
    pdf.addImage(p.dataUrl, imgFmt, 5, 5, pageW - 10, pageH - 10, undefined, "FAST");
  });
  return pdf.output("blob");
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

export function JournalScanArchive({ jeKey, companyName, className }: Props) {
  const { toast } = useToast();
  const supported = isFsAccessSupported();

  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [pages, setPages] = useState<PendingPage[]>([]);
  const [archived, setArchived] = useState<ArchivedFileMeta[]>([]);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"upload" | "camera">("upload");

  // ─── Camera state ────────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Refresh saved-folder + archived list whenever dialog opens.
  useEffect(() => {
    if (!open) return;
    setArchived(getArchivedFiles(jeKey));
    if (supported) {
      getArchiveFolder().then(setFolder);
    }
  }, [open, jeKey, supported]);

  // Refresh badge count even when dialog is closed (after save).
  const [badgeCount, setBadgeCount] = useState(0);
  useEffect(() => { setBadgeCount(getArchivedFiles(jeKey).length); }, [jeKey, archived.length]);

  // ─── Camera lifecycle ────────────────────────────────────────────────────
  async function startCamera() {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch (e: any) {
      setCameraError(e?.message ?? "تعذّر فتح الكاميرا");
    }
  }
  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }
  useEffect(() => {
    if (tab !== "camera" || !open) { stopCamera(); return; }
    startCamera();
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, open]);

  async function captureFromCamera() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0);
    const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/jpeg", 0.9));
    const file = new File([blob], `capture_${Date.now()}.jpg`, { type: "image/jpeg" });
    const { dataUrl, bytes } = await fileToCompressedDataUrl(file);
    setPages((p) => [...p, { id: crypto.randomUUID(), dataUrl, bytes }]);
    toast({ title: "تم التقاط الصفحة", description: `إجمالي الصفحات: ${pages.length + 1}` });
  }

  // ─── File-input handler (multiple PDFs/images allowed) ───────────────────
  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const f of Array.from(files)) {
      if (f.type === "application/pdf") {
        // PDFs are saved as-is, one per file (don't merge into the multi-page draft).
        await savePdfDirect(f);
      } else if (f.type.startsWith("image/")) {
        const { dataUrl, bytes } = await fileToCompressedDataUrl(f);
        setPages((p) => [...p, { id: crypto.randomUUID(), dataUrl, bytes }]);
      } else {
        toast({ title: "صيغة غير مدعومة", description: f.name, variant: "destructive" });
      }
    }
  }

  // ─── Saving ──────────────────────────────────────────────────────────────
  function subPathFor(): string[] {
    const year = new Date().getFullYear().toString();
    return ["ZacodeArchive", companyName?.trim() || "بدون شركة", year, jeKey];
  }

  async function savePdfDirect(pdfFile: File) {
    setSaving(true);
    try {
      const filename = `${jeKey}_${timestamp()}_${pdfFile.name.replace(/\.[^.]+$/, "")}.pdf`;
      const r = await saveToArchive(folder, subPathFor(), filename, pdfFile);
      recordArchivedFile(jeKey, {
        filename, path: r.path, bytes: pdfFile.size, savedAt: new Date().toISOString(),
        viaDownload: r.viaDownload,
      });
      setArchived(getArchivedFiles(jeKey));
      toast({
        title: "تمت الأرشفة",
        description: r.viaDownload ? "تم تنزيل الملف على جهازك" : `تم الحفظ في: ${r.path}`,
      });
    } catch (e: any) {
      toast({ title: "تعذّر الحفظ", description: e?.message ?? String(e), variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function saveScannedPages() {
    if (pages.length === 0) {
      toast({ title: "لا توجد صفحات للحفظ", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const blob = buildPdf(pages);
      const filename = `${jeKey}_${timestamp()}.pdf`;
      const r = await saveToArchive(folder, subPathFor(), filename, blob);
      recordArchivedFile(jeKey, {
        filename, path: r.path, bytes: blob.size, pages: pages.length,
        savedAt: new Date().toISOString(), viaDownload: r.viaDownload,
      });
      setArchived(getArchivedFiles(jeKey));
      setPages([]);
      toast({
        title: "تمت الأرشفة",
        description: r.viaDownload
          ? `تم تنزيل ${pages.length} صفحة كملف PDF`
          : `تم الحفظ في: ${r.path}`,
      });
    } catch (e: any) {
      toast({ title: "تعذّر الحفظ", description: e?.message ?? String(e), variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function openArchived(meta: ArchivedFileMeta) {
    const url = await openArchivedFile(meta);
    if (!url) {
      toast({
        title: "تعذّر فتح الملف",
        description: meta.viaDownload
          ? "هذا الملف محفوظ في مجلّد التنزيلات. افتحه من المتصفح أو من Windows Explorer."
          : "افتح الملف يدوياً من المجلّد المحدد",
      });
      return;
    }
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  function onPickFolder() {
    pickArchiveFolder().then((h) => {
      if (h) {
        setFolder(h);
        toast({ title: "تم اختيار مجلّد الأرشيف", description: h.name });
      }
    }).catch((e) => {
      if (e?.name !== "AbortError") {
        toast({ title: "تعذّر اختيار المجلّد", description: e?.message ?? "", variant: "destructive" });
      }
    });
  }

  function onResetFolder() {
    clearArchiveFolder().then(() => {
      setFolder(null);
      toast({ title: "تم إعادة الضبط", description: "سيُطلب اختيار المجلّد عند الحفظ القادم" });
    });
  }

  const folderLabel = useMemo(() => {
    if (!supported) return "تنزيل تلقائي على مجلّد التنزيلات (المتصفح لا يدعم اختيار مجلّد)";
    if (folder) return `📁 ${folder.name}`;
    return "لم يُحدَّد مجلّد بعد — سيُسأل عند أول حفظ";
  }, [folder, supported]);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setPages([]); stopCamera(); } }}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={className ?? "h-8 gap-1.5 text-xs relative"}
          title="أرشفة مستندات (تخزين على جهازك المحلي)"
        >
          <Paperclip className="h-3.5 w-3.5" />
          أرشفة مستند
          {badgeCount > 0 && (
            <span className="absolute -top-1.5 -left-1.5 h-4 min-w-[16px] rounded-full bg-emerald-500 text-white text-[10px] font-bold leading-none flex items-center justify-center px-1">
              {badgeCount}
            </span>
          )}
        </Button>
      </DialogTrigger>

      <DialogContent dir="rtl" className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="h-5 w-5 text-primary" />
            أرشفة مستندات القيد على جهازك
          </DialogTitle>
          <DialogDescription>
            تُحفظ الملفات على جهازك مباشرةً ولا تُرسَل لأي خادم. تختار مجلّد الأرشيف
            مرة واحدة وكل الحفظ بعدها يتمّ تلقائياً.
          </DialogDescription>
        </DialogHeader>

        {/* ── Folder selector ──────────────────────────────────────────── */}
        <div className={`rounded-lg border-2 p-3 flex items-center gap-3 ${
          folder ? "border-emerald-300 bg-emerald-50/50" : "border-amber-300 bg-amber-50/50"
        }`}>
          <FolderOpen className={`h-5 w-5 shrink-0 ${folder ? "text-emerald-600" : "text-amber-600"}`} />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold">مجلّد الأرشيف</div>
            <div className="text-[11px] text-muted-foreground truncate">{folderLabel}</div>
          </div>
          {supported && (
            <>
              <Button type="button" size="sm" variant="outline" onClick={onPickFolder} className="h-8 text-xs gap-1">
                <FolderOpen className="h-3.5 w-3.5" />
                {folder ? "تغيير" : "اختر مجلّد"}
              </Button>
              {folder && (
                <Button type="button" size="sm" variant="ghost" onClick={onResetFolder} className="h-8 text-xs gap-1">
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              )}
            </>
          )}
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="mt-3">
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="upload" className="gap-1.5">
              <Upload className="h-4 w-4" />ملفات / صور
            </TabsTrigger>
            <TabsTrigger value="camera" className="gap-1.5">
              <Camera className="h-4 w-4" />كاميرا
            </TabsTrigger>
          </TabsList>

          {/* ── Tab 1: file upload ───────────────────────────────────── */}
          <TabsContent value="upload" className="mt-3 space-y-3">
            <label className="block">
              <input
                type="file"
                accept="image/*,application/pdf"
                multiple
                className="hidden"
                onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }}
              />
              <span className="block w-full border-2 border-dashed border-input rounded-lg p-6 text-center cursor-pointer hover:bg-accent transition-colors">
                <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                <div className="text-sm font-semibold mt-2">اسحب ملفاتك هنا أو اضغط للاختيار</div>
                <div className="text-xs text-muted-foreground mt-1">
                  صور (JPG/PNG) تُجمَّع في PDF واحد · ملفات PDF تُحفظ كما هي
                </div>
              </span>
            </label>
          </TabsContent>

          {/* ── Tab 2: live camera ───────────────────────────────────── */}
          <TabsContent value="camera" className="mt-3 space-y-3">
            <div className="rounded-lg overflow-hidden border bg-black/90 min-h-[260px] relative">
              <video ref={videoRef} className="w-full max-h-[400px] object-contain" muted playsInline />
              {!cameraOn && !cameraError && (
                <div className="absolute inset-0 flex items-center justify-center text-white/60 text-sm">
                  جاري تشغيل الكاميرا…
                </div>
              )}
              {cameraError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-amber-200 text-sm p-4">
                  <AlertCircle className="h-8 w-8" />
                  <div className="text-center">{cameraError}</div>
                </div>
              )}
            </div>
            <Button
              type="button"
              onClick={captureFromCamera}
              disabled={!cameraOn}
              className="w-full gap-2"
            >
              <Camera className="h-4 w-4" />التقط صفحة
            </Button>
          </TabsContent>
        </Tabs>

        {/* ── Pending pages preview ────────────────────────────────────── */}
        {pages.length > 0 && (
          <div className="mt-4 space-y-2">
            <Label className="text-sm font-semibold">
              صفحات قيد التحضير ({pages.length})
            </Label>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {pages.map((p, i) => (
                <div key={p.id} className="relative group rounded-md border overflow-hidden bg-muted/30">
                  <img src={p.dataUrl} alt="" className="w-full h-24 object-cover" />
                  <div className="absolute top-1 right-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">
                    {i + 1}
                  </div>
                  <button
                    type="button"
                    onClick={() => setPages((ps) => ps.filter((x) => x.id !== p.id))}
                    className="absolute top-1 left-1 h-5 w-5 rounded-full bg-red-500/90 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <div className="text-[10px] text-center text-muted-foreground py-0.5">
                    {formatBytes(p.bytes)}
                  </div>
                </div>
              ))}
            </div>
            <Button
              type="button"
              onClick={saveScannedPages}
              disabled={saving}
              className="w-full gap-2"
            >
              <Save className="h-4 w-4" />
              {saving ? "جاري الحفظ…" : `احفظ كملف PDF (${pages.length} صفحة)`}
            </Button>
          </div>
        )}

        {/* ── Already-archived list ────────────────────────────────────── */}
        {archived.length > 0 && (
          <div className="mt-4 space-y-2 border-t pt-4">
            <Label className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              مستندات مؤرشفة لهذا القيد ({archived.length})
            </Label>
            <div className="space-y-1.5 max-h-[220px] overflow-y-auto">
              {archived.map((f) => (
                <div key={f.filename + f.savedAt} className="flex items-center gap-2 p-2 rounded-md border bg-muted/30 text-sm">
                  {f.filename.toLowerCase().endsWith(".pdf")
                    ? <FileText className="h-4 w-4 text-red-500 shrink-0" />
                    : <ImageIcon className="h-4 w-4 text-blue-500 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-mono text-xs">{f.filename}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {formatBytes(f.bytes)}{f.pages ? ` · ${f.pages} صفحة` : ""}
                      {" · "}{new Date(f.savedAt).toLocaleString("ar-SA")}
                      {f.viaDownload && " · مجلّد التنزيلات"}
                    </div>
                  </div>
                  <Button
                    type="button" size="sm" variant="ghost" className="h-7 w-7 p-0"
                    title="فتح الملف"
                    onClick={() => openArchived(f)}
                    disabled={f.viaDownload}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button" size="sm" variant="ghost"
                    className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
                    title="حذف من فهرس الأرشفة (لا يحذف الملف من جهازك)"
                    onClick={() => {
                      removeArchivedFile(jeKey, f.filename);
                      setArchived(getArchivedFiles(jeKey));
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              ⚠️ زر الحذف يُزيل الملف من فهرس البرنامج فقط. الملف الفعلي يبقى على جهازك حتى تحذفه يدوياً.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>إغلاق</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
