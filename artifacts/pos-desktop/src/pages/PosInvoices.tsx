// POS sales invoices viewer (فواتير نقطة البيع).
//
// A read-only LIST + DETAIL viewer over the local offline_invoices table.
// POS offline invoices are ZATCA-signed and immutable — editing a line would
// corrupt the QR / XAdES signature — so this screen deliberately offers NO
// line-item editor. It surfaces:
//   - every saved sale/return with its sync (posting) status
//   - a wide detail modal: header, lines, totals, and whether a ZATCA QR exists
//
// Data comes exclusively through the typed wrappers in ../lib/invoices; no
// Tauri command is invoked directly.

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  listAllInvoices,
  getOfflineInvoice,
  deleteOfflineInvoice,
  type PendingInvoice,
  type OfflineInvoicePayload,
  type FullInvoice,
} from "../lib/invoices";
import {
  Page, Card, Table, Th, Td, Modal, ErrorMsg, Empty,
  input, btnSecondary, fmt,
  useGridFilter, GridToolbar, SortableTh, GridFilterRow, type GridColumn,
  ExportButtons, gridToExportCols,
} from "./_adminUi";
import { currencySymbol } from "../lib/currency";
import { getUiLanguage, uiText, useUiLanguage } from "../lib/appSettings";

type FilterKind = "all" | "sales" | "returns";

const FILTERS: { value: FilterKind; label: string }[] = [
  { value: "all", label: "الكل" },
  { value: "sales", label: "مبيعات" },
  { value: "returns", label: "مرتجعات" },
];

// Reliable sale/return classification. The Rust backend now stamps every row
// with `docType` (parsed from the payload's `kind`); both sales AND returns
// share the "OFF-" invoice_no prefix on a real device, so the old prefix test
// mis-classified every return as a sale. We still fall back to the prefix for
// browser-dev rows that predate `docType`.
function docKindOf(r: { invoiceNo: string; docType?: string | null }): "sale" | "return" {
  if (r.docType === "return") return "return";
  if (r.docType === "sale") return "sale";
  return r.invoiceNo.startsWith("RET") ? "return" : "sale";
}

function typeLabel(kind: "sale" | "return", language = getUiLanguage()): string {
  return kind === "return" ? uiText("مرتجع", "Return", language) : uiText("بيع", "Sale", language);
}

function paymentMethodLabel(m: string | undefined, language = getUiLanguage()): string {
  if (m === "cash") return uiText("نقداً", "Cash", language);
  if (m === "card") return uiText("بطاقة", "Card", language);
  return m ?? "—";
}

// sync_status → coloured badge. pending/queued are amber (not yet uploaded),
// synced/submitted are green (accepted by ZATCA / cloud), error is red.
function SyncBadge({ status }: { status: string }) {
  const language = useUiLanguage();
  const s = (status || "").toLowerCase();
  let bg = "#fffbeb", color = "#92400e", border = "#fde68a", text = status || "—";
  if (s === "pending" || s === "queued") {
    bg = "#fffbeb"; color = "#92400e"; border = "#fde68a";
    text = s === "queued" ? uiText("قيد المزامنة", "Queued", language) : uiText("غير مرفوعة", "Not uploaded", language);
  } else if (s === "synced" || s === "submitted") {
    bg = "#f0fdf4"; color = "#166534"; border = "#bbf7d0"; text = uiText("مرفوعة", "Uploaded", language);
  } else if (s === "error" || s === "failed") {
    bg = "#fef2f2"; color = "#991b1b"; border = "#fecaca"; text = uiText("خطأ", "Error", language);
  }
  return (
    <span style={{
      display: "inline-block", padding: "2px 10px", borderRadius: 999,
      fontSize: 12, background: bg, color, border: `1px solid ${border}`,
    }}>{text}</span>
  );
}

function fmtDate(iso: string, language = getUiLanguage()): string {
  if (!iso) return "—";
  // Local SQLite timestamps are stored without a timezone suffix; treat them
  // as UTC so they render in the cashier's local time consistently.
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(language === "en" ? "en-GB" : "ar-SA");
}

