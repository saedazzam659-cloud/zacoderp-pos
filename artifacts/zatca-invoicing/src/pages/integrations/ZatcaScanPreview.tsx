import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  X, FileSpreadsheet, ShieldCheck, AlertTriangle, CheckCircle2,
  Wand2, Download, Send, Search, Filter, Pencil, RefreshCw,
  TrendingUp, FileWarning, FileCheck2, Eye, Sparkles, Building2,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableHeader, TableRow, TableHead, TableBody, TableCell,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

// ──────────────────────────────────────────────────────────────────────
// ZATCA standard column schema (matches the official template export).
// All headers are bilingual — the parser accepts either the Arabic or
// English form, so user files from any source are normalized in.
// ──────────────────────────────────────────────────────────────────────
export interface ZatcaRow {
  invoiceNumber: string;        // رقم الفاتورة
  issueDate: string;            // تاريخ الإصدار yyyy-mm-dd
  issueTime: string;            // وقت الإصدار hh:mm:ss
  invoiceType: string;          // 388 / 381 / 383
  sellerName: string;           // اسم البائع
  sellerVat: string;            // الرقم الضريبي للبائع (15 رقم)
  buyerName: string;            // اسم المشتري
  buyerVat: string;             // رقم ضريبي للمشتري (اختياري)
  itemName: string;             // اسم الصنف
  quantity: number;             // الكمية
  unitPrice: number;            // سعر الوحدة
  vatRate: number;              // نسبة الضريبة %
  vatCategory: string;          // S/Z/E/O
  totalExclVat: number;         // الإجمالي قبل الضريبة
  vatAmount: number;            // قيمة الضريبة
  totalInclVat: number;         // الإجمالي شامل الضريبة
  currency: string;             // SAR
}

interface FieldDef {
  key: keyof ZatcaRow;
  ar: string;
  en: string;
  aliases: string[];
  numeric?: boolean;
  required?: boolean;
}

const FIELDS: FieldDef[] = [
  { key: "invoiceNumber", ar: "رقم الفاتورة",            en: "Invoice Number",  aliases: ["invoice_no", "invoice number", "no", "رقم"], required: true },
  { key: "issueDate",     ar: "تاريخ الإصدار",           en: "Issue Date",      aliases: ["date", "invoice_date", "تاريخ"], required: true },
  { key: "issueTime",     ar: "وقت الإصدار",             en: "Issue Time",      aliases: ["time", "وقت"] },
  { key: "invoiceType",   ar: "نوع الفاتورة",            en: "Invoice Type",    aliases: ["type", "نوع"] },
  { key: "sellerName",    ar: "اسم البائع",              en: "Seller Name",     aliases: ["seller", "البائع"], required: true },
  { key: "sellerVat",     ar: "الرقم الضريبي للبائع",    en: "Seller VAT",      aliases: ["seller_vat", "vat_seller"], required: true },
  { key: "buyerName",     ar: "اسم المشتري",             en: "Buyer Name",      aliases: ["buyer", "customer", "العميل", "المشتري"], required: true },
  { key: "buyerVat",      ar: "الرقم الضريبي للمشتري",   en: "Buyer VAT",       aliases: ["buyer_vat", "customer_vat"] },
  { key: "itemName",      ar: "اسم الصنف",               en: "Item",            aliases: ["product", "description", "الصنف", "البيان"], required: true },
  { key: "quantity",      ar: "الكمية",                  en: "Quantity",        aliases: ["qty", "كمية"], numeric: true, required: true },
  { key: "unitPrice",     ar: "سعر الوحدة",              en: "Unit Price",      aliases: ["price", "rate", "السعر"], numeric: true, required: true },
  { key: "vatRate",       ar: "نسبة الضريبة %",          en: "VAT Rate %",      aliases: ["vat", "tax_rate", "نسبة الضريبة"], numeric: true },
  { key: "vatCategory",   ar: "فئة الضريبة",             en: "VAT Category",    aliases: ["tax_category", "category"] },
  { key: "totalExclVat",  ar: "الإجمالي قبل الضريبة",    en: "Total Excl. VAT", aliases: ["subtotal", "net"], numeric: true },
  { key: "vatAmount",     ar: "قيمة الضريبة",            en: "VAT Amount",      aliases: ["tax", "vat_amount"], numeric: true },
  { key: "totalInclVat",  ar: "الإجمالي شامل الضريبة",   en: "Total Incl. VAT", aliases: ["total", "grand_total", "الإجمالي"], numeric: true, required: true },
  { key: "currency",      ar: "العملة",                  en: "Currency",        aliases: ["ccy", "العمله"] },
];

const INVOICE_TYPES = new Set(["388", "381", "383"]);
const VAT_CATEGORIES = new Set(["S", "Z", "E", "O"]);

interface RowError {
  field: keyof ZatcaRow | "_row";
  level: "error" | "warning";
  msg: string;
  fix?: string;
}

// ── Header normalization ──────────────────────────────────────────────
function normHeader(h: string): keyof ZatcaRow | null {
  const t = String(h).trim().toLowerCase().replace(/[\s_-]+/g, " ");
  for (const f of FIELDS) {
    if (t === f.ar.toLowerCase() || t === f.en.toLowerCase()) return f.key;
    if (f.aliases.some(a => a.toLowerCase() === t)) return f.key;
    // contains-based fallback
    if (t.includes(f.en.toLowerCase()) || t.includes(f.ar.toLowerCase())) return f.key;
  }
  return null;
}

