import { useState, Fragment, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { aiApi, type ItemFieldsSuggestion } from "@/lib/aiApi";
import { parseError } from "@/lib/parseError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import ExportButtons from "@/components/ExportButtons";
import { TablePagination, usePagination } from "@/components/TablePagination";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { useFmt, trimTrailingZeros } from "@/hooks/use-fmt";
import {
  Plus, Pencil, Trash2, Package, Search, X, Save,
  ChevronDown, ChevronUp, Warehouse, Ruler, Star,
  AlertTriangle, BookMarked, Sparkles, Loader2,
  QrCode, Tag, Printer, History, ArrowRight,
  TrendingUp, Calendar, DollarSign, BarChart3,
  ScanLine, FileText, Upload, ExternalLink,
  Truck, Check, Boxes, Layers,
  Building2, Cog, Bell, Store, FlaskConical,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import BulkLabelDialog from "@/components/BulkLabelDialog";
import ScanToImageDialog from "@/components/ScanToImageDialog";
import type { ItemDocument, ItemSupplier, BundleComponent, ItemVariant, ItemBranchStockRow } from "@/lib/inventoryApi";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import {
  rowToneFor, SEL_TONE, DocColorLegend, buildToneTooltip, DICT_TONES, type LegendItem,
} from "@/lib/docRowTone";

const EMPTY = {
  code: "", nameAr: "", nameEn: "", barcode: "", itemType: "stock", itemNature: "merchandise",
  groupId: "", unitId: "", costPrice: "0", salePrice: "0", vatRate: "15",
  reorderLevel: "0", maxLevel: "", costMethod: "weighted_avg", description: "", status: "active",
  costAccountId: "", revenueAccountId: "", imageUrl: "",
  // PRO Extension #3 — per-item default discount auto-applied on sales lines.
  discountType: "none" as "none" | "percent" | "amount", discountValue: "0",
  tags: "" as string, // comma-separated
  // PRO Extension #2 — bundle (kit) flag. Auto-flips when components
  // are added/removed via the Components panel, but can also be ticked
  // manually here so the panel becomes visible before the first add.
  isBundle: false as boolean,
  // POS visibility — when false, the item is hidden from cashier/POS lists
  // (it stays in inventory, sales documents, etc). Defaults to true so
  // existing items keep showing up.
  showInPos: true as boolean,
  // Optional expiry date. Most useful for manufactured items (those that
  // have a BOM / bundle composition) but stored on every item uniformly.
  expiryDate: "" as string,
};

// ─── Helpers: tags as array ↔ string ─────────────────────────────────────────
function tagsToArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  return String(v).split(",").map(s => s.trim()).filter(Boolean);
}

// ─── Inline chip-style tags input ────────────────────────────────────────────
function TagsInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const tags = tagsToArray(value);
  const [draft, setDraft] = useState("");

  function addTag(raw: string) {
    const v = raw.trim().slice(0, 40);
    if (!v) return;
    if (tags.some(t => t.toLowerCase() === v.toLowerCase())) { setDraft(""); return; }
    if (tags.length >= 20) { setDraft(""); return; }
    onChange([...tags, v].join(","));
    setDraft("");
  }
  function removeTag(idx: number) {
    onChange(tags.filter((_, i) => i !== idx).join(","));
  }

  return (
    <div className="min-h-9 w-full rounded-md border border-input bg-background px-2 py-1.5 flex flex-wrap gap-1.5 items-center focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
      {tags.map((tg, i) => (
        <span key={i} className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs font-medium rounded-md px-2 py-0.5">
          <Tag className="h-3 w-3" />
          {tg}
          <button type="button" onClick={() => removeTag(i)} className="hover:text-destructive" aria-label="remove">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addTag(draft);
          } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
            removeTag(tags.length - 1);
          }
        }}
        onBlur={() => addTag(draft)}
        placeholder={tags.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[80px] outline-none bg-transparent text-xs py-0.5"
      />
    </div>
  );
}

