import { saveBlob } from "@/lib/saveFile";
// Shared create / edit / view dialog for goods-receipt (سند استلام) and
// delivery (سند تسليم) documents. PURE archive — no GL, no stock, no ZATCA.
// Used both from the invoice "أرشفة" tab (seeded from an invoice) and from the
// standalone list page. Handles recipient info, an e-signature (drawn or an
// uploaded image), an editable lines table, SAP-style print, PDF download and
// email / WhatsApp share.

import { useEffect, useRef, useState, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DateField } from "@/components/ui/date-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { usePermission } from "@/hooks/usePermission";
import { SignaturePad, type SignaturePadHandle } from "@/components/SignaturePad";
import {
  buildDeliveryReceiptPrintHtml, htmlToPdfBlob, blobToBase64,
  type DRPrintDoc, type DRPrintLine,
} from "@/lib/deliveryReceiptPrint";
import { openWhatsApp, buildDocWhatsAppText } from "@/lib/whatsapp";
import {
  Plus, Trash2, Printer, Download, Mail, Share2, CheckCircle2,
  PenLine, ImageUp, Loader2, History,
} from "lucide-react";
import { useDemoActionGate } from "@/hooks/use-demo-action-gate";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useQuery } from "@tanstack/react-query";
import { useInventoryItemSearch } from "@/hooks/useInventoryItemSearch";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function displayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const row = value as Record<string, unknown>;
  for (const key of ["nameAr", "name", "nameEn", "label", "ar", "en", "value", "code", "id"]) {
    const text = displayText(row[key]);
    if (text.trim()) return text;
  }
  return "";
}

export type DRKind = "receipt" | "delivery";

interface LineRow {
  itemId?: number | null;
  itemName: string;
  unit?: string | null;
  orderedQty?: number;
  actualQty?: number;
  notes?: string | null;
}

export interface DRSeed {
  invoiceId?: number;
  invoiceType?: "purchase" | "sales";
  invoiceNumber?: string | null;
  branchId?: number | null;
  warehouseId?: number | null;
  warehouseName?: string | null;
  partyId?: number | null;
  partyType?: "customer" | "supplier" | null;
  partyName?: string | null;
  lines?: LineRow[];
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  kind: DRKind;
  editId?: number | null;
  seed?: DRSeed | null;
  onSaved?: () => void;
}

const STATUS_OPTS = [
  { value: "full",    label: "كامل" },
  { value: "partial", label: "جزئي" },
  { value: "damaged", label: "به تلفيات" },
];

function todayIso(): string {
  return new Date().toISOString();
}

