// أرقام المسلسلات — document-numbering-series admin (standalone, admin-only).
//
// Lets the operator set the prefix, the next number, and the zero-padding
// width per document type. The chosen series is consumed atomically by the
// Rust create commands (next_doc_no) so edits here apply to the very NEXT
// issued document of that type. A live preview shows exactly what the next
// number will look like.

import { useEffect, useMemo, useState } from "react";
import {
  listNumberSeries, updateNumberSeries,
  type NumberSeries, type NumberSeriesDocType,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, ErrorMsg, Empty,
  input, btnPrimary,
} from "./_adminUi";

const DOC_LABELS: Record<NumberSeriesDocType, string> = {
  journal_entry: "القيود اليومية",
  purchase: "فواتير الشراء",
  purchase_return: "مرتجع الشراء",
  sales_invoice: "فواتير المبيعات",
  sales_return: "مرتجع المبيعات",
  quotation: "عروض الأسعار",
  sales_order: "أوامر البيع",
};

const PAD_MIN = 1;
const PAD_MAX = 12;
const PREFIX_MAX = 16;

/** Build the preview label exactly the way Rust's next_doc_no formats it. */
function preview(prefix: string, next: number, padding: number): string {
  const width = padding < 1 ? 1 : padding;
  return `${prefix}${String(Math.max(1, next)).padStart(width, "0")}`;
}

type RowState = NumberSeries & { saving?: boolean; saved?: boolean; error?: string | null };

export default function NumberSeriesAdmin() {
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await listNumberSeries();
      setRows(list.map((r) => ({ ...r })));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function patch(docType: NumberSeriesDocType, p: Partial<RowState>) {
    setRows((prev) => prev.map((r) =>
      r.docType === docType ? { ...r, ...p, saved: false, error: null } : r));
  }

  function validate(r: RowState): string | null {
    if (!Number.isInteger(r.nextNumber) || r.nextNumber < 1) return "الرقم التالي يجب أن يكون 1 أو أكبر";
    if (!Number.isInteger(r.padding) || r.padding < PAD_MIN || r.padding > PAD_MAX) return `عدد الخانات يجب أن يكون بين ${PAD_MIN} و ${PAD_MAX}`;
    if (r.prefix.length > PREFIX_MAX) return `البادئة طويلة جداً (${PREFIX_MAX} حرفاً كحد أقصى)`;
    return null;
  }

  async function save(docType: NumberSeriesDocType) {
    const r = rows.find((x) => x.docType === docType);
    if (!r) return;
    const err = validate(r);
    if (err) { patch(docType, { error: err }); return; }
    patch(docType, { saving: true });
    try {
      await updateNumberSeries({ docType: r.docType, prefix: r.prefix, nextNumber: r.nextNumber, padding: r.padding });
      setRows((prev) => prev.map((x) =>
        x.docType === docType ? { ...x, saving: false, saved: true, error: null } : x));
    } catch (e) {
      patch(docType, { saving: false });
      setRows((prev) => prev.map((x) =>
        x.docType === docType ? { ...x, error: e instanceof Error ? e.message : String(e) } : x));
    }
  }

  const subtitle = useMemo(
    () => "تحكّم كامل في ترقيم المستندات — البادئة والرقم التالي وعدد الخانات. التغيير يُطبّق على المستند التالي مباشرةً.",
    [],
  );

  return (
    <Page title="أرقام المسلسلات" subtitle={subtitle}>
      {loadError && <ErrorMsg text={loadError} />}
      <Card>
        {loading ? (
          <Empty text="جارٍ التحميل..." />
        ) : rows.length === 0 ? (
          <Empty text="لا توجد سلاسل ترقيم." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>نوع المستند</Th>
                <Th style={{ width: 180 }}>البادئة</Th>
                <Th style={{ width: 150 }}>الرقم التالي</Th>
                <Th style={{ width: 130 }}>عدد الخانات</Th>
                <Th style={{ width: 200 }}>معاينة</Th>
                <Th style={{ width: 120 }}></Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.docType}>
                  <Td>{DOC_LABELS[r.docType] ?? r.docType}</Td>
                  <Td>
                    <input
                      value={r.prefix}
                      maxLength={PREFIX_MAX}
                      onChange={(e) => patch(r.docType, { prefix: e.target.value })}
                      style={input}
                      placeholder="مثال: INV-"
                    />
                  </Td>
                  <Td>
                    <input
                      type="number"
                      min={1}
                      value={r.nextNumber}
                      onChange={(e) => patch(r.docType, { nextNumber: Math.floor(Number(e.target.value) || 0) })}
                      style={input}
                    />
                  </Td>
                  <Td>
                    <input
                      type="number"
                      min={PAD_MIN}
                      max={PAD_MAX}
                      value={r.padding}
                      onChange={(e) => patch(r.docType, { padding: Math.floor(Number(e.target.value) || 0) })}
                      style={input}
                    />
                  </Td>
                  <Td mono>
                    <span style={{ fontWeight: 600, color: "#0f172a" }}>
                      {preview(r.prefix, r.nextNumber, r.padding)}
                    </span>
                  </Td>
                  <Td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => void save(r.docType)}
                        disabled={r.saving}
                        style={{ ...btnPrimary, padding: "6px 14px", fontSize: 13, opacity: r.saving ? 0.6 : 1 }}
                      >
                        {r.saving ? "..." : "حفظ"}
                      </button>
                      {r.saved && <span style={{ color: "#16a34a", fontSize: 13 }}>✓</span>}
                    </div>
                    {r.error && (
                      <div style={{ color: "#991b1b", fontSize: 12, marginTop: 4 }}>{r.error}</div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <div style={{ marginTop: 12, fontSize: 12, color: "#64748b", lineHeight: 1.8 }}>
        ⚠️ تنبيه: ضبط «الرقم التالي» على قيمة سبق استخدامها قد يسبّب تعارضاً عند حفظ مستند جديد
        (أرقام الفواتير فريدة). اجعل الرقم التالي أكبر من آخر رقم مستخدم.
      </div>
    </Page>
  );
}
