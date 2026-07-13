// Odoo-style split-screen attachment viewer.
//
// A fixed panel pinned to the LEFT edge of the screen (the form stays on the
// right in RTL) that previews the documents archived for the current record:
// PDFs in an <iframe>, images in an <img>, with prev/next navigation, a file
// strip, and per-file actions (open, email, WhatsApp, delete).
//
// Rendered by <JournalScanArchive>, so EVERY screen that uses the archive
// button gets the split view for free. While the panel is open the page body
// gets a matching padding-left (md+ only) so the form is pushed — a true
// split — instead of being covered. On small screens the panel overlays.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  X, ChevronRight, ChevronLeft, ExternalLink, Trash2, FileText,
  Image as ImageIcon, Paperclip, Download,
} from "lucide-react";
import { ArchiveSendButtons } from "@/components/ArchiveSendButtons";
import { openArchivedFile, type ArchivedFileMeta } from "@/lib/localArchive";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const PANEL_W = "min(46vw, 760px)";

export interface PanelCloudFile {
  id: number;
  filename: string;
  contentType?: string | null;
  bytes?: number | null;
  pages?: number | null;
  uploadedByName?: string | null;
  createdAt: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  isCloud: boolean;
  cloudFiles: PanelCloudFile[];
  localFiles: ArchivedFileMeta[];
  token: string | null;
  companyName?: string | null;
  /** When set (cloud mode), the panel jumps to this file id on open/change. */
  focusCloudId?: number | null;
  onDeleteCloud: (f: PanelCloudFile) => void;
  onDeleteLocal: (f: ArchivedFileMeta) => void;
}

type FileKind = "pdf" | "image" | "other";

function kindOf(filename: string, contentType?: string | null): FileKind {
  const n = filename.toLowerCase();
  if (n.endsWith(".pdf") || contentType === "application/pdf") return "pdf";
  if (/\.(jpe?g|png|webp|gif|bmp)$/.test(n) || (contentType ?? "").startsWith("image/")) return "image";
  return "other";
}

