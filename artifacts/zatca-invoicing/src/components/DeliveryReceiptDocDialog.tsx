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

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

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
  const { user, token } = useAuth();
  const { toast } = useToast();
  // Approve (lock) maps to the backend `post` action on this module.
  const canApprove = usePermission("delivery_receipt_docs", "post");
  const company = (user as any)?.company ?? null;
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
    setWarehouseName(s?.warehouseName ?? null);
    setPartyName(s?.partyName ?? null);
    setRecipientName(""); setRecipientJob(""); setRecipientIdNumber(""); setRecipientPhone("");
    setNotes(""); setAudit([]); setApprovedByName(null); setCreatedByName(null);
    setIsApproved(false); setShowAudit(false);
    setSigMode("draw"); setSigDataUrl(null); setSigObjectPath(null);
    setLines((s?.lines?.length ? s.lines : [{ itemName: "", orderedQty: 0, actualQty: 0 }]).map(l => ({ ...l })));
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
      setInvoiceNumber(d.invoiceNumber ?? null); setPartyName(d.partyName ?? null);
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
          itemId: l.itemId ?? null, itemName: l.itemName ?? "", unit: l.unit ?? null,
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
      branchId: s?.branchId ?? undefined,
      warehouseId: s?.warehouseId ?? undefined,
      invoiceId: s?.invoiceId ?? undefined,
      invoiceType: s?.invoiceType ?? undefined,
      invoiceNumber: invoiceNumber ?? undefined,
      partyId: s?.partyId ?? undefined,
      partyType: s?.partyType ?? undefined,
      partyName: partyName ?? undefined,
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
      kind, docNumber, docDate, invoiceNumber, partyName, warehouseName, status, notes,
      recipientName, recipientJob, recipientIdNumber, recipientPhone,
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
    try {
      const blob = await makePdfBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${label}-${docNumber || "مسودة"}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {label}{docNumber ? ` — ${docNumber}` : " جديد"}
            {isApproved && <Badge className="bg-emerald-600 text-white gap-1"><CheckCircle2 className="h-3 w-3" />معتمد</Badge>}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-16 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
        <div className="space-y-5">
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1"><Label className="text-xs">{partyLabel}</Label>
              <Input className="h-9 text-sm" value={partyName ?? ""} onChange={e => setPartyName(e.target.value)} disabled={!canWrite} /></div>
            {warehouseName && <div className="space-y-1"><Label className="text-xs">المستودع</Label>
              <Input className="h-9 text-sm bg-muted/40" value={warehouseName} readOnly /></div>}
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
                      <td className="p-1"><Input className="h-8 text-xs" value={l.itemName} onChange={e => updateLine(i, { itemName: e.target.value })} disabled={!canWrite} /></td>
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

        <DialogFooter className="flex-wrap gap-2">
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
        </DialogFooter>

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
      </DialogContent>
    </Dialog>
  );
}