export default function DeliveryReceiptDocDialog({ open, onOpenChange, kind, editId, seed, onSaved }: Props) {
    const gate = useDemoActionGate();
  const { user, token } = useAuth();
  const { toast } = useToast();
  // Approve (lock) maps to the backend `post` action on this module.
  const canApprove = usePermission("delivery_receipt_docs", "post");
  const company = (user as any)?.company ?? null;
  const companyId = Number(company?.id) || undefined;
  const authH = { Authorization: `Bearer ${token}` };
  const isReceipt = kind === "receipt";
  const label = isReceipt ? "سند استلام" : "سند تسليم";
  const partyLabel = isReceipt ? "المورد / الجهة المسلِّمة" : "العميل / الجهة المستلِمة";

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(editId ?? null);
  const [status, setStatus] = useState("full");
  const [docNumber, setDocNumber] = useState("");
  const [docDate, setDocDate] = useState(todayIso());
  const [invoiceNumber, setInvoiceNumber] = useState<string | null>(null);
  const [partyId, setPartyId] = useState<number | null>(null);
  const [branchId, setBranchId] = useState<number | null>(seed?.branchId ?? null);
  const [warehouseId, setWarehouseId] = useState<number | null>(seed?.warehouseId ?? null);
  const [currencyCode, setCurrencyCode] = useState("");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [warehouseName, setWarehouseName] = useState<string | null>(null);
  const [partyName, setPartyName] = useState<string | null>(null);
  const [recipientName, setRecipientName] = useState("");
  const [recipientJob, setRecipientJob] = useState("");
  const [recipientIdNumber, setRecipientIdNumber] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineRow[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [approvedByName, setApprovedByName] = useState<string | null>(null);
  const [createdByName, setCreatedByName] = useState<string | null>(null);
  const [isApproved, setIsApproved] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  const { data: parties = [] } = useQuery<any[]>({
    queryKey: ["delivery-receipt-parties", kind, companyId],
    enabled: !!token,
    queryFn: async () => {
      const path = isReceipt ? "/api/suppliers" : "/api/customers";
      const response = await fetch(`${API}${path}${companyId ? `?companyId=${companyId}` : ""}`, { headers: authH });
      if (!response.ok) throw new Error("تعذر تحميل الجهات");
      return response.json();
    },
  });
  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", companyId],
    enabled: !!token,
    queryFn: async () => {
      const response = await fetch(`${API}/api/org/branches${companyId ? `?companyId=${companyId}` : ""}`, { headers: authH });
      if (!response.ok) throw new Error("تعذر تحميل الفروع");
      return response.json();
    },
  });
  const { data: warehouses = [] } = useQuery<any[]>({
    queryKey: ["warehouses", companyId],
    enabled: !!token,
    queryFn: async () => {
      const response = await fetch(`${API}/api/inventory/warehouses${companyId ? `?companyId=${companyId}` : ""}`, { headers: authH });
      if (!response.ok) throw new Error("تعذر تحميل المخازن");
      return response.json();
    },
  });
  const { data: currencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", companyId],
    enabled: !!token,
    queryFn: async () => {
      const response = await fetch(`${API}/api/currencies${companyId ? `?companyId=${companyId}` : ""}`, { headers: authH });
      if (!response.ok) throw new Error("تعذر تحميل العملات");
      return response.json();
    },
  });
  const { items: inventoryItems, setSearch: setItemSearch, isSearching: isSearchingItems } =
    useInventoryItemSearch(companyId, authH, lines.map(line => line.itemId), !!token);
  const partyOptions = parties.map((party: any) => ({
    value: String(party.id), label: displayText(party.nameAr) || displayText(party.name) || displayText(party.nameEn) || `#${party.id}`,
    code: displayText(party.code), description: displayText(party.phone),
  }));
  const itemOptions = inventoryItems.map((item: any) => ({
    value: String(item.id), label: displayText(item.nameAr) || displayText(item.name) || displayText(item.nameEn) || `#${item.id}`,
    code: displayText(item.code), barcode: displayText(item.barcode),
    description: displayText(item.unitName) || displayText(item.unit) || displayText(item.baseUnitName),
    rawItem: item,
  }));
  const branchOptions = branches.map((branch: any) => ({ value: String(branch.id), label: displayText(branch.nameAr) || displayText(branch.name) || `#${branch.id}` }));
  const warehouseOptions = warehouses
    .filter((warehouse: any) => !branchId || !warehouse.branchId || Number(warehouse.branchId) === branchId)
    .map((warehouse: any) => ({ value: String(warehouse.id), label: displayText(warehouse.nameAr) || displayText(warehouse.name) || `#${warehouse.id}` }));
  const currencyOptions = currencies.map((currency: any) => ({
    value: displayText(currency.code) || displayText(currency.currencyCode) || String(currency.id),
    label: displayText(currency.nameAr) || displayText(currency.name) || displayText(currency.code) || displayText(currency.currencyCode) || `#${currency.id}`,
  }));

  // Signature: either drawn (pad) or an uploaded image. `sigDataUrl` holds the
  // in-memory image for immediate print; `sigObjectPath` is the stored path.
  const [sigMode, setSigMode] = useState<"draw" | "image">("draw");
  const [sigDataUrl, setSigDataUrl] = useState<string | null>(null);
  const [sigObjectPath, setSigObjectPath] = useState<string | null>(null);
  const padRef = useRef<SignaturePadHandle | null>(null);
  const seedRef = useRef(seed);
  seedRef.current = seed;

  const reset = useCallback(() => {
    const s = seedRef.current;
    setStatus("full"); setDocNumber(""); setDocDate(todayIso());
    setInvoiceNumber(s?.invoiceNumber ?? null);
    setPartyId(s?.partyId ?? null);
    setBranchId(s?.branchId ?? null);
    setWarehouseId(s?.warehouseId ?? null);
    setCurrencyCode("");
    setExchangeRate("1");
    setWarehouseName(s?.warehouseName ?? null);
    setPartyName(displayText(s?.partyName) || null);
    setRecipientName(""); setRecipientJob(""); setRecipientIdNumber(""); setRecipientPhone("");
    setNotes(""); setAudit([]); setApprovedByName(null); setCreatedByName(null);
    setIsApproved(false); setShowAudit(false);
    setSigMode("draw"); setSigDataUrl(null); setSigObjectPath(null);
    setLines((s?.lines?.length ? s.lines : [{ itemName: "", orderedQty: 0, actualQty: 0 }])
      .map(l => ({ ...l, itemName: displayText(l.itemName), unit: displayText(l.unit) || null })));
    setSavedId(null);
  }, []);

  const loadDoc = useCallback(async (id: number) => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/delivery-receipt-documents/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error("تعذّر تحميل السند");
      const d = await r.json();
      setSavedId(d.id); setStatus(d.status ?? "full");
      setDocNumber(d.docNumber ?? ""); setDocDate(d.docDate ?? todayIso());
      setInvoiceNumber(d.invoiceNumber ?? null); setPartyName(displayText(d.partyName) || null);
      setPartyId(d.partyId ?? null); setBranchId(d.branchId ?? null); setWarehouseId(d.warehouseId ?? null);
      setCurrencyCode(d.currencyCode ?? ""); setExchangeRate(String(d.exchangeRate ?? 1));
      setRecipientName(d.recipientName ?? ""); setRecipientJob(d.recipientJob ?? "");
      setRecipientIdNumber(d.recipientIdNumber ?? ""); setRecipientPhone(d.recipientPhone ?? "");
      setNotes(d.notes ?? ""); setApprovedByName(d.approvedByName ?? null);
      setCreatedByName(d.createdByName ?? null);
      setIsApproved(d.status === "approved" || !!d.approvedAt);
      setSigObjectPath(d.signatureObjectPath ?? null);
      setSigMode(d.signatureType === "image" ? "image" : "draw");
      setSigDataUrl(null);
      setAudit(Array.isArray(d.audit) ? d.audit : []);
      setLines((Array.isArray(d.lines) && d.lines.length ? d.lines : [{ itemName: "", orderedQty: 0, actualQty: 0 }])
        .map((l: any) => ({
          itemId: l.itemId ?? null, itemName: displayText(l.itemName), unit: displayText(l.unit) || null,
          orderedQty: Number(l.orderedQty ?? 0), actualQty: Number(l.actualQty ?? 0), notes: l.notes ?? null,
        })));
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message ?? "تعذّر التحميل", variant: "destructive" });
    } finally { setLoading(false); }
  }, [token, toast]);

  useEffect(() => {
    if (!open) return;
    if (editId) loadDoc(editId);
    else reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId]);

  function addLine() { setLines(ls => [...ls, { itemName: "", orderedQty: 0, actualQty: 0 }]); }
  function removeLine(i: number) { setLines(ls => ls.filter((_, idx) => idx !== i)); }
  function updateLine(i: number, patch: Partial<LineRow>) {
    setLines(ls => ls.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  }

  async function onSignatureImage(file: File) {
    const reader = new FileReader();
    reader.onload = () => setSigDataUrl(String(reader.result || ""));
    reader.readAsDataURL(file);
  }

  // Upload a signature blob to object storage via the presigned PUT flow and
  // return the stored objectPath (never a data: URI to the backend).
  async function uploadSignature(): Promise<{ path: string; type: "draw" | "image" } | null> {
    let blob: Blob | null = null;
    let type: "draw" | "image" = sigMode;
    if (sigMode === "draw") {
      blob = (await padRef.current?.toBlob()) ?? null;
      if (!blob && sigObjectPath) return null; // keep existing
    } else if (sigDataUrl) {
      const res = await fetch(sigDataUrl);
      blob = await res.blob();
    }
    if (!blob) return null;
    const urlRes = await fetch(`${API}/api/storage/uploads/request-url`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    if (!urlRes.ok) throw new Error("تعذّر تجهيز رفع التوقيع");
    const { uploadURL, objectPath } = await urlRes.json();
    const put = await fetch(uploadURL, {
      method: "PUT", headers: { "Content-Type": "image/png" }, body: blob,
    });
    if (!put.ok) throw new Error("فشل رفع التوقيع");
    return { path: objectPath, type };
  }

  function buildPayload(sig?: { path: string; type: "draw" | "image" } | null) {
    const s = seedRef.current;
    return {
      kind,
      docNumber: docNumber || undefined,
      docDate,
      status,
      branchId: branchId ?? null,
      warehouseId: warehouseId ?? null,
      invoiceId: s?.invoiceId ?? undefined,
      invoiceType: s?.invoiceType ?? undefined,
      invoiceNumber: invoiceNumber ?? undefined,
      partyId: partyId ?? null,
      partyType: isReceipt ? "supplier" : "customer",
      partyName: partyName ?? undefined,
      currencyCode: currencyCode || null,
      exchangeRate: exchangeRate ? Number(exchangeRate) : null,
      recipientName: recipientName || undefined,
      recipientJob: recipientJob || undefined,
      recipientIdNumber: recipientIdNumber || undefined,
      recipientPhone: recipientPhone || undefined,
      signatureType: sig ? sig.type : (sigObjectPath ? sigMode : undefined),
      signatureObjectPath: sig ? sig.path : (sigObjectPath ?? undefined),
      notes: notes || undefined,
      lines: lines.filter(l => l.itemName.trim()).map((l, i) => ({
        itemId: l.itemId ?? undefined,
        itemName: l.itemName.trim(),
        unit: l.unit ?? undefined,
        orderedQty: Number(l.orderedQty ?? 0),
        actualQty: Number(l.actualQty ?? 0),
        notes: l.notes ?? undefined,
        sortOrder: i,
      })),
    };
  }

  async function save(): Promise<number | null> {
    if (!lines.some(l => l.itemName.trim())) {
      toast({ title: "تنبيه", description: "أضِف صنفاً واحداً على الأقل", variant: "destructive" });
      return null;
    }
    setSaving(true);
    try {
      const sig = await uploadSignature();
      const payload = buildPayload(sig);
      const url = savedId
        ? `${API}/api/delivery-receipt-documents/${savedId}`
        : `${API}/api/delivery-receipt-documents`;
      const r = await fetch(url, {
        method: savedId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err?.error ?? "تعذّر حفظ السند");
      }
      const d = await r.json();
      const id = d.id ?? savedId;
      setSavedId(id);
      if (d.docNumber) setDocNumber(d.docNumber);
      if (sig) setSigObjectPath(sig.path);
      toast({ title: "تم الحفظ", description: `${label} رقم ${d.docNumber ?? ""}` });
      onSaved?.();
      return id;
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message ?? "تعذّر الحفظ", variant: "destructive" });
      return null;
    } finally { setSaving(false); }
  }

  async function approve() {
    let id = savedId;
    if (!id) { id = await save(); if (!id) return; }
    try {
      const r = await fetch(`${API}/api/delivery-receipt-documents/${id}/approve`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error ?? "تعذّر الاعتماد"); }
      setIsApproved(true);
      toast({ title: "تم الاعتماد", description: `${label} مُعتمد الآن` });
      onSaved?.();
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message ?? "تعذّر الاعتماد", variant: "destructive" });
    }
  }

  // Resolve a signature image URL for print/PDF: prefer the in-memory data URL,
  // else stream the stored object via the tokenized endpoint (→ data URL).
  async function resolveSignatureForPrint(id: number | null): Promise<string | null> {
    if (sigDataUrl) return sigDataUrl;
    if (id && sigObjectPath && token) {
      try {
        const r = await fetch(`${API}/api/delivery-receipt-documents/${id}/signature?token=${encodeURIComponent(token)}`);
        if (r.ok) {
          const blob = await r.blob();
          return await new Promise<string>((resolve) => {
            const fr = new FileReader();
            fr.onloadend = () => resolve(String(fr.result || ""));
            fr.readAsDataURL(blob);
          });
        }
      } catch { /* ignore — print without signature */ }
    }
    return null;
  }

  function toPrintDoc(sigUrl: string | null): DRPrintDoc {
    return {
      kind, docNumber, docDate, invoiceNumber, partyName,
      branchName: displayText(branches.find((branch: any) => Number(branch.id) === branchId)?.nameAr)
        || displayText(branches.find((branch: any) => Number(branch.id) === branchId)?.name),
      warehouseName: displayText(warehouses.find((warehouse: any) => Number(warehouse.id) === warehouseId)?.nameAr)
        || displayText(warehouses.find((warehouse: any) => Number(warehouse.id) === warehouseId)?.name)
        || warehouseName,
      currencyCode, exchangeRate, status, notes,
      recipientName, recipientJob, recipientIdNumber, recipientPhone,
      printOptions: company?.deliveryReceiptPrintOptions ?? null,
      signatureUrl: sigUrl, createdByName, approvedByName,
      lines: lines.filter(l => l.itemName.trim()).map<DRPrintLine>(l => ({
        itemName: l.itemName, unit: l.unit, orderedQty: l.orderedQty, actualQty: l.actualQty, notes: l.notes,
      })),
    };
  }

  async function doPrint() {
    const id = savedId;
    const sigUrl = await resolveSignatureForPrint(id);
    const html = buildDeliveryReceiptPrintHtml(toPrintDoc(sigUrl), company);
    const w = window.open("", "_blank");
    if (!w) { toast({ title: "منع النوافذ", description: "فعّل النوافذ المنبثقة للطباعة", variant: "destructive" }); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  async function makePdfBlob(): Promise<Blob> {
    const sigUrl = await resolveSignatureForPrint(savedId);
    const html = buildDeliveryReceiptPrintHtml(toPrintDoc(sigUrl), company);
    return htmlToPdfBlob(html);
  }

  async function doDownload() {
      if (!(await gate('export'))) return;
    try {
      const blob = await makePdfBlob();
      await saveBlob(blob, `${label}-${docNumber || "مسودة"}.pdf`);
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message ?? "تعذّر إنشاء PDF", variant: "destructive" });
    }
  }

  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailSending, setEmailSending] = useState(false);

  async function sendEmail() {
    let id = savedId;
    if (!id) { id = await save(); if (!id) return; }
    if (!/^\S+@\S+\.\S+$/.test(emailTo)) {
      toast({ title: "تنبيه", description: "أدخل بريداً صحيحاً", variant: "destructive" }); return;
    }
    setEmailSending(true);
    try {
      const blob = await makePdfBlob();
      const b64 = await blobToBase64(blob);
      const r = await fetch(`${API}/api/delivery-receipt-documents/${id}/email`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to: emailTo, pdfBase64: b64, filename: `${label}-${docNumber}.pdf` }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error ?? "تعذّر الإرسال"); }
      toast({ title: "تم الإرسال", description: `أُرسل إلى ${emailTo}` });
      setEmailOpen(false); setEmailTo("");
    } catch (e: any) {
      toast({ title: "خطأ", description: e?.message ?? "تعذّر الإرسال", variant: "destructive" });
    } finally { setEmailSending(false); }
  }

  function shareWhatsApp() {
    const msg = buildDocWhatsAppText({
      companyName: company?.nameAr || company?.nameEn,
      title: label,
      docNo: docNumber,
      date: docDate ? new Date(docDate).toLocaleDateString("en-GB") : null,
      partyName: partyName,
      note: recipientName ? `المستلِم: ${recipientName}` : null,
    });
    openWhatsApp(msg, recipientPhone);
  }

  const canWrite = !isApproved;

  return (
    <div className="min-h-screen bg-slate-50/70 p-3 sm:p-6" dir="rtl">
      <div className="mx-0 w-full max-w-none space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>عودة للسندات</Button>
            <div>
              <h1 className="text-xl font-bold">{label}{docNumber ? ` — ${docNumber}` : " جديد"}</h1>
              <p className="text-xs text-muted-foreground mt-1">مستند أرشيفي للتوثيق فقط — لا ينشئ قيداً أو حركة مخزون</p>
            </div>
            {isApproved && <Badge className="bg-emerald-600 text-white gap-1"><CheckCircle2 className="h-3 w-3" />معتمد</Badge>}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="gap-1" onClick={doPrint}><Printer className="h-4 w-4" />طباعة</Button>
            <Button type="button" variant="outline" size="sm" className="gap-1" onClick={doDownload}><Download className="h-4 w-4" />PDF</Button>
            <Button type="button" disabled={saving || !canWrite} onClick={() => save()}>{saving ? "جارٍ الحفظ…" : "حفظ السند"}</Button>
          </div>
        </div>

        {loading ? (
          <div className="py-16 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
        <div className="space-y-5 rounded-xl border bg-white p-4 sm:p-6 shadow-sm">
          {/* Header meta */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="space-y-1"><Label className="text-xs">رقم السند</Label>
              <Input className="h-9 text-sm" dir="ltr" placeholder="تلقائي" value={docNumber}
                onChange={e => setDocNumber(e.target.value)} disabled={!canWrite} /></div>
            <div className="space-y-1"><Label className="text-xs">التاريخ</Label>
              <DateField className="h-9 text-sm" value={docDate} onChange={e => setDocDate(e.target.value)} disabled={!canWrite} /></div>
            <div className="space-y-1"><Label className="text-xs">الحالة</Label>
              <Select value={status} onValueChange={setStatus} disabled={!canWrite}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>{STATUS_OPTS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-1"><Label className="text-xs">الفاتورة المرتبطة</Label>
              <Input className="h-9 text-sm bg-muted/40" dir="ltr" value={invoiceNumber ?? ""} readOnly /></div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 rounded-lg border p-3">
            <div className="space-y-1"><Label className="text-xs">{partyLabel}</Label>
              <SearchCombobox items={partyOptions} value={partyId == null ? "" : String(partyId)}
                onValueChange={value => {
                  const party = parties.find((row: any) => String(row.id) === value);
                  setPartyId(value ? Number(value) : null);
                  setPartyName(party ? (displayText(party.nameAr) || displayText(party.name) || displayText(party.nameEn)) : null);
                  if (party?.phone) setRecipientPhone(displayText(party.phone));
                }}
                placeholder={`اختر ${isReceipt ? "المورد" : "العميل"} (اختياري)`}
                searchPlaceholder="ابحث بالاسم أو الكود..." disabled={!canWrite} clearable testId="drdoc-party-picker" />
            </div>
            <div className="space-y-1"><Label className="text-xs">الفرع (اختياري)</Label>
              <SearchCombobox items={branchOptions} value={branchId == null ? "" : String(branchId)}
                onValueChange={value => {
                  setBranchId(value ? Number(value) : null);
                  setWarehouseId(null);
                  setWarehouseName(null);
                }}
                placeholder="اختر الفرع" disabled={!canWrite} clearable testId="drdoc-branch-picker" />
            </div>
            <div className="space-y-1"><Label className="text-xs">المخزن (اختياري)</Label>
              <SearchCombobox items={warehouseOptions} value={warehouseId == null ? "" : String(warehouseId)}
                onValueChange={value => {
                  setWarehouseId(value ? Number(value) : null);
                  const selected = warehouses.find((row: any) => String(row.id) === value);
                  setWarehouseName(selected ? displayText(selected.nameAr) || displayText(selected.name) || null : null);
                }}
                placeholder="اختر المخزن" disabled={!canWrite} clearable testId="drdoc-warehouse-picker" />
            </div>
            <div className="space-y-1"><Label className="text-xs">العملة (اختياري)</Label>
              <SearchCombobox items={currencyOptions} value={currencyCode}
                onValueChange={setCurrencyCode} placeholder="اختر العملة" disabled={!canWrite}
                clearable testId="drdoc-currency-picker" />
            </div>
            <div className="space-y-1"><Label className="text-xs">سعر الصرف</Label>
              <Input className="h-9 text-sm" type="number" min="0.000001" step="0.000001" dir="ltr"
                value={exchangeRate} onChange={event => setExchangeRate(event.target.value)} disabled={!canWrite} />
            </div>
          </div>

          {/* Recipient */}
          <div className="rounded-lg border p-3 space-y-3">
            <div className="text-xs font-semibold text-primary">بيانات المستلِم</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="space-y-1"><Label className="text-xs">الاسم</Label>
                <Input className="h-9 text-sm" value={recipientName} onChange={e => setRecipientName(e.target.value)} disabled={!canWrite} /></div>
              <div className="space-y-1"><Label className="text-xs">الوظيفة/الصفة</Label>
                <Input className="h-9 text-sm" value={recipientJob} onChange={e => setRecipientJob(e.target.value)} disabled={!canWrite} /></div>
              <div className="space-y-1"><Label className="text-xs">رقم الهوية</Label>
                <Input className="h-9 text-sm" dir="ltr" value={recipientIdNumber} onChange={e => setRecipientIdNumber(e.target.value)} disabled={!canWrite} /></div>
              <div className="space-y-1"><Label className="text-xs">الجوال</Label>
                <Input className="h-9 text-sm" dir="ltr" value={recipientPhone} onChange={e => setRecipientPhone(e.target.value)} disabled={!canWrite} /></div>
            </div>
          </div>

          {/* Lines */}
          <div className="rounded-lg border overflow-hidden">
            <div className="flex items-center justify-between bg-muted/40 px-3 py-2">
              <div className="text-xs font-semibold text-primary">الأصناف</div>
              {canWrite && <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={addLine}>
                <Plus className="h-3.5 w-3.5" />إضافة صنف</Button>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/20 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-right">الصنف</th><th className="p-2 w-20">الوحدة</th>
                    <th className="p-2 w-24">كمية الفاتورة</th><th className="p-2 w-24">الكمية الفعلية</th>
                    <th className="p-2 text-right">ملاحظات</th><th className="p-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-1 min-w-[220px]"><SearchCombobox items={itemOptions}
                        value={l.itemId == null ? "" : String(l.itemId)}
                        onValueChange={value => {
                          const item = inventoryItems.find((row: any) => String(row.id) === value);
                          updateLine(i, {
                            itemId: value ? Number(value) : null,
                            itemName: item ? (displayText(item.nameAr) || displayText(item.name) || displayText(item.nameEn)) : "",
                            unit: item ? (displayText(item.unitName) || displayText(item.unit) || displayText(item.baseUnitName)) : "",
                          });
                        }}
                        onSearchChange={setItemSearch} loading={isSearchingItems}
                        placeholder="ابحث واختر الصنف..." disabled={!canWrite} clearable testId={`drdoc-item-${i}`} /></td>
                      <td className="p-1"><Input className="h-8 text-xs" value={l.unit ?? ""} onChange={e => updateLine(i, { unit: e.target.value })} disabled={!canWrite} /></td>
                      <td className="p-1"><Input className="h-8 text-xs" type="number" dir="ltr" value={l.orderedQty ?? 0} onChange={e => updateLine(i, { orderedQty: Number(e.target.value) || 0 })} disabled={!canWrite} /></td>
                      <td className="p-1"><Input className="h-8 text-xs" type="number" dir="ltr" value={l.actualQty ?? 0} onChange={e => updateLine(i, { actualQty: Number(e.target.value) || 0 })} disabled={!canWrite} /></td>
                      <td className="p-1"><Input className="h-8 text-xs" value={l.notes ?? ""} onChange={e => updateLine(i, { notes: e.target.value })} disabled={!canWrite} /></td>
                      <td className="p-1 text-center">{canWrite && <button type="button" onClick={() => removeLine(i)} className="text-destructive"><Trash2 className="h-4 w-4" /></button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Signature */}
          <div className="rounded-lg border p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-primary">توقيع المستلِم</div>
              {canWrite && (
                <div className="flex gap-1">
                  <Button type="button" size="sm" variant={sigMode === "draw" ? "default" : "outline"} className="h-7 text-xs gap-1" onClick={() => setSigMode("draw")}><PenLine className="h-3.5 w-3.5" />رسم</Button>
                  <Button type="button" size="sm" variant={sigMode === "image" ? "default" : "outline"} className="h-7 text-xs gap-1" onClick={() => setSigMode("image")}><ImageUp className="h-3.5 w-3.5" />صورة</Button>
                </div>
              )}
            </div>
            {sigMode === "draw" ? (
              <SignaturePad ref={padRef} disabled={!canWrite} />
            ) : (
              <div className="space-y-2">
                {canWrite && <Input type="file" accept="image/*" className="h-9 text-xs" onChange={e => { const f = e.target.files?.[0]; if (f) onSignatureImage(f); }} />}
                {(sigDataUrl || sigObjectPath) && (
                  <img src={sigDataUrl ?? `${API}/api/delivery-receipt-documents/${savedId}/signature?token=${encodeURIComponent(token ?? "")}`} alt="التوقيع" className="max-h-28 border rounded bg-white" />
                )}
              </div>
            )}
          </div>

          <div className="space-y-1"><Label className="text-xs">ملاحظات</Label>
            <Textarea className="text-sm" rows={2} value={notes} onChange={e => setNotes(e.target.value)} disabled={!canWrite} /></div>

          {audit.length > 0 && (
            <div className="rounded-lg border">
              <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-primary" onClick={() => setShowAudit(v => !v)}>
                <History className="h-3.5 w-3.5" />سجل التدقيق ({audit.length})
              </button>
              {showAudit && (
                <div className="max-h-40 overflow-y-auto border-t divide-y text-xs">
                  {audit.map((a, i) => (
                    <div key={i} className="px-3 py-1.5 flex justify-between gap-2">
                      <span>{a.action} — {a.userName ?? "—"}</span>
                      <span className="text-muted-foreground" dir="ltr">{a.at ? new Date(a.at).toLocaleString("en-GB") : ""}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        )}

        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-3 shadow-sm">
          <div className="flex flex-wrap gap-2 ml-auto">
            <Button type="button" variant="outline" size="sm" className="gap-1" onClick={doPrint}><Printer className="h-4 w-4" />طباعة</Button>
            <Button type="button" variant="outline" size="sm" className="gap-1" onClick={doDownload}><Download className="h-4 w-4" />PDF</Button>
            <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => setEmailOpen(true)}><Mail className="h-4 w-4" />بريد</Button>
            <Button type="button" variant="outline" size="sm" className="gap-1" onClick={shareWhatsApp}><Share2 className="h-4 w-4" />واتساب</Button>
          </div>
          {!isApproved && canApprove && savedId != null && (
            <Button type="button" variant="secondary" size="sm" className="gap-1" onClick={approve}><CheckCircle2 className="h-4 w-4" />اعتماد</Button>
          )}
          {canWrite && (
            <Button type="button" size="sm" disabled={saving} onClick={() => save()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "حفظ"}
            </Button>
          )}
        </div>

        {/* Email sub-dialog */}
        <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
          <DialogContent className="max-w-sm" dir="rtl">
            <DialogHeader><DialogTitle>إرسال بالبريد</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Label className="text-xs">البريد الإلكتروني للمستلِم</Label>
              <Input dir="ltr" type="email" value={emailTo} onChange={e => setEmailTo(e.target.value)} placeholder="name@example.com" />
            </div>
            <DialogFooter>
              <Button size="sm" disabled={emailSending} onClick={sendEmail}>
                {emailSending ? <Loader2 className="h-4 w-4 animate-spin" /> : "إرسال"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