function fmtBytes(b?: number | null): string {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

export function ArchivePreviewPanel({
  open, onClose, isCloud, cloudFiles, localFiles, token, companyName,
  focusCloudId, onDeleteCloud, onDeleteLocal,
}: Props) {
  const count = isCloud ? cloudFiles.length : localFiles.length;
  const [idx, setIdx] = useState(0);
  const safeIdx = count === 0 ? 0 : Math.min(idx, count - 1);

  // Jump to the file the user explicitly asked to preview (dialog row button).
  useEffect(() => {
    if (!open || !isCloud || focusCloudId == null) return;
    const i = cloudFiles.findIndex((f) => f.id === focusCloudId);
    if (i >= 0) setIdx(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isCloud, focusCloudId]);

  const cloud = isCloud && count > 0 ? cloudFiles[safeIdx] : null;
  const local = !isCloud && count > 0 ? localFiles[safeIdx] : null;
  const filename = cloud?.filename ?? local?.filename ?? "";
  const kind = useMemo(
    () => kindOf(filename, cloud?.contentType),
    [filename, cloud?.contentType],
  );

  // ─── Push the page content to the right (true split, md+ only) ───────────
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const apply = () => {
      document.body.style.transition = "padding-left .2s ease";
      document.body.style.paddingLeft = mq.matches ? PANEL_W : "0px";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      document.body.style.paddingLeft = "";
    };
  }, [open]);

  // ─── Resolve a preview URL ────────────────────────────────────────────────
  // Cloud: the guarded download endpoint (token in query — same pattern as
  // window.open). Local: an object URL via the File System Access index; may
  // be null (e.g. saved through the download fallback).
  const cloudUrl = cloud && token
    ? `${API}/api/document-archives/${cloud.id}/download?token=${encodeURIComponent(token)}`
    : null;

  const [localUrl, setLocalUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!open || isCloud || !local) { setLocalUrl(null); return; }
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      url = await openArchivedFile(local);
      if (!cancelled) setLocalUrl(url);
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isCloud, local?.filename, local?.savedAt]);

  const previewUrl = isCloud ? cloudUrl : localUrl;

  if (!open || count === 0) return null;

  const next = () => setIdx((i) => (i + 1) % count);
  const prev = () => setIdx((i) => (i - 1 + count) % count);

  return createPortal(
    <div
      dir="rtl"
      className="fixed left-0 top-0 bottom-0 z-40 flex flex-col bg-background border-e shadow-2xl w-full md:w-[min(46vw,760px)]"
      data-testid="archive-preview-panel"
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        <Paperclip className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="truncate text-xs font-mono font-semibold" title={filename}>{filename}</div>
          <div className="text-[10px] text-muted-foreground">
            {isCloud
              ? `${fmtBytes(cloud?.bytes)}${cloud?.pages ? ` · ${cloud.pages} صفحة` : ""}${cloud?.uploadedByName ? ` · ${cloud.uploadedByName}` : ""}`
              : `${fmtBytes(local?.bytes)}${local?.pages ? ` · ${local.pages} صفحة` : ""}`}
          </div>
        </div>
        {count > 1 && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={prev} title="السابق" data-testid="archive-panel-prev">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span dir="ltr">{safeIdx + 1} / {count}</span>
            <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={next} title="التالي" data-testid="archive-panel-next">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        )}
        <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={onClose} title="إغلاق المعاينة" data-testid="archive-panel-close">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b flex-wrap">
        {previewUrl && (
          <Button
            type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs"
            onClick={() => window.open(previewUrl, "_blank", "noopener")}
          >
            <ExternalLink className="h-3.5 w-3.5" />فتح
          </Button>
        )}
        {isCloud && cloud && (
          <>
            <ArchiveSendButtons
              fileId={cloud.id}
              filename={cloud.filename}
              token={token}
              companyName={companyName}
              variant="toolbar"
            />
            <Button
              type="button" size="sm" variant="outline"
              className="h-8 gap-1.5 text-xs text-destructive hover:bg-destructive/10"
              onClick={() => onDeleteCloud(cloud)}
            >
              <Trash2 className="h-3.5 w-3.5" />حذف
            </Button>
          </>
        )}
        {!isCloud && local && (
          <Button
            type="button" size="sm" variant="outline"
            className="h-8 gap-1.5 text-xs text-destructive hover:bg-destructive/10"
            title="يُزيل الملف من فهرس البرنامج فقط — الملف يبقى على جهازك"
            onClick={() => onDeleteLocal(local)}
          >
            <Trash2 className="h-3.5 w-3.5" />إزالة من الفهرس
          </Button>
        )}
      </div>

      {/* ── Preview area ───────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 bg-muted/60 flex items-center justify-center overflow-hidden">
        {previewUrl ? (
          kind === "pdf" ? (
            <iframe
              key={previewUrl}
              src={previewUrl}
              title={filename}
              className="w-full h-full border-0 bg-white"
            />
          ) : kind === "image" ? (
            <div className="w-full h-full overflow-auto flex items-center justify-center p-3">
              <img src={previewUrl} alt={filename} className="max-w-full max-h-full object-contain rounded shadow" />
            </div>
          ) : (
            <div className="text-center text-sm text-muted-foreground p-6 space-y-3">
              <FileText className="h-10 w-10 mx-auto opacity-50" />
              <div>لا تتوفر معاينة مباشرة لهذه الصيغة.</div>
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => window.open(previewUrl, "_blank", "noopener")}>
                <Download className="h-3.5 w-3.5" />تنزيل / فتح الملف
              </Button>
            </div>
          )
        ) : (
          <div className="text-center text-xs text-muted-foreground p-6 leading-relaxed">
            {isCloud
              ? "تعذّر تجهيز المعاينة."
              : "هذا الملف محفوظ محلياً ولا يمكن معاينته تلقائياً (محفوظ عبر التنزيل أو المجلّد غير متاح). افتحه من جهازك."}
          </div>
        )}
      </div>

      {/* ── File strip ─────────────────────────────────────────────────── */}
      {count > 1 && (
        <div className="border-t px-2 py-1.5 flex gap-1.5 overflow-x-auto shrink-0 bg-muted/30">
          {(isCloud ? cloudFiles : localFiles).map((f: any, i: number) => {
            const fname: string = f.filename;
            const k = kindOf(fname, f.contentType);
            const active = i === safeIdx;
            return (
              <button
                key={isCloud ? `c${f.id}` : `${fname}_${f.savedAt}`}
                type="button"
                onClick={() => setIdx(i)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] whitespace-nowrap transition-colors ${
                  active ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-accent"
                }`}
                title={fname}
              >
                {k === "pdf"
                  ? <FileText className={`h-3 w-3 ${active ? "" : "text-red-500"}`} />
                  : <ImageIcon className={`h-3 w-3 ${active ? "" : "text-blue-500"}`} />}
                <span className="max-w-[140px] truncate font-mono">{fname}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}
