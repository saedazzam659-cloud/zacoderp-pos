import { useEffect, useState } from "react";
import {
  getSalesInvoice,
  getSalesReturn,
  setSalesInvoiceZatca,
  type SalesLine,
} from "../accounting";
import { getCompanyProfile } from "../appSettings";
import { baseCurrencyCode } from "../currency";
import { loadLicense } from "../standalone";
import { isZatcaCountry } from "../zatcaBridge";
import { tauriInvoke } from "../localStore";
import {
  buildAndSignInvoice,
  loadActiveCredentials,
  submitSigned,
  type BuildInvoiceInput,
  type SignedInvoice,
  type SubmitOutcome,
} from "./submit";
import {
  zatcaGetInvoice,
  zatcaGetOnboarding,
  type ZatcaInvoiceRow,
} from "./native";
import type { OfflineInvoicePayload, SavedInvoice } from "../invoices";

export type ZatcaSubmissionMode = "manual" | "automatic";
export type ZatcaQueueSource = "sales_invoice" | "sales_return" | "pos_sale" | "pos_return";

export type QueuedZatcaDocument = {
  input: BuildInvoiceInput;
  source: ZatcaQueueSource;
  sourceId?: number;
  queuedAt: string;
};

const QUEUE_SETTING = "zatca_local_submission_queue_v1";
const MODE_SETTING = "zatca_local_submission_mode";
const CHANGE_EVENT = "pos-desktop-zatca-queue-changed";

let queueMutation: Promise<unknown> = Promise.resolve();
let chainMutation: Promise<unknown> = Promise.resolve();

