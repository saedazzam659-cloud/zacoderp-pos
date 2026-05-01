// PRO Extension #14 — Scan a barcode (1D or QR) → look up the item in the
// already-loaded inventory list → upload an image and attach it to that item.
//
// Designed as a quick warehouse-floor workflow: a clerk holds the camera
// to a product's barcode, the matching item flashes onto the screen, and
// the same dialog lets them snap (or pick) a photo to attach in one step.
//
// Item lookup is purely client-side against the items array passed in by
// the parent — no extra API call needed because the Items page already
// loaded all items for display.
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScanLine, Camera, Upload, CheckCircle2, AlertCircle, Package } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export interface ScanItem {
  id: number;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  barcode?: string | null;
  imageUrl?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  items: ScanItem[];
  onAttach: (itemId: number, imageUrl: string) => Promise<void>;
}

export default function ScanToImageDialog({ open, onOpenChange, items, onAttach }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const scannerRef = useRef<Html5Qrcode | null>(null);
  // Unique per dialog instance so two simultaneously-mounted dialogs (or a
  // remount during state transitions) don't collide on the same DOM node.
  // useId() returns a stable id like ":r0:" — sanitised to be a valid DOM id.
  const rawId = useId();
  const containerId = `scan-cam-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [scannedCode, setScannedCode] = useState<string | null>(null);
  const [matchedItem, setMatchedItem] = useState<ScanItem | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [scanning, setScanning] = useState(false);

  // Start the camera when the dialog opens; stop it when closed.
  // We DON'T tear down on every re-render — only when `open` flips.
  useEffect(() => {
    if (!open) return;
    setScannedCode(null);
    setMatchedItem(null);
    setScanError(null);

    const scanner = new Html5Qrcode(containerId, {
      verbose: false,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.CODE_39,
      ],
    });
    scannerRef.current = scanner;

    scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 240, height: 160 } },
      (decoded) => {
        // Stop after the first successful scan to avoid duplicate matches.
        if (scannerRef.current) {
          scannerRef.current.stop().catch(() => {});
          setScanning(false);
        }
        setScannedCode(decoded);
        const found = items.find(i => (i.barcode?.trim() || i.code) === decoded);
        if (found) {
          setMatchedItem(found);
        } else {
          setScanError(t("pages.items.scanToImage.notFound", { code: decoded }));
        }
      },
      () => { /* per-frame errors are noisy; ignore */ },
    ).then(() => setScanning(true)).catch((err) => {
      setScanError(t("pages.items.scanToImage.cameraError"));
      // eslint-disable-next-line no-console
      console.error("camera start failed", err);
    });

    return () => {
      const s = scannerRef.current;
      if (s) {
        // stop() rejects if it was never started; swallow either way.
        s.stop().catch(() => {});
        s.clear();
        scannerRef.current = null;
      }
      setScanning(false);
    };
    // We intentionally do NOT depend on `items` — the closure captures the
    // items at scan-start time, and re-creating the scanner on every items
    // change would tear down the camera unnecessarily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function reset() {
    setScannedCode(null);
    setMatchedItem(null);
    setScanError(null);
    // Re-mount the scanner by toggling open via the parent, easier than
    // calling scanner APIs directly here.
    onOpenChange(false);
    setTimeout(() => onOpenChange(true), 60);
  }

  async function handleFile(file: File) {
    if (!matchedItem) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: t("pages.items.scanToImage.notImage"), variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: t("pages.items.scanToImage.tooLarge"), variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const reqRes = await fetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("zatca_token") ?? ""}`,
        },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!reqRes.ok) throw new Error("presigned url failed");
      const { uploadURL, objectPath } = await reqRes.json();
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error("upload failed");
      await onAttach(matchedItem.id, objectPath);
      toast({ title: t("pages.items.scanToImage.success", { name: matchedItem.nameAr }) });
      onOpenChange(false);
    } catch (e: any) {
      toast({
        title: t("pages.items.scanToImage.uploadFailed"),
        description: String(e?.message ?? e),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="h-5 w-5 text-primary" />
            {t("pages.items.scanToImage.title")}
          </DialogTitle>
        </DialogHeader>

        {/* Camera preview area — html5-qrcode renders into this div */}
        <div className="space-y-3">
          {!matchedItem && !scanError && (
            <>
              <div
                id={containerId}
                className="rounded-lg overflow-hidden border bg-black/90 min-h-[240px] flex items-center justify-center"
              >
                {!scanning && (
                  <div className="text-white/60 text-sm flex flex-col items-center gap-2">
                    <Camera className="h-8 w-8" />
                    {t("pages.items.scanToImage.starting")}
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground text-center">
                {t("pages.items.scanToImage.hint")}
              </p>
            </>
          )}

          {scanError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
                <div className="flex-1">
                  <p className="font-semibold text-destructive">{t("pages.items.scanToImage.errorTitle")}</p>
                  <p className="text-xs text-muted-foreground mt-1">{scanError}</p>
                </div>
              </div>
              <Button variant="outline" className="w-full mt-3" onClick={reset}>
                {t("pages.items.scanToImage.tryAgain")}
              </Button>
            </div>
          )}

          {matchedItem && (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50/50 dark:bg-emerald-900/10 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{matchedItem.nameAr}</p>
                  <p className="text-xs text-muted-foreground font-mono">{matchedItem.code}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {t("pages.items.scanToImage.scannedCode")}: {scannedCode}
                  </p>
                </div>
                {matchedItem.imageUrl ? (
                  <img
                    src={matchedItem.imageUrl.startsWith("/objects/") ? `/api/storage${matchedItem.imageUrl}` : matchedItem.imageUrl}
                    alt=""
                    className="w-12 h-12 rounded-md object-cover border"
                  />
                ) : (
                  <Package className="h-12 w-12 text-muted-foreground/40" />
                )}
              </div>

              <label className="block">
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
                />
                <span className="w-full inline-flex items-center justify-center gap-2 h-10 px-4 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer text-sm font-medium">
                  <Upload className="h-4 w-4" />
                  {uploading
                    ? t("pages.items.scanToImage.uploading")
                    : matchedItem.imageUrl
                      ? t("pages.items.scanToImage.replaceImage")
                      : t("pages.items.scanToImage.attachImage")}
                </span>
              </label>
              <Button variant="outline" className="w-full" onClick={reset} disabled={uploading}>
                {t("pages.items.scanToImage.scanAnother")}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
