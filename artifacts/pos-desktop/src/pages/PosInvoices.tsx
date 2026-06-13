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
  type PendingInvoice,
  type OfflineInvoicePayload,
  type FullInvoice,
} from "../lib/invoices";
import {
  Page, Card, Table, Th, Td, Modal, ErrorMsg, Empty,
  input, btnSecondary, fmt,
} from "./_adminUi";
import { currencySymbol } from "../lib/currency";

type FilterKind = "all" | "sales" | "returns";

const FILTERS: { value: FilterKind; label: string }[] = [
  { value: "all", label: "الكل" },
  { value: "sales", label: "مبيعات" },
  { value: "returns", label: "مرتجعات" },
];

function invoiceTypeLabel(invoiceNo: string): string {
  return invoiceNo.startsWith("RET") ? "مرتجع" : "بيع";
}

function paymentMethodLabel(m: string | undefined): string {
  if (m === "cash") return "نقداً";
  if (m === "card") return "بطاقة";
  return m ?? "—";
}

// sync_status → coloured badge. pending/queued are amber (not yet uploaded),
// synced/submitted are green (accepted by ZATCA / cloud), error is red.
function SyncBadge({ status }: { status: string }) {
  const s = (status || "").toLowerCase();
  let bg = "#fffbeb", color = "#92400e", border = "#fde68a", text = status || "—";
  if (s === "pending" || s === "queued") {
    bg = "#fffbeb"; color = "#92400e"; border = "#fde68a";
    text = s === "queued" ? "قيد المزامنة" : "غير مرفوعة";
  } else if (s === "synced" || s === "submitted") {
    bg = "#f0fdf4"; color = "#166534"; border = "#bbf7d0"; text = "مرفوعة";
  } else if (s === "error" || s === "failed") {
    bg = "#fef2f2"; color = "#991b1b"; border = "#fecaca"; text = "خطأ";
  }
  return (
    <span style={{
      display: "inline-block", padding: "2px 10px", borderRadius: 999,
      fontSize: 12, background: bg, color, border: `1px solid ${border}`,
    }}>{text}</span>
  );
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  // Local SQLite timestamps are stored without a timezone suffix; treat them
  // as UTC so they render in the cashier's local time consistently.
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("ar-SA");
}

export default function PosInvoices({ companyName, cashierName }: { companyName?: string; cashierName?: string }) {
  const sym = currencySymbol();
  const [rows, setRows] = useState<PendingInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKind>("all");

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

  const filtered = useMemo(() => {
    if (filter === "sales") return rows.filter((r) => r.invoiceNo.startsWith("OFF"));
    if (filter === "returns") return rows.filter((r) => r.invoiceNo.startsWith("RET"));
    return rows;
  }, [rows, filter]);

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

  const subtitle = [cashierName ? `الكاشير: ${cashierName}` : null, companyName]
    .filter(Boolean).join(" · ");

  return (
    <Page
      title="فواتير نقطة البيع"
      subtitle={subtitle}
      right={
        <button onClick={() => void refresh()} style={btnSecondary} disabled={loading}>
          {loading ? "..." : "🔄 تحديث"}
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
              {f.label}
            </button>
          );
        })}
      </div>

      <ErrorMsg text={err} />

      <Card style={{ marginTop: 8 }}>
        {loading ? (
          <Empty text="جارٍ التحميل…" />
        ) : filtered.length === 0 ? (
          <Empty text="لا توجد فواتير" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>رقم الفاتورة</Th>
                <Th>التاريخ</Th>
                <Th>النوع</Th>
                <Th>حالة المزامنة</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => void openDetail(r)}
                  style={{ cursor: "pointer" }}
                >
                  <Td mono>{r.invoiceNo}</Td>
                  <Td>{fmtDate(r.createdAt)}</Td>
                  <Td>{invoiceTypeLabel(r.invoiceNo)}</Td>
                  <Td><SyncBadge status={r.syncStatus} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {detail && (
        <Modal title={`تفاصيل الفاتورة — ${detail.invoiceNo}`} onCancel={closeDetail} wide>
          {detailLoading ? (
            <Empty text="جارٍ التحميل…" />
          ) : (
            <>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px",
                background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10,
                padding: "12px 16px", marginBottom: 12, fontSize: 14,
              }}>
                <DetailRow k="رقم الفاتورة" v={detail.invoiceNo} mono />
                <DetailRow k="النوع" v={invoiceTypeLabel(detail.invoiceNo)} />
                <DetailRow k="التاريخ" v={fmtDate(detailPayload?.timestamp || detail.createdAt)} />
                <DetailRow k="حالة المزامنة" node={<SyncBadge status={detail.syncStatus} />} />
                <DetailRow k="العميل" v={detailPayload?.customerName || "—"} />
                <DetailRow k="الرقم الضريبي" v={detailPayload?.vatNumber || "—"} />
                <DetailRow k="طريقة الدفع" v={paymentMethodLabel(detailPayload?.paymentMethod)} />
              </div>

              <ErrorMsg text={detailErr} />

              {detailPayload && (
                <>
                  <Table>
                    <thead>
                      <tr>
                        <Th>الصنف</Th>
                        <Th>الكمية</Th>
                        <Th>السعر</Th>
                        <Th>الضريبة</Th>
                        <Th>الإجمالي</Th>
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
                    <TotalRow k="الإجمالي قبل الضريبة" v={`${fmt(detailPayload.subtotal)} ${sym}`} />
                    <TotalRow k="ضريبة القيمة المضافة" v={`${fmt(detailPayload.vat)} ${sym}`} />
                    <TotalRow k="الإجمالي النهائي" v={`${fmt(detailPayload.grandTotal)} ${sym}`} big />
                  </div>
                </>
              )}

              <div style={{
                marginTop: 12, fontSize: 13,
                color: detail.qrBase64 ? "#166534" : "#94a3b8",
              }}>
                {detail.qrBase64 ? "✅ يوجد رمز QR ضريبي" : "لا يوجد رمز QR ضريبي"}
              </div>
            </>
          )}
        </Modal>
      )}
    </Page>
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