function parseDate(v: unknown): string {
  if (!v) return "";
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  const s = String(v).trim();
  // dd/mm/yyyy or dd-mm-yyyy
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // already yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Excel serial number
  const n = Number(s);
  if (!isNaN(n) && n > 25569 && n < 60000) {
    const d = new Date(Math.round((n - 25569) * 86400 * 1000));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return s;
}

function parseTime(v: unknown): string {
  if (!v) return "";
  const s = String(v).trim();
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}:${(m[3] ?? "00").padStart(2, "0")}`;
  return s;
}

function num(v: unknown, def = 0): number {
  if (typeof v === "number") return v;
  if (v == null || v === "") return def;
  const cleaned = String(v).replace(/[,\s]/g, "").replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const n = Number(cleaned);
  return isNaN(n) ? def : n;
}

// ── Parse any input (xlsx/csv/json) into ZatcaRow[] ──────────────────
// Returns both the normalized rows AND the original raw objects so the UI
// can re-apply a different (e.g. AI-suggested) header mapping later
// without re-reading the file.
export async function parseToZatcaRowsWithRaw(file: File): Promise<{ rows: ZatcaRow[]; raw: Record<string, unknown>[] }> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  let raw: Record<string, unknown>[];
  if (ext === "json") {
    const text = await file.text();
    const data = JSON.parse(text);
    raw = Array.isArray(data) ? data : (data.invoices ?? data.rows ?? data.data ?? [data]);
  } else {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  }
  return { rows: raw.map(o => rowFromObject(o)), raw };
}
export async function parseToZatcaRows(file: File): Promise<ZatcaRow[]> {
  return (await parseToZatcaRowsWithRaw(file)).rows;
}

// AI mapping returns canonical keys like "invoice_number". Map them to ZatcaRow keys.
const AI_KEY_TO_ROW: Record<string, keyof ZatcaRow> = {
  invoice_number: "invoiceNumber", invoice_date: "issueDate", invoice_time: "issueTime", invoice_type: "invoiceType",
  seller_name: "sellerName", seller_vat: "sellerVat",
  buyer_name: "buyerName", buyer_vat: "buyerVat",
  item_name: "itemName", quantity: "quantity", unit_price: "unitPrice",
  vat_rate: "vatRate", vat_category: "vatCategory",
  subtotal: "totalExclVat", vat: "vatAmount", total: "totalInclVat", currency: "currency",
};
export function rowsFromRawWithMapping(raw: Record<string, unknown>[], aiMapping: Record<string, string | null>): ZatcaRow[] {
  return raw.map(obj => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      // Prefer AI mapping when provided, fall back to deterministic normHeader
      const aiKey = aiMapping[k];
      const mapped = aiKey ? AI_KEY_TO_ROW[aiKey] ?? null : normHeader(k);
      if (mapped) out[mapped] = v;
    }
    return finalizeRow(out);
  });
}

function rowFromObject(obj: Record<string, unknown>): ZatcaRow {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const mapped = normHeader(k);
    if (mapped) out[mapped] = v;
  }
  return finalizeRow(out);
}

function finalizeRow(out: Record<string, unknown>): ZatcaRow {
  return {
    invoiceNumber: String(out.invoiceNumber ?? "").trim(),
    issueDate:     parseDate(out.issueDate),
    issueTime:     parseTime(out.issueTime),
    invoiceType:   String(out.invoiceType ?? "388").trim(),
    sellerName:    String(out.sellerName ?? "").trim(),
    sellerVat:     String(out.sellerVat ?? "").replace(/\D/g, ""),
    buyerName:     String(out.buyerName ?? "").trim(),
    buyerVat:      String(out.buyerVat ?? "").replace(/\D/g, ""),
    itemName:      String(out.itemName ?? "").trim(),
    quantity:      num(out.quantity, 1),
    unitPrice:     num(out.unitPrice),
    vatRate:       num(out.vatRate, 15),
    vatCategory:   String(out.vatCategory ?? "S").trim().toUpperCase(),
    totalExclVat:  num(out.totalExclVat),
    vatAmount:     num(out.vatAmount),
    totalInclVat:  num(out.totalInclVat),
    currency:      String(out.currency ?? "SAR").trim().toUpperCase(),
  };
}

// ── ZATCA validation rules ────────────────────────────────────────────
function validate(r: ZatcaRow): RowError[] {
  const errs: RowError[] = [];
  if (!r.invoiceNumber) errs.push({ field: "invoiceNumber", level: "error", msg: "رقم الفاتورة مطلوب" });
  if (!r.issueDate || !/^\d{4}-\d{2}-\d{2}$/.test(r.issueDate)) {
    errs.push({ field: "issueDate", level: "error", msg: "تاريخ غير صحيح", fix: "تطبيع للصيغة yyyy-mm-dd" });
  }
  if (!INVOICE_TYPES.has(r.invoiceType)) {
    errs.push({ field: "invoiceType", level: "error", msg: "النوع يجب أن يكون 388/381/383", fix: "ضبط على 388 (فاتورة ضريبية)" });
  }
  if (!r.sellerName) errs.push({ field: "sellerName", level: "error", msg: "اسم البائع مطلوب" });
  if (!/^3\d{13}3$/.test(r.sellerVat)) {
    errs.push({ field: "sellerVat", level: "error", msg: "الرقم الضريبي للبائع يجب أن يكون 15 رقم يبدأ وينتهي بـ 3" });
  }
  if (!r.buyerName) errs.push({ field: "buyerName", level: "warning", msg: "اسم المشتري فارغ — سيتم الاعتبار B2C" });
  if (r.buyerVat && !/^3\d{13}3$/.test(r.buyerVat)) {
    errs.push({ field: "buyerVat", level: "error", msg: "الرقم الضريبي للمشتري بصيغة غير صحيحة", fix: "حذف الرقم لاعتبارها B2C" });
  }
  if (!r.itemName) errs.push({ field: "itemName", level: "error", msg: "اسم الصنف مطلوب" });
  if (!(r.quantity > 0)) errs.push({ field: "quantity", level: "error", msg: "الكمية يجب أن تكون أكبر من صفر", fix: "ضبط على 1" });
  if (!(r.unitPrice >= 0)) errs.push({ field: "unitPrice", level: "error", msg: "سعر الوحدة لا يمكن أن يكون سالب", fix: "ضبط على 0" });
  if (!VAT_CATEGORIES.has(r.vatCategory)) {
    errs.push({ field: "vatCategory", level: "error", msg: "فئة ضريبة غير معتمدة (S/Z/E/O)", fix: "ضبط على S — أساسية 15%" });
  }
  if (r.vatCategory === "S" && Math.abs(r.vatRate - 15) > 0.01) {
    errs.push({ field: "vatRate", level: "warning", msg: "النسبة الأساسية 15% — القيمة الحالية مختلفة", fix: "ضبط على 15%" });
  }
  if ((r.vatCategory === "Z" || r.vatCategory === "E") && r.vatRate !== 0) {
    errs.push({ field: "vatRate", level: "warning", msg: "فئة معفاة/صفرية — النسبة يجب أن تكون 0", fix: "ضبط على 0%" });
  }
  // Recompute totals and compare
  const expectedExcl = round2(r.quantity * r.unitPrice);
  const expectedVat = round2(expectedExcl * r.vatRate / 100);
  const expectedIncl = round2(expectedExcl + expectedVat);
  if (r.totalExclVat && Math.abs(r.totalExclVat - expectedExcl) > 0.02) {
    errs.push({ field: "totalExclVat", level: "warning", msg: `الإجمالي قبل الضريبة لا يطابق (متوقع ${expectedExcl})`, fix: "إعادة الحساب التلقائي" });
  }
  if (r.vatAmount && Math.abs(r.vatAmount - expectedVat) > 0.02) {
    errs.push({ field: "vatAmount", level: "warning", msg: `قيمة الضريبة لا تطابق (متوقع ${expectedVat})`, fix: "إعادة الحساب التلقائي" });
  }
  if (Math.abs(r.totalInclVat - expectedIncl) > 0.02) {
    errs.push({ field: "totalInclVat", level: "error", msg: `الإجمالي شامل الضريبة لا يطابق الكمية × السعر + الضريبة (متوقع ${expectedIncl})`, fix: "إعادة الحساب التلقائي" });
  }
  if (r.currency !== "SAR") {
    errs.push({ field: "currency", level: "warning", msg: "العملة يجب أن تكون SAR لزاتكا", fix: "تحويل إلى SAR" });
  }
  return errs;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Auto-fix per ZATCA rules ─────────────────────────────────────────
function autofix(r: ZatcaRow): ZatcaRow {
  const out = { ...r };
  if (!INVOICE_TYPES.has(out.invoiceType)) out.invoiceType = "388";
  if (!VAT_CATEGORIES.has(out.vatCategory)) out.vatCategory = "S";
  if (out.vatCategory === "S") out.vatRate = 15;
  if (out.vatCategory === "Z" || out.vatCategory === "E") out.vatRate = 0;
  if (!(out.quantity > 0)) out.quantity = 1;
  if (!(out.unitPrice >= 0)) out.unitPrice = 0;
  if (!out.currency || out.currency !== "SAR") out.currency = "SAR";
  if (out.buyerVat && !/^3\d{13}3$/.test(out.buyerVat)) out.buyerVat = "";
  if (!out.issueTime) out.issueTime = "00:00:00";
  // Recompute totals
  out.totalExclVat = round2(out.quantity * out.unitPrice);
  out.vatAmount = round2(out.totalExclVat * out.vatRate / 100);
  out.totalInclVat = round2(out.totalExclVat + out.vatAmount);
  return out;
}

// ── Excel export (ZATCA-format compliant template / validated data) ──
export function exportZatcaExcel(rows: ZatcaRow[], filename: string) {
  const headers = FIELDS.map(f => `${f.ar} | ${f.en}`);
  const data = [
    headers,
    ...rows.map(r => FIELDS.map(f => (r[f.key] as unknown) ?? "")),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  // Column widths
  ws["!cols"] = FIELDS.map(f => ({ wch: f.ar.length + 8 }));
  // Header styling cue (sheetjs community lacks full styling; we set freeze + filter)
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length - 1, c: headers.length - 1 } }) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "ZATCA Invoices");
  XLSX.writeFile(wb, filename);
}

export function downloadZatcaTemplate() {
  const sample: ZatcaRow = {
    invoiceNumber: "INV-2026-0001",
    issueDate: "2026-05-14",
    issueTime: "10:30:00",
    invoiceType: "388",
    sellerName: "اسم شركتك",
    sellerVat: "300000000000003",
    buyerName: "اسم العميل",
    buyerVat: "",
    itemName: "اسم الصنف أو الخدمة",
    quantity: 1,
    unitPrice: 100,
    vatRate: 15,
    vatCategory: "S",
    totalExclVat: 100,
    vatAmount: 15,
    totalInclVat: 115,
    currency: "SAR",
  };
  exportZatcaExcel([sample], "zatca-invoice-template.xlsx");
}

// ──────────────────────────────────────────────────────────────────────
// MAIN PREVIEW MODAL
// ──────────────────────────────────────────────────────────────────────
// Picker option supplied by IntegrationGateway after fetching
// /api/admin/gateway-clients/picker/list. Only "active" clients appear.
export interface GatewayClientPick {
  id: number;
  nameAr: string;
  nameEn: string | null;
  vatNumber: string;
  zatcaEnv: "sandbox" | "production";
  hasCredentials: boolean;
  monthlyQuota: number;
  invoicesThisMonth: number;
  lastIcv: number;
}

export interface SubmitResult {
  submitted: number;
  rejected: number;
  env: "sandbox" | "production";
  results: Array<{ invoiceNumber: string; status: string; uuid?: string; icv?: number; error?: string }>;
  chain: { lastIcv: number; lastPih: string };
}

interface Props {
  file: File;
  onClose: () => void;
  // Legacy callback (used when no real-submit path is wired). When clients
  // is supplied, submission goes directly to the API and onConfirm is
  // invoked with the result for parent toasts/cleanup.
  onConfirm: (rows: ZatcaRow[], result?: SubmitResult) => void;
  clients?: GatewayClientPick[];
  loadingClients?: boolean;
}

export default function ZatcaScanPreview({ file, onClose, onConfirm, clients, loadingClients }: Props) {
  const { toast } = useToast();
  const [rows, setRows] = useState<ZatcaRow[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "errors" | "warnings" | "ok">("all");
  const [editingCell, setEditingCell] = useState<{ row: number; key: keyof ZatcaRow } | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [aiMapping, setAiMapping] = useState<Record<string, string | null> | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  // Detect headers that the deterministic parser couldn't map — those are
  // the ones the user benefits from running through AI.
  const unmappedHeaders = useMemo(() => {
    if (rawRows.length === 0) return [] as string[];
    const headers = Array.from(new Set(rawRows.flatMap(r => Object.keys(r))));
    return headers.filter(h => normHeader(h) === null);
  }, [rawRows]);

  const handleAiMap = async () => {
    if (!selectedClientId || rawRows.length === 0) return;
    const headers = Array.from(new Set(rawRows.flatMap(r => Object.keys(r))));
    setAiLoading(true);
    try {
      const token = localStorage.getItem("zatca_token");
      const acting = localStorage.getItem("zatca_acting_company_id");
      const headersInit: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headersInit.Authorization = `Bearer ${token}`;
      if (acting) headersInit["x-acting-company-id"] = acting;
      const res = await fetch(`/api/admin/gateway-clients/${selectedClientId}/ai-map-columns`, {
        method: "POST", headers: headersInit, credentials: "include",
        body: JSON.stringify({ headers }),
      });
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json() as { mapping: Record<string, string | null>; source: string };
      setAiMapping(j.mapping);
      const newRows = rowsFromRawWithMapping(rawRows, j.mapping);
      setRows(newRows);
      const mappedCount = Object.values(j.mapping).filter(v => v !== null).length;
      toast({
        title: `تم ربط ${mappedCount} من ${headers.length} عمود`,
        description: j.source === "openai" ? "اقتراح بالذكاء الاصطناعي طُبّق على الصفوف." : "تم استخدام مطابقة احتمالية محلية.",
      });
    } catch (e) {
      toast({ title: "تعذّر الاقتراح", description: e instanceof Error ? e.message : "خطأ غير معروف", variant: "destructive" });
    } finally {
      setAiLoading(false);
    }
  };
  const selectedClient = useMemo(
    () => clients?.find(c => c.id === selectedClientId) ?? null,
    [clients, selectedClientId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { rows: parsed, raw } = await parseToZatcaRowsWithRaw(file);
        if (cancelled) return;
        if (parsed.length === 0) {
          setParseErr("لم يتم العثور على أي صف في الملف. تأكد من أن الملف يحتوي على رؤوس أعمدة في الصف الأول.");
        } else {
          setRows(parsed);
          setRawRows(raw);
        }
      } catch (e) {
        if (!cancelled) setParseErr(e instanceof Error ? e.message : "تعذّر قراءة الملف");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [file]);

  const validations = useMemo(() => rows.map(validate), [rows]);

  const stats = useMemo(() => {
    let errors = 0, warnings = 0, clean = 0;
    validations.forEach(v => {
      if (v.some(e => e.level === "error")) errors++;
      else if (v.some(e => e.level === "warning")) warnings++;
      else clean++;
    });
    return { errors, warnings, clean, total: rows.length };
  }, [rows, validations]);

  const sumIncl = useMemo(() => rows.reduce((s, r) => s + (Number(r.totalInclVat) || 0), 0), [rows]);
  const sumVat = useMemo(() => rows.reduce((s, r) => s + (Number(r.vatAmount) || 0), 0), [rows]);

  const filteredIdx = useMemo(() => {
    return rows.map((_, i) => i).filter(i => {
      const v = validations[i];
      if (filter === "errors" && !v.some(e => e.level === "error")) return false;
      if (filter === "warnings" && !v.some(e => e.level === "warning")) return false;
      if (filter === "ok" && v.length > 0) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const r = rows[i];
        const hay = `${r.invoiceNumber} ${r.buyerName} ${r.itemName} ${r.sellerName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, validations, filter, search]);

  const handleAutofixAll = () => {
    setRows(prev => prev.map(autofix));
    toast({ title: "تم التصحيح التلقائي", description: "تم تطبيق قواعد زاتكا على كل الصفوف" });
  };

  const handleAutofixRow = (i: number) => {
    setRows(prev => prev.map((r, idx) => idx === i ? autofix(r) : r));
  };

  const handleCellEdit = (i: number, key: keyof ZatcaRow, value: string) => {
    setRows(prev => prev.map((r, idx) => {
      if (idx !== i) return r;
      const f = FIELDS.find(x => x.key === key);
      const newVal = f?.numeric ? num(value) : value;
      return { ...r, [key]: newVal };
    }));
  };

  const handleConfirm = async () => {
    if (stats.errors > 0) {
      toast({
        title: "لا يمكن الإصدار قبل تصحيح الأخطاء",
        description: `لديك ${stats.errors} فاتورة بأخطاء حرجة. اضغط "تصحيح تلقائي" أو عدّل يدوياً.`,
        variant: "destructive",
      });
      return;
    }
    // No clients prop means legacy demo flow — just bubble up.
    if (!clients) { onConfirm(rows); return; }

    if (!selectedClient) {
      toast({ title: "اختر الشركة المُرسِلة", description: "يجب اختيار شركة مُسجَّلة لإرسال الفواتير لزاتكا باسمها.", variant: "destructive" });
      return;
    }
    if (selectedClient.zatcaEnv === "production" && !selectedClient.hasCredentials) {
      toast({ title: "مفاتيح زاتكا غير مكتملة", description: "هذه الشركة في وضع الإنتاج لكن بدون CSID — لا يمكن الإرسال.", variant: "destructive" });
      return;
    }
    const remaining = selectedClient.monthlyQuota - selectedClient.invoicesThisMonth;
    if (remaining < rows.length) {
      toast({ title: "الحصة الشهرية غير كافية", description: `المتبقي للشركة ${remaining.toLocaleString("ar-EG")} فاتورة، والدفعة ${rows.length.toLocaleString("ar-EG")}.`, variant: "destructive" });
      return;
    }

    setSubmitting(true);
    try {
      const token = localStorage.getItem("zatca_token");
      const res = await fetch(`/api/admin/gateway-clients/${selectedClient.id}/submit-batch`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ rows, fileName: file.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "فشل الإرسال");
      const result = data as SubmitResult;
      const isSandbox = result.env === "sandbox";
      toast({
        title: isSandbox ? "تم الإرسال (وضع التجربة)" : "تم تجهيز الدفعة للإنتاج",
        description: `${result.submitted.toLocaleString("ar-EG")} ناجحة، ${result.rejected.toLocaleString("ar-EG")} مرفوضة. ICV: ${result.chain.lastIcv}`,
      });
      onConfirm(rows, result);
    } catch (e) {
      toast({ title: "تعذّر الإرسال", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleExportValidated = () => {
    exportZatcaExcel(rows, `zatca-validated-${file.name.replace(/\.[^.]+$/, "")}.xlsx`);
    toast({ title: "تم التصدير", description: "ملف Excel بصيغة زاتكا جاهز للتحميل" });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-background w-full h-full sm:h-[92vh] sm:max-w-7xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden">

        {/* ── HEADER ─────────────────────────────────────────────── */}
        <div className="relative bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 text-white p-4 sm:p-5 shrink-0">
          <div className="absolute -top-12 -end-12 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
          <div className="absolute -bottom-12 -start-12 h-32 w-32 rounded-full bg-cyan-300/20 blur-2xl" />
          <div className="relative flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-12 w-12 rounded-2xl bg-white/15 backdrop-blur ring-1 ring-white/30 flex items-center justify-center shrink-0">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg sm:text-xl font-extrabold">معاينة وفحص الفواتير قبل الإرسال إلى زاتكا</h2>
                  <Badge className="bg-white/20 text-white hover:bg-white/20 border-white/30">
                    <Sparkles className="h-3 w-3 me-1" />
                    Real-time validation
                  </Badge>
                </div>
                <p className="text-xs sm:text-sm text-white/80 mt-0.5 truncate">
                  <FileSpreadsheet className="inline h-3.5 w-3.5 me-1" />
                  {file.name}
                </p>
              </div>
            </div>
            <Button onClick={onClose} variant="ghost" size="icon" className="text-white hover:bg-white/20 shrink-0">
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* ── BODY ───────────────────────────────────────────────── */}
        <div className="flex-1 overflow-auto p-3 sm:p-5 space-y-4 bg-gradient-to-b from-slate-50 to-white">
          {loading && (
            <div className="flex flex-col items-center justify-center py-20">
              <RefreshCw className="h-10 w-10 text-indigo-500 animate-spin mb-3" />
              <p className="font-bold text-foreground">جاري قراءة الملف وتحليل البيانات...</p>
              <p className="text-sm text-muted-foreground mt-1">قد يستغرق ثوانٍ للملفات الكبيرة</p>
            </div>
          )}

          {!loading && parseErr && (
            <Card className="border-rose-300 bg-rose-50">
              <CardContent className="p-5 flex items-start gap-3">
                <AlertTriangle className="h-6 w-6 text-rose-600 shrink-0" />
                <div>
                  <p className="font-bold text-rose-900">تعذّر تحليل الملف</p>
                  <p className="text-sm text-rose-800 mt-1">{parseErr}</p>
                  <Button onClick={downloadZatcaTemplate} size="sm" className="mt-3 bg-rose-600 hover:bg-rose-700 text-white gap-1.5">
                    <Download className="h-3.5 w-3.5" />
                    تحميل القالب الرسمي
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {!loading && !parseErr && rows.length > 0 && (
            <>
              {/* Stat cards */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 sm:gap-3">
                <StatCard icon={FileSpreadsheet} label="إجمالي الفواتير" value={stats.total} accent="bg-slate-100 text-slate-700" />
                <StatCard icon={CheckCircle2} label="جاهزة للإرسال" value={stats.clean} accent="bg-emerald-100 text-emerald-700" />
                <StatCard icon={AlertTriangle} label="تحذيرات" value={stats.warnings} accent="bg-amber-100 text-amber-700" />
                <StatCard icon={FileWarning} label="أخطاء" value={stats.errors} accent="bg-rose-100 text-rose-700" />
                <StatCard icon={TrendingUp} label="إجمالي شامل الضريبة" value={`${sumIncl.toFixed(2)} ﷼`} accent="bg-indigo-100 text-indigo-700" mono />
              </div>

              {/* Action bar */}
              <div className="flex flex-wrap items-center gap-2 bg-white rounded-2xl border p-3">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="ابحث برقم الفاتورة أو اسم العميل أو الصنف..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="ps-9 h-9"
                  />
                </div>
                <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
                  {([
                    { k: "all", lbl: `الكل (${stats.total})`, cls: "" },
                    { k: "errors", lbl: `أخطاء (${stats.errors})`, cls: "data-[on=true]:bg-rose-600 data-[on=true]:text-white" },
                    { k: "warnings", lbl: `تحذيرات (${stats.warnings})`, cls: "data-[on=true]:bg-amber-500 data-[on=true]:text-white" },
                    { k: "ok", lbl: `سليمة (${stats.clean})`, cls: "data-[on=true]:bg-emerald-600 data-[on=true]:text-white" },
                  ] as const).map(b => (
                    <button
                      key={b.k}
                      data-on={filter === b.k}
                      onClick={() => setFilter(b.k)}
                      className={`text-xs font-bold px-3 py-1.5 rounded-md transition-colors data-[on=true]:shadow ${b.cls} ${filter === b.k ? "" : "text-muted-foreground hover:bg-background"}`}
                    >
                      {b.lbl}
                    </button>
                  ))}
                </div>
                <Button onClick={handleAutofixAll} disabled={stats.errors + stats.warnings === 0} className="gap-1.5 bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:opacity-90 text-white">
                  <Wand2 className="h-4 w-4" />
                  تصحيح تلقائي للكل
                </Button>
                {unmappedHeaders.length > 0 && (
                  <Button
                    onClick={handleAiMap}
                    disabled={!selectedClientId || aiLoading}
                    title={!selectedClientId ? "اختر العميل أولاً" : `${unmappedHeaders.length} عمود غير معرّف`}
                    className="gap-1.5 bg-gradient-to-r from-sky-600 to-cyan-600 hover:opacity-90 text-white"
                  >
                    {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    ربط الأعمدة بالذكاء الاصطناعي
                    <Badge variant="outline" className="bg-white/20 text-white border-white/40 text-[10px]">{unmappedHeaders.length}</Badge>
                  </Button>
                )}
                {aiMapping && (
                  <span className="text-xs text-emerald-700 font-medium">✓ تم تطبيق الاقتراح</span>
                )}
                <Button onClick={downloadZatcaTemplate} variant="outline" size="sm" className="gap-1.5">
                  <Download className="h-3.5 w-3.5" />
                  قالب زاتكا
                </Button>
                <Button onClick={handleExportValidated} variant="outline" size="sm" className="gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50">
                  <FileCheck2 className="h-3.5 w-3.5" />
                  تصدير المُصحّح
                </Button>
              </div>

              {/* Table */}
              <Card className="overflow-hidden">
                <div className="overflow-x-auto max-h-[55vh]">
                  <Table className="text-xs">
                    <TableHeader className="bg-slate-100 sticky top-0 z-10">
                      <TableRow>
                        <TableHead className="w-12 text-center">#</TableHead>
                        <TableHead className="w-16 text-center">الحالة</TableHead>
                        <TableHead className="min-w-[120px]">رقم الفاتورة</TableHead>
                        <TableHead className="min-w-[110px]">التاريخ</TableHead>
                        <TableHead className="min-w-[140px]">المشتري</TableHead>
                        <TableHead className="min-w-[140px]">الصنف</TableHead>
                        <TableHead className="min-w-[70px] text-end">الكمية</TableHead>
                        <TableHead className="min-w-[90px] text-end">السعر</TableHead>
                        <TableHead className="min-w-[80px] text-end">الضريبة %</TableHead>
                        <TableHead className="min-w-[100px] text-end">الإجمالي</TableHead>
                        <TableHead className="min-w-[200px]">المشاكل</TableHead>
                        <TableHead className="w-20 text-center">إجراء</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredIdx.map(i => {
                        const r = rows[i];
                        const v = validations[i];
                        const hasError = v.some(e => e.level === "error");
                        const hasWarning = v.some(e => e.level === "warning");
                        const rowBg = hasError ? "bg-rose-50/60 hover:bg-rose-50" : hasWarning ? "bg-amber-50/40 hover:bg-amber-50" : "hover:bg-emerald-50/30";
                        return (
                          <TableRow key={i} className={rowBg}>
                            <TableCell className="text-center text-muted-foreground font-mono">{i + 1}</TableCell>
                            <TableCell className="text-center">
                              {hasError ? (
                                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-600 text-white" title="خطأ">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                </span>
                              ) : hasWarning ? (
                                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-amber-500 text-white" title="تحذير">
                                  <Eye className="h-3.5 w-3.5" />
                                </span>
                              ) : (
                                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-white" title="جاهزة">
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                </span>
                              )}
                            </TableCell>
                            <EditableCell value={r.invoiceNumber} onSave={v => handleCellEdit(i, "invoiceNumber", v)} active={editingCell?.row === i && editingCell.key === "invoiceNumber"} setActive={a => setEditingCell(a ? { row: i, key: "invoiceNumber" } : null)} hasErr={v.some(e => e.field === "invoiceNumber")} mono />
                            <EditableCell value={r.issueDate} onSave={v => handleCellEdit(i, "issueDate", v)} active={editingCell?.row === i && editingCell.key === "issueDate"} setActive={a => setEditingCell(a ? { row: i, key: "issueDate" } : null)} hasErr={v.some(e => e.field === "issueDate")} />
                            <EditableCell value={r.buyerName || "—"} onSave={v => handleCellEdit(i, "buyerName", v)} active={editingCell?.row === i && editingCell.key === "buyerName"} setActive={a => setEditingCell(a ? { row: i, key: "buyerName" } : null)} hasErr={v.some(e => e.field === "buyerName" && e.level === "error")} />
                            <EditableCell value={r.itemName} onSave={v => handleCellEdit(i, "itemName", v)} active={editingCell?.row === i && editingCell.key === "itemName"} setActive={a => setEditingCell(a ? { row: i, key: "itemName" } : null)} hasErr={v.some(e => e.field === "itemName")} />
                            <EditableCell value={String(r.quantity)} onSave={v => handleCellEdit(i, "quantity", v)} active={editingCell?.row === i && editingCell.key === "quantity"} setActive={a => setEditingCell(a ? { row: i, key: "quantity" } : null)} hasErr={v.some(e => e.field === "quantity")} align="end" mono />
                            <EditableCell value={r.unitPrice.toFixed(2)} onSave={v => handleCellEdit(i, "unitPrice", v)} active={editingCell?.row === i && editingCell.key === "unitPrice"} setActive={a => setEditingCell(a ? { row: i, key: "unitPrice" } : null)} hasErr={v.some(e => e.field === "unitPrice")} align="end" mono />
                            <EditableCell value={`${r.vatRate}%`} onSave={v => handleCellEdit(i, "vatRate", v.replace("%", ""))} active={editingCell?.row === i && editingCell.key === "vatRate"} setActive={a => setEditingCell(a ? { row: i, key: "vatRate" } : null)} hasErr={v.some(e => e.field === "vatRate")} align="end" mono />
                            <EditableCell value={r.totalInclVat.toFixed(2)} onSave={v => handleCellEdit(i, "totalInclVat", v)} active={editingCell?.row === i && editingCell.key === "totalInclVat"} setActive={a => setEditingCell(a ? { row: i, key: "totalInclVat" } : null)} hasErr={v.some(e => e.field === "totalInclVat")} align="end" mono />
                            <TableCell className="space-y-1 py-2">
                              {v.length === 0 ? (
                                <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 border-0">
                                  <CheckCircle2 className="h-3 w-3 me-1" />
                                  مطابق لزاتكا
                                </Badge>
                              ) : v.slice(0, 2).map((e, ei) => (
                                <div key={ei} className={`flex items-start gap-1 text-[11px] leading-tight ${e.level === "error" ? "text-rose-700" : "text-amber-700"}`}>
                                  <span className="shrink-0">{e.level === "error" ? "⛔" : "⚠️"}</span>
                                  <span className="truncate" title={e.msg}>{e.msg}</span>
                                </div>
                              ))}
                              {v.length > 2 && (
                                <p className="text-[10px] text-muted-foreground">+ {v.length - 2} أخرى</p>
                              )}
                            </TableCell>
                            <TableCell className="text-center">
                              {v.length > 0 && (
                                <Button size="sm" variant="ghost" onClick={() => handleAutofixRow(i)} className="h-7 w-7 p-0 text-violet-600 hover:bg-violet-50" title="تصحيح تلقائي">
                                  <Wand2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {filteredIdx.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={12} className="text-center py-10 text-muted-foreground">
                            <Filter className="h-10 w-10 mx-auto mb-2 opacity-30" />
                            لا توجد صفوف تطابق هذا الفلتر
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </Card>

              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Pencil className="h-3 w-3" />
                اضغط أي خلية لتعديلها يدوياً • اضغط <Wand2 className="h-3 w-3 inline" /> لتصحيح صف بقواعد زاتكا • إجمالي الضريبة: <b className="font-mono">{sumVat.toFixed(2)} ﷼</b>
              </p>
            </>
          )}
        </div>

        {/* ── FOOTER ─────────────────────────────────────────────── */}
        <div className="border-t bg-white p-3 sm:p-4 space-y-3 shrink-0">
          {/* Company picker — only shown when integrated with the gateway */}
          {clients && (
            <div className="rounded-xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50 to-violet-50 p-3 flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-indigo-900 font-bold text-sm shrink-0">
                <Building2 className="h-4 w-4" />
                إرسال نيابةً عن:
              </div>
              {loadingClients ? (
                <div className="text-xs text-slate-500 flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin" />جاري تحميل الشركات...</div>
              ) : clients.length === 0 ? (
                <div className="text-xs text-amber-800 bg-amber-100 rounded-lg px-2.5 py-1.5">
                  ⚠️ لا توجد شركات مُفعَّلة. أضف شركة من صفحة "بوابة زاتكا" أولاً.
                </div>
              ) : (
                <>
                  <select
                    value={selectedClientId ?? ""}
                    onChange={e => setSelectedClientId(e.target.value ? Number(e.target.value) : null)}
                    className="flex-1 min-w-[220px] h-9 rounded-md border-2 border-indigo-300 bg-white px-3 text-sm font-medium focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="">— اختر شركة —</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.nameAr} • {c.vatNumber} {c.zatcaEnv === "production" ? "🟢 إنتاج" : "🟡 تجربة"} {!c.hasCredentials ? "⚠️" : ""}
                      </option>
                    ))}
                  </select>
                  {selectedClient && (
                    <div className="text-[11px] text-slate-700 flex items-center gap-3 font-mono">
                      <span>المتبقي: <b className="text-emerald-700">{(selectedClient.monthlyQuota - selectedClient.invoicesThisMonth).toLocaleString("ar-EG")}</b></span>
                      <span>•</span>
                      <span>ICV الحالي: <b>{selectedClient.lastIcv}</b></span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              {stats.errors > 0 ? (
                <span className="text-rose-700 font-bold flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4" />
                  لا يمكن الإصدار — {stats.errors} فاتورة بحاجة تصحيح
                </span>
              ) : stats.warnings > 0 ? (
                <span className="text-amber-700 font-semibold">
                  ⚠️ {stats.warnings} تحذير — يمكن المتابعة لكن يُنصح بالمراجعة
                </span>
              ) : rows.length > 0 ? (
                <span className="text-emerald-700 font-bold flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4" />
                  كل الفواتير مطابقة لمعايير زاتكا — جاهزة للإرسال
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={onClose} disabled={submitting}>
                إلغاء
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={loading || rows.length === 0 || stats.errors > 0 || submitting || (clients !== undefined && !selectedClient)}
                className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:opacity-90 text-white font-bold gap-2 min-w-[180px]"
                size="lg"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {submitting ? "جاري الإرسال..." : `إرسال ${rows.length > 0 ? `(${rows.length})` : ""} إلى زاتكا`}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, accent, mono }: { icon: typeof FileSpreadsheet; label: string; value: number | string; accent: string; mono?: boolean }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3">
        <div className="flex items-center gap-2.5">
          <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${accent}`}>
            <Icon className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] text-muted-foreground leading-none mb-1 truncate">{label}</p>
            <p className={`font-extrabold text-lg leading-none ${mono ? "font-mono" : ""}`}>{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EditableCell({
  value, onSave, active, setActive, hasErr, align = "start", mono,
}: {
  value: string;
  onSave: (v: string) => void;
  active: boolean;
  setActive: (a: boolean) => void;
  hasErr: boolean;
  align?: "start" | "end";
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);

  if (active) {
    return (
      <TableCell className="p-1">
        <Input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => { if (draft !== value) onSave(draft); setActive(false); }}
          onKeyDown={e => {
            if (e.key === "Enter") { if (draft !== value) onSave(draft); setActive(false); }
            if (e.key === "Escape") { setDraft(value); setActive(false); }
          }}
          className={`h-7 text-xs ${mono ? "font-mono" : ""} ${align === "end" ? "text-end" : ""}`}
        />
      </TableCell>
    );
  }

  return (
    <TableCell
      onClick={() => setActive(true)}
      className={`cursor-pointer hover:bg-white py-2 ${align === "end" ? "text-end" : ""} ${mono ? "font-mono" : ""} ${hasErr ? "text-rose-700 font-semibold underline decoration-dotted decoration-rose-400 underline-offset-2" : ""}`}
    >
      {value || <span className="text-muted-foreground italic">— فارغ —</span>}
    </TableCell>
  );
}