// ─── QR Code preview dialog ──────────────────────────────────────────────────
function ItemQrDialog({ open, onOpenChange, item }: { open: boolean; onOpenChange: (v: boolean) => void; item: any }) {
  const { t, i18n } = useTranslation();
  if (!item) return null;
  // Use barcode if available, else item code, else id — most useful for POS scanning.
  const qrValue = String(item.barcode || item.code || item.id);
  // Locale-aware display name: prefer current-language name, fallback to Ar then En then code
  const displayName = i18n.language?.startsWith("en")
    ? (item.nameEn || item.nameAr || item.code || "")
    : (item.nameAr || item.nameEn || item.code || "");

  function printQr() {
    // Open with noopener for safety; build the document via DOM APIs and textContent
    // so user-controlled fields (name/code/barcode) cannot inject HTML/JS (XSS).
    const w = window.open("", "_blank", "width=420,height=620,noopener,noreferrer");
    if (!w) return;
    const svgEl = document.getElementById("item-qr-svg");
    const svgMarkup = svgEl ? new XMLSerializer().serializeToString(svgEl) : "";
    const isRtl = !i18n.language?.startsWith("en");
    const lang = isRtl ? "ar" : "en";
    const dir = isRtl ? "rtl" : "ltr";
    const printLabel = t("pages.items.qr.print");
    const titleLabel = t("pages.items.qr.title");

    // Build doc structure first, then inject only safe primitives.
    const doc = w.document;
    doc.open();
    doc.write("<!doctype html><html><head></head><body></body></html>");
    doc.close();

    doc.documentElement.setAttribute("lang", lang);
    doc.documentElement.setAttribute("dir", dir);

    const titleEl = doc.createElement("title");
    titleEl.textContent = `${titleLabel} — ${displayName}`;
    doc.head.appendChild(titleEl);

    const styleEl = doc.createElement("style");
    styleEl.textContent = `
      body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 20px; }
      .sticker { display: inline-block; padding: 16px; border: 1px dashed #ccc; border-radius: 12px; }
      h2 { margin: 8px 0 4px; font-size: 16px; }
      .code { font-family: monospace; color: #555; font-size: 12px; }
      .barcode { font-family: monospace; color: #888; font-size: 11px; margin-top: 4px; }
      .actions { margin-top: 20px; }
      .actions button { padding: 6px 14px; font-size: 13px; cursor: pointer; }
      @media print { .actions { display: none; } .sticker { border: none; } }
    `;
    doc.head.appendChild(styleEl);

    const sticker = doc.createElement("div");
    sticker.className = "sticker";
    // SVG markup is generated by qrcode.react and contains no user input — safe to inject as innerHTML.
    const svgWrap = doc.createElement("div");
    svgWrap.innerHTML = svgMarkup;
    sticker.appendChild(svgWrap);

    const h2 = doc.createElement("h2");
    h2.textContent = displayName; // textContent → safe
    sticker.appendChild(h2);

    if (item.code) {
      const codeDiv = doc.createElement("div");
      codeDiv.className = "code";
      codeDiv.textContent = String(item.code);
      sticker.appendChild(codeDiv);
    }
    if (item.barcode) {
      const bcDiv = doc.createElement("div");
      bcDiv.className = "barcode";
      bcDiv.textContent = `🔖 ${String(item.barcode)}`;
      sticker.appendChild(bcDiv);
    }
    doc.body.appendChild(sticker);

    const actions = doc.createElement("div");
    actions.className = "actions";
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.textContent = printLabel; // localized
    btn.addEventListener("click", () => w.print());
    actions.appendChild(btn);
    doc.body.appendChild(actions);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" dir={i18n.language?.startsWith("en") ? "ltr" : "rtl"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5 text-primary" />
            {t("pages.items.qr.title")}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="bg-white p-3 rounded-xl border">
            <QRCodeSVG id="item-qr-svg" value={qrValue} size={200} level="M" />
          </div>
          <p className="text-sm font-semibold text-center">{displayName}</p>
          <p className="text-xs font-mono text-muted-foreground">{item.code}</p>
          {item.barcode && <p className="text-[11px] font-mono text-muted-foreground">🔖 {item.barcode}</p>}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button onClick={printQr} className="gap-2">
            <Printer className="h-4 w-4" />
            {t("pages.items.qr.print")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Item Audit-Log (history) dialog ─────────────────────────────────────────
// Shows a tenant-scoped, most-recent-first timeline of every create/edit/
// delete action for one item. Field-level diffs come from the server's
// `metadata.changes` array; full snapshots come from create/delete entries.
// All field labels are translated via `pages.items.history.fields.<key>` so
// the timeline is fully bilingual.
function ItemHistoryDialog({ open, onOpenChange, item }: { open: boolean; onOpenChange: (v: boolean) => void; item: any }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  // Include tenant id in the queryKey so cached audit rows from a previous
  // tenant are never served when the user switches companies (architect finding).
  const tenantKey = user?.role === "superadmin" ? "sa" : (user?.company?.id ?? "anon");
  const isRtl = !i18n.language?.startsWith("en");
  const { data: rows, isLoading, isError, error } = useQuery({
    queryKey: ["item-audit", tenantKey, item?.id],
    queryFn: () => inventoryApi.getItemAudit(item!.id),
    enabled: !!item?.id && open,
  });

  function fieldLabel(field: string): string {
    return t(`pages.items.history.fields.${field}`, { defaultValue: field });
  }
  function actionLabel(action: string): string {
    if (action === "create") return t("pages.items.history.actionCreate");
    if (action === "edit")   return t("pages.items.history.actionEdit");
    if (action === "delete") return t("pages.items.history.actionDelete");
    return action;
  }
  function actionColor(action: string): string {
    if (action === "create") return "bg-green-50 text-green-700 border-green-200";
    if (action === "edit")   return "bg-blue-50  text-blue-700  border-blue-200";
    if (action === "delete") return "bg-red-50   text-red-700   border-red-200";
    return "bg-slate-50 text-slate-700 border-slate-200";
  }
  function fmtValue(v: unknown): string {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "object") {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
  }
  function fmtDate(s: string): string {
    try {
      return new Date(s).toLocaleString(isRtl ? "ar-SA" : "en-GB", {
        year: "numeric", month: "short", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return s; }
  }

  if (!item) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col" dir={isRtl ? "rtl" : "ltr"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-primary" />
            {t("pages.items.history.title")}
            <span className="text-sm font-normal text-muted-foreground">
              — {item.nameAr ?? item.code}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1 -mr-1">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("pages.items.history.loading")}
            </div>
          )}
          {isError && (
            <div className="text-sm text-destructive bg-destructive/5 rounded-md p-3">
              {t("pages.items.history.errorTitle")}: {parseError(error)}
            </div>
          )}
          {!isLoading && !isError && (!rows || rows.length === 0) && (
            <div className="text-sm text-muted-foreground text-center py-12 border border-dashed rounded-lg">
              <History className="h-8 w-8 mx-auto mb-2 opacity-30" />
              {t("pages.items.history.empty")}
            </div>
          )}
          {!isLoading && !isError && rows && rows.length > 0 && (
            <ol className="space-y-3">
              {rows.map((row: any) => {
                const meta = row.metadata ?? {};
                const changes: Array<{ field: string; from: unknown; to: unknown }> = Array.isArray(meta.changes) ? meta.changes : [];
                const snapshot: Record<string, unknown> | null = meta.snapshot && typeof meta.snapshot === "object" ? meta.snapshot : null;
                return (
                  <li key={row.id} className="border rounded-lg p-3 bg-card">
                    {/* Header row: action + timestamp + user */}
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className={cn("text-[11px] font-semibold rounded-full px-2 py-0.5 border", actionColor(row.action))}>
                        {actionLabel(row.action)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {fmtDate(row.createdAt)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        · {t("pages.items.history.byUser")}{" "}
                        <span className="font-medium text-foreground">
                          {row.username || t("pages.items.history.anonymous")}
                        </span>
                        {row.role && <span className="text-muted-foreground"> ({row.role})</span>}
                      </span>
                      {row.action === "edit" && (
                        <span className="text-[11px] text-muted-foreground ml-auto">
                          {t("pages.items.history.changesCount", { count: changes.length })}
                        </span>
                      )}
                    </div>

                    {/* Edit: show diff table */}
                    {row.action === "edit" && changes.length > 0 && (
                      <div className="rounded border bg-muted/20 overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-muted/40">
                            <tr className="text-start">
                              <th className="px-2 py-1.5 font-semibold text-start w-1/3">{t("pages.items.history.field")}</th>
                              <th className="px-2 py-1.5 font-semibold text-start">{t("pages.items.history.from")}</th>
                              <th className="px-2 py-1.5 w-6"></th>
                              <th className="px-2 py-1.5 font-semibold text-start">{t("pages.items.history.to")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {changes.map((ch, i) => (
                              <tr key={i} className="border-t border-muted/40">
                                <td className="px-2 py-1.5 font-medium">{fieldLabel(ch.field)}</td>
                                <td className="px-2 py-1.5 text-muted-foreground line-through tabular-nums break-all">
                                  {fmtValue(ch.from)}
                                </td>
                                <td className="px-2 py-1.5 text-muted-foreground">
                                  <ArrowRight className={cn("h-3 w-3", isRtl && "rotate-180")} />
                                </td>
                                <td className="px-2 py-1.5 font-medium tabular-nums break-all">
                                  {fmtValue(ch.to)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Create / delete: collapsible snapshot */}
                    {(row.action === "create" || row.action === "delete") && snapshot && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground py-1 select-none">
                          {t("pages.items.history.snapshot")}
                        </summary>
                        <div className="rounded border bg-muted/20 mt-1 overflow-hidden">
                          <table className="w-full">
                            <tbody>
                              {Object.entries(snapshot).map(([k, v]) => (
                                <tr key={k} className="border-t border-muted/40 first:border-t-0">
                                  <td className="px-2 py-1 font-medium w-1/3">{fieldLabel(k)}</td>
                                  <td className="px-2 py-1 break-all tabular-nums">{fmtValue(v)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2 mt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("common.close", { defaultValue: "إغلاق" })}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ItemImageUpload({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);

  async function handleFile(file: File) {
    if (!file.type.startsWith("image/")) {
      toast({ title: "نوع ملف غير مدعوم", description: "يرجى اختيار صورة فقط", variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "حجم الصورة كبير", description: "الحد الأقصى 5 ميجابايت", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const res = await fetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("zatca_token") ?? ""}` },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!res.ok) throw new Error("فشل تجهيز رابط الرفع");
      const { uploadURL, objectPath } = await res.json();
      const putRes = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!putRes.ok) throw new Error("فشل رفع الصورة");
      onChange(objectPath);
      toast({ title: "تم رفع الصورة" });
    } catch (e: any) {
      toast({ title: "تعذّر رفع الصورة", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  const previewSrc = value ? (value.startsWith("/objects/") ? `/api/storage${value}` : value) : "";

  return (
    <div className="flex items-center gap-3">
      <div className="w-20 h-20 rounded-xl border border-dashed border-border bg-muted/30 grid place-items-center overflow-hidden shrink-0">
        {previewSrc ? (
          <img src={previewSrc} alt="" className="w-full h-full object-cover" />
        ) : (
          <Package className="h-7 w-7 text-muted-foreground/50" />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <label className="cursor-pointer">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
          <span className="inline-flex items-center gap-1.5 text-xs h-8 px-3 rounded-md border bg-background hover:bg-accent transition">
            {uploading ? "جارٍ الرفع..." : value ? "تغيير الصورة" : "رفع صورة"}
          </span>
        </label>
        {value && (
          <button
            type="button"
            className="text-xs text-destructive hover:underline text-right"
            onClick={() => onChange("")}
          >
            إزالة الصورة
          </button>
        )}
      </div>
    </div>
  );
}
const UNIT_EMPTY = { unitId: "", conversionFactor: "1", costPrice: "0", salePrice: "0", isBase: false };

// ─── Item Unit Prices Panel ──────────────────────────────────────────────────
// PRO Extension #5 — Per-item Analytics panel.
// Renders 4 KPI tiles (last sold date, total qty sold, total revenue, avg
// monthly sales) by lazy-fetching the analytics endpoint when the parent
// expands this tab. Self-contained so the surrounding loop stays clean.
function ItemAnalyticsPanel({ itemId, unitCode }: { itemId: number; unitCode: string }) {
  const { t, i18n } = useTranslation();
  const { fmt, fmtQty } = useFmt();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["item-analytics", itemId],
    queryFn: () => inventoryApi.getItemAnalytics(itemId),
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
      </div>
    );
  }
  if (isError || !data) {
    return <p className="text-xs text-destructive py-4 text-center">{t("pages.items.analytics.error")}</p>;
  }
  // No posted sales yet — show a neutral empty state instead of zeros.
  if (data.invoiceCount === 0) {
    return (
      <p className="text-xs text-muted-foreground py-4 text-center border border-dashed rounded-lg">
        <BarChart3 className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
        {t("pages.items.analytics.empty")}
      </p>
    );
  }

  const formatDate = (iso: string) => {
    try { return new Date(iso).toLocaleDateString(i18n.language === "ar" ? "ar-EG" : "en-US"); }
    catch { return iso; }
  };

  const tiles = [
    { icon: Calendar,    label: t("pages.items.analytics.lastSold"),     value: data.lastSoldDate ? formatDate(data.lastSoldDate) : "—", color: "text-sky-600" },
    { icon: TrendingUp,  label: t("pages.items.analytics.totalQty"),     value: `${fmtQty(data.totalSalesQty)} ${unitCode}`,             color: "text-emerald-600" },
    { icon: DollarSign,  label: t("pages.items.analytics.totalRevenue"), value: `${fmt(data.totalRevenue)} ${t("pages.items.sar")}`,    color: "text-purple-600" },
    { icon: BarChart3,   label: t("pages.items.analytics.avgMonthly"),   value: `${fmtQty(data.averageMonthlySales)} ${unitCode}`,      color: "text-amber-600" },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map((tile, i) => (
          <div key={i} className="rounded-lg border bg-background p-3">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1.5">
              <tile.icon className={cn("h-3.5 w-3.5", tile.color)} />
              <span>{tile.label}</span>
            </div>
            <div className="text-base font-bold tabular-nums">{tile.value}</div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground text-center">
        {t("pages.items.analytics.basedOn", { count: data.invoiceCount })}
      </p>
    </div>
  );
}

function ItemUnitPricesPanel({ itemId }: { itemId: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { fmt } = useFmt();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const { data: allUnits = [] } = useQuery({ queryKey: ["units", cid], queryFn: () => inventoryApi.getUnits(cid) });
  const { data: unitPrices = [], isLoading } = useQuery({
    queryKey: ["item-units", itemId],
    queryFn: () => inventoryApi.getItemUnits(itemId),
  });

  const [form, setForm] = useState<any>(UNIT_EMPTY);
  const [editUpId, setEditUpId] = useState<number | null>(null);
  const [showUnitForm, setShowUnitForm] = useState(false);

  const inv = () => qc.invalidateQueries({ queryKey: ["item-units", itemId] });
  const addMut = useMutation({
    mutationFn: (data: any) => inventoryApi.addItemUnit(itemId, data),
    onSuccess: () => { inv(); setForm(UNIT_EMPTY); setShowUnitForm(false); toast({ title: t("pages.items.unitAdded") }); },
  });
  const updMut = useMutation({
    mutationFn: ({ upId, data }: any) => inventoryApi.updateItemUnit(itemId, upId, data),
    onSuccess: () => { inv(); setForm(UNIT_EMPTY); setEditUpId(null); setShowUnitForm(false); toast({ title: t("pages.items.updated") }); },
  });
  const delMut = useMutation({
    mutationFn: (upId: number) => inventoryApi.deleteItemUnit(itemId, upId),
    onSuccess: () => { inv(); toast({ title: t("pages.items.deleted") }); },
  });

  function handleEditUp(up: any) {
    setForm({ unitId: String(up.unitId), conversionFactor: up.conversionFactor ?? "1", costPrice: up.costPrice ?? "0", salePrice: up.salePrice ?? "0", isBase: up.isBase });
    setEditUpId(up.id);
    setShowUnitForm(true);
  }
  function handleSubmitUp(e: React.FormEvent) {
    e.preventDefault();
    const data = { ...form, unitId: Number(form.unitId), conversionFactor: form.conversionFactor, costPrice: form.costPrice, salePrice: form.salePrice, isBase: form.isBase };
    if (editUpId) updMut.mutate({ upId: editUpId, data });
    else addMut.mutate(data);
  }

  const usedUnitIds = new Set((unitPrices as any[]).map((u: any) => String(u.unitId)));
  const availableUnits = allUnits.filter((u: any) => !usedUnitIds.has(String(u.id)) || String(u.id) === form.unitId);

  return (
    <div className="space-y-3">
      {/* Header + Add button */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {t("pages.items.unitPricesDescription")}
        </p>
        {!showUnitForm && (
          <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs" onClick={() => { setForm(UNIT_EMPTY); setEditUpId(null); setShowUnitForm(true); }}>
            <Plus className="h-3.5 w-3.5" />{t("pages.items.addUnit")}
          </Button>
        )}
      </div>

      {/* Unit form */}
      {showUnitForm && (
        <div className="rounded-lg border bg-background p-4">
          <form onSubmit={handleSubmitUp} className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("pages.items.unitLabel")}</Label>
                <SearchCombobox
                  items={availableUnits.map((u: any) => ({ value: String(u.id), code: u.code, label: u.nameAr }))}
                  value={form.unitId}
                  onValueChange={v => setForm((p: any) => ({ ...p, unitId: v }))}
                  placeholder={t("pages.items.chooseUnit")}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("pages.items.conversionFactorLabel")}</Label>
                <Input className="h-8 text-xs" type="number" step="any" min="0.000001" value={form.conversionFactor} onChange={e => setForm((p: any) => ({ ...p, conversionFactor: e.target.value }))} required />
                <p className="text-[10px] text-muted-foreground">{t("pages.items.conversionFactorHint")}</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("pages.items.costPriceLabel")}</Label>
                <Input className="h-8 text-xs" type="number" step="any" value={form.costPrice} onChange={e => setForm((p: any) => ({ ...p, costPrice: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("pages.items.salePriceLabel")}</Label>
                <Input className="h-8 text-xs" type="number" step="any" value={form.salePrice} onChange={e => setForm((p: any) => ({ ...p, salePrice: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("pages.items.isBaseLabel")}</Label>
                <div className="flex items-center gap-2 h-8">
                  <input type="checkbox" id="isbase" checked={form.isBase} onChange={e => setForm((p: any) => ({ ...p, isBase: e.target.checked }))} className="rounded" />
                  <label htmlFor="isbase" className="text-xs text-muted-foreground">{t("pages.items.isBaseYes")}</label>
                </div>
              </div>
            </div>
            {/* Preview */}
            {form.unitId && form.conversionFactor && (
              <div className="text-xs bg-amber-50 border border-amber-100 rounded px-3 py-2 text-amber-800">
                {t("pages.items.unitConversionPreview", { factor: trimTrailingZeros(form.conversionFactor) })}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setShowUnitForm(false); setEditUpId(null); }}>{t("common.cancel")}</Button>
              <Button type="submit" size="sm" className="h-7 text-xs" disabled={addMut.isPending || updMut.isPending}>{editUpId ? t("common.save") : t("common.add")}</Button>
            </div>
          </form>
        </div>
      )}

      {/* Unit prices list */}
      {isLoading ? <Skeleton className="h-16 w-full" /> : (unitPrices as any[]).length === 0 && !showUnitForm ? (
        <div className="text-center py-6 text-xs text-muted-foreground border border-dashed rounded-lg">
          <Ruler className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
          <p>{t("pages.items.noUnitsLinked")}</p>
          <p className="mt-0.5 text-[10px]">{t("pages.items.addUnitToDefinePricing")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {(unitPrices as any[]).map((up: any) => (
            <div key={up.id} className={cn("rounded-lg border p-3 bg-background flex flex-col gap-1 relative", up.isBase && "border-green-300 bg-green-50/40")}>
              {up.isBase && (
                <span className="absolute top-2 left-2 flex items-center gap-0.5 text-[9px] font-bold text-green-700 bg-green-100 rounded-full px-1.5 py-0.5">
                  <Star className="h-2.5 w-2.5" />{t("pages.items.base")}
                </span>
              )}
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-xs font-bold font-mono text-primary">{up.unit?.code ?? "—"}</span>
                <span className="text-xs font-medium">{up.unit?.nameAr ?? "—"}</span>
              </div>
              <div className="grid grid-cols-3 gap-1 text-[10px]">
                <div className="bg-muted/50 rounded px-1.5 py-1 text-center">
                  <p className="text-muted-foreground">{t("pages.items.factor")}</p>
                  <p className="font-bold tabular-nums">×{trimTrailingZeros(up.conversionFactor)}</p>
                </div>
                <div className="bg-orange-50 rounded px-1.5 py-1 text-center">
                  <p className="text-orange-600">{t("pages.items.cost")}</p>
                  <p className="font-bold tabular-nums text-orange-800">{fmt(up.costPrice)}</p>
                </div>
                <div className="bg-blue-50 rounded px-1.5 py-1 text-center">
                  <p className="text-blue-600">{t("pages.items.sale")}</p>
                  <p className="font-bold tabular-nums text-blue-800">{fmt(up.salePrice)}</p>
                </div>
              </div>
              <div className="flex gap-1 justify-end mt-1">
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleEditUp(up)}><Pencil className="h-3 w-3" /></Button>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => { if (confirm(t("pages.items.deleteUnitPriceConfirm"))) delMut.mutate(up.id); }}><Trash2 className="h-3 w-3" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── AI Assist Dialog ────────────────────────────────────────────────────────
type AIDraft = ItemFieldsSuggestion & { suggestedGroupId?: string; suggestedUnitId?: string };

function AIAssistDialog({
  open, onOpenChange, form, groups, units, onApply,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  form: any;
  groups: any[];
  units: any[];
  onApply: (patch: Record<string, any>) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<AIDraft | null>(null);
  const [picks, setPicks] = useState<Record<string, boolean>>({});
  // Sequence id to ignore stale responses (StrictMode double-effects + slow networks)
  const reqIdRef = useRef(0);

  async function load() {
    const myId = ++reqIdRef.current;
    setLoading(true);
    setDraft(null);
    try {
      const groupName = (groups as any[]).find((g: any) => String(g.id) === String(form.groupId))?.nameAr ?? "";
      const unitName  = (units as any[]).find((u: any) => String(u.id) === String(form.unitId))?.nameAr ?? "";
      const res = await aiApi.suggestItemFields({
        nameAr: form.nameAr, nameEn: form.nameEn, code: form.code,
        costPrice: form.costPrice, salePrice: form.salePrice, vatRate: form.vatRate,
        itemType: form.itemType, description: form.description, barcode: form.barcode,
        group: groupName, unit: unitName,
        availableGroups: (groups as any[]).map((g: any) => g.nameAr).filter(Boolean),
        availableUnits:  (units  as any[]).map((u: any) => u.nameAr).filter(Boolean),
      });

      const matchGroup = (name: string | null) => {
        if (!name) return undefined;
        const g = (groups as any[]).find((x: any) => x.nameAr === name || x.nameEn === name);
        return g ? String(g.id) : undefined;
      };
      const matchUnit = (name: string | null) => {
        if (!name) return undefined;
        const u = (units as any[]).find((x: any) => x.nameAr === name || x.nameEn === name);
        return u ? String(u.id) : undefined;
      };
      // Drop stale response (a newer load() has superseded this one)
      if (myId !== reqIdRef.current) return;

      const enriched: AIDraft = {
        ...res,
        suggestedGroupId: matchGroup(res.suggestedGroup),
        suggestedUnitId:  matchUnit(res.suggestedUnit),
      };
      setDraft(enriched);

      // Default selection: only check fields that are currently empty/zero in the form
      const isEmpty = (v: any) => v === undefined || v === null || String(v).trim() === "";
      const isZeroish = (v: any) => isEmpty(v) || String(v) === "0";
      setPicks({
        nameAr:      Boolean(enriched.nameAr) && isEmpty(form.nameAr),
        nameEn:      Boolean(enriched.nameEn) && isEmpty(form.nameEn),
        description: Boolean(enriched.description) && isEmpty(form.description),
        salePrice:   enriched.suggestedSalePrice !== null && isZeroish(form.salePrice),
        vatRate:     enriched.suggestedVatRate !== null && isZeroish(form.vatRate),
        groupId:     Boolean(enriched.suggestedGroupId) && isEmpty(form.groupId),
        unitId:      Boolean(enriched.suggestedUnitId) && isEmpty(form.unitId),
        itemType:    Boolean(enriched.suggestedItemType) && enriched.suggestedItemType !== form.itemType,
        tags:        Array.isArray(enriched.tags) && enriched.tags.length > 0 && tagsToArray(form.tags).length === 0,
      });
    } catch (e: any) {
      if (myId !== reqIdRef.current) return;
      toast({ title: t("pages.items.aiAssist.errorTitle"), description: parseError(e), variant: "destructive" });
    } finally {
      if (myId === reqIdRef.current) setLoading(false);
    }
  }

  function apply() {
    if (!draft) return;
    const patch: Record<string, any> = {};
    if (picks.nameAr      && draft.nameAr)            patch.nameAr      = draft.nameAr;
    if (picks.nameEn      && draft.nameEn)            patch.nameEn      = draft.nameEn;
    if (picks.description && draft.description)       patch.description = draft.description;
    if (picks.salePrice   && draft.suggestedSalePrice !== null) patch.salePrice = String(draft.suggestedSalePrice);
    if (picks.vatRate     && draft.suggestedVatRate   !== null) patch.vatRate   = String(draft.suggestedVatRate);
    if (picks.groupId     && draft.suggestedGroupId)  patch.groupId  = draft.suggestedGroupId;
    if (picks.unitId      && draft.suggestedUnitId)   patch.unitId   = draft.suggestedUnitId;
    if (picks.itemType    && draft.suggestedItemType) patch.itemType = draft.suggestedItemType;
    if (picks.tags        && draft.tags && draft.tags.length > 0) {
      // Merge with existing tags (dedupe by lowercase) — never silently wipe user tags
      const existing = tagsToArray(form.tags);
      const seen = new Set(existing.map(x => x.toLowerCase()));
      const merged = [...existing];
      for (const t of draft.tags) {
        const k = t.toLowerCase();
        if (!seen.has(k)) { seen.add(k); merged.push(t); }
        if (merged.length >= 20) break;
      }
      patch.tags = merged.join(",");
    }
    onApply(patch);
    toast({ title: t("pages.items.aiAssist.applied") });
    onOpenChange(false);
  }

  // Auto-load suggestions when dialog opens; reset on close.
  // The reqIdRef sequence id ensures only the latest in-flight request can update state,
  // so React StrictMode's double-mount or rapid open/close cycles cannot cause races.
  useEffect(() => {
    if (open) {
      void load();
    } else {
      reqIdRef.current++; // Invalidate any in-flight load
      setDraft(null);
      setPicks({});
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const Row = ({ keyName, label, current, suggested, badge }: any) => {
    const has = suggested !== undefined && suggested !== null && String(suggested).trim() !== "";
    if (!has) return null;
    const checked = !!picks[keyName];
    return (
      <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => setPicks(p => ({ ...p, [keyName]: !!v }))}
          className="mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-foreground">{label}</span>
            {badge && <Badge variant="secondary" className="text-[10px] h-4 px-1.5">{badge}</Badge>}
          </div>
          {current !== undefined && String(current).trim() !== "" && String(current) !== "0" && (
            <p className="text-[11px] text-muted-foreground line-through truncate">{String(current)}</p>
          )}
          <p className="text-xs text-foreground break-words">{String(suggested)}</p>
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            {t("pages.items.aiAssist.title")}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm">{t("pages.items.aiAssist.loading")}</p>
          </div>
        )}

        {!loading && draft && (
          <div className="space-y-3">
            {draft.reasoning && (
              <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 text-xs text-foreground">
                <span className="font-semibold text-primary">{t("pages.items.aiAssist.reasoning")}: </span>
                {draft.reasoning}
              </div>
            )}

            <Row keyName="nameAr"      label={t("pages.items.nameAr")}      current={form.nameAr}      suggested={draft.nameAr} />
            <Row keyName="nameEn"      label={t("pages.items.nameEn")}      current={form.nameEn}      suggested={draft.nameEn} />
            <Row keyName="description" label={t("pages.items.notesDescription")} current={form.description} suggested={draft.description} />
            <Row keyName="salePrice"   label={t("pages.items.salePriceLabel")}   current={form.salePrice}
                 suggested={draft.suggestedSalePrice}
                 badge={draft.suggestedMargin !== null ? t("pages.items.aiAssist.marginBadge", { pct: draft.suggestedMargin }) : undefined} />
            <Row keyName="vatRate"     label={t("pages.items.vatRate")}          current={form.vatRate}    suggested={draft.suggestedVatRate !== null ? `${draft.suggestedVatRate}%` : null} />
            <Row keyName="groupId"     label={t("pages.items.group")}            current={(groups as any[]).find((g: any) => String(g.id) === String(form.groupId))?.nameAr} suggested={draft.suggestedGroup} />
            <Row keyName="unitId"      label={t("pages.items.baseUnit")}         current={(units  as any[]).find((u: any) => String(u.id) === String(form.unitId))?.nameAr}  suggested={draft.suggestedUnit} />
            <Row keyName="itemType"    label={t("pages.items.itemType")}         current={form.itemType === "stock" ? t("pages.items.stock") : t("pages.items.service")}
                 suggested={draft.suggestedItemType === "stock" ? t("pages.items.stock") : draft.suggestedItemType === "service" ? t("pages.items.service") : null} />

            {draft.tags && draft.tags.length > 0 && (
              <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
                <Checkbox
                  checked={!!picks.tags}
                  onCheckedChange={(v) => setPicks(p => ({ ...p, tags: !!v }))}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-foreground mb-2">{t("pages.items.aiAssist.tags")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {draft.tags.map((tag, i) => (
                      <Badge key={i} variant="outline" className="text-xs">{tag}</Badge>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button onClick={apply} disabled={loading || !draft} className="gap-2">
            <Sparkles className="h-4 w-4" />
            {t("pages.items.aiAssist.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function Items() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { fmt, fmtQty } = useFmt();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<"all" | "stock" | "service">("all");
  const [filterNature, setFilterNature] = useState<"all" | "raw" | "semi" | "finished" | "consumable" | "merchandise">("all");
  const [form, setForm] = useState<any>(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [activeItemTab, setActiveItemTab] = useState("basic");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedTab, setExpandedTab] = useState<"balances" | "units" | "analytics" | "documents" | "suppliers" | "bundle" | "variants" | "currencies" | "branches" | "reorder" | "bomSteps" | "batches">("balances");
  const [aiOpen, setAiOpen] = useState(false);
  const [qrItem, setQrItem] = useState<any>(null);
  const [historyItem, setHistoryItem] = useState<any>(null);
  // PRO Extension #13 — bulk label printing: row selection + dialog state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [labelsOpen, setLabelsOpen] = useState(false);
  // PRO Extension #14 — scan-barcode-to-attach-image
  const [scanOpen, setScanOpen] = useState(false);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["items", cid],
    queryFn: () => inventoryApi.getItems(cid),
  });
  const { data: groups = [] } = useQuery({
    queryKey: ["item-groups", cid],
    queryFn: () => inventoryApi.getItemGroups(cid),
  });
  const { data: units = [] } = useQuery({
    queryKey: ["units", cid],
    queryFn: () => inventoryApi.getUnits(cid),
  });
  const { data: itemDetail } = useQuery({
    queryKey: ["item-detail", expandedId],
    queryFn: () => inventoryApi.getItem(expandedId!),
    enabled: expandedId !== null,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["items"] });
  const errToast = (title: string) => (e: any) => toast({ title, description: parseError(e), variant: "destructive" });
  const createMut = useMutation({ mutationFn: inventoryApi.createItem, onSuccess: () => { invalidate(); reset(); toast({ title: t("pages.items.itemSaved") }); }, onError: errToast("تعذّر حفظ الصنف") });
  const updateMut = useMutation({ mutationFn: ({ id, data }: any) => inventoryApi.updateItem(id, data), onSuccess: () => { invalidate(); reset(); toast({ title: t("pages.items.itemUpdated") }); }, onError: errToast("تعذّر تعديل الصنف") });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteItem, onSuccess: () => { invalidate(); toast({ title: t("pages.items.deleted") }); }, onError: errToast("تعذّر الحذف") });
  // PRO Extension #15 — manual low-stock scan that creates broadcast
  // notifications. Server is idempotent per-item per-day so re-clicking
  // a few seconds later is safe and the toast clearly explains the result.
  const notifyLowStockMut = useMutation({
    mutationFn: () => inventoryApi.notifyLowStock(),
    onSuccess: (r) => {
      toast({
        title: t("pages.items.notifyLowStock.successTitle"),
        description: t("pages.items.notifyLowStock.successBody", {
          created: r.created,
          alreadyNotified: r.skippedAlreadyNotified,
          aboveThreshold: r.skippedAboveThreshold,
        }),
      });
    },
    onError: errToast(t("pages.items.notifyLowStock.failed")),
  });

  function reset() { setForm(EMPTY); setEditId(null); setShowForm(false); setActiveItemTab("basic"); }
  function handleEdit(item: any) {
    setForm({
      ...item,
      groupId: item.groupId ?? "", unitId: item.unitId ?? "",
      costPrice: item.costPrice ?? "0", salePrice: item.salePrice ?? "0",
      vatRate: item.vatRate ?? "15", reorderLevel: item.reorderLevel ?? "0",
      maxLevel: item.maxLevel ?? "",
      costAccountId:    item.costAccountId    ? String(item.costAccountId)    : "",
      revenueAccountId: item.revenueAccountId ? String(item.revenueAccountId) : "",
      tags: item.tags ?? "",
      discountType:  (item.discountType ?? "none") as "none" | "percent" | "amount",
      discountValue: item.discountValue != null ? String(item.discountValue) : "0",
      showInPos: item.showInPos !== false,
      expiryDate: item.expiryDate ?? "",
    });
    setEditId(item.id);
    setShowForm(true);
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      ...form,
      groupId:          form.groupId          ? Number(form.groupId)          : null,
      unitId:           form.unitId           ? Number(form.unitId)           : null,
      costAccountId:    form.costAccountId    ? Number(form.costAccountId)    : null,
      revenueAccountId: form.revenueAccountId ? Number(form.revenueAccountId) : null,
    };
    if (editId) updateMut.mutate({ id: editId, data: payload });
    else        createMut.mutate(payload);
  }
  function toggleExpand(id: number) {
    if (expandedId === id) { setExpandedId(null); }
    else { setExpandedId(id); setExpandedTab("balances"); }
  }

  const filtered = items.filter((it: any) => {
    // PRO Extension #20 — variants are stand-alone SKUs in the backend
    // (so they show up in sales/purchase/transfer/scan flows just like
    // any other item), but the Items master page only shows PARENTS in
    // the catalog list. Variants are reachable through the parent's
    // "المتغيّرات" tab in the expanded row.
    if (it.parentItemId != null) return false;
    const s = search.toLowerCase();
    const matchText = it.nameAr.includes(search)
      || it.code.includes(search)
      || (it.nameEn ?? "").toLowerCase().includes(s)
      || (it.barcode ?? "").includes(search)
      || (it.tags ?? "").toLowerCase().includes(s);
    const matchType = filterType === "all" || it.itemType === filterType;
    const matchNature = filterNature === "all" || (it.itemNature ?? "merchandise") === filterNature;
    return matchText && matchType && matchNature;
  });

  const pager = usePagination(filtered);

  const ITEM_EXPORT_COLS = [
    { key: "code",          header: t("pages.items.itemCode"),       width: 16 },
    { key: "nameAr",        header: t("pages.items.nameAr"),   width: 30 },
    { key: "nameEn",        header: t("pages.items.nameEn"), width: 30 },
    { key: "barcode",       header: t("pages.items.barcode"),           width: 18 },
    { key: "itemType",      header: t("common.status"),             width: 12 }, // Used for type here in original? Wait.
    { key: "groupName",     header: t("pages.items.group"),          width: 20 },
    { key: "unitName",      header: t("pages.items.unit"),            width: 14 },
    { key: "costPrice",     header: t("pages.items.costPriceLabel"),       width: 16 },
    { key: "salePrice",     header: t("pages.items.salePriceLabel"),         width: 16 },
    { key: "reorderLevel",  header: t("pages.items.reorderLevel"),          width: 14 },
    { key: "status",        header: t("common.status"),             width: 12 },
  ];

  const exportRows = filtered.map((it: any) => ({
    code:         it.code,
    nameAr:       it.nameAr,
    nameEn:       it.nameEn ?? "",
    barcode:      it.barcode ?? "",
    itemType:     it.itemType === "stock" ? t("pages.items.stock") : t("pages.items.service"),
    groupName:    it.group?.nameAr ?? "",
    unitName:     it.unit?.nameAr ?? "",
    costPrice:    fmt(it.costPrice),
    salePrice:    fmt(it.salePrice),
    reorderLevel: fmtQty(it.reorderLevel),
    status:       it.status === "active" ? t("pages.items.active") : t("pages.items.inactive"),
  }));

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Package className="h-6 w-6 text-primary" />{t("pages.items.itemsTitle")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("pages.items.itemsSubtitle")}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {selectedIds.size > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="gap-2 border-primary/40 text-primary"
              onClick={() => setLabelsOpen(true)}
              title={t("pages.items.bulkLabels.buttonHint")}
            >
              <Tag className="h-4 w-4" />
              {t("pages.items.bulkLabels.button", { count: selectedIds.size })}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => setScanOpen(true)}
            title={t("pages.items.scanToImage.buttonHint")}
          >
            <ScanLine className="h-4 w-4" />
            {t("pages.items.scanToImage.button")}
          </Button>
          {/* PRO Extension #15 — manual trigger to scan items at-or-below
              their reorderLevel and create broadcast notifications.
              Idempotent per-item per-day on the server, so spam-clicking
              is safe. */}
          <Button
            size="sm"
            variant="outline"
            className="gap-2 border-amber-500/40 text-amber-700 dark:text-amber-400"
            onClick={() => notifyLowStockMut.mutate()}
            disabled={notifyLowStockMut.isPending}
            title={t("pages.items.notifyLowStock.buttonHint")}
          >
            {notifyLowStockMut.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Bell className="h-4 w-4" />}
            {t("pages.items.notifyLowStock.button")}
          </Button>
          <ExportButtons rows={exportRows} columns={ITEM_EXPORT_COLS} filename={`${t("pages.items.itemsTitle")}-${new Date().toISOString().slice(0,10)}`} title={t("pages.items.itemsTitle")} />
          <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
            <Plus className="h-4 w-4" />{t("pages.items.newItem")}
          </Button>
        </div>
      </div>

      {showForm && (
        <FormPanel
          icon={Package}
          title={editId ? t("pages.items.editItem") : t("pages.items.newItem")}
          subtitle={t("pages.items.itemFormSubtitle")}
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending || updateMut.isPending}
          saveDisabled={!form.code || !form.nameAr}
          saveLabel={editId ? t("pages.items.saveEdit") : t("pages.items.addItem")}
        >
          <div className="flex justify-end mb-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setAiOpen(true)}
              className="gap-1.5 h-8 text-xs border-primary/40 text-primary hover:bg-primary/10"
              disabled={!form.nameAr && !form.nameEn && !form.code && !form.barcode && !form.description}
              title={t("pages.items.aiAssist.buttonHint")}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t("pages.items.aiAssist.button")}
            </Button>
          </div>
          <Tabs value={activeItemTab} onValueChange={setActiveItemTab} className="w-full">
            <TabsList className="w-full h-9 mb-5">
              <TabsTrigger value="basic"    className="flex-1 text-xs gap-1.5"><Package   className="h-3.5 w-3.5" />{t("pages.items.basicData")}</TabsTrigger>
              <TabsTrigger value="pricing"  className="flex-1 text-xs gap-1.5"><Ruler      className="h-3.5 w-3.5" />{t("pages.items.pricingAndControl")}</TabsTrigger>
              <TabsTrigger value="pos"      className="flex-1 text-xs gap-1.5"><Store      className="h-3.5 w-3.5" />نقطة البيع</TabsTrigger>
              <TabsTrigger value="accounts" className="flex-1 text-xs gap-1.5"><BookMarked className="h-3.5 w-3.5" />{t("pages.items.accountingLink")}</TabsTrigger>
            </TabsList>
            <TabsContent value="basic" className="mt-0">
              <FormGrid>
                <Field label={t("pages.items.itemCode")} required><Input placeholder="ITM-001" dir="ltr" className="text-left" value={form.code} onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} /></Field>
                <Field label={t("pages.items.nameAr")} required><Input placeholder={t("pages.items.nameAr")} value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} /></Field>
                <Field label={t("pages.items.nameEn")}><Input placeholder="Item Name" dir="ltr" className="text-left" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} /></Field>
                <Field label={t("pages.items.barcode")}><Input placeholder="1234567890" dir="ltr" className="text-left" value={form.barcode} onChange={e => setForm((p: any) => ({ ...p, barcode: e.target.value }))} /></Field>
                <Field label={t("pages.items.itemType")}>
                  <SearchCombobox items={[{ value: "stock", label: t("pages.items.stock") }, { value: "service", label: t("pages.items.service") }]} value={form.itemType} onValueChange={v => setForm((p: any) => ({ ...p, itemType: v }))} placeholder={t("pages.items.itemType")} />
                </Field>
                <Field label="طبيعة الصنف" hint="يساعد في تمييز الخامات عن البضاعة الجاهزة في شاشات التصنيع">
                  <SearchCombobox
                    items={[
                      { value: "raw",         label: "خامات (مواد أولية)" },
                      { value: "semi",        label: "نصف مصنّع" },
                      { value: "finished",    label: "تام الصنع" },
                      { value: "consumable",  label: "مستهلكات" },
                      { value: "merchandise", label: "بضاعة عادية" },
                    ]}
                    value={form.itemNature || "merchandise"}
                    onValueChange={v => setForm((p: any) => ({ ...p, itemNature: v }))}
                    placeholder="طبيعة الصنف"
                  />
                </Field>
                <Field label={t("pages.items.group")}>
                  <SearchCombobox items={[{ value: "", label: t("pages.items.noGroup") }, ...(groups as any[]).map((g: any) => ({ value: String(g.id), code: g.code, label: g.nameAr, labelEn: g.nameEn }))]} value={form.groupId} onValueChange={v => setForm((p: any) => ({ ...p, groupId: v }))} placeholder={t("pages.items.chooseGroup")} />
                </Field>
                <Field label={t("pages.items.baseUnit")} hint={t("pages.items.baseUnitHint")}>
                  <SearchCombobox items={[{ value: "", label: t("pages.items.chooseUnit") }, ...(units as any[]).map((u: any) => ({ value: String(u.id), code: u.code, label: u.nameAr }))]} value={form.unitId} onValueChange={v => setForm((p: any) => ({ ...p, unitId: v }))} placeholder={t("pages.items.chooseUnit")} />
                </Field>
                <Field label={t("common.status")}>
                  <SearchCombobox items={[{ value: "active", label: t("pages.items.active") }, { value: "inactive", label: t("pages.items.inactive") }]} value={form.status} onValueChange={v => setForm((p: any) => ({ ...p, status: v }))} placeholder={t("common.status")} />
                </Field>
                <Field label="صورة الصنف" className="md:col-span-2">
                  <ItemImageUpload value={form.imageUrl ?? ""} onChange={(v) => setForm((p: any) => ({ ...p, imageUrl: v }))} />
                </Field>
                <Field label={t("pages.items.tagsLabel")} hint={t("pages.items.tagsHint")} className="md:col-span-2">
                  <TagsInput
                    value={form.tags ?? ""}
                    onChange={(v) => setForm((p: any) => ({ ...p, tags: v }))}
                    placeholder={t("pages.items.tagsPlaceholder")}
                  />
                </Field>
                {editId && (
                  <Field label={t("pages.items.qr.label")} className="md:col-span-2">
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => setQrItem({ id: editId, nameAr: form.nameAr, code: form.code, barcode: form.barcode })} className="gap-1.5 h-9">
                        <QrCode className="h-4 w-4" />
                        {t("pages.items.qr.show")}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setHistoryItem({ id: editId, nameAr: form.nameAr, code: form.code })} className="gap-1.5 h-9">
                        <History className="h-4 w-4" />
                        {t("pages.items.history.show")}
                      </Button>
                    </div>
                  </Field>
                )}
              </FormGrid>
            </TabsContent>
            <TabsContent value="pricing" className="mt-0 space-y-6">
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">{t("pages.items.defaultPricing")}</p>
                <FormGrid>
                  <Field label={t("pages.items.costPriceLabel")}><Input type="number" step="any" dir="ltr" className="text-left" value={form.costPrice} onChange={e => setForm((p: any) => ({ ...p, costPrice: e.target.value }))} /></Field>
                  <Field label={t("pages.items.salePriceLabel")}><Input type="number" step="any" dir="ltr" className="text-left" value={form.salePrice} onChange={e => setForm((p: any) => ({ ...p, salePrice: e.target.value }))} /></Field>
                  <Field label={t("pages.items.vatRate")}><Input type="number" step="any" dir="ltr" className="text-left" value={form.vatRate} onChange={e => setForm((p: any) => ({ ...p, vatRate: e.target.value }))} /></Field>
                  <Field label={t("pages.items.costMethod")}>
                    <SearchCombobox items={[{ value: "weighted_avg", label: t("pages.items.weightedAvg") }, { value: "last_cost", label: t("pages.items.lastCost") }]} value={form.costMethod} onValueChange={v => setForm((p: any) => ({ ...p, costMethod: v }))} placeholder={t("pages.items.costMethodPlaceholder")} />
                  </Field>
                  <Field label={t("pages.items.discount.type")}>
                    <SearchCombobox
                      items={[
                        { value: "none",    label: t("pages.items.discount.none") },
                        { value: "percent", label: t("pages.items.discount.percent") },
                        { value: "amount",  label: t("pages.items.discount.amount") },
                      ]}
                      value={form.discountType ?? "none"}
                      onValueChange={(v) => setForm((p: any) => ({
                        ...p,
                        discountType: v,
                        // Auto-zero the value when switching to "none" so a stale
                        // number doesn't get accidentally persisted.
                        discountValue: v === "none" ? "0" : (p.discountValue ?? "0"),
                      }))}
                      placeholder={t("pages.items.discount.typePlaceholder")}
                    />
                  </Field>
                  <Field label={t("pages.items.discount.value")}>
                    <Input
                      type="number"
                      step="any"
                      min={0}
                      max={form.discountType === "percent" ? 100 : undefined}
                      dir="ltr"
                      className="text-left"
                      disabled={!form.discountType || form.discountType === "none"}
                      value={form.discountValue ?? "0"}
                      placeholder={form.discountType === "percent" ? "%" : ""}
                      onChange={(e) => setForm((p: any) => ({ ...p, discountValue: e.target.value }))}
                    />
                  </Field>
                </FormGrid>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">{t("pages.items.controlData")}</p>
                <FormGrid>
                  <Field label={t("pages.items.reorderLevel")}><Input type="number" step="any" dir="ltr" className="text-left" value={form.reorderLevel} onChange={e => setForm((p: any) => ({ ...p, reorderLevel: e.target.value }))} /></Field>
                  <Field label={t("pages.items.maxStockLevel")}><Input type="number" step="any" placeholder={t("pages.items.optional")} dir="ltr" className="text-left" value={form.maxLevel} onChange={e => setForm((p: any) => ({ ...p, maxLevel: e.target.value }))} /></Field>
                  <Field label={t("pages.items.notesDescription")} className="md:col-span-2"><Input placeholder={t("pages.items.descriptionPlaceholder")} value={form.description} onChange={e => setForm((p: any) => ({ ...p, description: e.target.value }))} /></Field>
                </FormGrid>
              </div>
            </TabsContent>
            <TabsContent value="pos" className="mt-0 space-y-6">
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">إعدادات نقطة البيع</p>
                <div className="rounded-lg border border-border bg-card p-4 space-y-3">
                  <label className="flex items-start gap-3 cursor-pointer select-none">
                    <Checkbox
                      checked={form.showInPos !== false}
                      onCheckedChange={(v) => setForm((p: any) => ({ ...p, showInPos: v === true }))}
                      className="mt-0.5"
                    />
                    <div className="space-y-0.5">
                      <div className="text-sm font-medium">إظهار الصنف في شاشة نقاط البيع (POS)</div>
                      <div className="text-xs text-muted-foreground">
                        عند إلغاء التحديد، لن يظهر هذا الصنف في شاشات الكاشير والسوبرماركت والمطاعم،
                        لكنه يبقى متوفّراً في المخزون وفواتير المبيعات والمشتريات.
                      </div>
                    </div>
                  </label>
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-3 tracking-wider">تاريخ الانتهاء (للأصناف ذات قائمة المكوّنات / BOM)</p>
                <FormGrid>
                  <Field
                    label="تاريخ انتهاء الصنف"
                    hint={form.isBundle ? "صنف مركَّب (BOM) — يمكن تسجيل تاريخ الانتهاء." : "متاح لكل الأصناف، لكنه يُستخدم عادةً للأصناف المُصنّعة (التي لها مكوّنات BOM)."}
                  >
                    <Input
                      type="date"
                      dir="ltr"
                      className="text-left"
                      value={form.expiryDate ?? ""}
                      onChange={(e) => setForm((p: any) => ({ ...p, expiryDate: e.target.value }))}
                    />
                  </Field>
                </FormGrid>
              </div>
            </TabsContent>
            <TabsContent value="accounts" className="mt-0">
              <FormGrid>
                <Field label={t("pages.items.costAccount")}>
                  <AccountCombobox value={form.costAccountId} onValueChange={v => setForm((p: any) => ({ ...p, costAccountId: v }))} placeholder={t("pages.items.chooseCostAccount")} filterTypes={["expense", "asset"]} grouped={false} />
                </Field>
                <Field label={t("pages.items.revenueAccount")}>
                  <AccountCombobox value={form.revenueAccountId} onValueChange={v => setForm((p: any) => ({ ...p, revenueAccountId: v }))} placeholder={t("pages.items.chooseRevenueAccount")} filterTypes={["revenue"]} grouped={false} />
                </Field>
              </FormGrid>
            </TabsContent>
          </Tabs>
          <AIAssistDialog
            open={aiOpen}
            onOpenChange={setAiOpen}
            form={form}
            groups={groups as any[]}
            units={units as any[]}
            onApply={(patch) => setForm((p: any) => ({ ...p, ...patch }))}
          />
        </FormPanel>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pr-9" placeholder={t("pages.items.searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 bg-muted/50 p-1 rounded-lg border">
          {(["all", "stock", "service"] as const).map(ti => (
            <button key={ti} onClick={() => setFilterType(ti)} className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-all", filterType === ti ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {ti === "all" ? t("pages.items.all") : ti === "stock" ? t("pages.items.stock") : t("pages.items.service")}
            </button>
          ))}
        </div>
        {/* Item nature filter — لتمييز الخامات / تام الصنع / المستهلكات بسرعة */}
        <div className="flex gap-1 bg-muted/50 p-1 rounded-lg border" data-testid="filter-nature">
          {([
            { v: "all",         label: "الكل" },
            { v: "raw",         label: "خامات" },
            { v: "semi",        label: "نصف مصنّع" },
            { v: "finished",    label: "تام الصنع" },
            { v: "consumable",  label: "مستهلكات" },
            { v: "merchandise", label: "بضاعة" },
          ] as const).map(n => (
            <button key={n.v} onClick={() => setFilterNature(n.v as any)} className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-all", filterNature === n.v ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")} data-testid={`filter-nature-${n.v}`}>
              {n.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        {(() => {
          const items: LegendItem[] = [
            { kind: "active",   count: filtered.filter((it: any) => it.status === "active").length,
              labelOverride: "نشط", hintOverride: "صنف نشط — يظهر في فواتير البيع/الشراء وحركات المخزون" },
            { kind: "inactive", count: filtered.filter((it: any) => it.status !== "active").length,
              labelOverride: "غير نشط", hintOverride: "صنف موقوف — لا يظهر في الإدخال" },
          ];
          return <DocColorLegend items={items} />;
        })()}
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-3 py-3 text-center font-semibold text-muted-foreground w-10">
                <Checkbox
                  checked={pager.pagedItems.length > 0 && pager.pagedItems.every((it: any) => selectedIds.has(it.id))}
                  onCheckedChange={(v) => {
                    setSelectedIds(prev => {
                      const next = new Set(prev);
                      if (v) {
                        pager.pagedItems.forEach((it: any) => next.add(it.id));
                      } else {
                        pager.pagedItems.forEach((it: any) => next.delete(it.id));
                      }
                      return next;
                    });
                  }}
                  aria-label={t("pages.items.bulkLabels.selectAll")}
                />
              </th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-8"></th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("pages.items.code")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("pages.items.item")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">{t("pages.items.group")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden md:table-cell">{t("pages.items.baseUnit")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden lg:table-cell">{t("pages.items.cost")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden lg:table-cell">{t("pages.items.sale")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{t("pages.items.itemType")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{t("common.status")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-24">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={11} className="px-4 py-3"><Skeleton className="h-6 w-full" /></td></tr>)
              : filtered.length === 0
              ? <tr><td colSpan={11} className="px-4 py-12 text-center text-muted-foreground"><Package className="h-8 w-8 mx-auto mb-2 opacity-30" />{t("pages.items.noItemsFound")}{search ? t("pages.items.matchingSearch") : ""}</td></tr>
              : pager.pagedItems.map((it: any) => {
                  const dictStatus = it.status === "active" ? "active" : "inactive";
                  const isSel = selectedIds.has(it.id);
                  return (
                  <Fragment key={it.id}>
                    <tr
                      data-status={dictStatus}
                      className={cn(
                        "transition-colors group",
                        isSel ? SEL_TONE : rowToneFor({ status: dictStatus, statusMap: DICT_TONES }),
                      )}
                      title={buildToneTooltip({ status: dictStatus, statusMap: DICT_TONES })}
                    >
                      <td className="px-3 py-3 text-center">
                        <Checkbox
                          checked={selectedIds.has(it.id)}
                          onCheckedChange={(v) => {
                            setSelectedIds(prev => {
                              const next = new Set(prev);
                              if (v) next.add(it.id); else next.delete(it.id);
                              return next;
                            });
                          }}
                          aria-label={t("pages.items.bulkLabels.selectRow")}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => toggleExpand(it.id)} className="text-muted-foreground hover:text-foreground">
                          {expandedId === it.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-bold">{it.code}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          {it.imageUrl ? (
                            <img
                              src={it.imageUrl.startsWith("/objects/") ? `/api/storage${it.imageUrl}` : it.imageUrl}
                              alt=""
                              className="w-10 h-10 rounded-md object-cover border border-border shrink-0"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-md bg-muted grid place-items-center shrink-0">
                              <Package className="h-4 w-4 text-muted-foreground/40" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="font-medium">{it.nameAr}</p>
                            {it.nameEn && <p className="text-xs text-muted-foreground">{it.nameEn}</p>}
                            {it.barcode && <p className="text-[10px] text-muted-foreground/70 font-mono">🔖 {it.barcode}</p>}
                            {it.tags && tagsToArray(it.tags).length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {tagsToArray(it.tags).slice(0, 4).map((tg, i) => (
                                  <span key={i} className="inline-flex items-center gap-0.5 bg-primary/10 text-primary text-[9px] font-medium rounded px-1 py-0.5">
                                    <Tag className="h-2 w-2" />{tg}
                                  </span>
                                ))}
                                {tagsToArray(it.tags).length > 4 && (
                                  <span className="text-[9px] text-muted-foreground">+{tagsToArray(it.tags).length - 4}</span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground text-xs">{it.group?.nameAr ?? "—"}</td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {it.unit ? (
                          <span className="text-xs font-mono font-bold text-primary bg-primary/5 rounded px-1.5 py-0.5">{it.unit.code}</span>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell tabular-nums text-xs">{fmt(it.costPrice)}</td>
                      <td className="px-4 py-3 hidden lg:table-cell tabular-nums text-xs font-medium">{fmt(it.salePrice)}</td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex flex-col items-center gap-1">
                          <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5", it.itemType === "stock" ? "bg-blue-50 text-blue-700" : "bg-purple-50 text-purple-700")}>
                            {it.itemType === "stock" ? t("pages.items.stock") : t("pages.items.service")}
                          </span>
                          {(() => {
                            const nat = (it.itemNature ?? "merchandise") as string;
                            if (nat === "merchandise") return null;
                            const cls =
                              nat === "raw"        ? "bg-amber-50 text-amber-700 border-amber-200"
                            : nat === "semi"       ? "bg-orange-50 text-orange-700 border-orange-200"
                            : nat === "finished"   ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : nat === "consumable" ? "bg-rose-50 text-rose-700 border-rose-200"
                            : "bg-slate-50 text-slate-700 border-slate-200";
                            const label =
                              nat === "raw"        ? "خامات"
                            : nat === "semi"       ? "نصف مصنّع"
                            : nat === "finished"   ? "تام الصنع"
                            : nat === "consumable" ? "مستهلكات" : "بضاعة";
                            return <span className={cn("text-[9px] font-medium rounded-full px-2 py-0.5 border", cls)} data-testid={`badge-nature-${it.id}`}>{label}</span>;
                          })()}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5", it.status === "active" ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500")}>
                          {it.status === "active" ? t("pages.items.active") : t("pages.items.inactive")}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setQrItem(it)} title={t("pages.items.qr.show")}><QrCode className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setHistoryItem(it)} title={t("pages.items.history.show")}><History className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(it)}><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm(t("pages.items.deleteItemConfirm"))) deleteMut.mutate(it.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                      </td>
                    </tr>
                    {/* Expanded row: tabs for balances + unit prices */}
                    {expandedId === it.id && (
                      <tr className="bg-muted/20">
                        <td colSpan={11} className="px-6 py-4">
                          {/* Tabs */}
                          <div className="flex gap-1 bg-muted/50 p-1 rounded-lg w-fit mb-4 border">
                            <button
                              onClick={() => setExpandedTab("balances")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "balances" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <Warehouse className="h-3.5 w-3.5" />{t("pages.items.warehouseBalances")}
                            </button>
                            <button
                              onClick={() => setExpandedTab("units")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "units" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <Ruler className="h-3.5 w-3.5" />{t("pages.items.unitPrices")}
                            </button>
                            <button
                              onClick={() => setExpandedTab("analytics")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "analytics" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <TrendingUp className="h-3.5 w-3.5" />{t("pages.items.analytics.tabLabel")}
                            </button>
                            <button
                              onClick={() => setExpandedTab("documents")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "documents" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <FileText className="h-3.5 w-3.5" />{t("pages.items.documents.tabLabel")}
                            </button>
                            <button
                              onClick={() => setExpandedTab("suppliers")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "suppliers" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <Truck className="h-3.5 w-3.5" />{t("pages.items.suppliers.tabLabel")}
                            </button>
                            <button
                              onClick={() => setExpandedTab("bundle")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "bundle" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <Boxes className="h-3.5 w-3.5" />{t("pages.items.bundle.tabLabel")}
                              {it.isBundle && (
                                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[9px] font-bold">{t("pages.items.bundle.kitBadge")}</span>
                              )}
                            </button>
                            {/* PRO Extension #20 — Variants tab. Hidden when
                                this row is a bundle parent (variants/bundles
                                are orthogonal). */}
                            {!it.isBundle && !it.parentItemId && (
                              <button
                                onClick={() => setExpandedTab("variants")}
                                className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                  expandedTab === "variants" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                              >
                                <Layers className="h-3.5 w-3.5" />{t("pages.items.variants.tabLabel")}
                              </button>
                            )}
                            {/* PRO Extension #8 — Multi-currency override prices */}
                            <button
                              onClick={() => setExpandedTab("currencies")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "currencies" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <DollarSign className="h-3.5 w-3.5" />{t("pages.items.currencyPrices.tabLabel")}
                            </button>
                            {/* PRO Extension #9 — Per-branch stock & thresholds */}
                            <button
                              onClick={() => setExpandedTab("branches")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "branches" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <Building2 className="h-3.5 w-3.5" />{t("pages.items.branches.tabLabel")}
                            </button>
                            {/* Batches: رقم الدفعة + تاريخ الانتهاء */}
                            <button
                              onClick={() => setExpandedTab("batches")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "batches" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <FlaskConical className="h-3.5 w-3.5" />الدفعات
                            </button>
                            {/* PRO Extension #16 — Smart reorder suggestion */}
                            <button
                              onClick={() => setExpandedTab("reorder")}
                              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                expandedTab === "reorder" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                              <TrendingUp className="h-3.5 w-3.5" />{t("pages.items.reorder.tabLabel")}
                            </button>
                            {/* PRO Extension #18 — BOM steps (only meaningful for bundles) */}
                            {it.isBundle && (
                              <button
                                onClick={() => setExpandedTab("bomSteps")}
                                className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                                  expandedTab === "bomSteps" ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
                              >
                                <Cog className="h-3.5 w-3.5" />{t("pages.items.bomSteps.tabLabel")}
                              </button>
                            )}
                          </div>

                          {expandedTab === "balances" && (
                            <>
                              {!itemDetail?.balances?.length
                                ? <p className="text-xs text-muted-foreground py-4 text-center border border-dashed rounded-lg"><Warehouse className="h-6 w-6 mx-auto mb-1.5 opacity-30" />{t("pages.items.noBalancesRegistered")}</p>
                                : (
                                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                                    {itemDetail.balances.map((b: any) => (
                                      <div key={b.id} className="rounded-lg border bg-background p-3">
                                        <p className="text-xs font-medium truncate">{b.warehouse?.nameAr ?? "—"}</p>
                                        <div className="flex items-end gap-1 mt-1">
                                          <span className="text-lg font-bold tabular-nums">{fmtQty(b.qty)}</span>
                                          <span className="text-xs text-muted-foreground mb-0.5">{it.unit?.code ?? ""}</span>
                                        </div>
                                        <p className="text-[10px] text-muted-foreground">{t("pages.items.avgCost")}: {fmt(b.avgCost)} {t("pages.items.sar")}</p>
                                        {Number(b.qty) < Number(it.reorderLevel) && Number(b.qty) >= 0 && (
                                          <p className="text-[10px] text-amber-600 flex items-center gap-0.5 mt-0.5"><AlertTriangle className="h-2.5 w-2.5" />{t("pages.items.belowReorderLevel")}</p>
                                        )}
                                        {Number(b.qty) < 0 && (
                                          <p className="text-[10px] text-red-600 flex items-center gap-0.5 mt-0.5"><AlertTriangle className="h-2.5 w-2.5" />{t("pages.items.negativeBalance")}</p>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                            </>
                          )}

                          {expandedTab === "units" && (
                            <ItemUnitPricesPanel itemId={it.id} />
                          )}

                          {expandedTab === "analytics" && (
                            <ItemAnalyticsPanel itemId={it.id} unitCode={it.unit?.code ?? ""} />
                          )}

                          {expandedTab === "documents" && (
                            <ItemDocumentsPanel itemId={it.id} />
                          )}

                          {expandedTab === "suppliers" && (
                            <ItemSuppliersPanel itemId={it.id} />
                          )}

                          {expandedTab === "bundle" && (
                            <ItemBundleComponentsPanel itemId={it.id} />
                          )}

                          {expandedTab === "variants" && (
                            <ItemVariantsPanel itemId={it.id} parentName={it.nameAr} />
                          )}

                          {expandedTab === "currencies" && (
                            <ItemCurrencyPricesPanel itemId={it.id} />
                          )}

                          {expandedTab === "branches" && (
                            <ItemBranchStockPanel itemId={it.id} unitCode={it.unit?.code ?? ""} />
                          )}

                          {expandedTab === "reorder" && (
                            <ItemReorderPanel itemId={it.id} unitCode={it.unit?.code ?? ""} />
                          )}

                          {expandedTab === "batches" && (
                            <ItemBatchesPanel itemId={it.id} unitCode={it.unit?.code ?? ""} />
                          )}

                          {expandedTab === "bomSteps" && (
                            <ItemBomStepsPanel itemId={it.id} />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && (
          <TablePagination
            page={pager.page}
            pageSize={pager.pageSize}
            pageCount={pager.pageCount}
            total={pager.total}
            onPageChange={pager.setPage}
            onPageSizeChange={pager.setPageSize}
            itemLabel={t("pages.items.itemLabel", { defaultValue: "صنف" })}
          />
        )}
      </div>

      {/* QR Code dialog (item-scoped, mounted once at top level) */}
      <ItemQrDialog open={qrItem !== null} onOpenChange={(v) => !v && setQrItem(null)} item={qrItem} />

      {/* Audit-log / history dialog (item-scoped, mounted once at top level) */}
      <ItemHistoryDialog open={historyItem !== null} onOpenChange={(v) => !v && setHistoryItem(null)} item={historyItem} />

      {/* PRO Extension #13 — bulk label printing */}
      <BulkLabelDialog
        open={labelsOpen}
        onOpenChange={setLabelsOpen}
        items={(items as any[]).filter(i => selectedIds.has(i.id)).map(i => ({
          id: i.id, code: i.code, nameAr: i.nameAr, nameEn: i.nameEn,
          barcode: i.barcode, salePrice: i.salePrice,
        }))}
      />

      {/* PRO Extension #14 — scan barcode → attach image */}
      <ScanToImageDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        items={(items as any[]).map(i => ({
          id: i.id, code: i.code, nameAr: i.nameAr, nameEn: i.nameEn,
          barcode: i.barcode, imageUrl: i.imageUrl,
        }))}
        onAttach={async (itemId, objectPath) => {
          // Persist by patching just the imageUrl on the existing item.
          await inventoryApi.updateItem(itemId, { imageUrl: objectPath });
          // Refresh the items list so the new image shows in the table.
          qc.invalidateQueries({ queryKey: ["items"] });
        }}
      />
    </div>
  );
}

// ─── Item Bundle Components Panel (PRO Extension #2) ─────────────────────────
// Manages the "kit composition" of a parent item: child item, qty per parent,
// optional notes. The backend auto-flips `items.is_bundle` to true when the
// first child is added and back to false when the last is removed, so the
// user doesn't have to touch the checkbox separately.
function ItemBundleComponentsPanel({ itemId }: { itemId: number }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isAr = i18n.language?.startsWith("ar");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["item-bundle", itemId],
    queryFn: () => inventoryApi.getBundleComponents(itemId),
  });

  const components = data?.components ?? [];

  // Pull the full items list (already cached by the page) to populate the
  // child dropdown. Filter out: this item itself, items already added as
  // components, and other bundles (no nested bundles in this batch).
  const { data: allItems = [] } = useQuery({
    queryKey: ["items"],
    queryFn: () => inventoryApi.getItems(),
  });
  const linkedChildIds = new Set(components.map(c => c.childItemId));
  const availableChildren = (allItems as any[]).filter((it: any) =>
    it.id !== itemId && !linkedChildIds.has(it.id) && !it.isBundle
  );

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ childItemId: "", qty: "1", notes: "" });
  const resetForm = () => setForm({ childItemId: "", qty: "1", notes: "" });

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["item-bundle", itemId] });
    // Items list may have updated `isBundle` flags after add/delete.
    qc.invalidateQueries({ queryKey: ["items"] });
  };

  const addMut = useMutation({
    mutationFn: () => inventoryApi.addBundleComponent(itemId, {
      childItemId: Number(form.childItemId),
      qty: form.qty,
      notes: form.notes || null,
    }),
    onSuccess: () => {
      inv(); resetForm(); setShowForm(false);
      toast({ title: t("pages.items.bundle.added") });
    },
    onError: (e: any) => toast({
      title: t("pages.items.bundle.addFailed"),
      description: parseError(e),
      variant: "destructive",
    }),
  });

  const updateMut = useMutation({
    mutationFn: ({ linkId, qty }: { linkId: number; qty: string }) =>
      inventoryApi.updateBundleComponent(itemId, linkId, { qty }),
    onSuccess: () => { inv(); toast({ title: t("pages.items.bundle.updated") }); },
    onError: (e: any) => toast({
      title: t("pages.items.bundle.updateFailed"),
      description: parseError(e),
      variant: "destructive",
    }),
  });

  const deleteMut = useMutation({
    mutationFn: (linkId: number) => inventoryApi.deleteBundleComponent(itemId, linkId),
    onSuccess: () => { inv(); toast({ title: t("pages.items.bundle.deleted") }); },
    onError: (e: any) => toast({
      title: t("pages.items.bundle.deleteFailed"),
      description: parseError(e),
      variant: "destructive",
    }),
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError) {
    return (
      <div className="text-center text-xs text-destructive py-4 border border-dashed border-destructive/30 rounded-lg">
        {t("pages.items.bundle.loadError")}
      </div>
    );
  }

  // Compute total cost / sale price from components for the summary footer.
  const totalCost = components.reduce((s, c) =>
    s + (Number(c.childCostPrice) || 0) * (Number(c.qty) || 0), 0);
  const totalSale = components.reduce((s, c) =>
    s + (Number(c.childSalePrice) || 0) * (Number(c.qty) || 0), 0);

  return (
    <div className="space-y-3">
      {/* Header */}
      {!showForm && (
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs text-muted-foreground">{t("pages.items.bundle.description")}</p>
            {data?.isBundle && components.length > 0 && (
              <p className="text-[11px] text-primary font-medium mt-0.5">
                <Package className="h-3 w-3 inline-block ml-1" />
                {t("pages.items.bundle.kitActive")}
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 shrink-0"
            onClick={() => setShowForm(true)}
            disabled={availableChildren.length === 0}
            title={availableChildren.length === 0 ? t("pages.items.bundle.noMoreToAdd") : ""}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("pages.items.bundle.addButton")}
          </Button>
        </div>
      )}

      {showForm && (
        <div className="p-3 rounded-lg border bg-background/50 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="text-xs font-medium block mb-1">{t("pages.items.bundle.childItem")} *</label>
              <select
                value={form.childItemId}
                onChange={(e) => setForm(f => ({ ...f, childItemId: e.target.value }))}
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">— {t("pages.items.bundle.chooseChild")} —</option>
                {availableChildren.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {(isAr ? c.nameAr : (c.nameEn || c.nameAr))} {c.code ? `(${c.code})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.bundle.qty")} *</label>
              <Input
                type="number"
                step="0.0001"
                min="0.0001"
                value={form.qty}
                onChange={(e) => setForm(f => ({ ...f, qty: e.target.value }))}
                className="h-9"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">{t("pages.items.bundle.notes")}</label>
            <Input
              value={form.notes}
              onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
              className="h-9"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => { resetForm(); setShowForm(false); }}>
              {t("common.cancel", { defaultValue: "إلغاء" })}
            </Button>
            <Button
              size="sm"
              disabled={!form.childItemId || !form.qty || addMut.isPending}
              onClick={() => addMut.mutate()}
              className="gap-1.5"
            >
              {addMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {t("pages.items.bundle.save")}
            </Button>
          </div>
        </div>
      )}

      {components.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded-lg">
          <Boxes className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
          {t("pages.items.bundle.empty")}
        </p>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground">{t("pages.items.bundle.childItem")}</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground hidden sm:table-cell">{t("pages.items.bundle.code")}</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-32">{t("pages.items.bundle.qty")}</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground hidden md:table-cell">{t("pages.items.bundle.unitCost")}</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground hidden md:table-cell">{t("pages.items.bundle.subtotal")}</th>
                <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {components.map((c) => {
                const subTotal = (Number(c.childCostPrice) || 0) * (Number(c.qty) || 0);
                return (
                  <tr key={c.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2 font-medium">
                      {isAr ? (c.childNameAr || c.childNameEn) : (c.childNameEn || c.childNameAr)}
                    </td>
                    <td className="px-3 py-2 hidden sm:table-cell font-mono text-[11px] text-muted-foreground">{c.childCode ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        step="0.0001"
                        min="0.0001"
                        defaultValue={trimTrailingZeros(c.qty)}
                        onBlur={(e) => {
                          const v = e.target.value;
                          if (v && Number(v) > 0 && v !== trimTrailingZeros(c.qty)) {
                            updateMut.mutate({ linkId: c.id, qty: v });
                          }
                        }}
                        className="h-7 text-xs w-24"
                      />
                    </td>
                    <td className="px-3 py-2 hidden md:table-cell text-muted-foreground">
                      {c.childCostPrice ? trimTrailingZeros(c.childCostPrice) : "—"}
                    </td>
                    <td className="px-3 py-2 hidden md:table-cell font-semibold">
                      {subTotal > 0 ? subTotal.toFixed(2) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive mx-auto block"
                        onClick={() => { if (confirm(t("pages.items.bundle.deleteConfirm"))) deleteMut.mutate(c.id); }}
                        disabled={deleteMut.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {components.length > 0 && (totalCost > 0 || totalSale > 0) && (
              <tfoot className="bg-muted/30 border-t font-semibold">
                <tr>
                  <td colSpan={3} className="px-3 py-2 text-right">{t("pages.items.bundle.totals")}</td>
                  <td className="px-3 py-2 hidden md:table-cell text-muted-foreground">
                    {totalCost > 0 ? `${t("pages.items.bundle.totalCost")}: ${totalCost.toFixed(2)}` : "—"}
                  </td>
                  <td className="px-3 py-2 hidden md:table-cell">
                    {totalSale > 0 ? `${t("pages.items.bundle.totalSale")}: ${totalSale.toFixed(2)}` : "—"}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Item Suppliers Panel (PRO Extension #17) ────────────────────────────────
// Per-item supplier directory: links suppliers to items, tracks last
// purchase price + supplier-side SKU + lead time + notes, and lets the
// user mark a single "preferred" supplier per item. The backend enforces
// the "only one preferred" invariant in a single transaction.
function ItemSuppliersPanel({ itemId }: { itemId: number }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const isAr = i18n.language?.startsWith("ar");

  const { data: links = [], isLoading, isError } = useQuery({
    queryKey: ["item-suppliers", itemId],
    queryFn: () => inventoryApi.getItemSuppliers(itemId),
  });

  // Fetch the company's full supplier directory so the "Add" form can
  // show a dropdown filtered to suppliers not yet linked.
  const { data: allSuppliers = [] } = useQuery({
    queryKey: ["suppliers", cid],
    queryFn: async () => {
      const r = await fetch(`/api/suppliers${cid ? `?companyId=${cid}` : ""}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("zatca_token") ?? ""}` },
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<Array<{ id: number; nameAr: string; nameEn?: string; code?: string }>>;
    },
  });

  const linkedSupplierIds = new Set(links.map(l => l.supplierId));
  const availableSuppliers = allSuppliers.filter(s => !linkedSupplierIds.has(s.id));

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    supplierId: "",
    supplierItemCode: "",
    lastPurchasePrice: "",
    lastPurchaseDate: "",
    leadTimeDays: "",
    preferredSupplier: false,
    notes: "",
  });
  const resetForm = () => setForm({
    supplierId: "", supplierItemCode: "", lastPurchasePrice: "",
    lastPurchaseDate: "", leadTimeDays: "", preferredSupplier: false, notes: "",
  });

  const inv = () => qc.invalidateQueries({ queryKey: ["item-suppliers", itemId] });

  const addMut = useMutation({
    mutationFn: () => inventoryApi.addItemSupplier(itemId, {
      supplierId: Number(form.supplierId),
      supplierItemCode: form.supplierItemCode || null,
      lastPurchasePrice: form.lastPurchasePrice || null,
      lastPurchaseDate: form.lastPurchaseDate || null,
      leadTimeDays: form.leadTimeDays ? Number(form.leadTimeDays) : null,
      preferredSupplier: form.preferredSupplier,
      notes: form.notes || null,
    }),
    onSuccess: () => {
      inv();
      resetForm();
      setShowForm(false);
      toast({ title: t("pages.items.suppliers.added") });
    },
    onError: (e: any) => toast({
      title: t("pages.items.suppliers.addFailed"),
      description: parseError(e),
      variant: "destructive",
    }),
  });

  const togglePreferredMut = useMutation({
    mutationFn: (link: ItemSupplier) => inventoryApi.updateItemSupplier(itemId, link.id, {
      preferredSupplier: !link.preferredSupplier,
    }),
    onSuccess: () => { inv(); toast({ title: t("pages.items.suppliers.updated") }); },
    onError: (e: any) => toast({
      title: t("pages.items.suppliers.updateFailed"),
      description: parseError(e),
      variant: "destructive",
    }),
  });

  const deleteMut = useMutation({
    mutationFn: (linkId: number) => inventoryApi.deleteItemSupplier(itemId, linkId),
    onSuccess: () => { inv(); toast({ title: t("pages.items.suppliers.deleted") }); },
    onError: (e: any) => toast({
      title: t("pages.items.suppliers.deleteFailed"),
      description: parseError(e),
      variant: "destructive",
    }),
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError) {
    return (
      <div className="text-center text-xs text-destructive py-4 border border-dashed border-destructive/30 rounded-lg">
        {t("pages.items.suppliers.loadError")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Add bar */}
      {!showForm && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{t("pages.items.suppliers.description")}</p>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setShowForm(true)}
            disabled={availableSuppliers.length === 0}
            title={availableSuppliers.length === 0 ? t("pages.items.suppliers.noMoreToAdd") : ""}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("pages.items.suppliers.addButton")}
          </Button>
        </div>
      )}

      {showForm && (
        <div className="p-3 rounded-lg border bg-background/50 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.suppliers.supplier")} *</label>
              <select
                value={form.supplierId}
                onChange={(e) => setForm(f => ({ ...f, supplierId: e.target.value }))}
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">— {t("pages.items.suppliers.chooseSupplier")} —</option>
                {availableSuppliers.map(s => (
                  <option key={s.id} value={s.id}>
                    {(isAr ? s.nameAr : (s.nameEn || s.nameAr)) + (s.code ? ` (${s.code})` : "")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.suppliers.supplierItemCode")}</label>
              <Input
                value={form.supplierItemCode}
                onChange={(e) => setForm(f => ({ ...f, supplierItemCode: e.target.value }))}
                placeholder={t("pages.items.suppliers.supplierItemCodeHint")}
                className="h-9"
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.suppliers.lastPurchasePrice")}</label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                value={form.lastPurchasePrice}
                onChange={(e) => setForm(f => ({ ...f, lastPurchasePrice: e.target.value }))}
                className="h-9"
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.suppliers.lastPurchaseDate")}</label>
              <Input
                type="date"
                value={form.lastPurchaseDate}
                onChange={(e) => setForm(f => ({ ...f, lastPurchaseDate: e.target.value }))}
                className="h-9"
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.suppliers.leadTimeDays")}</label>
              <Input
                type="number"
                min="0"
                value={form.leadTimeDays}
                onChange={(e) => setForm(f => ({ ...f, leadTimeDays: e.target.value }))}
                className="h-9"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <Checkbox
                  checked={form.preferredSupplier}
                  onCheckedChange={(v) => setForm(f => ({ ...f, preferredSupplier: !!v }))}
                />
                <span>{t("pages.items.suppliers.preferred")}</span>
              </label>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">{t("pages.items.suppliers.notes")}</label>
            <Input
              value={form.notes}
              onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
              className="h-9"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => { resetForm(); setShowForm(false); }}>
              {t("common.cancel", { defaultValue: "إلغاء" })}
            </Button>
            <Button
              size="sm"
              disabled={!form.supplierId || addMut.isPending}
              onClick={() => addMut.mutate()}
              className="gap-1.5"
            >
              {addMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {t("pages.items.suppliers.save")}
            </Button>
          </div>
        </div>
      )}

      {/* Linked suppliers list */}
      {links.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded-lg">
          <Truck className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
          {t("pages.items.suppliers.empty")}
        </p>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground w-10"></th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground">{t("pages.items.suppliers.supplier")}</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground hidden sm:table-cell">{t("pages.items.suppliers.supplierItemCode")}</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground">{t("pages.items.suppliers.lastPurchasePrice")}</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground hidden md:table-cell">{t("pages.items.suppliers.lastPurchaseDate")}</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground hidden lg:table-cell">{t("pages.items.suppliers.leadTimeDays")}</th>
                <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-32"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {links.map((l) => (
                <tr key={l.id} className={cn("hover:bg-muted/30", l.preferredSupplier && "bg-primary/5")}>
                  <td className="px-3 py-2 text-center">
                    {l.preferredSupplier && (
                      <Star className="h-4 w-4 text-amber-500 fill-amber-500 mx-auto" aria-label={t("pages.items.suppliers.preferred")} />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{isAr ? (l.supplierName || l.supplierNameEn) : (l.supplierNameEn || l.supplierName)}</div>
                    {l.supplierCode && <div className="text-[10px] text-muted-foreground font-mono">{l.supplierCode}</div>}
                  </td>
                  <td className="px-3 py-2 hidden sm:table-cell font-mono text-[11px]">{l.supplierItemCode ?? "—"}</td>
                  <td className="px-3 py-2">
                    {l.lastPurchasePrice
                      ? <span className="font-semibold">{trimTrailingZeros(l.lastPurchasePrice)} <span className="text-[10px] text-muted-foreground">{t("pages.items.sar")}</span></span>
                      : "—"}
                  </td>
                  <td className="px-3 py-2 hidden md:table-cell text-muted-foreground">{l.lastPurchaseDate ?? "—"}</td>
                  <td className="px-3 py-2 hidden lg:table-cell text-muted-foreground">
                    {l.leadTimeDays != null ? `${l.leadTimeDays} ${t("pages.items.suppliers.days")}` : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => togglePreferredMut.mutate(l)}
                        disabled={togglePreferredMut.isPending}
                        title={l.preferredSupplier ? t("pages.items.suppliers.unsetPreferred") : t("pages.items.suppliers.setPreferred")}
                      >
                        {l.preferredSupplier
                          ? <Check className="h-3.5 w-3.5 text-amber-600" />
                          : <Star className="h-3.5 w-3.5" />
                        }
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        onClick={() => { if (confirm(t("pages.items.suppliers.deleteConfirm"))) deleteMut.mutate(l.id); }}
                        disabled={deleteMut.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Item Documents Panel (PRO Extension #10) ────────────────────────────────
// Lists files attached to an item (warranties / certificates / manuals / etc.)
// and provides upload + delete + download. The actual blob lives in object
// storage; this panel just owns the metadata table and the per-file UI.
const DOC_CATEGORIES = ["warranty", "certificate", "manual", "datasheet", "invoice", "other"] as const;
type DocCategory = typeof DOC_CATEGORIES[number];

function ItemDocumentsPanel({ itemId }: { itemId: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const [pendingCategory, setPendingCategory] = useState<DocCategory>("warranty");

  const { data: docs = [], isLoading, isError } = useQuery({
    queryKey: ["item-documents", itemId],
    queryFn: () => inventoryApi.getItemDocuments(itemId),
  });

  const deleteMut = useMutation({
    mutationFn: (docId: number) => inventoryApi.deleteItemDocument(itemId, docId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item-documents", itemId] });
      toast({ title: t("pages.items.documents.deleted") });
    },
    onError: (e: any) => toast({ title: t("pages.items.documents.deleteFailed"), description: parseError(e), variant: "destructive" }),
  });

  async function handleUpload(file: File) {
    // Server caps document size at the same 10 MB limit our object-storage
    // sidecar enforces; this client-side check just gives a faster error.
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: t("pages.items.documents.tooLarge"), variant: "destructive" });
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
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" }),
      });
      if (!reqRes.ok) throw new Error(await reqRes.text());
      const { uploadURL, objectPath } = await reqRes.json();
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putRes.ok) throw new Error("upload failed");
      await inventoryApi.addItemDocument(itemId, {
        fileUrl: objectPath,
        fileName: file.name,
        fileType: file.type || undefined,
        fileSize: file.size,
        category: pendingCategory,
      });
      qc.invalidateQueries({ queryKey: ["item-documents", itemId] });
      toast({ title: t("pages.items.documents.uploaded") });
    } catch (e: any) {
      toast({ title: t("pages.items.documents.uploadFailed"), description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  function fileSize(bytes: number | null): string {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function isImage(d: ItemDocument): boolean {
    return !!d.fileType?.startsWith("image/");
  }

  if (isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (isError) {
    return (
      <div className="text-center text-xs text-destructive py-4 border border-dashed border-destructive/30 rounded-lg">
        {t("pages.items.documents.loadError")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Upload bar */}
      <div className="flex flex-wrap items-center gap-2 p-3 rounded-lg border bg-background/50">
        <select
          value={pendingCategory}
          onChange={(e) => setPendingCategory(e.target.value as DocCategory)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
          disabled={uploading}
        >
          {DOC_CATEGORIES.map(c => (
            <option key={c} value={c}>{t(`pages.items.documents.cat.${c}`)}</option>
          ))}
        </select>
        <label className="cursor-pointer">
          <input
            type="file"
            className="hidden"
            disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ""; }}
          />
          <span className="inline-flex items-center gap-1.5 text-xs h-9 px-3 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition">
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {uploading ? t("pages.items.documents.uploading") : t("pages.items.documents.upload")}
          </span>
        </label>
        <p className="text-[10px] text-muted-foreground">{t("pages.items.documents.maxSize")}</p>
      </div>

      {/* Documents grid */}
      {(docs as ItemDocument[]).length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded-lg">
          <FileText className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
          {t("pages.items.documents.empty")}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {(docs as ItemDocument[]).map((d) => {
            const url = d.fileUrl.startsWith("/objects/") ? `/api/storage${d.fileUrl}` : d.fileUrl;
            return (
              <div key={d.id} className="rounded-lg border bg-background p-3 flex gap-3">
                <div className="w-12 h-12 rounded-md bg-muted grid place-items-center shrink-0 overflow-hidden">
                  {isImage(d) ? (
                    <img src={url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <FileText className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate" title={d.fileName}>{d.fileName}</p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                      {t(`pages.items.documents.cat.${d.category}`, { defaultValue: d.category })}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">{fileSize(d.fileSize)}</span>
                  </div>
                  <div className="flex gap-1 mt-2">
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                    >
                      <ExternalLink className="h-2.5 w-2.5" />
                      {t("pages.items.documents.view")}
                    </a>
                    <button
                      type="button"
                      onClick={() => { if (confirm(t("pages.items.documents.deleteConfirm"))) deleteMut.mutate(d.id); }}
                      className="inline-flex items-center gap-1 text-[10px] text-destructive hover:underline ms-auto"
                      disabled={deleteMut.isPending}
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                      {t("common.delete", { defaultValue: "حذف" })}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Item Variants Panel (PRO Extension #20) ─────────────────────────────────
// Shows the variants of a parent item (e.g. "T-Shirt – Red – L" rows under
// the parent "T-Shirt"). The variants ARE items themselves (separate stock,
// separate code, separate barcode), so create-variant uses the dedicated
// /variants endpoint that auto-sets parent_item_id and inherits group/unit/
// vatRate from the parent, while edit/delete go through the standard items
// PUT/DELETE (which the panel doesn't expose here — users edit a variant by
// going to its own row in the items list once the includeVariants filter is
// flipped on, or via a future "open variant" link).
function ItemVariantsPanel({ itemId, parentName }: { itemId: number; parentName: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  // useFmt() returns a bag of formatters; pull `fmt` (monetary) for the
  // cost/price columns. (Not destructuring crashed the panel render.)
  const { fmt } = useFmt();
  const isAr = i18n.language?.startsWith("ar");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["item-variants", itemId],
    queryFn: () => inventoryApi.getItemVariants(itemId),
  });

  const variants = data?.variants ?? [];

  // Form state for "add variant". Attributes are entered as ad-hoc rows
  // ({ key, value }) so the user can model whatever attribute set fits
  // (color/size/flavor/...). Empty rows are skipped on submit.
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    code: "", nameAr: "", nameEn: "", barcode: "",
    costPrice: "", salePrice: "",
  });
  const [attrs, setAttrs] = useState<Array<{ k: string; v: string }>>([{ k: "", v: "" }]);

  const resetForm = () => {
    setForm({ code: "", nameAr: "", nameEn: "", barcode: "", costPrice: "", salePrice: "" });
    setAttrs([{ k: "", v: "" }]);
    setShowForm(false);
  };

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["item-variants", itemId] });
    // Variants opt out of the items list (parent_item_id IS NOT NULL),
    // but we still nudge the items query in case some panels render counts.
    qc.invalidateQueries({ queryKey: ["items"] });
  };

  const errToast = (title: string) => (e: any) => toast({
    title, description: parseError(e), variant: "destructive",
  });

  const addMut = useMutation({
    mutationFn: (data: any) => inventoryApi.addItemVariant(itemId, data),
    onSuccess: () => { inv(); resetForm(); toast({ title: t("pages.items.variants.added") }); },
    onError: errToast(t("pages.items.variants.addFailed")),
  });

  const submit = () => {
    if (!form.code.trim() || !form.nameAr.trim()) {
      toast({ title: t("pages.items.variants.codeAndNameRequired"), variant: "destructive" });
      return;
    }
    // Build the variantAttributes object from the attribute rows, skipping
    // empty pairs and trimming whitespace. Backend will validate the shape.
    const variantAttributes: Record<string, string> = {};
    for (const { k, v } of attrs) {
      const key = k.trim();
      if (key) variantAttributes[key] = (v ?? "").trim();
    }
    addMut.mutate({
      code: form.code.trim(),
      nameAr: form.nameAr.trim(),
      nameEn: form.nameEn.trim() || null,
      barcode: form.barcode.trim() || null,
      costPrice: form.costPrice.trim() || undefined,  // backend falls back to parent
      salePrice: form.salePrice.trim() || undefined,  // backend falls back to parent
      variantAttributes: Object.keys(variantAttributes).length > 0 ? variantAttributes : null,
    });
  };

  if (isLoading) return <p className="text-xs text-muted-foreground py-4 text-center">{t("common.loading", { defaultValue: "..." })}</p>;
  if (isError) return <p className="text-xs text-destructive py-4 text-center">{t("pages.items.variants.loadFailed")}</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("pages.items.variants.description", { name: parentName })}
        </p>
        <button
          type="button"
          onClick={() => setShowForm(s => !s)}
          className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" />
          {showForm ? t("common.cancel", { defaultValue: "إلغاء" }) : t("pages.items.variants.addButton")}
        </button>
      </div>

      {showForm && (
        <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <label className="text-xs">
              <span className="block mb-1 text-muted-foreground">{t("pages.items.variants.code")} *</span>
              <input
                type="text" value={form.code}
                onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
                className="w-full px-2 py-1 rounded border bg-background text-xs"
              />
            </label>
            <label className="text-xs">
              <span className="block mb-1 text-muted-foreground">{t("pages.items.variants.nameAr")} *</span>
              <input
                type="text" value={form.nameAr}
                onChange={e => setForm(f => ({ ...f, nameAr: e.target.value }))}
                className="w-full px-2 py-1 rounded border bg-background text-xs"
              />
            </label>
            <label className="text-xs">
              <span className="block mb-1 text-muted-foreground">{t("pages.items.variants.nameEn")}</span>
              <input
                type="text" value={form.nameEn}
                onChange={e => setForm(f => ({ ...f, nameEn: e.target.value }))}
                className="w-full px-2 py-1 rounded border bg-background text-xs"
              />
            </label>
            <label className="text-xs">
              <span className="block mb-1 text-muted-foreground">{t("pages.items.variants.barcode")}</span>
              <input
                type="text" value={form.barcode}
                onChange={e => setForm(f => ({ ...f, barcode: e.target.value }))}
                className="w-full px-2 py-1 rounded border bg-background text-xs"
              />
            </label>
            <label className="text-xs">
              <span className="block mb-1 text-muted-foreground">{t("pages.items.variants.costPrice")}</span>
              <input
                type="text" value={form.costPrice} placeholder={t("pages.items.variants.inheritFromParent")}
                onChange={e => setForm(f => ({ ...f, costPrice: e.target.value }))}
                className="w-full px-2 py-1 rounded border bg-background text-xs"
              />
            </label>
            <label className="text-xs">
              <span className="block mb-1 text-muted-foreground">{t("pages.items.variants.salePrice")}</span>
              <input
                type="text" value={form.salePrice} placeholder={t("pages.items.variants.inheritFromParent")}
                onChange={e => setForm(f => ({ ...f, salePrice: e.target.value }))}
                className="w-full px-2 py-1 rounded border bg-background text-xs"
              />
            </label>
          </div>

          {/* Variant attributes — free-form key/value rows. */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("pages.items.variants.attributes")}</p>
            {attrs.map((a, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-1 items-center">
                <input
                  type="text" value={a.k}
                  placeholder={t("pages.items.variants.attrKeyPlaceholder")}
                  onChange={e => setAttrs(arr => arr.map((row, i) => i === idx ? { ...row, k: e.target.value } : row))}
                  className="px-2 py-1 rounded border bg-background text-xs"
                />
                <input
                  type="text" value={a.v}
                  placeholder={t("pages.items.variants.attrValPlaceholder")}
                  onChange={e => setAttrs(arr => arr.map((row, i) => i === idx ? { ...row, v: e.target.value } : row))}
                  className="px-2 py-1 rounded border bg-background text-xs"
                />
                <button
                  type="button"
                  onClick={() => setAttrs(arr => arr.length > 1 ? arr.filter((_, i) => i !== idx) : [{ k: "", v: "" }])}
                  className="p-1 rounded hover:bg-destructive/10 text-destructive"
                  aria-label="remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setAttrs(arr => [...arr, { k: "", v: "" }])}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3 w-3" />{t("pages.items.variants.addAttribute")}
            </button>
          </div>

          <div className="flex gap-2 justify-end">
            <button
              type="button" onClick={resetForm}
              className="px-3 py-1.5 rounded-md border text-xs hover:bg-muted"
            >
              {t("common.cancel", { defaultValue: "إلغاء" })}
            </button>
            <button
              type="button" onClick={submit} disabled={addMut.isPending}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-xs disabled:opacity-50"
            >
              {addMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {t("pages.items.variants.save")}
            </button>
          </div>
        </div>
      )}

      {variants.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded-lg">
          <Layers className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
          {t("pages.items.variants.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-start font-medium">{t("pages.items.variants.code")}</th>
                <th className="px-2 py-1.5 text-start font-medium">{isAr ? t("pages.items.variants.nameAr") : t("pages.items.variants.nameEn")}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t("pages.items.variants.attributes")}</th>
                <th className="px-2 py-1.5 text-end font-medium">{t("pages.items.variants.costPrice")}</th>
                <th className="px-2 py-1.5 text-end font-medium">{t("pages.items.variants.salePrice")}</th>
              </tr>
            </thead>
            <tbody>
              {variants.map((v: ItemVariant) => (
                <tr key={v.id} className="border-t hover:bg-muted/20">
                  <td className="px-2 py-1.5 font-mono">{v.code}</td>
                  <td className="px-2 py-1.5">{isAr ? v.nameAr : (v.nameEn ?? v.nameAr)}</td>
                  <td className="px-2 py-1.5">
                    {v.variantAttributes && Object.keys(v.variantAttributes).length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(v.variantAttributes).map(([k, val]) => (
                          <span key={k} className="px-1.5 py-0.5 rounded-full bg-muted text-[10px]">
                            <span className="text-muted-foreground">{k}:</span> {String(val ?? "")}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-end tabular-nums">{fmt(v.costPrice)}</td>
                  <td className="px-2 py-1.5 text-end tabular-nums">{fmt(v.salePrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PRO Extension #8 — Multi-currency override prices panel
// ════════════════════════════════════════════════════════════════════════════
// Lets the user set per-item override prices in any of the tenant's
// non-default currencies. The default currency is excluded from the
// dropdown because the base price columns on `items` already cover it.
function ItemCurrencyPricesPanel({ itemId }: { itemId: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const { fmt } = useFmt();

  const { data: rows = [], isLoading, isError } = useQuery({
    queryKey: ["item-currency-prices", itemId],
    queryFn: () => inventoryApi.getItemCurrencyPrices(itemId),
  });

  // Pull tenant currency directory; filter out the default + already-used.
  const { data: allCurrencies = [] } = useQuery({
    queryKey: ["currencies", cid],
    queryFn: async () => {
      const r = await fetch(`/api/currencies${cid ? `?companyId=${cid}` : ""}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("zatca_token") ?? ""}` },
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<Array<{ id: number; code: string; nameAr: string; nameEn?: string; isDefault: boolean }>>;
    },
  });
  const usedCodes = new Set(rows.map(r => r.currencyCode));
  const availableCurrencies = allCurrencies.filter(c => !c.isDefault && !usedCodes.has(c.code));

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ currencyCode: "", costPrice: "", salePrice: "", notes: "" });
  const resetForm = () => setForm({ currencyCode: "", costPrice: "", salePrice: "", notes: "" });

  const inv = () => qc.invalidateQueries({ queryKey: ["item-currency-prices", itemId] });
  const errToast = (key: string) => (e: any) => toast({
    title: t(key), description: parseError(e), variant: "destructive",
  });

  const addMut = useMutation({
    mutationFn: () => inventoryApi.addItemCurrencyPrice(itemId, {
      currencyCode: form.currencyCode,
      costPrice: form.costPrice || 0,
      salePrice: form.salePrice || 0,
      notes: form.notes || undefined,
    }),
    onSuccess: () => { inv(); resetForm(); setShowForm(false); toast({ title: t("pages.items.currencyPrices.added") }); },
    onError: errToast("pages.items.currencyPrices.addFailed"),
  });

  const deleteMut = useMutation({
    mutationFn: (rowId: number) => inventoryApi.deleteItemCurrencyPrice(itemId, rowId),
    onSuccess: () => { inv(); toast({ title: t("pages.items.currencyPrices.deleted") }); },
    onError: errToast("pages.items.currencyPrices.deleteFailed"),
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError) return (
    <div className="text-center text-xs text-destructive py-4 border border-dashed border-destructive/30 rounded-lg">
      {t("pages.items.currencyPrices.loadError")}
    </div>
  );

  return (
    <div className="space-y-3">
      {!showForm && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{t("pages.items.currencyPrices.description")}</p>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setShowForm(true)}
            disabled={availableCurrencies.length === 0}
            title={availableCurrencies.length === 0 ? t("pages.items.currencyPrices.noMoreCurrencies") : ""}
          >
            <Plus className="h-3.5 w-3.5" />{t("pages.items.currencyPrices.addButton")}
          </Button>
        </div>
      )}
      {showForm && (
        <div className="p-3 rounded-lg border bg-background/50 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.currencyPrices.currency")} *</label>
              <select
                value={form.currencyCode}
                onChange={(e) => setForm(f => ({ ...f, currencyCode: e.target.value }))}
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">— {t("pages.items.currencyPrices.chooseCurrency")} —</option>
                {availableCurrencies.map(c => (
                  <option key={c.code} value={c.code}>{c.code} — {c.nameAr}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.currencyPrices.costPrice")}</label>
              <Input type="number" step="0.0001" min="0" value={form.costPrice}
                onChange={(e) => setForm(f => ({ ...f, costPrice: e.target.value }))} className="h-9" />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.currencyPrices.salePrice")}</label>
              <Input type="number" step="0.0001" min="0" value={form.salePrice}
                onChange={(e) => setForm(f => ({ ...f, salePrice: e.target.value }))} className="h-9" />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.currencyPrices.notes")}</label>
              <Input value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} className="h-9" />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => { resetForm(); setShowForm(false); }}>
              {t("common.cancel", { defaultValue: "إلغاء" })}
            </Button>
            <Button size="sm" disabled={!form.currencyCode || addMut.isPending}
              onClick={() => addMut.mutate()} className="gap-1.5">
              {addMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {t("pages.items.currencyPrices.save")}
            </Button>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded-lg">
          <DollarSign className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
          {t("pages.items.currencyPrices.empty")}
        </p>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-start">{t("pages.items.currencyPrices.currency")}</th>
                <th className="px-3 py-2 text-end">{t("pages.items.currencyPrices.costPrice")}</th>
                <th className="px-3 py-2 text-end">{t("pages.items.currencyPrices.salePrice")}</th>
                <th className="px-3 py-2 text-start">{t("pages.items.currencyPrices.notes")}</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t hover:bg-muted/20">
                  <td className="px-3 py-2 font-mono font-semibold">{r.currencyCode}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{fmt(r.costPrice)}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{fmt(r.salePrice)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.notes ?? "—"}</td>
                  <td className="px-2 py-2">
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive"
                      onClick={() => {
                        if (window.confirm(t("pages.items.currencyPrices.deleteConfirm", { code: r.currencyCode }))) deleteMut.mutate(r.id);
                      }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PRO Extension #9 — Per-branch stock & thresholds panel
// ════════════════════════════════════════════════════════════════════════════
// Renders ONE row per tenant branch (LEFT-JOINed server-side). Each row
// can be edited inline — qty, reorderLevel and maxLevel — and saving
// upserts via PUT /branch-stock/:branchId. Empty fields delete the row.
function ItemBranchStockPanel({ itemId, unitCode }: { itemId: number; unitCode: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { fmt, fmtQty } = useFmt();

  const { data: rows = [], isLoading, isError } = useQuery({
    queryKey: ["item-branch-stock", itemId],
    queryFn: () => inventoryApi.getItemBranchStock(itemId),
  });

  const [edits, setEdits] = useState<Record<number, { qty: string; reorderLevel: string; maxLevel: string; notes: string }>>({});
  const editFor = (b: ItemBranchStockRow) => edits[b.branchId] ?? {
    qty: b.qty ?? "0",
    reorderLevel: b.reorderLevel ?? "",
    maxLevel: b.maxLevel ?? "",
    notes: b.notes ?? "",
  };

  const inv = () => qc.invalidateQueries({ queryKey: ["item-branch-stock", itemId] });
  const errToast = (key: string) => (e: any) => toast({
    title: t(key), description: parseError(e), variant: "destructive",
  });

  const saveMut = useMutation({
    mutationFn: ({ branchId, data }: { branchId: number; data: any }) =>
      inventoryApi.upsertItemBranchStock(itemId, branchId, data),
    onSuccess: (_d, vars) => {
      inv();
      setEdits(e => { const n = { ...e }; delete n[vars.branchId]; return n; });
      toast({ title: t("pages.items.branches.saved") });
    },
    onError: errToast("pages.items.branches.saveFailed"),
  });
  const deleteMut = useMutation({
    mutationFn: (rowId: number) => inventoryApi.deleteItemBranchStock(itemId, rowId),
    onSuccess: () => { inv(); toast({ title: t("pages.items.branches.deleted") }); },
    onError: errToast("pages.items.branches.deleteFailed"),
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError) return (
    <div className="text-center text-xs text-destructive py-4 border border-dashed border-destructive/30 rounded-lg">
      {t("pages.items.branches.loadError")}
    </div>
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("pages.items.branches.description")}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded-lg">
          <Building2 className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
          {t("pages.items.branches.noBranches")}
        </p>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-start">{t("pages.items.branches.branch")}</th>
                <th className="px-3 py-2 text-end w-28">{t("pages.items.branches.qty")}</th>
                <th className="px-3 py-2 text-end w-28">{t("pages.items.branches.reorderLevel")}</th>
                <th className="px-3 py-2 text-end w-28">{t("pages.items.branches.maxLevel")}</th>
                <th className="px-3 py-2 text-start">{t("pages.items.branches.notes")}</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const e = editFor(b);
                const dirty = edits[b.branchId] !== undefined;
                const qtyNum = Number(b.qty);
                const rlNum  = b.reorderLevel != null ? Number(b.reorderLevel) : null;
                // Highlight branches at-or-below their per-branch reorder level
                // (the per-branch level wins over the global one, when set).
                const isLow  = rlNum !== null && rlNum > 0 && qtyNum <= rlNum;
                return (
                  <tr key={b.branchId} className={cn("border-t hover:bg-muted/10", isLow && "bg-amber-50/40 dark:bg-amber-900/10")}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{b.branchNameAr}</span>
                        {b.isMain && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-bold">{t("pages.items.branches.mainBadge")}</span>}
                      </div>
                      <span className="text-[10px] text-muted-foreground font-mono">{b.branchCode}</span>
                    </td>
                    <td className="px-2 py-1.5">
                      <Input type="number" step="0.0001" value={e.qty} className="h-8 text-end tabular-nums"
                        onChange={(ev) => setEdits(s => ({ ...s, [b.branchId]: { ...editFor(b), qty: ev.target.value } }))} />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input type="number" step="0.0001" min="0" value={e.reorderLevel} className="h-8 text-end tabular-nums"
                        onChange={(ev) => setEdits(s => ({ ...s, [b.branchId]: { ...editFor(b), reorderLevel: ev.target.value } }))} />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input type="number" step="0.0001" min="0" value={e.maxLevel} className="h-8 text-end tabular-nums"
                        onChange={(ev) => setEdits(s => ({ ...s, [b.branchId]: { ...editFor(b), maxLevel: ev.target.value } }))} />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input value={e.notes} className="h-8"
                        onChange={(ev) => setEdits(s => ({ ...s, [b.branchId]: { ...editFor(b), notes: ev.target.value } }))} />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex gap-1 justify-end">
                        {dirty && (
                          <Button size="icon" variant="default" className="h-7 w-7"
                            disabled={saveMut.isPending}
                            onClick={() => saveMut.mutate({
                              branchId: b.branchId,
                              data: {
                                qty: e.qty || "0",
                                reorderLevel: e.reorderLevel === "" ? null : e.reorderLevel,
                                maxLevel:     e.maxLevel     === "" ? null : e.maxLevel,
                                notes:        e.notes || undefined,
                              },
                            })}>
                            <Save className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {b.rowId !== null && (
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive"
                            onClick={() => {
                              if (window.confirm(t("pages.items.branches.deleteConfirm", { branch: b.branchNameAr }))) deleteMut.mutate(b.rowId!);
                            }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-muted/30">
              <tr className="border-t font-semibold">
                <td className="px-3 py-2">{t("pages.items.branches.totals")}</td>
                <td className="px-3 py-2 text-end tabular-nums">
                  {fmtQty(rows.reduce((s, r) => s + Number(r.qty || 0), 0))} {unitCode}
                </td>
                <td colSpan={4}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PRO Extension #16 — Smart reorder suggestion panel
// ════════════════════════════════════════════════════════════════════════════
// Read-only panel that displays the inputs (current stock, velocity, lead
// time, thresholds) the server used and the final suggested order qty.
// We also show the formula so the user understands where the number came
// from — important for trust on automated suggestions.
function ItemReorderPanel({ itemId, unitCode }: { itemId: number; unitCode: string }) {
  const { t } = useTranslation();
  const { fmt, fmtQty } = useFmt();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["item-reorder", itemId],
    queryFn: () => inventoryApi.getReorderSuggestion(itemId),
  });

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (isError || !data) return (
    <div className="text-center text-xs text-destructive py-4 border border-dashed border-destructive/30 rounded-lg">
      {t("pages.items.reorder.loadError")}
    </div>
  );

  const { inputs, computed } = data;
  const Tile = ({ label, value, hint, color }: { label: string; value: React.ReactNode; hint?: string; color?: string }) => (
    <div className="rounded-lg border bg-background p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-lg font-bold tabular-nums mt-0.5", color)}>{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("pages.items.reorder.description")}</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Tile
          label={t("pages.items.reorder.currentStock")}
          value={`${fmtQty(inputs.currentStock)} ${unitCode}`}
        />
        <Tile
          label={t("pages.items.reorder.avgMonthlySales")}
          value={fmtQty(inputs.avgMonthlySales)}
          hint={t("pages.items.reorder.avgMonthlySalesHint")}
        />
        <Tile
          label={t("pages.items.reorder.dailyVelocity")}
          value={fmtQty(inputs.dailyVelocity)}
          hint={`${fmtQty(inputs.dailyVelocity)} ${unitCode}/${t("pages.items.reorder.day")}`}
        />
        <Tile
          label={t("pages.items.reorder.leadTimeDays")}
          value={inputs.leadTimeDays}
          hint={t("pages.items.reorder.leadTimeHint")}
        />
        <Tile
          label={t("pages.items.reorder.reorderLevel")}
          value={fmtQty(inputs.reorderLevel)}
          hint={inputs.maxLevel != null ? t("pages.items.reorder.maxLevelHint", { max: fmtQty(inputs.maxLevel) }) : undefined}
        />
      </div>

      <div className={cn(
        "rounded-lg border-2 p-4 flex items-center justify-between gap-4 flex-wrap",
        computed.needsReorder
          ? "border-amber-500/60 bg-amber-50 dark:bg-amber-900/20"
          : "border-emerald-500/40 bg-emerald-50 dark:bg-emerald-900/10",
      )}>
        <div>
          <p className={cn("text-xs font-semibold flex items-center gap-1.5",
            computed.needsReorder ? "text-amber-800 dark:text-amber-300" : "text-emerald-800 dark:text-emerald-300")}>
            {computed.needsReorder
              ? <><AlertTriangle className="h-4 w-4" />{t("pages.items.reorder.needsReorder")}</>
              : <><Check className="h-4 w-4" />{t("pages.items.reorder.adequate")}</>}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1 max-w-md">
            {t("pages.items.reorder.formula", {
              reorder: fmtQty(inputs.reorderLevel),
              consumption: fmtQty(computed.leadTimeConsumption),
              target: fmtQty(computed.targetStock),
              current: fmtQty(inputs.currentStock),
            })}
          </p>
        </div>
        <div className="text-end">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("pages.items.reorder.suggestedQty")}</p>
          <p className={cn("text-3xl font-bold tabular-nums",
            computed.suggestedOrderQty > 0 ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300")}>
            {fmtQty(computed.suggestedOrderQty)} <span className="text-base font-medium text-muted-foreground">{unitCode}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Batches panel — رقم الدفعة + تاريخ الانتهاء
// ════════════════════════════════════════════════════════════════════════════
// Aggregates incoming purchase / goods-receipt movements by
// (batchNumber, expiryDate, warehouse). Outgoing movements do not yet
// carry a batch reference (medium-scope feature: historical recording
// only, no FIFO/FEFO lot tracking), so we show *received* qty + expiry
// status — not "remaining per batch".
function ItemBatchesPanel({ itemId, unitCode }: { itemId: number; unitCode: string }) {
  const { i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const { fmt, fmtQty } = useFmt();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["item-batches", itemId],
    queryFn: () => inventoryApi.getItemBatches(itemId),
  });

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (isError || !data) return (
    <div className="text-center text-xs text-destructive py-4 border border-dashed border-destructive/30 rounded-lg">
      تعذّر تحميل الدفعات
    </div>
  );

  if (!data.batches.length) return (
    <div className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded-lg">
      <FlaskConical className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
      لا توجد دفعات مسجّلة لهذا الصنف بعد.
      <p className="text-[10px] mt-1 opacity-70">أدخل رقم الدفعة وتاريخ الانتهاء في فاتورة المشتريات أو سند الاستلام، وستظهر هنا.</p>
    </div>
  );

  const s = data.summary;
  const statusBadge = (st: string) => {
    if (st === "expired")        return { cls: "bg-red-100 text-red-700 border-red-200",         label: "منتهية" };
    if (st === "expiring_soon")  return { cls: "bg-amber-100 text-amber-800 border-amber-200",   label: "قاربت على الانتهاء" };
    if (st === "active")         return { cls: "bg-emerald-100 text-emerald-700 border-emerald-200", label: "صالحة" };
    return                          { cls: "bg-slate-100 text-slate-600 border-slate-200",      label: "بدون انتهاء" };
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border bg-background p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">إجمالي الدفعات</p>
          <p className="text-lg font-bold tabular-nums mt-0.5">{s.totalBatches}</p>
        </div>
        <div className="rounded-lg border bg-emerald-50 dark:bg-emerald-900/10 p-3">
          <p className="text-[10px] uppercase tracking-wide text-emerald-700">صالحة</p>
          <p className="text-lg font-bold tabular-nums mt-0.5 text-emerald-700">{s.activeCount}</p>
        </div>
        <div className="rounded-lg border bg-amber-50 dark:bg-amber-900/10 p-3">
          <p className="text-[10px] uppercase tracking-wide text-amber-700">تنتهي خلال 30 يوم</p>
          <p className="text-lg font-bold tabular-nums mt-0.5 text-amber-700">{s.expiringSoonCount}</p>
        </div>
        <div className="rounded-lg border bg-red-50 dark:bg-red-900/10 p-3">
          <p className="text-[10px] uppercase tracking-wide text-red-700">منتهية</p>
          <p className="text-lg font-bold tabular-nums mt-0.5 text-red-700">{s.expiredCount}</p>
        </div>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className={cn("px-3 py-2 font-semibold text-muted-foreground text-xs", isRtl ? "text-right" : "text-left")}>رقم الدفعة</th>
              <th className={cn("px-3 py-2 font-semibold text-muted-foreground text-xs", isRtl ? "text-right" : "text-left")}>تاريخ الانتهاء</th>
              <th className="px-3 py-2 text-center font-semibold text-muted-foreground text-xs">الحالة</th>
              <th className={cn("px-3 py-2 font-semibold text-muted-foreground text-xs", isRtl ? "text-right" : "text-left")}>المستودع</th>
              <th className="px-3 py-2 text-center font-semibold text-muted-foreground text-xs">الكمية المستلمة</th>
              <th className="px-3 py-2 text-center font-semibold text-muted-foreground text-xs">متوسط التكلفة</th>
              <th className="px-3 py-2 text-center font-semibold text-muted-foreground text-xs">أول استلام</th>
              <th className="px-3 py-2 text-center font-semibold text-muted-foreground text-xs">آخر استلام</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.batches.map((b, i) => {
              const badge = statusBadge(b.status);
              return (
                <tr key={`${b.batchNumber}-${b.expiryDate ?? ""}-${b.warehouseId ?? ""}-${i}`} className="hover:bg-muted/20">
                  <td className="px-3 py-2 font-mono text-xs font-medium">{b.batchNumber}</td>
                  <td className="px-3 py-2 tabular-nums text-xs">
                    {b.expiryDate ?? <span className="text-muted-foreground">—</span>}
                    {b.daysToExpiry != null && (
                      <span className="block text-[10px] text-muted-foreground">
                        {b.daysToExpiry < 0 ? `منذ ${-b.daysToExpiry} يوم` : `بعد ${b.daysToExpiry} يوم`}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5 border", badge.cls)}>
                      {badge.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {isRtl ? (b.warehouse.nameAr ?? b.warehouse.nameEn ?? "—") : (b.warehouse.nameEn ?? b.warehouse.nameAr ?? "—")}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums text-xs font-semibold">
                    {fmtQty(b.receivedQty)} <span className="text-muted-foreground font-normal">{unitCode}</span>
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums text-xs">{fmt(b.avgCost)}</td>
                  <td className="px-3 py-2 text-center tabular-nums text-[10px] text-muted-foreground">{b.firstSeen}</td>
                  <td className="px-3 py-2 text-center tabular-nums text-[10px] text-muted-foreground">{b.lastSeen}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed border-r-2 border-amber-300 ps-3 py-1">
        <span className="font-semibold">ملاحظة:</span> العمود "الكمية المستلمة" يعرض إجمالي ما دخل المخزون بهذه الدفعة منذ أول تسجيل لها. حركات البيع/الصرف لا ترتبط بدفعة معينة في هذه المرحلة، لذلك لا يوجد عمود "المتبقي من الدفعة" — أُضيف لاحقاً عند ترقية النظام لتتبّع الدفعات الكامل (FIFO/FEFO).
      </p>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PRO Extension #18 — BOM steps panel (manufacturing recipe)
// ════════════════════════════════════════════════════════════════════════════
// Sequence-ordered list of manufacturing steps with labour + overhead
// cost per step. The footer shows the totals and the "manufactured cost"
// (component cost + labour + overhead), useful when costing a kit.
function ItemBomStepsPanel({ itemId }: { itemId: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { fmt } = useFmt();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["item-bom-steps", itemId],
    queryFn: () => inventoryApi.getItemBomSteps(itemId),
  });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ sequence: "", nameAr: "", nameEn: "", durationMinutes: "", laborCost: "", overheadCost: "", notes: "" });
  const resetForm = () => setForm({ sequence: "", nameAr: "", nameEn: "", durationMinutes: "", laborCost: "", overheadCost: "", notes: "" });

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["item-bom-steps", itemId] });
    qc.invalidateQueries({ queryKey: ["item-bundle", itemId] });
  };
  const errToast = (key: string) => (e: any) => toast({
    title: t(key), description: parseError(e), variant: "destructive",
  });

  const addMut = useMutation({
    mutationFn: () => inventoryApi.addItemBomStep(itemId, {
      // Auto-pick next sequence if user didn't supply one
      sequence: form.sequence ? Number(form.sequence) : ((data?.steps.length ?? 0) + 1),
      nameAr: form.nameAr,
      nameEn: form.nameEn || undefined,
      durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : 0,
      laborCost:    form.laborCost    || 0,
      overheadCost: form.overheadCost || 0,
      notes: form.notes || undefined,
    }),
    onSuccess: () => { inv(); resetForm(); setShowForm(false); toast({ title: t("pages.items.bomSteps.added") }); },
    onError: errToast("pages.items.bomSteps.addFailed"),
  });
  const deleteMut = useMutation({
    mutationFn: (stepId: number) => inventoryApi.deleteItemBomStep(itemId, stepId),
    onSuccess: () => { inv(); toast({ title: t("pages.items.bomSteps.deleted") }); },
    onError: errToast("pages.items.bomSteps.deleteFailed"),
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError || !data) return (
    <div className="text-center text-xs text-destructive py-4 border border-dashed border-destructive/30 rounded-lg">
      {t("pages.items.bomSteps.loadError")}
    </div>
  );

  const { steps, totals } = data;

  return (
    <div className="space-y-3">
      {!showForm && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{t("pages.items.bomSteps.description")}</p>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowForm(true)}>
            <Plus className="h-3.5 w-3.5" />{t("pages.items.bomSteps.addButton")}
          </Button>
        </div>
      )}
      {showForm && (
        <div className="p-3 rounded-lg border bg-background/50 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.bomSteps.sequence")}</label>
              <Input type="number" min="0" value={form.sequence} placeholder={`${(data.steps.length ?? 0) + 1}`}
                onChange={(e) => setForm(f => ({ ...f, sequence: e.target.value }))} className="h-9" />
            </div>
            <div className="lg:col-span-2">
              <label className="text-xs font-medium block mb-1">{t("pages.items.bomSteps.nameAr")} *</label>
              <Input value={form.nameAr} onChange={(e) => setForm(f => ({ ...f, nameAr: e.target.value }))} className="h-9" />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.bomSteps.nameEn")}</label>
              <Input value={form.nameEn} onChange={(e) => setForm(f => ({ ...f, nameEn: e.target.value }))} className="h-9" />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.bomSteps.durationMinutes")}</label>
              <Input type="number" min="0" value={form.durationMinutes}
                onChange={(e) => setForm(f => ({ ...f, durationMinutes: e.target.value }))} className="h-9" />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.bomSteps.laborCost")}</label>
              <Input type="number" step="0.0001" min="0" value={form.laborCost}
                onChange={(e) => setForm(f => ({ ...f, laborCost: e.target.value }))} className="h-9" />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">{t("pages.items.bomSteps.overheadCost")}</label>
              <Input type="number" step="0.0001" min="0" value={form.overheadCost}
                onChange={(e) => setForm(f => ({ ...f, overheadCost: e.target.value }))} className="h-9" />
            </div>
            <div className="lg:col-span-1">
              <label className="text-xs font-medium block mb-1">{t("pages.items.bomSteps.notes")}</label>
              <Input value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} className="h-9" />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => { resetForm(); setShowForm(false); }}>
              {t("common.cancel", { defaultValue: "إلغاء" })}
            </Button>
            <Button size="sm" disabled={!form.nameAr || addMut.isPending}
              onClick={() => addMut.mutate()} className="gap-1.5">
              {addMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {t("pages.items.bomSteps.save")}
            </Button>
          </div>
        </div>
      )}
      {steps.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded-lg">
          <Cog className="h-6 w-6 mx-auto mb-1.5 opacity-30" />
          {t("pages.items.bomSteps.empty")}
        </p>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-2 py-2 text-center w-12">#</th>
                <th className="px-3 py-2 text-start">{t("pages.items.bomSteps.step")}</th>
                <th className="px-3 py-2 text-end w-24">{t("pages.items.bomSteps.durationMinutes")}</th>
                <th className="px-3 py-2 text-end w-28">{t("pages.items.bomSteps.laborCost")}</th>
                <th className="px-3 py-2 text-end w-28">{t("pages.items.bomSteps.overheadCost")}</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {steps.map(s => (
                <tr key={s.id} className="border-t hover:bg-muted/20">
                  <td className="px-2 py-2 text-center font-mono font-semibold">{s.sequence}</td>
                  <td className="px-3 py-2">
                    <p className="font-medium">{s.nameAr}</p>
                    {s.nameEn && <p className="text-[10px] text-muted-foreground">{s.nameEn}</p>}
                    {s.notes && <p className="text-[10px] text-muted-foreground italic">{s.notes}</p>}
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums">{s.durationMinutes ?? 0}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{fmt(s.laborCost)}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{fmt(s.overheadCost)}</td>
                  <td className="px-2 py-2">
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive"
                      onClick={() => {
                        if (window.confirm(t("pages.items.bomSteps.deleteConfirm", { name: s.nameAr }))) deleteMut.mutate(s.id);
                      }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-muted/30 font-semibold">
              <tr className="border-t">
                <td colSpan={2} className="px-3 py-2">{t("pages.items.bomSteps.totals")}</td>
                <td className="px-3 py-2 text-end tabular-nums">{totals.totalDurationMin}</td>
                <td className="px-3 py-2 text-end tabular-nums">{fmt(totals.totalLaborCost)}</td>
                <td className="px-3 py-2 text-end tabular-nums">{fmt(totals.totalOverheadCost)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Manufactured-cost summary — components + labour + overhead */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border bg-muted/20 p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("pages.items.bomSteps.componentCost")}</p>
          <p className="text-base font-bold tabular-nums">{fmt(totals.componentCost)}</p>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("pages.items.bomSteps.totalLaborCost")}</p>
          <p className="text-base font-bold tabular-nums">{fmt(totals.totalLaborCost)}</p>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("pages.items.bomSteps.totalOverheadCost")}</p>
          <p className="text-base font-bold tabular-nums">{fmt(totals.totalOverheadCost)}</p>
        </div>
        <div className="rounded-lg border-2 border-primary/40 bg-primary/5 p-3">
          <p className="text-[10px] uppercase tracking-wide text-primary font-semibold">{t("pages.items.bomSteps.manufacturedCost")}</p>
          <p className="text-lg font-bold tabular-nums text-primary">{fmt(totals.manufacturedCost)}</p>
        </div>
      </div>
    </div>
  );
}