function hasTauri(): boolean {
  return typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function readSetting(key: string): Promise<string | null> {
  const local = typeof window !== "undefined" ? localStorage.getItem(key) : null;
  if (local != null) return local;
  if (!hasTauri()) return null;
  try {
    const value = await tauriInvoke<string | null>("standalone_get_setting", { key });
    if (value != null) localStorage.setItem(key, value);
    return value;
  } catch {
    return null;
  }
}

async function writeSetting(key: string, value: string): Promise<void> {
  if (typeof window !== "undefined") localStorage.setItem(key, value);
  if (hasTauri()) {
    await tauriInvoke<void>("standalone_set_setting", { key, value });
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

function withQueueLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = queueMutation.then(operation, operation);
  queueMutation = next.then(() => undefined, () => undefined);
  return next;
}

function withChainLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = chainMutation.then(operation, operation);
  chainMutation = next.then(() => undefined, () => undefined);
  return next;
}

export function getZatcaSubmissionMode(): ZatcaSubmissionMode {
  if (typeof window === "undefined") return "manual";
  return localStorage.getItem(MODE_SETTING) === "automatic" ? "automatic" : "manual";
}

export async function setZatcaSubmissionMode(mode: ZatcaSubmissionMode): Promise<void> {
  await writeSetting(MODE_SETTING, mode);
}

export async function hasLocalZatcaEntitlement(): Promise<boolean> {
  if (!isZatcaCountry()) return false;
  const file = await loadLicense();
  return file?.payload?.country?.toUpperCase() === "SA" &&
    Array.isArray(file.payload.modules) &&
    file.payload.modules.includes("zatca");
}

export function useLocalZatcaEntitlement(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => { void hasLocalZatcaEntitlement().then((value) => { if (active) setEnabled(value); }); };
    refresh();
    window.addEventListener("pos-desktop-tax-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      active = false;
      window.removeEventListener("pos-desktop-tax-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return enabled;
}

async function readQueueUnlocked(): Promise<QueuedZatcaDocument[]> {
  const raw = await readSetting(QUEUE_SETTING);
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((row): row is QueuedZatcaDocument =>
      !!row && typeof row === "object" &&
      typeof row.input?.uuid === "string" &&
      typeof row.input?.invoiceNumber === "string" &&
      (row.source === "sales_invoice" || row.source === "sales_return" ||
        row.source === "pos_sale" || row.source === "pos_return"),
    );
  } catch {
    return [];
  }
}

export async function listQueuedZatcaDocuments(): Promise<QueuedZatcaDocument[]> {
  await queueMutation;
  return readQueueUnlocked();
}

export async function queueZatcaDocument(
  input: BuildInvoiceInput,
  source: ZatcaQueueSource,
  sourceId?: number,
): Promise<void> {
  if (!(await hasLocalZatcaEntitlement())) {
    throw new Error("وحدة زاتكا غير مفعّلة لهذا الترخيص أو أن الدولة ليست السعودية.");
  }
  const recorded = await zatcaGetInvoice(input.uuid);
  if (recorded) {
    if (source === "sales_invoice" && sourceId && recorded.qrBase64) {
      await setSalesInvoiceZatca(sourceId, recorded.qrBase64, recorded.localUuid);
    }
    return;
  }
  await withQueueLock(async () => {
    const rows = await readQueueUnlocked();
    const existingIndex = rows.findIndex((row) => row.input.uuid === input.uuid);
    if (existingIndex >= 0) {
      const existing = rows[existingIndex];
      if (existing.input.invoiceNumber !== input.invoiceNumber) {
        throw new Error("معرّف مستند زاتكا مستخدم لفاتورة مختلفة.");
      }
      rows[existingIndex] = { ...existing, input, source, sourceId };
    } else {
      rows.push({ input, source, sourceId, queuedAt: new Date().toISOString() });
    }
    await writeSetting(QUEUE_SETTING, JSON.stringify(rows));
  });
}

export async function queueOrSubmitZatcaDocument(
  input: BuildInvoiceInput,
  source: ZatcaQueueSource,
  sourceId?: number,
): Promise<SubmitOutcome | null> {
  await queueZatcaDocument(input, source, sourceId);
  const recorded = await zatcaGetInvoice(input.uuid);
  if (recorded) {
    await removeQueuedDocument(input.uuid);
    return {
      status: recorded.status === "submitted" ? "submitted" : recorded.status === "rejected" ? "rejected" : "pending",
      zatcaStatus: recorded.zatcaStatus,
      offline: recorded.status === "pending",
    };
  }
  if (getZatcaSubmissionMode() !== "automatic") return null;
  return submitQueuedZatcaDocument(input.uuid);
}

async function removeQueuedDocument(uuid: string): Promise<void> {
  await withQueueLock(async () => {
    const rows = await readQueueUnlocked();
    const next = rows.filter((row) => row.input.uuid !== uuid);
    if (next.length !== rows.length) await writeSetting(QUEUE_SETTING, JSON.stringify(next));
  });
}

function storedFlow(value: string | null): "simplified" | "standard" {
  return value?.endsWith("standard") ? "standard" : "simplified";
}

function signedFromRow(row: ZatcaInvoiceRow): SignedInvoice {
  if (!row.signedXml) throw new Error("الفاتورة الموقّعة غير متوفرة لإعادة الإرسال.");
  const documentType = row.invoiceType?.startsWith("credit_") ? "credit" : "invoice";
  return {
    uuid: row.localUuid,
    icv: row.icv,
    pih: row.pih,
    invoiceHash: row.invoiceHash,
    signedXml: row.signedXml,
    qrBase64: row.qrBase64 ?? "",
    flow: storedFlow(row.invoiceType),
    documentType,
    invoiceNumber: row.invoiceNo ?? "",
  };
}

/** Signs locally, stores in the local PIH/ICV chain, and submits directly to ZATCA. */
export async function submitQueuedZatcaDocument(
  uuid: string,
  options: { retryExisting?: boolean } = {},
): Promise<SubmitOutcome> {
  return withChainLock(async () => {
    const queued = (await listQueuedZatcaDocuments()).find((row) => row.input.uuid === uuid);
    if (!queued) throw new Error("المستند غير موجود في قائمة زاتكا اليدوية.");
    if (!(await hasLocalZatcaEntitlement())) {
      throw new Error("تعذر الإرسال: زاتكا لا تعمل إلا بترخيص سعودي مفعّل.");
    }

    const creds = await loadActiveCredentials();
    const existing = await zatcaGetInvoice(uuid);
    if (existing) {
      if (existing.status === "submitted") {
        if (queued.source === "sales_invoice" && queued.sourceId && existing.qrBase64) {
          await setSalesInvoiceZatca(queued.sourceId, existing.qrBase64, existing.localUuid);
        }
        await removeQueuedDocument(uuid);
        return { status: "submitted", zatcaStatus: existing.zatcaStatus, offline: false };
      }
      if (!options.retryExisting) {
        return {
          status: existing.status === "rejected" ? "rejected" : "pending",
          zatcaStatus: existing.zatcaStatus,
          offline: existing.status === "pending",
        };
      }
      await removeQueuedDocument(uuid);
      const full = await requireFullInvoice(uuid);
      if (queued.source === "sales_invoice" && queued.sourceId && full.qrBase64) {
        await setSalesInvoiceZatca(queued.sourceId, full.qrBase64, full.localUuid);
      }
      return submitSigned(creds, signedFromRow(full));
    }

    const signed = await buildAndSignInvoice(creds, queued.input);
    if (queued.source === "sales_invoice" && queued.sourceId) {
      await setSalesInvoiceZatca(queued.sourceId, signed.qrBase64, signed.uuid);
    }
    // Signing has consumed this invoice's ICV and stored its XML locally.
    // Further network retries use that exact signed row, never a new ICV.
    await removeQueuedDocument(uuid);
    return submitSigned(creds, signed);
  });
}

async function requireFullInvoice(uuid: string): Promise<ZatcaInvoiceRow> {
  const row = await zatcaGetInvoice(uuid);
  if (!row) throw new Error("الفاتورة غير موجودة في سجل زاتكا المحلي.");
  return row;
}

export async function buildSalesInvoiceZatcaInput(id: number): Promise<BuildInvoiceInput> {
  const invoice = await getSalesInvoice(id);
  if (invoice.status && invoice.status !== "posted") {
    throw new Error("لن تُرسل فاتورة مسودة إلى زاتكا. رحّل الفاتورة أولاً.");
  }
  const invoiceType = invoice.invoiceType === "standard" ? "standard" : "simplified";
  return buildInput({
    uuid: await stableUuid(`sales-invoice:${invoice.id}`),
    invoiceNumber: invoice.invoiceNo,
    issueDate: invoice.invoiceDate,
    flow: invoiceType,
    documentType: "invoice",
    paymentMethod: invoice.paymentMethod,
    subtotal: invoice.subtotal,
    vatTotal: invoice.vatTotal,
    grandTotal: invoice.grandTotal,
    notes: invoice.notes,
    lines: invoice.lines,
    customerName: invoice.buyerName || invoice.customerName,
    customerVat: invoice.buyerVat,
    customerAddress: invoice.buyerAddress,
  });
}

export async function buildSalesReturnZatcaInput(id: number): Promise<BuildInvoiceInput> {
  const saleReturn = await getSalesReturn(id);
  if (saleReturn.status !== "posted") {
    throw new Error("لن يُرسل مرتجع غير مُرحّل إلى زاتكا.");
  }
  if (!saleReturn.invoiceId) {
    throw new Error("إشعار الإرجاع يحتاج فاتورة مبيعات أصلية مرتبطة به.");
  }
  const original = await getSalesInvoice(saleReturn.invoiceId);
  return buildInput({
    uuid: await stableUuid(`sales-return:${saleReturn.id}`),
    invoiceNumber: saleReturn.returnNo,
    issueDate: saleReturn.returnDate,
    flow: original.invoiceType === "standard" ? "standard" : "simplified",
    documentType: "credit",
    billingReferenceId: original.invoiceNo,
    instructionNote: saleReturn.notes?.trim() || "مرتجع مبيعات",
    paymentMethod: saleReturn.paymentMethod,
    subtotal: saleReturn.subtotal,
    vatTotal: saleReturn.vatTotal,
    grandTotal: saleReturn.grandTotal,
    notes: saleReturn.notes,
    lines: saleReturn.lines,
    customerName: original.buyerName || original.customerName || saleReturn.customerName,
    customerVat: original.buyerVat,
    customerAddress: original.buyerAddress,
  });
}

export async function buildOfflineInvoiceZatcaInput(
  saved: SavedInvoice,
  payload: OfflineInvoicePayload & { kind?: "sale" | "return"; refOf?: string; reason?: string },
): Promise<BuildInvoiceInput> {
  const credit = payload.kind === "return";
  if (credit && !payload.refOf?.trim()) {
    throw new Error("إشعار الإرجاع يحتاج رقم الفاتورة الأصلية.");
  }
  const timestamp = new Date(payload.timestamp);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("تاريخ الفاتورة غير صالح لإرسال زاتكا.");
  return buildInput({
    uuid: validUuid(saved.localUuid) ? saved.localUuid : await stableUuid(`offline:${saved.localUuid}`),
    invoiceNumber: saved.invoiceNo,
    issueDate: timestamp.toISOString().slice(0, 10),
    issueTime: timestamp.toISOString().slice(11, 19),
    flow: "simplified",
    documentType: credit ? "credit" : "invoice",
    billingReferenceId: credit ? payload.refOf : null,
    instructionNote: credit ? payload.reason?.trim() || "مرتجع مبيعات" : null,
    paymentMethod: payload.paymentMethod === "cash" ? "cash" : "bank",
    subtotal: payload.subtotal,
    vatTotal: payload.vat,
    grandTotal: payload.grandTotal,
    notes: credit ? payload.reason ?? null : null,
    lines: payload.lines.map((line) => ({
      itemId: line.itemId,
      itemName: line.nameAr,
      qty: Math.abs(line.qty),
      unitPrice: line.unitPrice,
      vatRate: line.vatRate,
      lineTotal: Math.abs(line.qty * line.unitPrice * (1 + line.vatRate / 100)),
    })),
    customerName: payload.customerName,
    customerVat: payload.vatNumber,
    customerAddress: null,
  });
}

export async function prepareOfflineInvoiceForZatca(
  saved: SavedInvoice,
  payload: OfflineInvoicePayload & { kind?: "sale" | "return"; refOf?: string; reason?: string },
): Promise<{ qrBase64: string | null; outcome: SubmitOutcome | null } | null> {
  if (!(await hasLocalZatcaEntitlement())) return null;
  const source: ZatcaQueueSource = payload.kind === "return" ? "pos_return" : "pos_sale";
  const input = await buildOfflineInvoiceZatcaInput(saved, payload);
  const outcome = await queueOrSubmitZatcaDocument(input, source);
  const recorded = await zatcaGetInvoice(input.uuid);
  return { qrBase64: recorded?.qrBase64 ?? null, outcome };
}

async function buildInput(source: {
  uuid: string;
  invoiceNumber: string;
  issueDate: string;
  issueTime?: string;
  flow: "simplified" | "standard";
  documentType: "invoice" | "credit";
  billingReferenceId?: string | null;
  instructionNote?: string | null;
  paymentMethod: string;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  notes?: string | null;
  lines: SalesLine[];
  customerName?: string | null;
  customerVat?: string | null;
  customerAddress?: string | null;
}): Promise<BuildInvoiceInput> {
  if (!isZatcaCountry() || baseCurrencyCode() !== "SAR") {
    throw new Error("الإرسال المباشر يتطلب اختيار السعودية والريال السعودي كعملة أساسية.");
  }
  const profile = getCompanyProfile();
  const onboarding = await zatcaGetOnboarding();
  let org: Record<string, unknown> = {};
  try { org = onboarding.orgJson ? JSON.parse(onboarding.orgJson) : {}; } catch { /* validation below */ }
  const companyName = String(org.organizationName || profile.name || "").trim();
  const companyVat = String(org.vatNumber || profile.vat || "").trim();
  const address = String(org.registeredAddress || profile.address || "").trim();
  if (!companyName || !companyVat || !address) {
    throw new Error("أكمل اسم المنشأة والرقم الضريبي والعنوان المسجل في إعداد زاتكا قبل الإرسال.");
  }
  const addressParts = parseSaudiAddress(address);
  if (!source.lines.length) throw new Error("لا يمكن إرسال مستند زاتكا بدون بنود.");

  const targetSubtotal = Math.abs(Number(source.subtotal) || 0);
  const targetVat = Math.abs(Number(source.vatTotal) || 0);
  const targetGrand = Math.abs(Number(source.grandTotal) || 0);
  const rawLines = source.lines.map((line) => ({
    qty: Math.abs(Number(line.qty) || 0),
    price: Math.abs(Number(line.unitPrice) || 0),
    rate: Math.max(0, Number(line.vatRate) || 0),
    description: line.itemName?.trim() || `صنف ${line.itemId}`,
    unitCode: "PCE",
  })).filter((line) => line.qty > 0);
  if (!rawLines.length) throw new Error("لا توجد كميات صالحة لإرسالها إلى زاتكا.");
  const rawSubtotal = rawLines.reduce((sum, line) => sum + line.qty * line.price, 0);
  if (rawSubtotal <= 0 || Math.abs(targetSubtotal + targetVat - targetGrand) > 0.03) {
    throw new Error("إجماليات المستند المحفوظة غير متطابقة؛ لم يتم إنشاء مستند زاتكا.");
  }
  const scale = targetSubtotal / rawSubtotal;
  let netSum = 0;
  let vatSum = 0;
  const lineItems = rawLines.map((line, index) => {
    const isLast = index === rawLines.length - 1;
    let net = round2(line.qty * line.price * scale);
    let vat = round2(net * line.rate / 100);
    if (isLast) {
      net = round2(targetSubtotal - netSum);
      vat = round2(targetVat - vatSum);
    }
    netSum = round2(netSum + net);
    vatSum = round2(vatSum + vat);
    let unitPrice = round2(line.price * scale);
    if (unitPrice * line.qty < net) unitPrice = Math.ceil((net / line.qty) * 100) / 100;
    const discount = round2(Math.max(0, unitPrice * line.qty - net));
    return {
      id: index + 1,
      description: line.description,
      quantity: String(line.qty),
      unitCode: line.unitCode,
      unitPrice: unitPrice.toFixed(2),
      discountAmount: discount.toFixed(2),
      taxCategory: "S",
      vatRate: line.rate.toFixed(2),
      vatAmount: vat.toFixed(2),
      subtotal: net.toFixed(2),
      total: round2(net + vat).toFixed(2),
    };
  });
  const issueDate = normalizeDate(source.issueDate);
  const customerName = source.customerName?.trim();
  if (source.flow === "standard" && (!customerName || !source.customerVat?.trim())) {
    throw new Error("الفاتورة الضريبية تحتاج اسم العميل ورقمه الضريبي قبل إرسالها إلى زاتكا.");
  }
  const customer = customerName ? {
    nameAr: customerName,
    vatNumber: source.customerVat?.trim() || null,
    street: source.customerAddress?.trim() || "",
    buildingNumber: "",
    city: "",
    postalCode: "",
    country: "SA",
  } : null;
  const invoiceTotal = targetGrand.toFixed(2);
  const vatTotal = targetVat.toFixed(2);
  return {
    uuid: source.uuid,
    invoiceNumber: source.invoiceNumber,
    flow: source.flow,
    documentType: source.documentType,
    issueDate,
    issueTime: source.issueTime || "00:00:00",
    currency: "SAR",
    qr: {
      sellerName: companyName,
      vatNumber: companyVat,
      invoiceTotal,
      vatTotal,
    },
    data: {
      invoiceNumber: source.invoiceNumber,
      documentType: source.documentType,
      billingReferenceId: source.billingReferenceId ?? null,
      instructionNote: source.instructionNote ?? null,
      issueDate,
      issueTime: source.issueTime || "00:00:00",
      supplyDate: issueDate,
      currency: "SAR",
      paymentMethod: source.paymentMethod === "cash" ? "10" : "30",
      subtotal: targetSubtotal.toFixed(2),
      discountTotal: "0.00",
      vatTotal,
      grandTotal: invoiceTotal,
      notes: source.notes ?? null,
      lineItems,
      company: {
        nameAr: companyName,
        nameEn: null,
        vatNumber: companyVat,
        crNumber: profile.cr || "",
        ...addressParts,
        country: "SA",
      },
      customer,
    },
  };
}

function normalizeDate(value: string): string {
  const direct = value?.slice(0, 10);
  if (direct && /^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("تاريخ الفاتورة غير صالح لإرسال زاتكا.");
  return parsed.toISOString().slice(0, 10);
}

function parseSaudiAddress(address: string): {
  street: string;
  buildingNumber: string;
  city: string;
  district: string | null;
  postalCode: string;
} {
  const parts = address.split(/[,،|]+/).map((part) => part.trim()).filter(Boolean);
  const find = (pattern: RegExp) => parts.find((part) => pattern.test(part)) ?? "";
  const buildingPart = find(/(?:مبنى|رقم\s*المبنى|building(?:\s*number)?)\s*[:#-]?\s*\d{4}\b/i);
  const postalPart = find(/(?:الرمز\s*البريدي|postal(?:\s*code)?)\s*[:#-]?\s*\d{5}\b/i);
  const cityPart = find(/(?:المدينة|مدينة|city)\s*[:#-]?\s*.+/i);
  const districtPart = find(/(?:الحي|حي|district)\s*[:#-]?\s*.+/i);
  const buildingNumber = buildingPart.match(/\d{4}\b/)?.[0] ?? "";
  const postalCode = postalPart.match(/\d{5}\b/)?.[0] ?? "";
  const city = cityPart.replace(/^(?:المدينة|مدينة|city)\s*[:#-]?\s*/i, "").trim();
  const district = districtPart.replace(/^(?:الحي|حي|district)\s*[:#-]?\s*/i, "").trim();
  const street = parts
    .filter((part) => part !== buildingPart && part !== postalPart && part !== cityPart && part !== districtPart)
    .join("، ")
    .trim();
  if (!street || !buildingNumber || !city || !postalCode) {
    throw new Error("أدخل العنوان بصيغة واضحة تشمل الشارع، الحي، المدينة، رقم المبنى من 4 أرقام والرمز البريدي من 5 أرقام.");
  }
  return { street, buildingNumber, city, district: district || null, postalCode };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function stableUuid(value: string): Promise<string> {
  const namespace = new Uint8Array([
    0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1,
    0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
  ]);
  const name = new TextEncoder().encode(value);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace, 0);
  input.set(name, namespace.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
