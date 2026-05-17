// Visual WYSIWYG designer for print templates across the system.
// Phase 1: Free drag/resize/style of text, images, tables, fields,
// rectangles, and lines on an A4 canvas. Layout is stored as JSON per
// (company, documentType) and rendered later by each document's print
// modal in subsequent phases.

import { useEffect, useMemo, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  Plus, Trash2, Save, Copy, FileText, Image as ImageIcon, Type, Square,
  Minus, Table as TableIcon, Tag, Star, Download, Printer, ZoomIn, ZoomOut,
  LayoutTemplate, X, CheckCircle2, Maximize2, PanelLeftOpen, PanelRightOpen,
  Box, MousePointer2, Undo2, Redo2,
} from "lucide-react";
import { PRESETS_BY_DOC, type PresetDescriptor } from "./printDesigner/presets";

// ───────────────────────────── Types ─────────────────────────────

type DocumentType =
  | "sales_invoice" | "purchase_invoice" | "sales_return" | "purchase_return"
  | "receipt_voucher" | "payment_voucher" | "bank_receipt" | "treasury_receipt"
  | "account_statement" | "journal_entry";

type ElementType = "text" | "image" | "rect" | "line" | "table" | "field" | "container";

interface TableColumn {
  key: string; label: string; width?: number; align?: "start" | "end" | "center";
}

interface Element {
  id: string;
  type: ElementType;
  x: number; y: number; width: number; height: number;
  rotation?: number;
  zIndex?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  textAlign?: "start" | "end" | "center" | "justify";
  color?: string;
  background?: string;
  borderColor?: string;
  borderWidth?: number;
  borderStyle?: string;
  padding?: number;
  opacity?: number;
  text?: string;
  src?: string;
  fieldKey?: string;
  tableSpec?: {
    columns: TableColumn[];
    headerBg?: string;
    headerColor?: string;
    rowBg?: string;
    altRowBg?: string;
    borderColor?: string;
    borderWidth?: number;
  };
}

interface Layout {
  elements: Element[];
  pageBackground?: string;
  margins?: { top: number; right: number; bottom: number; left: number };
}

interface Template {
  id: number;
  companyId: number;
  documentType: DocumentType;
  name: string;
  isDefault: boolean;
  paperSize: string;
  widthMm: number;
  heightMm: number;
  layoutJson: Layout;
  createdAt: string;
  updatedAt: string;
}

// ───────────────────────────── Catalog ───────────────────────────

const DOC_TYPES: { value: DocumentType; label: string }[] = [
  { value: "sales_invoice",     label: "فاتورة مبيعات" },
  { value: "purchase_invoice",  label: "فاتورة مشتريات" },
  { value: "sales_return",      label: "مرتجع مبيعات" },
  { value: "purchase_return",   label: "مرتجع مشتريات" },
  { value: "receipt_voucher",   label: "سند قبض" },
  { value: "payment_voucher",   label: "سند صرف" },
  { value: "bank_receipt",      label: "إيصال بنك" },
  { value: "treasury_receipt",  label: "إيصال خزينة" },
  { value: "account_statement", label: "كشف حساب" },
  { value: "journal_entry",     label: "قيد محاسبي" },
];

// Field placeholders available per document type. Used by the
// "حقول البيانات" sidebar to insert smart-placeholder text elements that
// the renderer will later substitute at print time.
const FIELDS_BY_DOC: Record<DocumentType, { key: string; label: string }[]> = {
  sales_invoice: [
    { key: "company.name",      label: "اسم الشركة" },
    { key: "company.vat",       label: "الرقم الضريبي" },
    { key: "company.address",   label: "عنوان الشركة" },
    { key: "company.phone",     label: "هاتف الشركة" },
    { key: "invoice.number",    label: "رقم الفاتورة" },
    { key: "invoice.date",      label: "تاريخ الفاتورة" },
    { key: "customer.name",     label: "اسم العميل" },
    { key: "customer.vat",      label: "ضريبي العميل" },
    { key: "customer.address",  label: "عنوان العميل" },
    { key: "totals.subtotal",   label: "المجموع الفرعي" },
    { key: "totals.discount",   label: "الخصم" },
    { key: "totals.vat",        label: "الضريبة" },
    { key: "totals.grand",      label: "الإجمالي" },
    { key: "totals.grandWords", label: "الإجمالي كتابة" },
    { key: "qr.zatca",          label: "QR زاتكا" },
    { key: "notes",             label: "ملاحظات" },
  ],
  purchase_invoice: [
    { key: "company.name", label: "اسم الشركة" },
    { key: "invoice.number", label: "رقم الفاتورة" },
    { key: "invoice.date", label: "التاريخ" },
    { key: "supplier.name", label: "اسم المورد" },
    { key: "supplier.vat", label: "ضريبي المورد" },
    { key: "totals.subtotal", label: "المجموع الفرعي" },
    { key: "totals.vat", label: "الضريبة" },
    { key: "totals.grand", label: "الإجمالي" },
  ],
  sales_return: [
    { key: "return.number", label: "رقم المرتجع" },
    { key: "return.date", label: "التاريخ" },
    { key: "invoice.number", label: "رقم الفاتورة الأصلية" },
    { key: "customer.name", label: "اسم العميل" },
    { key: "totals.grand", label: "إجمالي المرتجع" },
  ],
  purchase_return: [
    { key: "return.number", label: "رقم المرتجع" },
    { key: "return.date", label: "التاريخ" },
    { key: "supplier.name", label: "اسم المورد" },
    { key: "totals.grand", label: "إجمالي المرتجع" },
  ],
  receipt_voucher: [
    { key: "voucher.number", label: "رقم السند" },
    { key: "voucher.date", label: "التاريخ" },
    { key: "voucher.amount", label: "المبلغ" },
    { key: "voucher.amountWords", label: "المبلغ كتابة" },
    { key: "voucher.payer", label: "المستلم منه" },
    { key: "voucher.description", label: "البيان" },
    { key: "voucher.method", label: "طريقة الدفع" },
  ],
  payment_voucher: [
    { key: "voucher.number", label: "رقم السند" },
    { key: "voucher.date", label: "التاريخ" },
    { key: "voucher.amount", label: "المبلغ" },
    { key: "voucher.amountWords", label: "المبلغ كتابة" },
    { key: "voucher.beneficiary", label: "المستفيد" },
    { key: "voucher.description", label: "البيان" },
  ],
  bank_receipt: [
    { key: "bank.name", label: "اسم البنك" },
    { key: "bank.account", label: "رقم الحساب" },
    { key: "voucher.amount", label: "المبلغ" },
    { key: "voucher.date", label: "التاريخ" },
  ],
  treasury_receipt: [
    { key: "treasury.name", label: "اسم الخزينة" },
    { key: "voucher.amount", label: "المبلغ" },
    { key: "voucher.date", label: "التاريخ" },
  ],
  account_statement: [
    { key: "account.name",   label: "اسم الحساب" },
    { key: "account.code",   label: "رقم الحساب" },
    { key: "period.from",    label: "من تاريخ" },
    { key: "period.to",      label: "إلى تاريخ" },
    { key: "totals.opening", label: "الرصيد الافتتاحي" },
    { key: "totals.debit",   label: "إجمالي المدين" },
    { key: "totals.credit",  label: "إجمالي الدائن" },
    { key: "totals.closing", label: "الرصيد الختامي" },
  ],
  journal_entry: [
    { key: "je.number",      label: "رقم القيد" },
    { key: "je.date",        label: "التاريخ" },
    { key: "je.description", label: "البيان" },
    { key: "je.totalDebit",  label: "إجمالي المدين" },
    { key: "je.totalCredit", label: "إجمالي الدائن" },
  ],
};

