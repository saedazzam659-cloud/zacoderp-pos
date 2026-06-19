// Customers admin — list + add + edit + delete via a large stacked form panel.
// Read/write via lib/customers.ts; cloud sync is best-effort via pushQueue.

import { useEffect, useState } from "react";
import {
  listCustomers, createCustomer, updateCustomer, deleteCustomer,
  type LocalCustomer, type CreateCustomerInput,
} from "../lib/customers";
import { listCurrencies, listAccounts, type Currency, type Account } from "../lib/accounting";
import { listBranches, type Branch } from "../lib/branches";
import { SearchCombobox } from "./_adminUi";

const emptyInput: CreateCustomerInput = {
  nameAr: "", nameEn: "", phone: "", vatNumber: "",
  currencyCode: "SAR", openingBalance: 0, openingNature: "debit",
  creditLimit: 0, enforceCreditLimit: false, paymentTermsDays: 0,
  crNumber: "", email: "",
  city: "", district: "", street: "", buildingNumber: "", postalCode: "",
  country: "SA", nationalAddressShort: "",
  locationLat: "", locationLng: "", locationLink: "",
  includeInStatements: true, branchId: null, accountId: null,
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
  const [branches, setBranches] = useState<Branch[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<EditState>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [cs, cur, br, accs] = await Promise.all([
        listCustomers(search || undefined), listCurrencies(true), listBranches().catch(() => []),
        listAccounts().catch(() => []),
      ]);
      setRows(cs); setCurrencies(cur); setBranches(br); setAccounts(accs);
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [search]);

  function startNew() { setErr(null); setEdit({ mode: "new", data: { ...emptyInput } }); }
  function startEdit(c: LocalCustomer) {
    setErr(null);
    setEdit({ mode: "edit", id: c.id, data: {
      nameAr: c.nameAr, nameEn: c.nameEn ?? "", phone: c.phone ?? "", vatNumber: c.vatNumber ?? "",
      currencyCode: c.currencyCode ?? "SAR",
      creditLimit: c.creditLimit ?? 0,
      enforceCreditLimit: c.enforceCreditLimit ?? false,
      paymentTermsDays: c.paymentTermsDays ?? 0,
      crNumber: c.crNumber ?? "", email: c.email ?? "",
      city: c.city ?? "", district: c.district ?? "", street: c.street ?? "",
      buildingNumber: c.buildingNumber ?? "", postalCode: c.postalCode ?? "",
      country: c.country ?? "SA", nationalAddressShort: c.nationalAddressShort ?? "",
      locationLat: c.locationLat ?? "", locationLng: c.locationLng ?? "", locationLink: c.locationLink ?? "",
      includeInStatements: c.includeInStatements ?? true,
      branchId: c.branchId ?? null,
      accountId: c.accountId ?? null,
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
        await updateCustomer(edit.id, {
          nameAr: f.nameAr, nameEn: f.nameEn, phone: f.phone, vatNumber: f.vatNumber,
          currencyCode: f.currencyCode,
          creditLimit: f.creditLimit,
          enforceCreditLimit: f.enforceCreditLimit,
          paymentTermsDays: f.paymentTermsDays,
          crNumber: f.crNumber, email: f.email,
          city: f.city, district: f.district, street: f.street,
          buildingNumber: f.buildingNumber, postalCode: f.postalCode,
          country: f.country, nationalAddressShort: f.nationalAddressShort,
          locationLat: f.locationLat, locationLng: f.locationLng, locationLink: f.locationLink,
          includeInStatements: f.includeInStatements,
          branchId: f.branchId,
          accountId: f.accountId,
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

      {edit && (
        <CustomerForm
          mode={edit.mode}
          data={edit.data}
          setField={setField}
          onSave={save}
          onCancel={cancel}
          busy={busy}
          err={err}
          currencyOpts={currencyOpts}
          branches={branches}
          accounts={accounts}
        />
      )}

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="بحث بالاسم أو الهاتف أو الرقم الضريبي..."
        style={S.search}
      />

      {toast && <div style={toast.kind === "ok" ? S.ok : S.err}>{toast.text}</div>}

      {loading ? <div style={S.empty}>... جاري التحميل</div>
      : rows.length === 0 ? <div style={S.empty}>لا يوجد عملاء بعد — أضف أول عميل</div>
      : (
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>الاسم</th>
            <th style={S.th}>الهاتف</th>
            <th style={S.th}>الرقم الضريبي</th>
            <th style={S.th}>العملة</th>
            <th style={S.th}>الرصيد</th>
            <th style={S.th}>النوع</th>
            <th style={S.th}>حد الائتمان</th>
            <th style={S.th}>المصدر</th>
            <th style={S.thRight}>إجراء</th>
          </tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} style={{ ...S.tr, opacity: edit ? 0.5 : 1 }}>
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
                  {(c.creditLimit ?? 0) > 0
                    ? <span style={c.enforceCreditLimit ? S.badgeLimitOn : S.badgeLimitOff}>{fmtAmount(c.creditLimit ?? 0)}</span>
                    : <span style={S.muted}>—</span>}
                </td>
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
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CustomerForm({ mode, data, setField, onSave, onCancel, busy, err, currencyOpts, branches, accounts }: {
  mode: "new" | "edit";
  data: CreateCustomerInput;
  setField: <K extends keyof CreateCustomerInput>(k: K, v: CreateCustomerInput[K]) => void;
  onSave: () => void; onCancel: () => void;
  busy: boolean; err: string | null;
  currencyOpts: string[];
  branches: Branch[];
  accounts: Account[];
}) {
  const [tab, setTab] = useState<"basic" | "address" | "credit" | "accounting">("basic");
  // Only postable (leaf) accounts can be assigned — mirrors the JE account picker.
  const leafAccounts = accounts.filter((a) => a.isLeaf);
  const handleSave = () => {
    if (!data.nameAr.trim()) setTab("basic");
    onSave();
  };
  return (
    <div style={S.formCard}>
      <div style={S.formTitle}>{mode === "new" ? "عميل جديد" : "تعديل بيانات العميل"}</div>

      <div style={S.tabBar}>
        <button type="button" onClick={() => setTab("basic")} style={tab === "basic" ? S.tabActive : S.tab}>المعلومات الأساسية</button>
        <button type="button" onClick={() => setTab("address")} style={tab === "address" ? S.tabActive : S.tab}>العنوان الوطني</button>
        <button type="button" onClick={() => setTab("credit")} style={tab === "credit" ? S.tabActive : S.tab}>الائتمان والاستحقاق</button>
        <button type="button" onClick={() => setTab("accounting")} style={tab === "accounting" ? S.tabActive : S.tab}>إعدادات المحاسبة</button>
      </div>

      {tab === "basic" && (
      <div style={S.grid}>
        <Field label="الاسم بالعربية *">
          <input autoFocus value={data.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={S.bigInput} placeholder="اسم العميل" />
        </Field>
        <Field label="الاسم بالإنجليزية">
          <input value={data.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value)} style={S.bigInput} placeholder="Customer name" />
        </Field>
        <Field label="رقم الهاتف">
          <input value={data.phone ?? ""} onChange={(e) => setField("phone", e.target.value)} style={S.bigInput} placeholder="05xxxxxxxx" />
        </Field>
        <Field label="الرقم الضريبي">
          <input value={data.vatNumber ?? ""} onChange={(e) => setField("vatNumber", e.target.value)} style={{ ...S.bigInput, fontFamily: "ui-monospace, monospace" }} placeholder="3xxxxxxxxxxxxx3" />
        </Field>
        <Field label="السجل التجاري">
          <input value={data.crNumber ?? ""} onChange={(e) => setField("crNumber", e.target.value)} style={{ ...S.bigInput, fontFamily: "ui-monospace, monospace" }} placeholder="10xxxxxxxx" />
        </Field>
        <Field label="البريد الإلكتروني">
          <input type="email" value={data.email ?? ""} onChange={(e) => setField("email", e.target.value)} style={S.bigInput} placeholder="name@example.com" />
        </Field>
        <Field label="العملة">
          <select value={data.currencyCode ?? "SAR"} onChange={(e) => setField("currencyCode", e.target.value)} style={S.bigInput}>
            {currencyOpts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="الفرع الافتراضي">
          <select value={data.branchId ?? ""} onChange={(e) => setField("branchId", e.target.value ? Number(e.target.value) : null)} style={S.bigInput}>
            <option value="">— بدون —</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
          </select>
        </Field>
        <Field label="إدراج في كشوف الحساب والأعمار">
          <label style={S.checkRow}>
            <input type="checkbox" checked={data.includeInStatements ?? true}
              onChange={(e) => setField("includeInStatements", e.target.checked)}
              style={S.checkbox} />
            <span>عند الإلغاء يُستبعد العميل من كشف الحساب وتقارير أعمار الديون</span>
          </label>
        </Field>
      </div>
      )}

      {tab === "address" && (
      <>
      <div style={S.grid}>
        <Field label="المدينة">
          <input value={data.city ?? ""} onChange={(e) => setField("city", e.target.value)} style={S.bigInput} placeholder="الرياض" />
        </Field>
        <Field label="الحي">
          <input value={data.district ?? ""} onChange={(e) => setField("district", e.target.value)} style={S.bigInput} placeholder="حي ..." />
        </Field>
        <Field label="الشارع">
          <input value={data.street ?? ""} onChange={(e) => setField("street", e.target.value)} style={S.bigInput} placeholder="شارع ..." />
        </Field>
        <Field label="رقم المبنى">
          <input value={data.buildingNumber ?? ""} onChange={(e) => setField("buildingNumber", e.target.value)} style={S.bigInput} placeholder="0000" />
        </Field>
        <Field label="الرمز البريدي">
          <input value={data.postalCode ?? ""} onChange={(e) => setField("postalCode", e.target.value)} style={S.bigInput} placeholder="00000" />
        </Field>
        <Field label="الدولة">
          <input value={data.country ?? "SA"} onChange={(e) => setField("country", e.target.value)} style={S.bigInput} placeholder="SA" />
        </Field>
        <Field label="العنوان الوطني المختصر">
          <input value={data.nationalAddressShort ?? ""} onChange={(e) => setField("nationalAddressShort", e.target.value)} style={{ ...S.bigInput, fontFamily: "ui-monospace, monospace" }} placeholder="RRRD0000" />
        </Field>
      </div>

      <div style={S.section}>الموقع الجغرافي (اختياري)</div>
      <div style={S.grid}>
        <Field label="خط العرض (Latitude)">
          <input value={data.locationLat ?? ""} onChange={(e) => setField("locationLat", e.target.value)} style={{ ...S.bigInput, fontFamily: "ui-monospace, monospace" }} placeholder="24.7136" />
        </Field>
        <Field label="خط الطول (Longitude)">
          <input value={data.locationLng ?? ""} onChange={(e) => setField("locationLng", e.target.value)} style={{ ...S.bigInput, fontFamily: "ui-monospace, monospace" }} placeholder="46.6753" />
        </Field>
        <Field label="رابط الموقع (خرائط جوجل)">
          <input value={data.locationLink ?? ""} onChange={(e) => setField("locationLink", e.target.value)} style={S.bigInput} placeholder="https://maps.google.com/..." />
        </Field>
      </div>
      </>
      )}

      {tab === "credit" && (
      <>
      <div style={S.grid}>
        <Field label="حد الائتمان (الحد الأقصى للمديونية)">
          <input type="number" step="0.01" min="0" value={data.creditLimit ?? 0}
            onChange={(e) => setField("creditLimit", Number(e.target.value) || 0)}
            style={S.bigInput} placeholder="0.00" />
        </Field>
        <Field label="مدة الاستحقاق (بالأيام)">
          <input type="number" step="1" min="0" value={data.paymentTermsDays ?? 0}
            onChange={(e) => setField("paymentTermsDays", Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            style={S.bigInput} placeholder="0" />
        </Field>
        <Field label="منع البيع عند تجاوز الحد / التأخر">
          <label style={S.checkRow}>
            <input type="checkbox" checked={!!data.enforceCreditLimit}
              onChange={(e) => setField("enforceCreditLimit", e.target.checked)}
              style={S.checkbox} />
            <span>تفعيل المنع — لن يُسمح بفاتورة بيع آجلة تتجاوز الحد أو لعميل متأخر السداد</span>
          </label>
        </Field>
      </div>

      {mode === "new" && (
        <>
          <div style={S.section}>الرصيد الافتتاحي (عند الإضافة فقط)</div>
          <div style={S.grid}>
            <Field label="المبلغ">
              <input type="number" step="0.01" min="0" value={data.openingBalance ?? 0}
                onChange={(e) => setField("openingBalance", Number(e.target.value) || 0)}
                style={S.bigInput} placeholder="0.00" />
            </Field>
            <Field label="الطبيعة">
              <select value={data.openingNature ?? "debit"}
                onChange={(e) => setField("openingNature", e.target.value as "debit" | "credit")}
                style={S.bigInput}>
                <option value="debit">مدين (لنا عليه)</option>
                <option value="credit">دائن (له علينا)</option>
              </select>
            </Field>
          </div>
        </>
      )}
      </>
      )}

      {tab === "accounting" && (
        <>
          <div style={S.section}>الربط المحاسبي</div>
          <div style={S.grid}>
            <Field label="حساب العميل في دليل الحسابات">
              <SearchCombobox
                value={data.accountId ?? ""}
                onChange={(v) => setField("accountId", v === "" ? null : Number(v))}
                options={[
                  { value: "", label: "— بدون (حساب العملاء الافتراضي) —" },
                  ...leafAccounts.map((a) => ({ value: a.id, label: `${a.code} - ${a.nameAr}` })),
                ]}
                style={S.bigInput}
              />
            </Field>
          </div>
          <div style={S.muted}>
            عند اختيار حساب، تُرحَّل ذمم هذا العميل إلى هذا الحساب بدلاً من حساب العملاء الافتراضي.
            تظهر الحسابات الفرعية (القابلة للترحيل) فقط.
          </div>
        </>
      )}

      {err && <div style={S.formErr}>⚠️ {err}</div>}

      <div style={S.formActions}>
        <button onClick={handleSave} disabled={busy} style={S.btnSave}>{busy ? "جاري الحفظ..." : "حفظ"}</button>
        <button onClick={onCancel} disabled={busy} style={S.btnCancel}>إلغاء</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={S.field}>
      <label style={S.label}>{label}</label>
      {children}
    </div>
  );
}

const S = {
  wrap: { maxWidth: 1100, margin: "0 auto", width: "100%" } as const,
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 } as const,
  h2: { margin: 0, fontSize: 22, color: "#0f172a" } as const,
  sub: { fontSize: 13, color: "#64748b", marginTop: 4 } as const,
  search: { width: "100%", padding: "12px 16px", fontSize: 15, border: "1px solid #cbd5e1", borderRadius: 8, marginBottom: 16, fontFamily: "inherit", boxSizing: "border-box" as const } as const,
  empty: { padding: 40, textAlign: "center" as const, color: "#94a3b8", background: "#fff", border: "1px dashed #e2e8f0", borderRadius: 8 } as const,

  // Large stacked form panel
  formCard: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" } as const,
  formTitle: { fontSize: 18, fontWeight: 700, color: "#0f172a", marginBottom: 8 } as const,
  tabBar: { display: "flex", gap: 8, flexWrap: "wrap" as const, borderBottom: "2px solid #e2e8f0", marginBottom: 18, marginTop: 6 } as const,
  tab: { padding: "10px 18px", background: "transparent", color: "#64748b", border: "none", borderBottom: "3px solid transparent", borderRadius: 0, cursor: "pointer", fontSize: 14, fontWeight: 700, fontFamily: "inherit", marginBottom: -2 } as const,
  tabActive: { padding: "10px 18px", background: "transparent", color: "#2563eb", border: "none", borderBottom: "3px solid #2563eb", borderRadius: 0, cursor: "pointer", fontSize: 14, fontWeight: 700, fontFamily: "inherit", marginBottom: -2 } as const,
  section: { fontSize: 13, fontWeight: 700, color: "#2563eb", marginTop: 18, marginBottom: 10, paddingBottom: 6, borderBottom: "1px solid #eff6ff" } as const,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 } as const,
  field: { display: "flex", flexDirection: "column" as const, gap: 6 } as const,
  label: { fontSize: 13, color: "#475569", fontWeight: 600 } as const,
  bigInput: { width: "100%", padding: "13px 14px", fontSize: 16, border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "inherit", boxSizing: "border-box" as const, background: "#fff" } as const,
  checkRow: { display: "flex", alignItems: "center", gap: 10, padding: "12px 4px", fontSize: 14, color: "#334155", cursor: "pointer" } as const,
  checkbox: { width: 20, height: 20, accentColor: "#2563eb", cursor: "pointer", flexShrink: 0 } as const,
  formErr: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "12px 14px", borderRadius: 8, marginTop: 16, fontSize: 14 } as const,
  formActions: { display: "flex", gap: 12, marginTop: 22 } as const,
  btnSave: { padding: "12px 28px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 15, fontWeight: 700 } as const,
  btnCancel: { padding: "12px 28px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontSize: 15, fontWeight: 600 } as const,

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
  badgeLimitOn: { display: "inline-block", padding: "2px 8px", background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 4, fontSize: 12, fontWeight: 600 } as const,
  badgeLimitOff: { display: "inline-block", padding: "2px 8px", background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 4, fontSize: 12, fontWeight: 600 } as const,
  btnPrimary: { padding: "10px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 } as const,
  btnEdit: { padding: "6px 12px", background: "#f1f5f9", color: "#0f172a", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", fontSize: 12, marginInlineEnd: 6 } as const,
  btnDel: { padding: "6px 12px", background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer", fontSize: 12 } as const,
  ok: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
  err: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 } as const,
};
