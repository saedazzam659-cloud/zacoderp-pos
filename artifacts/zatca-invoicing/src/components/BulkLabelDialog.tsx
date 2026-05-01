// PRO Extension #13 — Bulk barcode/QR label printing.
//
// Opens a printable label sheet for any number of selected items. Two render
// modes:
//   • "qr"      — uses the existing qrcode.react SVG renderer
//   • "barcode" — uses jsbarcode → SVG (Code128, the universal retail format)
//
// Layout: a CSS grid of fixed-size labels (40 × 25 mm by default — the
// classic Avery thermal-label size). The actual `window.print()` happens in
// a new window with a tight @media-print stylesheet so users get a clean
// page even if their main app shell has chrome around it.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import JsBarcode from "jsbarcode";
import { QRCodeSVG } from "qrcode.react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Printer, Tag } from "lucide-react";
import { useFmt } from "@/hooks/use-fmt";

export interface LabelItem {
  id: number;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  barcode?: string | null;
  salePrice?: string | number | null;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  items: LabelItem[];                   // pre-filtered selection
}

type Mode = "qr" | "barcode";

export default function BulkLabelDialog({ open, onOpenChange, items }: Props) {
  const { t } = useTranslation();
  const { fmt } = useFmt();
  const [mode, setMode] = useState<Mode>("barcode");
  const [copies, setCopies] = useState("1");
  const [showName, setShowName] = useState(true);
  const [showPrice, setShowPrice] = useState(true);
  const [showCode, setShowCode] = useState(true);
  const previewRef = useRef<HTMLDivElement | null>(null);

  // Expand each selected item to N copies. Bound to a sane upper limit so a
  // typo (e.g. 9999) doesn't try to render 100k SVGs and lock the browser.
  const copyCount = Math.max(1, Math.min(50, Number(copies) || 1));
  // Memoise the expanded sheet so the rendering effect has a stable dependency
  // (avoids a re-render→new-array→re-effect loop, and lets us list it as the
  // single dep instead of suppressing exhaustive-deps).
  const sheet = useMemo<{ item: LabelItem; idx: number }[]>(
    () => items.flatMap(i => Array.from({ length: copyCount }, (_, idx) => ({ item: i, idx }))),
    [items, copyCount],
  );

  // Render 1D barcode SVGs whenever the sheet (= items × copies) or mode
  // changes. JsBarcode mutates the DOM directly so we re-run on every change.
  useEffect(() => {
    if (!open || mode !== "barcode") return;
    sheet.forEach(({ item }, gi) => {
      const el = document.getElementById(`bclbl-${item.id}-${gi}`);
      if (!el) return;
      const value = item.barcode?.trim() || item.code; // fallback: item code
      try {
        JsBarcode(el, value, {
          format: "CODE128",
          displayValue: false,   // we render the number ourselves below the bars
          margin: 0,
          height: 40,
          width: 1.4,
        });
      } catch {
        // Invalid input for chosen format — leave element blank. The user can
        // see which label is empty and fix the underlying barcode value.
      }
    });
  }, [open, mode, sheet]);

  function handlePrint() {
    if (!previewRef.current) return;
    // Open a clean window so we don't drag the parent app's stylesheets in.
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) return;
    const css = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: system-ui, -apple-system, sans-serif; padding: 6mm; }
      .sheet { display: grid; grid-template-columns: repeat(auto-fill, 40mm); gap: 2mm; direction: ltr; }
      .lbl { width: 40mm; height: 25mm; border: 1px dashed #ccc; padding: 1mm; display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden; page-break-inside: avoid; }
      .lbl .name { font-size: 7pt; font-weight: 600; text-align: center; line-height: 1.1; max-height: 18px; overflow: hidden; }
      .lbl .price { font-size: 9pt; font-weight: 700; }
      .lbl .code { font-size: 6pt; font-family: monospace; color: #555; letter-spacing: 0.5px; }
      .lbl svg { max-width: 100%; height: auto; display: block; }
      @media print {
        @page { size: A4; margin: 6mm; }
        body { padding: 0; }
        .lbl { border: none; }
      }
    `;
    // Build the print document with createElement + importNode rather than
    // injecting innerHTML strings — eliminates any possibility of HTML
    // injection from item fields (nameAr, code, barcode) even though React
    // already escapes them.
    w.document.open();
    w.document.write(`<!doctype html><html><head><title></title><style>${css}</style></head><body></body></html>`);
    w.document.close();
    w.document.title = t("pages.items.bulkLabels.printTitle");
    const sheetRoot = w.document.createElement("div");
    sheetRoot.className = "sheet";
    // Each label is the .lbl child of the React-rendered preview DOM.
    const sourceLabels = previewRef.current.querySelectorAll(".lbl");
    sourceLabels.forEach((node) => {
      const cloned = w.document.importNode(node, true) as HTMLElement;
      sheetRoot.appendChild(cloned);
    });
    w.document.body.appendChild(sheetRoot);
    // Give the new window a tick to lay out cloned SVGs before triggering print.
    setTimeout(() => { w.focus(); w.print(); }, 200);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5 text-primary" />
            {t("pages.items.bulkLabels.title", { count: items.length })}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4">
          <div className="space-y-1">
            <Label className="text-xs">{t("pages.items.bulkLabels.mode")}</Label>
            <select
              className="w-full h-9 rounded-md border bg-background px-2 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
            >
              <option value="barcode">{t("pages.items.bulkLabels.modeBarcode")}</option>
              <option value="qr">{t("pages.items.bulkLabels.modeQr")}</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("pages.items.bulkLabels.copies")}</Label>
            <Input
              type="number" min={1} max={50}
              value={copies}
              onChange={(e) => setCopies(e.target.value)}
              className="h-9 text-center"
            />
          </div>
          <div className="space-y-2 col-span-2">
            <Label className="text-xs">{t("pages.items.bulkLabels.fields")}</Label>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <Checkbox checked={showName} onCheckedChange={(v) => setShowName(!!v)} />
                {t("pages.items.bulkLabels.showName")}
              </label>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <Checkbox checked={showPrice} onCheckedChange={(v) => setShowPrice(!!v)} />
                {t("pages.items.bulkLabels.showPrice")}
              </label>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <Checkbox checked={showCode} onCheckedChange={(v) => setShowCode(!!v)} />
                {t("pages.items.bulkLabels.showCode")}
              </label>
            </div>
          </div>
        </div>

        <div className="text-xs text-muted-foreground mb-2">
          {t("pages.items.bulkLabels.previewHint", { count: sheet.length })}
        </div>

        <div ref={previewRef} className="rounded-lg border bg-muted/30 p-3 max-h-[400px] overflow-auto">
          <div className="sheet" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 40mm)", gap: "2mm", direction: "ltr" }}>
            {sheet.map(({ item }, gi) => {
              const display = item.barcode?.trim() || item.code;
              return (
                <div
                  key={`${item.id}-${gi}`}
                  className="lbl"
                  style={{ width: "40mm", height: "25mm", border: "1px dashed #ccc", padding: "1mm", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "white" }}
                >
                  {showName && (
                    <div className="name" style={{ fontSize: "7pt", fontWeight: 600, textAlign: "center", lineHeight: 1.1, maxHeight: 18, overflow: "hidden" }}>
                      {item.nameAr}
                    </div>
                  )}
                  {mode === "qr" ? (
                    <QRCodeSVG value={display} size={48} level="M" />
                  ) : (
                    <svg id={`bclbl-${item.id}-${gi}`} />
                  )}
                  {showCode && (
                    <div className="code" style={{ fontSize: "6pt", fontFamily: "monospace", color: "#555", letterSpacing: "0.5px" }}>
                      {display}
                    </div>
                  )}
                  {showPrice && item.salePrice != null && (
                    <div className="price" style={{ fontSize: "9pt", fontWeight: 700 }}>
                      {fmt(Number(item.salePrice))} {t("pages.items.sar")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handlePrint} disabled={sheet.length === 0} className="gap-2">
            <Printer className="h-4 w-4" />
            {t("pages.items.bulkLabels.print")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