// Default table columns per doc type (used when adding a "table" element).
const DEFAULT_TABLE_COLS: Record<DocumentType, TableColumn[]> = {
  sales_invoice: [
    { key: "no",       label: "م",        width: 30,  align: "center" },
    { key: "name",     label: "الصنف",     width: 180, align: "start"  },
    { key: "qty",      label: "الكمية",   width: 60,  align: "center" },
    { key: "price",    label: "السعر",    width: 70,  align: "end"    },
    { key: "discount", label: "الخصم",    width: 60,  align: "end"    },
    { key: "vat",      label: "الضريبة",  width: 60,  align: "end"    },
    { key: "total",    label: "الإجمالي", width: 80,  align: "end"    },
  ],
  purchase_invoice: [
    { key: "no",    label: "م",        width: 30,  align: "center" },
    { key: "name",  label: "الصنف",     width: 200, align: "start"  },
    { key: "qty",   label: "الكمية",   width: 70,  align: "center" },
    { key: "price", label: "السعر",    width: 80,  align: "end"    },
    { key: "total", label: "الإجمالي", width: 90,  align: "end"    },
  ],
  sales_return: [
    { key: "no", label: "م", width: 30, align: "center" },
    { key: "name", label: "الصنف", width: 200, align: "start" },
    { key: "qty", label: "الكمية", width: 70, align: "center" },
    { key: "total", label: "الإجمالي", width: 90, align: "end" },
  ],
  purchase_return: [
    { key: "no", label: "م", width: 30, align: "center" },
    { key: "name", label: "الصنف", width: 200, align: "start" },
    { key: "qty", label: "الكمية", width: 70, align: "center" },
    { key: "total", label: "الإجمالي", width: 90, align: "end" },
  ],
  receipt_voucher: [],
  payment_voucher: [],
  bank_receipt:    [],
  treasury_receipt:[],
  account_statement: [
    { key: "date",        label: "التاريخ",  width: 90,  align: "center" },
    { key: "ref",         label: "المرجع",   width: 80,  align: "center" },
    { key: "description", label: "البيان",   width: 220, align: "start"  },
    { key: "debit",       label: "مدين",     width: 80,  align: "end"    },
    { key: "credit",      label: "دائن",     width: 80,  align: "end"    },
    { key: "balance",     label: "الرصيد",  width: 90,  align: "end"    },
  ],
  journal_entry: [
    { key: "account",     label: "الحساب",   width: 220, align: "start"  },
    { key: "description", label: "البيان",   width: 220, align: "start"  },
    { key: "debit",       label: "مدين",     width: 90,  align: "end"    },
    { key: "credit",      label: "دائن",     width: 90,  align: "end"    },
  ],
};

// mm → px at screen scale (96dpi · 1mm ≈ 3.7795 px). The Rnd canvas works
// in screen pixels and we keep px in JSON for fidelity with the print
// renderer. Could be reworked to store mm-based units later.
const MM = 3.7795;