export default function PosInvoices({ companyName, cashierName, onReuse }: { companyName?: string; cashierName?: string; onReuse?: (id: number) => void }) {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const sym = currencySymbol();
  const [rows, setRows] = useState<PendingInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKind>("all");
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Detail modal state.
  const [detail, setDetail] = useState<FullInvoice | null>(null);
  const [detailPayload, setDetailPayload] = useState<OfflineInvoicePayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const list = await listAllInvoices(200);
      setRows(list);
    } catch (e: any) {
      setErr(`تعذّر تحميل الفواتير: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(row: PendingInvoice) {
    const ok = window.confirm(
      `حذف الفاتورة ${row.invoiceNo} نهائياً من هذا الجهاز؟\n` +
      `هذا يحذف السجل المحلي فقط ولا يلغي أي فاتورة مُرسلة إلى هيئة الزكاة والضريبة.`,
    );
    if (!ok) return;
    setDeletingId(row.id);
    setErr(null);
    try {
      await deleteOfflineInvoice(row.id);
      await refresh();
    } catch (e: any) {
      setErr(`تعذّر حذف الفاتورة: ${e?.message ?? e}`);
    } finally {
      setDeletingId(null);
    }
  }

  const filtered = useMemo(() => {
    if (filter === "sales") return rows.filter((r) => docKindOf(r) === "sale");
    if (filter === "returns") return rows.filter((r) => docKindOf(r) === "return");
    return rows;
  }, [rows, filter]);

  const columns = useMemo<GridColumn<PendingInvoice>[]>(() => [
    { key: "invoiceNo", label: "رقم الفاتورة", value: (r) => r.invoiceNo },
    { key: "date", label: "التاريخ", value: (r) => r.createdAt },
    { key: "type", label: "النوع", value: (r) => typeLabel(docKindOf(r)) },
    { key: "sync", label: "حالة المزامنة", value: (r) => r.syncStatus },
  ], []);
  const grid = useGridFilter(filtered, columns);

  async function openDetail(row: PendingInvoice) {
    setDetail(null);
    setDetailPayload(null);
    setDetailErr(null);
    setDetailLoading(true);
    try {
      const full = await getOfflineInvoice(row.id);
      if (!full) {
        setDetailErr("لم يُعثر على بيانات الفاتورة");
        setDetail({
          id: row.id, localUuid: row.localUuid, invoiceNo: row.invoiceNo,
          payloadJson: "", qrBase64: row.qrBase64, signedXml: null,
          createdAt: row.createdAt, syncStatus: row.syncStatus,
        });
        return;
      }
      setDetail(full);
      try {
        setDetailPayload(JSON.parse(full.payloadJson) as OfflineInvoicePayload);
      } catch {
        setDetailErr("بيانات الفاتورة تالفة (JSON غير صالح)");
      }
    } catch (e: any) {
      setDetailErr(`فشل تحميل الفاتورة: ${e?.message ?? e}`);
      setDetail({
        id: row.id, localUuid: row.localUuid, invoiceNo: row.invoiceNo,
        payloadJson: "", qrBase64: row.qrBase64, signedXml: null,
        createdAt: row.createdAt, syncStatus: row.syncStatus,
      });
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setDetail(null);
    setDetailPayload(null);
    setDetailErr(null);
  }

  const subtitle = [cashierName ? `${text("الكاشير", "Cashier")}: ${cashierName}` : null, companyName]
    .filter(Boolean).join(" · ");

  return (
    <div dir={language === "en" ? "ltr" : "rtl"}>
    <Page
      title={text("فواتير نقطة البيع", "POS invoices")}
      subtitle={subtitle}
      right={
        <button onClick={() => void refresh()} style={btnSecondary} disabled={loading}>
          {loading ? "..." : `🔄 ${text("تحديث", "Refresh")}`}
        </button>
      }
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {FILTERS.map((f) => {
          const active = filter === f.value;
          return (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              style={{
                ...btnSecondary,
                background: active ? "#2563eb" : "#f1f5f9",
                color: active ? "#fff" : "#0f172a",
                border: active ? "1px solid #2563eb" : "1px solid #cbd5e1",
                fontWeight: active ? 600 : 400,
              }}
            >
              {f.value === "all" ? text("الكل", "All") : f.value === "sales" ? text("مبيعات", "Sales") : text("مرتجعات", "Returns")}
            </button>
          );
        })}
      </div>

      <ErrorMsg text={err} />

      {filtered.length > 0 && <GridToolbar grid={grid} placeholder={text("🔍 بحث في الفواتير…", "🔍 Search invoices…")} extra={<ExportButtons columns={gridToExportCols(columns)} rows={grid.view} filenameBase={language === "en" ? "pos-invoices" : "فواتير-نقاط-البيع"} title={text("فواتير نقاط البيع", "POS invoices")} />} />}

      <Card style={{ marginTop: 8 }}>
        {loading ? (
          <Empty text={text("جارٍ التحميل…", "Loading…")} />
        ) : filtered.length === 0 ? (
          <Empty text={text("لا توجد فواتير", "No invoices found")} />
        ) : grid.view.length === 0 ? (
          <Empty text={text("لا نتائج مطابقة للبحث", "No matching results")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <SortableTh grid={grid} colKey="invoiceNo">{text("رقم الفاتورة", "Invoice number")}</SortableTh>
                <SortableTh grid={grid} colKey="date">{text("التاريخ", "Date")}</SortableTh>
                <SortableTh grid={grid} colKey="type">{text("النوع", "Type")}</SortableTh>
                <SortableTh grid={grid} colKey="sync">{text("حالة المزامنة", "Sync status")}</SortableTh>
                <Th>{text("إجراءات", "Actions")}</Th>
              </tr>
              <GridFilterRow grid={grid} columns={columns} trailing={1} />
            </thead>
            <tbody>
              {grid.view.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => void openDetail(r)}
                  style={{ cursor: "pointer" }}
                >
                  <Td mono>{r.invoiceNo}</Td>
                  <Td>{fmtDate(r.createdAt, language)}</Td>
                  <Td>{typeLabel(docKindOf(r), language)}</Td>
                  <Td><SyncBadge status={r.syncStatus} /></Td>
                  <Td>
                    <div style={{ display: "flex", gap: 6 }}>
                      {onReuse && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onReuse(r.id); }}
                          style={{
                            ...btnSecondary, padding: "4px 12px", fontSize: 13,
                            background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe",
                          }}
                          title={text("تحميل أصناف الفاتورة في سلة جديدة", "Load invoice items into a new cart")}
                        >
                          {text("استخدام", "Reuse")}
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleDelete(r); }}
                        disabled={deletingId === r.id}
                        style={{
                          ...btnSecondary, padding: "4px 12px", fontSize: 13,
                          background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca",
                          opacity: deletingId === r.id ? 0.6 : 1,
                        }}
                        title={text("حذف السجل المحلي للفاتورة", "Delete the local invoice record")}
                      >
                        {deletingId === r.id ? "..." : text("حذف", "Delete")}
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {detail && (
        <Modal title={`${text("تفاصيل الفاتورة", "Invoice details")} — ${detail.invoiceNo}`} onCancel={closeDetail} wide>
          {detailLoading ? (
            <Empty text={text("جارٍ التحميل…", "Loading…")} />
          ) : (
            <>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px",
                background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10,
                padding: "12px 16px", marginBottom: 12, fontSize: 14,
              }}>
                <DetailRow k={text("رقم الفاتورة", "Invoice number")} v={detail.invoiceNo} mono />
                <DetailRow k={text("النوع", "Type")} v={typeLabel(((detailPayload as any)?.kind === "return" || detail.invoiceNo.startsWith("RET")) ? "return" : "sale", language)} />
                <DetailRow k={text("التاريخ", "Date")} v={fmtDate(detailPayload?.timestamp || detail.createdAt, language)} />
                <DetailRow k={text("حالة المزامنة", "Sync status")} node={<SyncBadge status={detail.syncStatus} />} />
                <DetailRow k={text("العميل", "Customer")} v={detailPayload?.customerName || "—"} />
                <DetailRow k={text("الرقم الضريبي", "Tax number")} v={detailPayload?.vatNumber || "—"} />
                <DetailRow k={text("طريقة الدفع", "Payment method")} v={paymentMethodLabel(detailPayload?.paymentMethod, language)} />
              </div>

              <ErrorMsg text={detailErr} />

              {detailPayload && (
                <>
                  <Table>
                    <thead>
                      <tr>
                        <Th>{text("الصنف", "Item")}</Th>
                        <Th>{text("الكمية", "Quantity")}</Th>
                        <Th>{text("السعر", "Price")}</Th>
                        <Th>{text("الضريبة", "Tax")}</Th>
                        <Th>{text("الإجمالي", "Total")}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailPayload.lines.map((l, i) => (
                        <tr key={i}>
                          <Td>{l.nameAr}</Td>
                          <Td num>{fmt(l.qty)}</Td>
                          <Td num>{fmt(l.unitPrice)} {sym}</Td>
                          <Td num>{fmt(l.vatRate)}%</Td>
                          <Td num>{fmt(l.qty * l.unitPrice)} {sym}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>

                  <div style={{
                    marginTop: 12, marginInlineStart: "auto", maxWidth: 360,
                    background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10,
                    padding: "12px 16px",
                  }}>
                    <TotalRow k={text("الإجمالي قبل الضريبة", "Subtotal")} v={`${fmt(detailPayload.subtotal)} ${sym}`} />
                    <TotalRow k={text("ضريبة القيمة المضافة", "VAT")} v={`${fmt(detailPayload.vat)} ${sym}`} />
                    <TotalRow k={text("الإجمالي النهائي", "Grand total")} v={`${fmt(detailPayload.grandTotal)} ${sym}`} big />
                  </div>
                </>
              )}

              <div style={{
                marginTop: 12, fontSize: 13,
                color: detail.qrBase64 ? "#166534" : "#94a3b8",
              }}>
                {detail.qrBase64 ? `✅ ${text("يوجد رمز QR ضريبي", "Tax QR code available")}` : text("لا يوجد رمز QR ضريبي", "No tax QR code")}
              </div>
            </>
          )}
        </Modal>
      )}
    </Page>
    </div>
  );
}

function DetailRow({ k, v, node, mono }: { k: string; v?: string; node?: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "#64748b" }}>{k}</span>
      <span style={{ fontWeight: 600, fontFamily: mono ? "ui-monospace, monospace" : undefined }}>
        {node ?? v}
      </span>
    </div>
  );
}

function TotalRow({ k, v, big }: { k: string; v: string; big?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "6px 0",
      borderTop: big ? "2px solid #2563eb" : undefined,
      marginTop: big ? 4 : 0,
      fontSize: big ? 17 : 14,
      fontWeight: big ? 800 : 400,
      color: big ? "#1e3a8a" : "#475569",
    }}>
      <span>{k}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>
    </div>
  );
}
