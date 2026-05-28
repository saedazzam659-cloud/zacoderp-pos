// Customers admin — list + add + edit + delete (inline editing in grid).
// Read/write via lib/customers.ts; cloud sync is best-effort via pushQueue.

import { useEffect, useState } from "react";
import {
  listCustomers, createCustomer, updateCustomer, deleteCustomer,
  type LocalCustomer, type CreateCustomerInput,
} from "../lib/customers";
import { listCurrencies, type Currency } from "../lib/accounting";

const emptyInput: CreateCustomerInput = {
  nameAr: "", nameEn: "", phone: "", vatNumber: "",
  currencyCode: "SAR", openingBalance: 0, openingNature: "debit",
};

// Customer balance follows AR convention: positive = owes us (مدين).
function balanceNature(bal: number): { label: string; color: string } {
  if (Math.abs(bal) < 0.001) return { label: "—", color: "#94a3b8" };
  return bal > 0 ? { label: "مدين", color: "#16a34a" } : { label: "دائن", color: "#dc2626" };
}
function fmtAmount(n: number): string {
  return n.toLocaleString("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type EditState =
  | { mode: "new"; data: CreateCustomerInput }
  | { mode: "edit"; id: number; data: CreateCustomerInput }
  | null;

export default function CustomersAdmin() {
  const [rows, setRows] = useState<LocalCustomer[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [cs, cur] = await Promise.all([listCustomers(search || undefined), listCurrencies(true)]);
      setRows(cs); setCurrencies(cur);
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [search]);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...emptyInput } }); }
  function startEdit(c: LocalCustomer) {
    setErr(null);
    setEdit({ mode: "edit", id: c.id, data: {
      nameAr: c.nameAr, nameEn: c.nameEn ?? "", phone: c.phone ?? "", vatNumber: c.vatNumber ?? "",
      currencyCode: c.currencyCode ?? "SAR",
    } });
  }
  function cancel() { setEdit(null); setErr(null); }
  function setField<K extends keyof CreateCustomerInput>(k: K, v: CreateCustomerInput[K]) {
    if (!edit) return; setEdit({ ...edit, data: { ...edit.data, [k]: v } });
  }

  async function save() {
    if (!edit) return;
    const f = edit.data;
    if (!f.nameAr.trim()) { setErr("الاسم بالعربية مطلوب"); return; }
    if (f.vatNumber && !/^3\d{13}3$/.test(f.vatNumber)) {
      setErr("الرقم الضريبي يجب أن يكون 15 رقم يبدأ وينتهي بـ3"); return;
    }
    setBusy(true); setErr(null);
    try {
      if (edit.mode === "new") {
        await createCustomer({ ...f, openingDate: new Date().toISOString().slice(0, 10) });
        setToast({ kind: "ok", text: "تم إضافة العميل" });
      } else {
        // currencyCode persists via LS overlay; opening balance is create-only.
        await updateCustomer(edit.id, {
          nameAr: f.nameAr, nameEn: f.nameEn, phone: f.phone, vatNumber: f.vatNumber,
          currencyCode: f.currencyCode,
        });
        setToast({ kind: "ok", text: "تم تحديث العميل" });
      }
      setEdit(null); await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }

  const currencyOpts = currencies.length > 0 ? currencies.map(c => c.code) : ["SAR"];

  async function handleDelete(c: LocalCustomer) {
    if (!confirm(`حذف العميل «${c.nameAr}»؟`)) return;
    try { await deleteCustomer(c.id); setToast({ kind: "ok", text: "تم الحذف" }); await refresh(); }
    catch (e: any) { setToast({ kind: "err", text: e?.message ?? "فشل الحذف" }); }
  }

  return (
    <div dir="rtl" style={S.wrap}>
      <div style={S.headerRow}>
        <div>
          <h2 style={S.h2}>العملاء ({rows.length})</h2>
          <div style={S.sub}>إدارة قائمة العملاء — يُزامن تلقائيًا مع السحابة عند الاتصال</div>
        </div>
        <button onClick={startNew} disabled={!!edit}
          style={{ ...S.btnPrimary, opacity: edit ? 0.5 : 1, cursor: edit ? "not-allowed" : "pointer" }}>
          + عميل جديد
        </button>
      </div>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="بحث بالاسم أو الهاتف أو الرقم الضريبي..."
        style={S.search}
      />

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      {loading ? <div style={S.empty}>... جاري التحميل</div>
      : rows.length === 0 && !edit ? <div style={S.empty}>لا يوجد عملاء بعد — أضف أول عميل</div>
      : (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>الاسم</th>
            <th style={S.th}>الهاتف</th>
            <th style={S.th}>الرقم الضريبي</th>
            <th style={S.th}>العملة</th>
            <th style={S.th}>الرصيد</th>
            <th style={S.th}>النوع</th>
            <th style={S.th}>المصدر</th>
            <th style={S.thRight}>إجراء</th>
          </tr></thead>
          <tbody>
            {edit?.mode === "new" && (
              <EditRow data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} isNew currencyOpts={currencyOpts} />
            )}
            {rows.map((c) => (
              edit?.mode === "edit" && edit.id === c.id ? (
                <EditRow key={c.id} data={edit.data} setField={setField} onSave={save} onCancel={cancel} busy={busy} err={err} cloudId={c.cloudId} currencyOpts={currencyOpts} />
              ) : (
                <tr key={c.id} style={{ ...S.tr, opacity: edit ? 0.6 : 1 }}>
                  <td style={S.td}>
                    <div style={{ fontWeight: 600 }}>{c.nameAr}</div>
                    {c.nameEn && <div style={S.muted}>{c.nameEn}</div>}
                  </td>
                  <td style={S.td}>{c.phone ?? "—"}</td>
                  <td style={S.tdMono}>{c.vatNumber ?? "—"}</td>
                  <td style={S.td}><span style={S.badgeCur}>{c.currencyCode ?? "SAR"}</span></td>
                  <td style={{ ...S.tdMono, color: balanceNature(c.balance ?? 0).color, fontWeight: 600 }}>{fmtAmount(Math.abs(c.balance ?? 0))}</td>
                  <td style={{ ...S.td, color: balanceNature(c.balance ?? 0).color, fontWeight: 600 }}>{balanceNature(c.balance ?? 0).label}</td>
                  <td style={S.td}>
                    <span style={c.cloudId ? S.badgeCloud : S.badgeLocal}>
                      {c.cloudId ? `☁️ سحابة #${c.cloudId}` : "📱 محلي"}
                    </span>
                  </td>
                  <td style={S.tdRight}>
                    <button onClick={() => startEdit(c)} disabled={!!edit} style={S.btnEdit}>تعديل</button>
                    <button onClick={() => handleDelete(c)} disabled={!!edit} style={S.btnDel}>حذف</button>
                  </td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EditRow({ data, setField, onSave, onCancel, busy, err, isNew, cloudId, currencyOpts }: {
  data: CreateCustomerInput;
  setField: <K extends keyof CreateCustomerInput>(k: K, v: CreateCustomerInput[K]) => void;
  onSave: () => void; onCancel: () => void;
  busy: boolean; err: string | null; isNew?: boolean; cloudId?: number | null;
  currencyOpts: string[];
}) {
  const ci: React.CSSProperties = { ...S.input, padding: "6px 8px", fontSize: 13, marginBottom: 0 };
  return (
    <>
      <tr style={{ ...S.tr, background: isNew ? "#f0fdf4" : "#eff6ff" }}>
        <td style={S.td}>
          <input autoFocus value={data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={ci} placeholder="الاسم بالعربية *" />
          <input value={data.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value)} style={{ ...ci, marginTop: 4 }} placeholder="الاسم بالإنجليزية" />
        </td>
        <td style={S.td}><input value={data.phone ?? ""} onChange={(e) => setField("phone", e.target.value)} style={ci} placeholder="05xxxxxxxx" /></td>
        <td style={S.td}><input value={data.vatNumber ?? ""} onChange={(e) => setField("vatNumber", e.target.value)} style={{ ...ci, fontFamily: "ui-monospace, monospace" }} placeholder="3xxxxxxxxxxxxx3" /></td>
        <td style={S.td}>
          <select value={data.currencyCode ?? "SAR"} onChange={(e) => setField("currencyCode", e.target.value)} style={ci}>
            {currencyOpts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </td>
        <td style={S.td} colSpan={2}>
          {isNew ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="number" step="0.01" min="0"
                value={data.openingBalance ?? 0}
                onChange={(e) => setField("openingBalance", Number(e.target.value) || 0)}
                style={{ ...ci, width: 90 }} placeholder="0.00"
              />
              <select
                value={data.openingNature ?? "debit"}
                onChange={(e) => setField("openingNature", e.target.value as "debit" | "credit")}
                style={{ ...ci, width: 110 }}
              >
                <option value="debit">مدين (لنا عليه)</option>
                <option value="credit">دائن (له علينا)</option>
              </select>
            </div>
          ) : (
            <span style={S.muted}>الرصيد الافتتاحي عند الإضافة فقط</span>
          )}
        </td>
        <td style={S.td}>
          <span style={cloudId ? S.badgeCloud : S.badgeLocal}>
            {cloudId ? `☁️ سحابة #${cloudId}` : "📱 محلي"}
          </span>
        </td>
        <td style={S.tdRight}>
          <button onClick={onSave} disabled={busy} style={S.btnSaveSm}>{busy ? "..." : "حفظ"}</button>
          <button onClick={onCancel} disabled={busy} style={S.btnCancelSm}>إلغاء</button>
        </td>
      </tr>
      {err && (
        <tr><td colSpan={8} style={{ ...S.td, background: "#fef2f2", color: "#991b1b" }}>⚠️ {err}</td></tr>
      )}
    </>
  );
}

const S = {
  wrap: { maxWidth: 1000, margin: "0 auto", width: "100%" } as const,
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 } as const,
  h2: { margin: 0, fontSize: 22, color: "#0f172a" } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  search: { width: "100%", padding: "10px 14px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 8, marginBottom: 16, fontFamily: "inherit" } as const,
  empty: { padding: 40, textAlign: "center" as const, color: "#94a3b8", background: "#fff", border: "1px dashed #e2e8f0", borderRadius: 8 } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" } as const,
  th: { textAlign: "right" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  thRight: { textAlign: "left" as const, padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  tr: { borderBottom: "1px solid #f1f5f9" } as const,
  td: { padding: "10px 14px", fontSize: 14, color: "#0f172a" } as const,
  tdMono: { padding: "10px 14px", fontSize: 13, color: "#0f172a", fontFamily: "ui-monospace, monospace" } as const,
  tdRight: { padding: "10px 14px", textAlign: "left" as const } as const,
  muted: { fontSize: 12, color: "#94a3b8", marginTop: 2 } as const,
  badgeCloud: { display: "inline-block", padding: "2px 8px", background: "#eff6ff", color: "#1d4ed8", border: "1px solid #dbeafe", borderRadius: 999, fontSize: 11 } as const,
  badgeLocal: { display: "inline-block", padding: "2px 8px", background: "#fefce8", color: "#854d0e", border: "1px solid #fef9c3", borderRadius: 999, fontSize: 11 } as const,
  badgeCur: { display: "inline-block", padding: "2px 8px", background: "#eff6ff", color: "#1e40af", borderRadius: 4, fontSize: 12, fontWeight: 600 } as const,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnEdit: { padding: "6px 12px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", fontSize: 12, marginInlineEnd: 6 } as const,
  btnDel: { padding: "6px 12px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontSize: 12 } as const,
  btnSaveSm: { padding: "5px 12px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, marginInlineEnd: 6 } as const,
  btnCancelSm: { padding: "5px 12px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontSize: 12 } as const,
  ok: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  input: { width: "100%", padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 6, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
};