function uid() {
  return `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultElement(type: ElementType, docType: DocumentType, fieldKey?: string, fieldLabel?: string): Element {
  const base: Element = {
    id: uid(), type, x: 40, y: 40, width: 200, height: 40, rotation: 0, zIndex: 1,
    fontFamily: "Tahoma, Arial, sans-serif",
    fontSize: 14, fontWeight: "400", textAlign: "start",
    color: "#111827", padding: 4, opacity: 1,
  };
  if (type === "text")  return { ...base, text: "نص" };
  if (type === "field") return { ...base, fieldKey: fieldKey ?? "company.name", text: fieldLabel ?? "{حقل}" };
  if (type === "image") return { ...base, src: "", width: 140, height: 140, background: "#f3f4f6" };
  if (type === "rect")  return { ...base, background: "#e5e7eb", borderColor: "#9ca3af", borderWidth: 1, borderStyle: "solid", width: 200, height: 80 };
  if (type === "line")  return { ...base, background: "#111827", height: 2, width: 240 };
  if (type === "container") return {
    ...base, width: 360, height: 220, zIndex: 0,
    background: "transparent",
    borderColor: "#94a3b8", borderWidth: 1, borderStyle: "dashed",
    text: "صندوق",
  };
  if (type === "table") return {
    ...base, width: 520, height: 200, background: "#ffffff",
    tableSpec: {
      columns: DEFAULT_TABLE_COLS[docType] ?? DEFAULT_TABLE_COLS.sales_invoice,
      headerBg: "#1f2937", headerColor: "#ffffff", rowBg: "#ffffff",
      altRowBg: "#f9fafb", borderColor: "#e5e7eb", borderWidth: 1,
    },
  };
  return base;
}

function emptyLayout(): Layout {
  return { elements: [], pageBackground: "#ffffff", margins: { top: 10, right: 10, bottom: 10, left: 10 } };
}

// ───────────────────────────── Page ──────────────────────────────

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function PrintDesigner() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [documentType, setDocumentType] = useState<DocumentType>("sales_invoice");
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [layout, setLayout] = useState<Layout>(emptyLayout);
  const [paperSize, setPaperSize] = useState<string>("A4");
  const [widthMm, setWidthMm]   = useState(210);
  const [heightMm, setHeightMm] = useState(297);
  const [templateName, setTemplateName] = useState("قالب جديد");
  const [selectedElId, setSelectedElId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [zoom, setZoom] = useState(0.85);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  // Undo / redo history — every call to patchLayout pushes the BEFORE state
  // onto `past` and clears `future`. Direct setLayout calls (template load,
  // first mount) intentionally do NOT touch the stacks so Ctrl+Z cannot
  // accidentally rewind to a different template's layout.
  const [past, setPast]     = useState<Layout[]>([]);
  const [future, setFuture] = useState<Layout[]>([]);
  // Marquee (rubber-band) selection. Coordinates are in page-space (unzoomed
  // pixels relative to the page top-right corner). `additive` is set when the
  // user holds Shift/Ctrl so the marquee adds to the existing selection
  // instead of replacing it.
  const [marquee, setMarquee] = useState<
    { x1: number; y1: number; x2: number; y2: number; additive: boolean } | null
  >(null);
  const [showLeftPanel, setShowLeftPanel]   = useState(true);  // elements + fields palette
  const [showRightPanel, setShowRightPanel] = useState(true);  // inspector

  // Stretch the page to fill the horizontal viewport (much more attractive
  // for portrait A4 — the page fills the workspace edge-to-edge and the
  // user scrolls vertically). For very tall pages we still cap the zoom so
  // a 80mm thermal page doesn't balloon to absurd sizes.
  const fitToPage = () => {
    const vp = canvasViewportRef.current;
    if (!vp) return;
    const padX = 32; // ~16px breathing room on each side
    const availW = vp.clientWidth - padX;
    const availH = vp.clientHeight - 32;
    const pageW = widthMm  * MM;
    const pageH = heightMm * MM;
    // Width-fit by default. If the page is much shorter than wide (landscape
    // or thermal), fall back to fitting both axes so it isn't blown up.
    const zByWidth  = availW / pageW;
    const zByHeight = availH / pageH;
    const z = pageH > pageW ? zByWidth : Math.min(zByWidth, zByHeight);
    setZoom(Math.max(0.3, Math.min(1.6, z)));
  };

  // Auto-fit on first mount, when paper size changes, or when a side panel
  // is collapsed/expanded (the available viewport width just changed).
  useEffect(() => {
    // Wait one frame so the flex layout reflows before we measure.
    const id = requestAnimationFrame(() => fitToPage());
    return () => cancelAnimationFrame(id);
  }, [widthMm, heightMm, showLeftPanel, showRightPanel]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dirty, setDirty] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  // Doc types for which we've already auto-opened the gallery this session,
  // so the user isn't pestered every time they switch back.
  const autoOpenedRef = useRef<Set<string>>(new Set());
  const canvasRef = useRef<HTMLDivElement>(null);

  // Fetch templates for the current doc type ------------------------------
  const { data: templates = [] } = useQuery<Template[]>({
    queryKey: ["print-designer", "templates", documentType],
    queryFn: async () => {
      const r = await fetch(`${API}/api/print-designer/templates?documentType=${documentType}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  // When templates list changes (or doc type changes), pick default or create-new state.
  useEffect(() => {
    if (templates.length === 0) {
      setSelectedTemplateId(null);
      // Auto-apply the first preset so the user sees a ready-to-edit
      // design immediately instead of a blank canvas. The "فارغ جديد"
      // button still gives them a blank starting point on demand.
      const presets = PRESETS_BY_DOC[documentType] ?? [];
      if (presets.length > 0 && !autoOpenedRef.current.has(documentType)) {
        autoOpenedRef.current.add(documentType);
        applyPreset(presets[0]);
        return;
      }
      setLayout(emptyLayout());
      setTemplateName("قالب جديد");
      setPaperSize("A4"); setWidthMm(210); setHeightMm(297);
      setDirty(false);
      return;
    }
    const preferred = templates.find(t => t.isDefault) ?? templates[0];
    setSelectedTemplateId(preferred.id);
  }, [templates.length, documentType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Marquee drag — once started by mousedown on the empty canvas, we attach
  // window-level move/up listeners so the rect keeps tracking even if the
  // cursor leaves the canvas. On release we pick every element whose bounding
  // box intersects the marquee rect and (depending on `additive`) either
  // replace or extend the current selection.
  useEffect(() => {
    if (!marquee) return;
    const onMove = (ev: MouseEvent) => {
      const node = canvasRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / zoom;
      const y = (ev.clientY - rect.top)  / zoom;
      setMarquee(m => (m ? { ...m, x2: x, y2: y } : m));
    };
    const onUp = () => {
      setMarquee(m => {
        if (!m) return null;
        const x1 = Math.min(m.x1, m.x2), x2 = Math.max(m.x1, m.x2);
        const y1 = Math.min(m.y1, m.y2), y2 = Math.max(m.y1, m.y2);
        // Tiny rects (a stray click) shouldn't change selection.
        if (x2 - x1 < 3 && y2 - y1 < 3) return null;
        const hit = layout.elements
          .filter(el => {
            const ex2 = el.x + el.width, ey2 = el.y + el.height;
            return el.x < x2 && ex2 > x1 && el.y < y2 && ey2 > y1;
          })
          .map(el => el.id);
        if (hit.length === 0) return null;
        if (m.additive) {
          setSelectedIds(prev => Array.from(new Set([...prev, ...hit])));
        } else {
          setSelectedIds(hit);
        }
        setSelectedElId(hit[hit.length - 1]);
        return null;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [marquee, zoom, layout]);

  // Esc closes the preset gallery modal.
  useEffect(() => {
    if (!showPresets) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowPresets(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showPresets]);

  // Delete-key removes all currently-selected elements; Esc clears selection.
  // Ignored when typing inside a form field so the inspector stays usable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIds.length > 0) { e.preventDefault(); deleteSelected(); }
      } else if (e.key === "Escape") {
        clearSelection();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && (e.key === "z" || e.key === "Z")) || e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds, layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load selected template into editor state ------------------------------
  useEffect(() => {
    if (selectedTemplateId == null) return;
    const t = templates.find(x => x.id === selectedTemplateId);
    if (!t) return;
    setLayout(t.layoutJson ?? emptyLayout());
    setTemplateName(t.name);
    setPaperSize(t.paperSize);
    setWidthMm(t.widthMm);
    setHeightMm(t.heightMm);
    setDirty(false);
  }, [selectedTemplateId, templates]);

  // Mutations -------------------------------------------------------------
  const createMut = useMutation({
    mutationFn: async (body: any) => {
      const r = await fetch(`${API}/api/print-designer/templates`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<Template>;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["print-designer", "templates", documentType] });
      setSelectedTemplateId(row.id);
      setDirty(false);
      toast({ title: "تم إنشاء القالب" });
    },
    onError: (e: any) => toast({ title: "تعذر الإنشاء", description: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: async (body: any) => {
      const r = await fetch(`${API}/api/print-designer/templates/${selectedTemplateId}`, {
        method: "PATCH", headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["print-designer", "templates", documentType] });
      setDirty(false);
      toast({ title: "تم الحفظ" });
    },
    onError: (e: any) => toast({ title: "تعذر الحفظ", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/print-designer/templates/${id}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["print-designer", "templates", documentType] });
      setSelectedTemplateId(null);
      toast({ title: "تم الحذف" });
    },
    onError: (e: any) => toast({ title: "تعذر الحذف", description: e.message, variant: "destructive" }),
  });

  const setDefaultMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/print-designer/templates/${id}/set-default`, { method: "POST", headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["print-designer", "templates", documentType] });
      toast({ title: "تم تعيينه افتراضياً" });
    },
  });

  // Helpers ---------------------------------------------------------------
  const selectedEl = useMemo(
    () => layout.elements.find(e => e.id === selectedElId) ?? null,
    [layout, selectedElId],
  );

  function patchLayout(next: Layout) {
    // Snapshot the BEFORE state so Ctrl+Z can roll back to it. Any new edit
    // invalidates the redo stack — standard editor semantics.
    setPast(p => [...p, layout]);
    setFuture([]);
    setLayout(next);
    setDirty(true);
  }

  function undo() {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setPast(p => p.slice(0, -1));
    setFuture(f => [layout, ...f]);
    setLayout(prev);
    setDirty(true);
    // Clear selection — the element a user had highlighted may no longer
    // exist (or have a different position) in the restored layout.
    setSelectedElId(null);
    setSelectedIds([]);
  }

  function redo() {
    if (future.length === 0) return;
    const next = future[0];
    setFuture(f => f.slice(1));
    setPast(p => [...p, layout]);
    setLayout(next);
    setDirty(true);
    setSelectedElId(null);
    setSelectedIds([]);
  }

  function addElement(type: ElementType, fieldKey?: string, fieldLabel?: string) {
    const el = defaultElement(type, documentType, fieldKey, fieldLabel);
    if (type !== "container") {
      el.zIndex = (Math.max(0, ...layout.elements.map(e => e.zIndex ?? 0)) + 1);
    }
    patchLayout({ ...layout, elements: [...layout.elements, el] });
    selectOnly(el.id);
  }

  function selectOnly(id: string) {
    setSelectedElId(id);
    setSelectedIds([id]);
  }

  function toggleInSelection(id: string) {
    setSelectedIds(prev => {
      if (prev.includes(id)) {
        const next = prev.filter(x => x !== id);
        setSelectedElId(next[next.length - 1] ?? null);
        return next;
      }
      setSelectedElId(id);
      return [...prev, id];
    });
  }

  function clearSelection() {
    setSelectedElId(null);
    setSelectedIds([]);
  }

  function moveBy(ids: string[], dx: number, dy: number) {
    if ((dx === 0 && dy === 0) || ids.length === 0) return;
    const set = new Set(ids);
    patchLayout({
      ...layout,
      elements: layout.elements.map(e =>
        set.has(e.id) ? { ...e, x: e.x + dx, y: e.y + dy } : e
      ),
    });
  }

  function containedChildIds(container: Element): string[] {
    const cx1 = container.x, cy1 = container.y;
    const cx2 = container.x + container.width, cy2 = container.y + container.height;
    return layout.elements
      .filter(e => e.id !== container.id && e.type !== "container")
      .filter(e => {
        const mx = e.x + e.width / 2;
        const my = e.y + e.height / 2;
        return mx >= cx1 && mx <= cx2 && my >= cy1 && my <= cy2;
      })
      .map(e => e.id);
  }

  function updateElement(id: string, patch: Partial<Element>) {
    patchLayout({
      ...layout,
      elements: layout.elements.map(e => (e.id === id ? { ...e, ...patch } : e)),
    });
  }

  function deleteElement(id: string) {
    patchLayout({ ...layout, elements: layout.elements.filter(e => e.id !== id) });
    if (selectedElId === id) setSelectedElId(null);
    setSelectedIds(prev => prev.filter(x => x !== id));
  }

  function deleteSelected() {
    if (selectedIds.length === 0) return;
    const set = new Set(selectedIds);
    patchLayout({ ...layout, elements: layout.elements.filter(e => !set.has(e.id)) });
    clearSelection();
  }

  function duplicateElement(id: string) {
    const el = layout.elements.find(e => e.id === id);
    if (!el) return;
    const copy: Element = { ...el, id: uid(), x: el.x + 20, y: el.y + 20 };
    patchLayout({ ...layout, elements: [...layout.elements, copy] });
    selectOnly(copy.id);
  }

  function bringForward(id: string) {
    const max = Math.max(0, ...layout.elements.map(e => e.zIndex ?? 0));
    updateElement(id, { zIndex: max + 1 });
  }
  function sendBackward(id: string) {
    const min = Math.min(0, ...layout.elements.map(e => e.zIndex ?? 0));
    updateElement(id, { zIndex: min - 1 });
  }

  function save() {
    const body = { name: templateName, paperSize, widthMm, heightMm, layoutJson: layout };
    if (selectedTemplateId) updateMut.mutate(body);
    else createMut.mutate({ documentType, ...body });
  }

  function createNew() {
    setSelectedTemplateId(null);
    setLayout(emptyLayout());
    setTemplateName(`قالب ${DOC_TYPES.find(d => d.value === documentType)?.label ?? ""}`);
    setPaperSize("A4"); setWidthMm(210); setHeightMm(297);
    setSelectedElId(null);
    setDirty(true);
  }

  // Apply a starter preset: deep-clone the layout (presets may reuse element
  // refs across calls), give every element a fresh id so subsequent edits
  // don't collide, and mark the editor dirty so the user is prompted to save.
  function applyPreset(p: PresetDescriptor) {
    const raw = p.build();
    const cloned = {
      ...raw,
      elements: raw.elements.map(el => ({
        ...el,
        id: `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      })),
    };
    setSelectedTemplateId(null);
    setLayout(cloned);
    setTemplateName(`${p.name} — ${DOC_TYPES.find(d => d.value === documentType)?.label ?? ""}`);
    setPaperSize(p.paperSize);
    setWidthMm(p.widthMm);
    setHeightMm(p.heightMm);
    setSelectedElId(null);
    setDirty(true);
    setShowPresets(false);
    toast({ title: "تم تحميل القالب الجاهز", description: "يمكنك الآن التعديل ثم الحفظ" });
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ documentType, name: templateName, paperSize, widthMm, heightMm, layoutJson: layout }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `${documentType}-${templateName}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  function previewPrint() {
    const win = window.open("", "_blank", "width=900,height=1100");
    if (!win) return;
    const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${templateName}</title>
      <style>body{margin:0;font-family:Tahoma,Arial,sans-serif;background:#eee;padding:20px;display:flex;justify-content:center}
      .page{background:${layout.pageBackground ?? "#fff"};position:relative;box-shadow:0 0 8px rgba(0,0,0,.1);width:${widthMm}mm;height:${heightMm}mm}
      @media print{body{background:#fff;padding:0}.page{box-shadow:none}}
      </style></head><body><div class="page">${renderElementsHtml(layout.elements)}</div>
      <script>setTimeout(()=>window.print(),300)<\/script></body></html>`;
    win.document.write(html); win.document.close();
  }

  // ─────────────────────────── Render ───────────────────────────
  return (
    <div className="flex flex-col h-screen bg-slate-100" dir="rtl">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b shadow-sm flex-wrap">
        <FileText className="w-5 h-5 text-indigo-600" />
        <h1 className="text-lg font-bold">مصمم نماذج الطباعة</h1>
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <select
          value={documentType}
          onChange={e => setDocumentType(e.target.value as DocumentType)}
          className="border rounded px-2 py-1 text-sm bg-white"
        >
          {DOC_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        <select
          value={selectedTemplateId ?? ""}
          onChange={e => setSelectedTemplateId(e.target.value ? Number(e.target.value) : null)}
          className="border rounded px-2 py-1 text-sm bg-white min-w-[180px]"
        >
          <option value="">— قالب جديد —</option>
          {templates.map(t => (
            <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " ⭐" : ""}</option>
          ))}
        </select>
        <input
          value={templateName}
          onChange={e => { setTemplateName(e.target.value); setDirty(true); }}
          className="border rounded px-2 py-1 text-sm bg-white min-w-[180px]"
          placeholder="اسم القالب"
        />
        <button onClick={() => setShowPresets(true)}
          className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700"
          title="ابدأ من قالب جاهز قابل للتعديل">
          <LayoutTemplate className="w-4 h-4" /> قوالب جاهزة
        </button>
        <button onClick={createNew} className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-slate-100 hover:bg-slate-200"
          title="صفحة بيضاء فارغة">
          <Plus className="w-4 h-4" /> فارغ جديد
        </button>
        <button onClick={undo} disabled={past.length === 0}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
          title="تراجع (Ctrl+Z)">
          <Undo2 className="w-3.5 h-3.5" /> تراجع
        </button>
        <button onClick={redo} disabled={future.length === 0}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
          title="إعادة (Ctrl+Y)">
          <Redo2 className="w-3.5 h-3.5" /> إعادة
        </button>
        <button onClick={save} disabled={updateMut.isPending || createMut.isPending}
          className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
          <Save className="w-4 h-4" /> حفظ {dirty && "•"}
        </button>
        {selectedTemplateId && (
          <>
            <button onClick={() => setDefaultMut.mutate(selectedTemplateId)}
              className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-amber-100 hover:bg-amber-200 text-amber-900">
              <Star className="w-4 h-4" /> اجعله افتراضي
            </button>
            <button onClick={() => { if (confirm("حذف القالب؟")) deleteMut.mutate(selectedTemplateId); }}
              className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-rose-100 hover:bg-rose-200 text-rose-900">
              <Trash2 className="w-4 h-4" /> حذف
            </button>
          </>
        )}
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <button onClick={previewPrint} className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-slate-100 hover:bg-slate-200">
          <Printer className="w-4 h-4" /> معاينة
        </button>
        <button onClick={exportJson} className="flex items-center gap-1 px-3 py-1 text-sm rounded bg-slate-100 hover:bg-slate-200">
          <Download className="w-4 h-4" /> JSON
        </button>
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <div className="flex items-center gap-1 text-sm">
          <button onClick={() => setZoom(z => Math.max(0.2, z - 0.1))} className="p-1 rounded hover:bg-slate-100" title="تصغير"><ZoomOut className="w-4 h-4"/></button>
          <span className="w-12 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(2, z + 0.1))} className="p-1 rounded hover:bg-slate-100" title="تكبير"><ZoomIn className="w-4 h-4"/></button>
          <button onClick={fitToPage}
            className="ml-1 flex items-center gap-1 px-2 py-1 text-xs rounded bg-indigo-50 hover:bg-indigo-100 text-indigo-700"
            title="ملاءمة الصفحة كاملة في الشاشة">
            <Maximize2 className="w-3.5 h-3.5"/> ملاءمة
          </button>
        </div>
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <button onClick={() => setShowLeftPanel(v => !v)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${showLeftPanel ? "bg-slate-100 hover:bg-slate-200 text-slate-700" : "bg-emerald-50 hover:bg-emerald-100 text-emerald-700"}`}
          title={showLeftPanel ? "إخفاء لوحة العناصر" : "إظهار لوحة العناصر"}>
          <PanelRightOpen className="w-3.5 h-3.5"/>
          {showLeftPanel ? "إخفاء العناصر" : "إظهار العناصر"}
        </button>
        <button onClick={() => setShowRightPanel(v => !v)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${showRightPanel ? "bg-slate-100 hover:bg-slate-200 text-slate-700" : "bg-emerald-50 hover:bg-emerald-100 text-emerald-700"}`}
          title={showRightPanel ? "إخفاء لوحة الخصائص" : "إظهار لوحة الخصائص"}>
          <PanelLeftOpen className="w-3.5 h-3.5"/>
          {showRightPanel ? "إخفاء الخصائص" : "إظهار الخصائص"}
        </button>
        <button
          onClick={() => { setShowLeftPanel(false); setShowRightPanel(false); }}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-violet-50 hover:bg-violet-100 text-violet-700"
          title="وضع التركيز — يخفي اللوحات الجانبية لرؤية النموذج كاملاً">
          <Maximize2 className="w-3.5 h-3.5"/> وضع التركيز
        </button>
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <button
          onClick={() => setMultiSelectMode(v => !v)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${multiSelectMode ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-slate-100 hover:bg-slate-200 text-slate-700"}`}
          title="أداة التحديد المتعدد — اضغط على عدة عناصر لتحديدها ثم اسحبها معاً (أو استخدم Shift+click)">
          <MousePointer2 className="w-3.5 h-3.5"/>
          {multiSelectMode ? `تحديد متعدد (${selectedIds.length})` : "تحديد متعدد"}
        </button>
        {selectedIds.length > 1 && (
          <span className="text-xs text-indigo-700 bg-indigo-50 px-2 py-1 rounded">
            {selectedIds.length} عناصر محددة — اسحب أحدها لتحريك الكل
          </span>
        )}
        <div className="mx-2 h-6 w-px bg-slate-200" />
        <button
          onClick={() => {
            // Pull every element back inside the page bounds. Useful when a
            // template was authored on a larger paper size or got dragged off
            // the visible area — without this the boxes stay invisible at
            // export time and the user can't reach them with the mouse.
            const pageW = widthMm * MM;
            const pageH = heightMm * MM;
            setLayout(prev => ({
              ...prev,
              elements: prev.elements.map(el => {
                const w = Math.min(el.width,  pageW);
                const h = Math.min(el.height, pageH);
                const x = Math.min(Math.max(0, el.x), Math.max(0, pageW - w));
                const y = Math.min(Math.max(0, el.y), Math.max(0, pageH - h));
                return { ...el, x, y, width: w, height: h };
              }),
            }));
          }}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-amber-50 hover:bg-amber-100 text-amber-700"
          title="ارجاع كل العناصر الخارجة من حدود الصفحة إلى داخل الإطار">
          <Maximize2 className="w-3.5 h-3.5"/> إرجاع للإطار
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left palette */}
        {showLeftPanel && (
        <div className="w-56 shrink-0 bg-white border-l overflow-y-auto p-3 text-sm space-y-4">
          <div>
            <div className="font-semibold mb-2 text-slate-700">العناصر</div>
            <div className="grid grid-cols-2 gap-2">
              <PaletteBtn icon={<Type className="w-4 h-4"/>}      label="نص"      onClick={() => addElement("text")} />
              <PaletteBtn icon={<ImageIcon className="w-4 h-4"/>} label="صورة"   onClick={() => addElement("image")} />
              <PaletteBtn icon={<TableIcon className="w-4 h-4"/>} label="جدول"   onClick={() => addElement("table")} />
              <PaletteBtn icon={<Square className="w-4 h-4"/>}    label="مستطيل" onClick={() => addElement("rect")} />
              <PaletteBtn icon={<Minus className="w-4 h-4"/>}     label="خط"     onClick={() => addElement("line")} />
              <PaletteBtn icon={<Box className="w-4 h-4"/>}       label="صندوق"  onClick={() => addElement("container")} />
            </div>
          </div>
          <div>
            <div className="font-semibold mb-2 text-slate-700">حقول البيانات</div>
            <div className="space-y-1">
              {FIELDS_BY_DOC[documentType].map(f => (
                <button key={f.key} onClick={() => addElement("field", f.key, `{${f.label}}`)}
                  className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-900 text-start">
                  <Tag className="w-3 h-3 shrink-0" /> {f.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="font-semibold mb-2 text-slate-700">إعدادات الصفحة</div>
            <div className="space-y-2">
              <label className="block">
                <span className="text-xs text-slate-600">حجم الورق</span>
                <select value={paperSize} onChange={e => {
                  const v = e.target.value; setPaperSize(v); setDirty(true);
                  if (v === "A4")        { setWidthMm(210); setHeightMm(297); }
                  if (v === "A5")        { setWidthMm(148); setHeightMm(210); }
                  if (v === "80mm")      { setWidthMm(80);  setHeightMm(297); }
                  if (v === "Letter")    { setWidthMm(216); setHeightMm(279); }
                }} className="w-full border rounded px-2 py-1">
                  <option>A4</option><option>A5</option><option>Letter</option><option>80mm</option>
                </select>
              </label>
              <div className="flex gap-1">
                <label className="flex-1"><span className="text-xs text-slate-600">عرض (mm)</span>
                  <input type="number" value={widthMm} onChange={e => { setWidthMm(Number(e.target.value)||210); setDirty(true); }} className="w-full border rounded px-2 py-1"/></label>
                <label className="flex-1"><span className="text-xs text-slate-600">طول (mm)</span>
                  <input type="number" value={heightMm} onChange={e => { setHeightMm(Number(e.target.value)||297); setDirty(true); }} className="w-full border rounded px-2 py-1"/></label>
              </div>
              <label className="block">
                <span className="text-xs text-slate-600">خلفية الصفحة</span>
                <input type="color" value={layout.pageBackground ?? "#ffffff"} onChange={e => patchLayout({ ...layout, pageBackground: e.target.value })}
                  className="w-full h-8 border rounded"/>
              </label>
            </div>
          </div>
        </div>
        )}

        {/* Canvas */}
        <div ref={canvasViewportRef}
          className="flex-1 overflow-auto p-4 flex items-start justify-center bg-gradient-to-b from-slate-100 to-slate-200">
          <div
            ref={canvasRef}
            onMouseDown={e => {
              // Marquee selection: only fires when the click lands directly on
              // the empty canvas background (not on an existing element). The
              // canvas is zoom-scaled, so we convert client coords back to
              // page-space (unzoomed pixels) so the rect matches element data.
              if (e.target !== canvasRef.current) return;
              if (e.button !== 0) return;
              const rect = canvasRef.current.getBoundingClientRect();
              const x = (e.clientX - rect.left) / zoom;
              const y = (e.clientY - rect.top)  / zoom;
              const additive = e.shiftKey || e.ctrlKey || e.metaKey || multiSelectMode;
              if (!additive) clearSelection();
              setMarquee({ x1: x, y1: y, x2: x, y2: y, additive });
            }}
            style={{
              width:  widthMm * MM * zoom,
              height: heightMm * MM * zoom,
              background: layout.pageBackground ?? "#ffffff",
              boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
              position: "relative",
              transformOrigin: "top right",
            }}
            className="overflow-visible"
          >
            <div style={{
              position: "absolute", inset: 0, transform: `scale(${zoom})`,
              transformOrigin: "top right", width: widthMm * MM, height: heightMm * MM,
            }}>
              {marquee && (
                <div
                  style={{
                    position: "absolute",
                    left:   Math.min(marquee.x1, marquee.x2),
                    top:    Math.min(marquee.y1, marquee.y2),
                    width:  Math.abs(marquee.x2 - marquee.x1),
                    height: Math.abs(marquee.y2 - marquee.y1),
                    border: "1.5px dashed #4f46e5",
                    background: "rgba(99,102,241,0.10)",
                    pointerEvents: "none",
                    zIndex: 9999,
                  }}
                />
              )}
              {layout.elements.map(el => (
                <ElementRnd key={el.id} el={el}
                  selected={selectedIds.includes(el.id)}
                  primary={el.id === selectedElId}
                  onSelect={(shift) => {
                    if (shift || multiSelectMode) {
                      toggleInSelection(el.id);
                    } else if (selectedIds.includes(el.id) && selectedIds.length > 1) {
                      // Preserve the existing multi-selection so the drag that
                      // typically follows can move the whole group. Just promote
                      // this element to "primary" so the inspector targets it.
                      setSelectedElId(el.id);
                    } else {
                      selectOnly(el.id);
                    }
                  }}
                  onChange={p => updateElement(el.id, p)}
                  onDelete={() => deleteElement(el.id)}
                  onGroupMove={(dx, dy) => {
                    // Multi-selection wins over container auto-grouping so the
                    // user always gets exactly what they selected. Container's
                    // implicit children are only used when no multi-set exists.
                    if (selectedIds.length > 1 && selectedIds.includes(el.id)) {
                      const extras = el.type === "container" ? containedChildIds(el) : [];
                      moveBy(Array.from(new Set([...selectedIds, ...extras])), dx, dy);
                    } else if (el.type === "container") {
                      moveBy([el.id, ...containedChildIds(el)], dx, dy);
                    } else {
                      updateElement(el.id, { x: el.x + dx, y: el.y + dy });
                    }
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Right inspector */}
        {showRightPanel && (
        <div className="w-60 shrink-0 bg-white border-r overflow-y-auto p-3 text-sm">
          {!selectedEl ? (
            <div className="text-slate-500 text-center mt-10 text-xs">
              اختر عنصراً لتعديل خصائصه<br/>أو اسحب عنصراً من اللوحة اليمنى
            </div>
          ) : (
            <Inspector el={selectedEl}
              onChange={p => updateElement(selectedEl.id, p)}
              onDelete={() => deleteElement(selectedEl.id)}
              onDuplicate={() => duplicateElement(selectedEl.id)}
              onForward={() => bringForward(selectedEl.id)}
              onBackward={() => sendBackward(selectedEl.id)}
            />
          )}
        </div>
        )}
      </div>

      {/* ───────────── Preset gallery modal ───────────── */}
      {showPresets && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onMouseDown={e => { if (e.target === e.currentTarget) setShowPresets(false); }}
          role="dialog" aria-modal="true" aria-labelledby="preset-gallery-title"
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <div>
                <h2 id="preset-gallery-title" className="text-lg font-bold text-slate-800 flex items-center gap-2">
                  <LayoutTemplate className="w-5 h-5 text-indigo-600" />
                  اختر قالباً جاهزاً —{" "}
                  <span className="text-indigo-600">
                    {DOC_TYPES.find(d => d.value === documentType)?.label}
                  </span>
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  حمّل تصميماً جاهزاً وعدّل عليه، أو اختر "فارغ جديد" لتبدأ من صفحة بيضاء.
                </p>
              </div>
              <button onClick={() => setShowPresets(false)}
                aria-label="إغلاق"
                className="p-1.5 rounded hover:bg-slate-100 text-slate-500">
                <X className="w-5 h-5"/>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {(PRESETS_BY_DOC[documentType]?.length ?? 0) === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  لا توجد قوالب جاهزة لهذا النوع من المستندات بعد.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {(PRESETS_BY_DOC[documentType] ?? []).map(p => (
                    <button key={p.key}
                      onClick={() => applyPreset(p)}
                      className="group text-start border border-slate-200 rounded-lg overflow-hidden hover:border-indigo-400 hover:shadow-md transition bg-white">
                      <div className={`h-28 bg-gradient-to-br ${p.accent} relative flex items-center justify-center`}>
                        <LayoutTemplate className="w-12 h-12 text-white/80"/>
                        <span className="absolute top-2 start-2 text-[10px] bg-white/90 text-slate-700 px-2 py-0.5 rounded-full font-medium">
                          {p.paperSize}
                        </span>
                      </div>
                      <div className="p-3">
                        <div className="font-bold text-sm text-slate-800 mb-1 flex items-center gap-1">
                          {p.name}
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 opacity-0 group-hover:opacity-100 transition"/>
                        </div>
                        <div className="text-xs text-slate-500 leading-relaxed line-clamp-2">
                          {p.description}
                        </div>
                      </div>
                    </button>
                  ))}

                  {/* Blank option */}
                  <button onClick={() => { setShowPresets(false); createNew(); }}
                    className="group text-start border-2 border-dashed border-slate-300 rounded-lg overflow-hidden hover:border-slate-500 hover:bg-slate-50 transition">
                    <div className="h-28 bg-slate-50 flex items-center justify-center">
                      <Plus className="w-12 h-12 text-slate-400 group-hover:text-slate-600"/>
                    </div>
                    <div className="p-3">
                      <div className="font-bold text-sm text-slate-700 mb-1">صفحة فارغة</div>
                      <div className="text-xs text-slate-500">ابدأ التصميم من الصفر بدون أي عناصر مسبقة</div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Subcomponents ─────────────────────────

function PaletteBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="flex flex-col items-center justify-center gap-1 p-2 rounded border bg-slate-50 hover:bg-indigo-50 hover:border-indigo-300 transition">
      {icon}
      <span className="text-xs">{label}</span>
    </button>
  );
}

function ElementRnd({
  el, selected, primary, onSelect, onChange, onDelete, onGroupMove,
}: {
  el: Element;
  selected: boolean;
  primary: boolean;
  onSelect: (shiftKey: boolean) => void;
  onChange: (p: Partial<Element>) => void;
  onDelete: () => void;
  onGroupMove: (dx: number, dy: number) => void;
}) {
  const isContainer = el.type === "container";
  // Containers use only the title-bar as drag handle so children placed
  // visually inside remain clickable. Other element types are draggable
  // anywhere on their body (default Rnd behavior).
  const handleClass = isContainer ? `pd-container-handle-${el.id}` : undefined;
  const outline = primary
    ? "2px solid #6366f1"
    : selected
      ? "2px dashed #6366f1"
      : isContainer
        ? "1px dashed #94a3b8"
        : "1px dashed transparent";
  return (
    <Rnd
      size={{ width: el.width, height: el.height }}
      position={{ x: el.x, y: el.y }}
      bounds="parent"
      dragHandleClassName={handleClass}
      onDragStop={(_e, d) => {
        const dx = d.x - el.x;
        const dy = d.y - el.y;
        if (dx === 0 && dy === 0) return;
        onGroupMove(dx, dy);
      }}
      onResizeStop={(_e, _dir, ref, _delta, pos) => onChange({
        width: parseInt(ref.style.width), height: parseInt(ref.style.height), x: pos.x, y: pos.y,
      })}
      onMouseDown={e => { e.stopPropagation(); onSelect(e.shiftKey); }}
      style={{
        outline,
        zIndex: el.zIndex ?? (isContainer ? 0 : 1),
      }}
      enableResizing={el.type !== "line"}
    >
      {isContainer ? (
        <div style={{ width: "100%", height: "100%", position: "relative", boxSizing: "border-box",
          background: el.background ?? "transparent",
          border: `${el.borderWidth ?? 1}px ${el.borderStyle ?? "dashed"} ${el.borderColor ?? "#94a3b8"}`,
          borderRadius: 4, opacity: el.opacity ?? 1 }}>
          <div className={handleClass}
            style={{ position: "absolute", top: 0, insetInlineStart: 0, insetInlineEnd: 0, height: 20,
              background: primary ? "#6366f1" : "#cbd5e1", color: "#fff",
              fontSize: 11, padding: "2px 8px", cursor: "move",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              borderTopRightRadius: 4, borderTopLeftRadius: 4 }}>
            <span>{el.text || "صندوق"}</span>
            <span style={{ opacity: 0.85 }}>{Math.round(el.width)}×{Math.round(el.height)}</span>
          </div>
        </div>
      ) : (
        <ElementView el={el} />
      )}
      {primary && (
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="absolute -top-3 -start-3 bg-rose-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs shadow">
          ×
        </button>
      )}
    </Rnd>
  );
}

function ElementView({ el }: { el: Element }) {
  const common: React.CSSProperties = {
    width: "100%", height: "100%",
    background: el.background, color: el.color,
    fontFamily: el.fontFamily, fontSize: el.fontSize,
    fontWeight: el.fontWeight as any, fontStyle: el.fontStyle,
    textAlign: el.textAlign as any,
    padding: el.padding, opacity: el.opacity ?? 1,
    borderColor: el.borderColor, borderStyle: el.borderStyle ?? "solid",
    borderWidth: el.borderWidth ?? 0, borderRadius: 0,
    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
    overflow: "hidden", boxSizing: "border-box",
    display: "flex", alignItems: "center",
    justifyContent: el.textAlign === "center" ? "center"
      : el.textAlign === "end" ? "flex-end" : "flex-start",
  };
  if (el.type === "text" || el.type === "field") {
    return <div style={common}><span style={{ width: "100%" }}>{el.text}</span></div>;
  }
  if (el.type === "image") {
    return el.src
      ? <img src={el.src} style={{ width: "100%", height: "100%", objectFit: "contain" }} alt="" />
      : <div style={{ ...common, color: "#9ca3af", justifyContent: "center" }}>📷 صورة</div>;
  }
  if (el.type === "rect") return <div style={common} />;
  if (el.type === "container") return <div style={{ ...common, background: el.background ?? "transparent" }} />;
  if (el.type === "line") return <div style={{ ...common, background: el.background ?? "#111827" }} />;
  if (el.type === "table") {
    const spec = el.tableSpec!;
    return (
      <table style={{ width: "100%", height: "100%", borderCollapse: "collapse", fontFamily: el.fontFamily, fontSize: el.fontSize ?? 12 }}>
        <thead>
          <tr>{spec.columns.map(c => (
            <th key={c.key} style={{
              background: spec.headerBg, color: spec.headerColor,
              border: `${spec.borderWidth ?? 1}px solid ${spec.borderColor ?? "#e5e7eb"}`,
              padding: 4, textAlign: c.align ?? "start", width: c.width,
            }}>{c.label}</th>
          ))}</tr>
        </thead>
        <tbody>
          {[0,1,2].map(r => (
            <tr key={r} style={{ background: r % 2 === 0 ? spec.rowBg : spec.altRowBg }}>
              {spec.columns.map(c => (
                <td key={c.key} style={{
                  border: `${spec.borderWidth ?? 1}px solid ${spec.borderColor ?? "#e5e7eb"}`,
                  padding: 4, textAlign: c.align ?? "start",
                }}>—</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return <div style={common}/>;
}

function Inspector({
  el, onChange, onDelete, onDuplicate, onForward, onBackward,
}: {
  el: Element;
  onChange: (p: Partial<Element>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onForward: () => void;
  onBackward: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-slate-800 text-sm">
          {el.type === "text" ? "نص" : el.type === "field" ? "حقل بيانات"
            : el.type === "image" ? "صورة" : el.type === "rect" ? "مستطيل"
            : el.type === "line" ? "خط" : el.type === "container" ? "صندوق"
            : "جدول"}
        </div>
        <div className="flex gap-1">
          <button onClick={onDuplicate} title="نسخ" className="p-1 rounded hover:bg-slate-100"><Copy className="w-4 h-4"/></button>
          <button onClick={onForward} title="للأمام" className="p-1 rounded hover:bg-slate-100">⬆</button>
          <button onClick={onBackward} title="للخلف" className="p-1 rounded hover:bg-slate-100">⬇</button>
          <button onClick={onDelete} title="حذف" className="p-1 rounded hover:bg-rose-100 text-rose-600"><Trash2 className="w-4 h-4"/></button>
        </div>
      </div>

      {/* Position & size */}
      <div className="grid grid-cols-2 gap-2">
        <Field label="X"     value={el.x}      onChange={v => onChange({ x: v })} />
        <Field label="Y"     value={el.y}      onChange={v => onChange({ y: v })} />
        <Field label="عرض"   value={el.width}  onChange={v => onChange({ width: v })} />
        <Field label="طول"   value={el.height} onChange={v => onChange({ height: v })} />
        <Field label="دوران"  value={el.rotation ?? 0} onChange={v => onChange({ rotation: v })} />
        <Field label="شفافية" value={el.opacity ?? 1}  step={0.05} max={1} onChange={v => onChange({ opacity: v })} />
      </div>

      {/* Text-like properties */}
      {(el.type === "text" || el.type === "field") && (
        <>
          <label className="block">
            <span className="text-xs text-slate-600">النص</span>
            <textarea value={el.text ?? ""} onChange={e => onChange({ text: e.target.value })}
              rows={2} className="w-full border rounded px-2 py-1 text-sm"/>
          </label>
        </>
      )}

      {el.type === "container" && (
        <label className="block">
          <span className="text-xs text-slate-600">عنوان الصندوق</span>
          <input type="text" value={el.text ?? ""}
            onChange={e => onChange({ text: e.target.value })}
            className="w-full border rounded px-2 py-1 text-sm"/>
          <p className="text-[11px] text-slate-500 mt-1">
            ضع العناصر بصرياً داخل الصندوق؛ عند سحب شريط العنوان تتحرك تلقائياً معه.
          </p>
        </label>
      )}

      {(el.type === "text" || el.type === "field" || el.type === "table") && (
        <>
          <label className="block">
            <span className="text-xs text-slate-600">الخط</span>
            <select value={el.fontFamily ?? "Tahoma"} onChange={e => onChange({ fontFamily: e.target.value })}
              className="w-full border rounded px-2 py-1 text-sm">
              <option value="Tahoma, Arial, sans-serif">Tahoma</option>
              <option value="'Cairo', sans-serif">Cairo</option>
              <option value="'Amiri', serif">Amiri</option>
              <option value="Arial, sans-serif">Arial</option>
              <option value="'Times New Roman', serif">Times New Roman</option>
              <option value="'Courier New', monospace">Courier New</option>
            </select>
          </label>
          <div className="grid grid-cols-3 gap-2">
            <Field label="حجم" value={el.fontSize ?? 14} onChange={v => onChange({ fontSize: v })} />
            <label className="block col-span-2">
              <span className="text-xs text-slate-600">سُمك</span>
              <select value={el.fontWeight ?? "400"} onChange={e => onChange({ fontWeight: e.target.value })}
                className="w-full border rounded px-2 py-1 text-sm">
                <option value="300">رفيع</option>
                <option value="400">عادي</option>
                <option value="600">شبه عريض</option>
                <option value="700">عريض</option>
                <option value="900">أسود</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-slate-600">المحاذاة</span>
            <div className="flex gap-1 mt-1">
              {(["start","center","end","justify"] as const).map(a => (
                <button key={a} onClick={() => onChange({ textAlign: a })}
                  className={`flex-1 px-2 py-1 border rounded text-xs ${el.textAlign === a ? "bg-indigo-100 border-indigo-400" : ""}`}>
                  {a === "start" ? "يمين" : a === "end" ? "يسار" : a === "center" ? "وسط" : "ضبط"}
                </button>
              ))}
            </div>
          </label>
        </>
      )}

      {/* Colors */}
      <div className="grid grid-cols-2 gap-2">
        <ColorField label="لون النص"     value={el.color}      onChange={v => onChange({ color: v })} />
        <ColorField label="خلفية"        value={el.background} onChange={v => onChange({ background: v })} />
        <ColorField label="لون الحد"     value={el.borderColor} onChange={v => onChange({ borderColor: v })} />
        <Field      label="سُمك الحد"    value={el.borderWidth ?? 0} onChange={v => onChange({ borderWidth: v })} />
      </div>

      {/* Image */}
      {el.type === "image" && (
        <label className="block">
          <span className="text-xs text-slate-600">رابط الصورة</span>
          <input value={el.src ?? ""} onChange={e => onChange({ src: e.target.value })}
            placeholder="https://..." className="w-full border rounded px-2 py-1 text-sm"/>
        </label>
      )}

      {/* Table editor */}
      {el.type === "table" && el.tableSpec && (
        <div className="space-y-2 border-t pt-3">
          <div className="font-semibold text-xs text-slate-700">أعمدة الجدول</div>
          {el.tableSpec.columns.map((c, idx) => (
            <div key={idx} className="flex gap-1 items-center">
              <input value={c.label}
                onChange={e => {
                  const cols = [...el.tableSpec!.columns];
                  cols[idx] = { ...c, label: e.target.value };
                  onChange({ tableSpec: { ...el.tableSpec!, columns: cols } });
                }}
                className="flex-1 border rounded px-1 text-xs py-0.5"/>
              <input type="number" value={c.width ?? 80}
                onChange={e => {
                  const cols = [...el.tableSpec!.columns];
                  cols[idx] = { ...c, width: Number(e.target.value) || 80 };
                  onChange({ tableSpec: { ...el.tableSpec!, columns: cols } });
                }}
                className="w-16 border rounded px-1 text-xs py-0.5"/>
              <button onClick={() => {
                  const cols = el.tableSpec!.columns.filter((_, i) => i !== idx);
                  onChange({ tableSpec: { ...el.tableSpec!, columns: cols } });
                }}
                className="text-rose-500 text-xs">×</button>
            </div>
          ))}
          <button onClick={() => {
              const cols = [...el.tableSpec!.columns, { key: `col${el.tableSpec!.columns.length+1}`, label: "عمود", width: 80, align: "start" as const }];
              onChange({ tableSpec: { ...el.tableSpec!, columns: cols } });
            }}
            className="text-xs px-2 py-1 bg-slate-100 rounded hover:bg-slate-200">+ عمود</button>
          <div className="grid grid-cols-2 gap-1 pt-2">
            <ColorField label="خلفية الرأس"  value={el.tableSpec.headerBg}    onChange={v => onChange({ tableSpec: { ...el.tableSpec!, headerBg: v }})} />
            <ColorField label="لون الرأس"    value={el.tableSpec.headerColor} onChange={v => onChange({ tableSpec: { ...el.tableSpec!, headerColor: v }})} />
            <ColorField label="خلفية الصف"   value={el.tableSpec.rowBg}       onChange={v => onChange({ tableSpec: { ...el.tableSpec!, rowBg: v }})} />
            <ColorField label="خلفية متبادلة" value={el.tableSpec.altRowBg}    onChange={v => onChange({ tableSpec: { ...el.tableSpec!, altRowBg: v }})} />
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, step = 1, max }: { label: string; value: number; onChange: (v: number) => void; step?: number; max?: number }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-600">{label}</span>
      <input type="number" value={Math.round(value * 100) / 100}
        step={step} max={max}
        onChange={e => onChange(Number(e.target.value) || 0)}
        className="w-full border rounded px-2 py-1 text-sm"/>
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-600">{label}</span>
      <div className="flex gap-1">
        <input type="color" value={value ?? "#000000"} onChange={e => onChange(e.target.value)}
          className="w-8 h-8 border rounded"/>
        <input type="text" value={value ?? ""} onChange={e => onChange(e.target.value)}
          className="flex-1 border rounded px-2 text-xs"/>
      </div>
    </label>
  );
}

// ───────────────────────── HTML renderer for print preview ─────────────────────────

function renderElementsHtml(elements: Element[]): string {
  return elements.map(el => {
    const base = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.width}px;height:${el.height}px;`
      + `font-family:${el.fontFamily ?? "Tahoma"};font-size:${el.fontSize ?? 14}px;`
      + `color:${el.color ?? "#000"};background:${el.background ?? "transparent"};`
      + `text-align:${el.textAlign ?? "start"};padding:${el.padding ?? 0}px;`
      + `opacity:${el.opacity ?? 1};`
      + (el.borderWidth ? `border:${el.borderWidth}px ${el.borderStyle ?? "solid"} ${el.borderColor ?? "#000"};` : "")
      + `z-index:${el.zIndex ?? 1};box-sizing:border-box;overflow:hidden;`
      + (el.rotation ? `transform:rotate(${el.rotation}deg);` : "");
    if (el.type === "text" || el.type === "field") return `<div style="${base}">${escapeHtml(el.text ?? "")}</div>`;
    if (el.type === "image") return el.src
      ? `<img src="${el.src}" style="${base};object-fit:contain"/>`
      : `<div style="${base}"></div>`;
    if (el.type === "rect") return `<div style="${base}"></div>`;
    if (el.type === "line") return `<div style="${base};background:${el.background ?? "#000"}"></div>`;
    if (el.type === "table" && el.tableSpec) {
      const s = el.tableSpec;
      const headers = s.columns.map(c =>
        `<th style="background:${s.headerBg ?? "#1f2937"};color:${s.headerColor ?? "#fff"};border:${s.borderWidth ?? 1}px solid ${s.borderColor ?? "#e5e7eb"};padding:4px;text-align:${c.align ?? "start"};width:${c.width ?? "auto"}px">${escapeHtml(c.label)}</th>`,
      ).join("");
      const rows = [0,1,2].map(r =>
        `<tr style="background:${r%2===0 ? s.rowBg ?? "#fff" : s.altRowBg ?? "#f9fafb"}">${
          s.columns.map(c => `<td style="border:${s.borderWidth ?? 1}px solid ${s.borderColor ?? "#e5e7eb"};padding:4px;text-align:${c.align ?? "start"}">—</td>`).join("")
        }</tr>`,
      ).join("");
      return `<table style="${base};border-collapse:collapse"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    return "";
  }).join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]!));
}
