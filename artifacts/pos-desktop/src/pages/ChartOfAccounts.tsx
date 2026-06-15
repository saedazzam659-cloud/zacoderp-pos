import { useEffect, useMemo, useRef, useState } from "react";
import {
  listAccounts, createAccount, updateAccount, deleteAccount,
  type Account, type AccountInput, type AccountType, type ReportDirection,
} from "../lib/accounting";
import { listCostCenters, type CostCenter } from "../lib/costCenters";
import { reportLedgerLines } from "../lib/reports";
import {
  Page, Card, Table, Th, Td, Empty, Modal, Field, Row, Actions, ErrorMsg,
  input, btnPrimary, btnSecondary, btnLink, fmt, SearchCombobox,
} from "./_adminUi";

const TYPE_LABEL: Record<AccountType, string> = {
  asset: "أصول", liability: "خصوم", equity: "حقوق ملكية", revenue: "إيرادات", expense: "مصروفات",
};
const TYPE_COLOR: Record<AccountType, string> = {
  asset: "#1e40af", liability: "#b91c1c", equity: "#7c3aed", revenue: "#15803d", expense: "#ea580c",
};
const TYPE_ORDER: AccountType[] = ["asset", "liability", "equity", "revenue", "expense"];

// "توجيه التقرير" — which financial report this account rolls up into. By
// default derived from the type (asset/liability/equity → المركز المالي,
// revenue/expense → قائمة الدخل) but can be overridden per account.
const DIRECTION_LABEL: Record<ReportDirection, string> = {
  balance_sheet: "المركز المالي", income_statement: "قائمة الدخل",
};
const DIRECTION_COLOR: Record<ReportDirection, string> = {
  balance_sheet: "#0f766e", income_statement: "#a16207",
};
function autoDirection(type: AccountType): ReportDirection {
  return type === "revenue" || type === "expense" ? "income_statement" : "balance_sheet";
}
function effectiveDirection(a: Account): ReportDirection {
  return a.reportDirection ?? autoDirection(a.type);
}

const emptyInput: AccountInput = {
  code: "", nameAr: "", nameEn: null, type: "asset", parentId: null, isLeaf: true,
  costCenterId: null, reportDirection: null, level: 1, notes: null, isActive: true,
};

type Props = { onDrillToStatement?: (accountId: number) => void };

export default function ChartOfAccounts({ onDrillToStatement }: Props) {
  const [rows, setRows] = useState<Account[]>([]);
  // Posted-only raw (debit − credit) balance per account id, derived from the
  // POSTED journal-entry ledger — NOT the denormalized accounts_local.balance
  // (which non-posting paths like inventory COGS / opening balances mutate).
  // This keeps شجرة الحسابات consistent with the financial reports: balances
  // appear only after the entries are posted (مرحّلة).
  const [postedRaw, setPostedRaw] = useState<Map<number, number>>(() => new Map());
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<"all" | AccountType>("all");
  const [viewMode, setViewMode] = useState<"tree" | "table">(() => {
    if (typeof window === "undefined") return "tree";
    return (localStorage.getItem("coa.viewMode") as "tree" | "table") || "tree";
  });
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  const [form, setForm] = useState<AccountInput>({ ...emptyInput });
  const [editId, setEditId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  async function refresh() {
    const [accs, lines] = await Promise.all([listAccounts(), reportLedgerLines({})]);
    setRows(accs);
    const m = new Map<number, number>();
    for (const l of lines) m.set(l.accountId, (m.get(l.accountId) ?? 0) + (l.debit - l.credit));
    setPostedRaw(m);
  }
  useEffect(() => {
    void refresh();
    void (async () => setCostCenters(await listCostCenters()))();
  }, []);

  function setView(v: "tree" | "table") {
    setViewMode(v);
    try { localStorage.setItem("coa.viewMode", v); } catch { /* ignore */ }
  }
  function toggleNode(id: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ── Aggregated balances (raw debit-credit signed) ──
  // Each account's own balance is the POSTED ledger sum Σ(debit − credit)
  // (positive = debit side) so sums across a subtree are in a consistent unit;
  // a parent's balance = own + Σ children. Unposted (draft) entries contribute
  // nothing because reportLedgerLines filters status='posted'.
  const byId = useMemo(() => new Map(rows.map((a) => [a.id, a])), [rows]);
  const childrenIndex = useMemo(() => {
    const m = new Map<number | null, Account[]>();
    for (const a of rows) {
      const k = a.parentId ?? null;
      const arr = m.get(k) || [];
      arr.push(a);
      m.set(k, arr);
    }
    for (const arr of m.values()) arr.sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
    return m;
  }, [rows]);
  function rawBalance(a: Account): number {
    return postedRaw.get(a.id) ?? 0;
  }
  const balanceCache = useMemo(() => new Map<number, number>(), [rows, postedRaw]);
  function computeBalance(id: number, seen: Set<number> = new Set()): number {
    if (balanceCache.has(id)) return balanceCache.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const self = byId.get(id);
    const own = self ? rawBalance(self) : 0;
    const kids = childrenIndex.get(id) || [];
    const sum = own + kids.reduce((s, c) => s + computeBalance(c.id, seen), 0);
    seen.delete(id);
    balanceCache.set(id, sum);
    return sum;
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const t of TYPE_ORDER) c[t] = 0;
    for (const a of rows) c[a.type] = (c[a.type] ?? 0) + 1;
    return c;
  }, [rows]);

  // ── Filtering (search + type) ──
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((a) => {
      const matchText = !q || a.nameAr.toLowerCase().includes(q) || a.code.toLowerCase().includes(q) || (a.nameEn ?? "").toLowerCase().includes(q);
      const matchType = filterType === "all" || a.type === filterType;
      return matchText && matchType;
    });
  }, [rows, search, filterType]);

  const flatSorted = useMemo(
    () => [...filtered].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    [filtered],
  );

  // Visible set for the tree = filtered accounts + all their ancestors.
  const visibleIds = useMemo(() => {
    const vis = new Set<number>();
    for (const a of filtered) {
      let cur: Account | undefined = a;
      while (cur && !vis.has(cur.id)) {
        vis.add(cur.id);
        cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
      }
    }
    return vis;
  }, [filtered, byId]);

  const treeRoots = useMemo(
    () => rows
      .filter((a) => visibleIds.has(a.id) && (a.parentId == null || !byId.has(a.parentId)))
      .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true })),
    [rows, visibleIds, byId],
  );

  // ── Form helpers ──
  function startNew() {
    setErr(null); setForm({ ...emptyInput }); setEditId(null); setShowForm(true);
    setTimeout(() => codeRef.current?.focus(), 60);
  }
  function startEdit(a: Account) {
    setErr(null);
    setForm({
      code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, type: a.type,
      parentId: a.parentId, isLeaf: a.isLeaf, costCenterId: a.costCenterId,
      reportDirection: a.reportDirection, level: a.level, notes: a.notes, isActive: a.isActive,
    });
    setEditId(a.id); setShowForm(true);
  }
  function suggestNextCode(srcCode: string, parentId: number | null): string {
    if (!srcCode) return "";
    const m = srcCode.match(/^(.*?)(\d+)$/);
    if (!m) return `${srcCode}-1`;
    const [, prefix, digits] = m;
    const width = digits.length;
    const allCodes = new Set(rows.map((x) => x.code));
    const siblings = rows.filter((x) => (x.parentId ?? null) === parentId);
    let maxN = parseInt(digits, 10);
    for (const s of siblings) {
      const sm = s.code.match(/^(.*?)(\d+)$/);
      if (!sm || sm[1] !== prefix) continue;
      const n = parseInt(sm[2], 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
    for (let i = 1; i <= 1000; i++) {
      const candidate = prefix + String(maxN + i).padStart(width, "0");
      if (!allCodes.has(candidate)) return candidate;
    }
    return prefix + String(maxN + 1).padStart(width, "0");
  }
  function startCopy(a: Account) {
    setErr(null);
    setForm({
      code: suggestNextCode(a.code, a.parentId), nameAr: a.nameAr, nameEn: a.nameEn,
      type: a.type, parentId: a.parentId, isLeaf: a.isLeaf, costCenterId: a.costCenterId,
      reportDirection: a.reportDirection, level: a.level, notes: a.notes, isActive: a.isActive,
    });
    setEditId(null); setShowForm(true);
    setTimeout(() => { const el = codeRef.current; if (el) { el.focus(); el.select(); } }, 80);
  }
  function cancel() { setShowForm(false); setEditId(null); setErr(null); }
  function setField<K extends keyof AccountInput>(k: K, v: AccountInput[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }
  async function save() {
    if (!form.code.trim() || !form.nameAr.trim()) { setErr("الكود والاسم مطلوبان"); return; }
    setBusy(true); setErr(null);
    try {
      const payload: AccountInput = { ...form, level: Number(form.level) || 1 };
      if (editId) await updateAccount(editId, payload);
      else await createAccount(payload);
      setShowForm(false); setEditId(null); await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل الحفظ"); }
    finally { setBusy(false); }
  }
  async function remove(a: Account) {
    if (!confirm(`حذف الحساب ${a.code} - ${a.nameAr}؟`)) return;
    try { await deleteAccount(a.id); await refresh(); }
    catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  const parentOptions = useMemo(
    () => [
      { value: "", label: "— بدون (حساب رئيسي) —" },
      ...rows
        .filter((a) => a.id !== editId)
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
        .map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` })),
    ],
    [rows, editId],
  );
  const costCenterOptions = useMemo(
    () => [
      { value: "", label: "— بدون مركز تكلفة —" },
      ...costCenters
        .filter((c) => c.isActive)
        .map((c) => ({ value: c.id, label: `${c.code} — ${c.nameAr}` })),
    ],
    [costCenters],
  );

  function Pill({ a }: { a: Account }) {
    const bal = computeBalance(a.id);
    const isZero = Math.abs(bal) < 0.005;
    const isCr = bal < 0;
    const tone = isZero
      ? { bg: "#f8fafc", color: "#64748b", border: "#e2e8f0" }
      : isCr
        ? { bg: "#fff1f2", color: "#be123c", border: "#fecdd3" }
        : { bg: "#ecfdf5", color: "#047857", border: "#a7f3d0" };
    const arrow = isZero ? "–" : isCr ? "▼" : "▲";
    const clickable = a.isLeaf && !isZero && !!onDrillToStatement;
    const inner = (
      <span dir="ltr" style={{
        display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${tone.border}`,
        background: tone.bg, color: tone.color, borderRadius: 999, padding: "2px 9px",
        fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums",
      }}>
        <span style={{ fontSize: 10 }}>{arrow}</span>
        <span style={{ fontFamily: "monospace" }}>{isZero ? "0.00" : fmt(Math.abs(bal))}</span>
        {!isZero && <span style={{ fontSize: 9, fontWeight: 700, opacity: 0.85, background: "rgba(255,255,255,0.6)", padding: "0 4px", borderRadius: 4 }}>{isCr ? "دائن" : "مدين"}</span>}
        {clickable && <span style={{ fontSize: 9, opacity: 0.6 }}>↗</span>}
      </span>
    );
    if (!clickable) return inner;
    return (
      <button
        type="button"
        onClick={() => onDrillToStatement!(a.id)}
        title="اعرض الحركات التي كوّنت هذا الرصيد"
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
      >
        {inner}
      </button>
    );
  }

  function TypeBadge({ type }: { type: AccountType }) {
    return <span style={{ background: TYPE_COLOR[type] + "20", color: TYPE_COLOR[type], padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{TYPE_LABEL[type]}</span>;
  }
  function DirectionBadge({ a }: { a: Account }) {
    const d = effectiveDirection(a);
    const overridden = a.reportDirection != null;
    return <span title={overridden ? "محدد يدوياً" : "تلقائي حسب النوع"} style={{ background: DIRECTION_COLOR[d] + "20", color: DIRECTION_COLOR[d], padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{DIRECTION_LABEL[d]}{overridden ? " ✎" : ""}</span>;
  }

  function renderTreeRow(a: Account, depth: number): React.ReactNode {
    const kids = (childrenIndex.get(a.id) || []).filter((c) => visibleIds.has(c.id));
    const hasKids = kids.length > 0;
    const isCollapsed = collapsed.has(a.id);
    const parent = a.parentId != null ? byId.get(a.parentId) : null;
    return (
      <>
        <tr key={a.id} style={{ opacity: a.isActive ? 1 : 0.5 }}>
          <Td mono>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginInlineStart: depth * 16 }}>
              {hasKids ? (
                <button onClick={() => toggleNode(a.id)} style={{ ...btnLink, fontSize: 11, width: 14 }} title={isCollapsed ? "توسيع" : "طي"}>{isCollapsed ? "▸" : "▾"}</button>
              ) : <span style={{ width: 14, display: "inline-block" }} />}
              {a.code}
            </span>
          </Td>
          <Td style={{ fontWeight: a.isLeaf ? 400 : 700 }}>
            {a.nameAr}
            {!a.isActive && <span style={{ marginInlineStart: 6, fontSize: 11, color: "#dc2626" }}>(معطّل)</span>}
          </Td>
          <Td><TypeBadge type={a.type} /></Td>
          <Td><DirectionBadge a={a} /></Td>
          <Td style={{ color: "#64748b" }}>{parent ? `${parent.code} - ${parent.nameAr}` : "—"}</Td>
          <Td style={{ textAlign: "left" }}><Pill a={a} /></Td>
          <Td>
            <button onClick={() => startEdit(a)} style={btnLink}>تعديل</button>{" · "}
            <button onClick={() => startCopy(a)} style={btnLink}>نسخ</button>{" · "}
            <button onClick={() => remove(a)} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
          </Td>
        </tr>
        {hasKids && !isCollapsed && kids.map((c) => renderTreeRow(c, depth + 1))}
      </>
    );
  }

  const cardBtn = (active: boolean, color: string): React.CSSProperties => ({
    flex: "1 1 130px", textAlign: "start", cursor: "pointer", border: `1px solid ${active ? color : "#e2e8f0"}`,
    background: active ? color + "12" : "#fff", borderRadius: 10, padding: "10px 12px", fontFamily: "inherit",
  });

  return (
    <Page
      title="شجرة الحسابات"
      subtitle={`${rows.length} حساب — الأكواد الافتراضية محفوظة، يمكنك إضافة فرعية وتعديل البيانات`}
      right={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "inline-flex", border: "1px solid #cbd5e1", borderRadius: 6, overflow: "hidden" }}>
            <button onClick={() => setView("tree")} style={{ padding: "6px 12px", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, background: viewMode === "tree" ? "#2563eb" : "#fff", color: viewMode === "tree" ? "#fff" : "#475569" }}>🌳 شجري</button>
            <button onClick={() => setView("table")} style={{ padding: "6px 12px", border: "none", borderInlineStart: "1px solid #cbd5e1", cursor: "pointer", fontFamily: "inherit", fontSize: 13, background: viewMode === "table" ? "#2563eb" : "#fff", color: viewMode === "table" ? "#fff" : "#475569" }}>☰ جدول</button>
          </div>
          <button onClick={() => window.print()} style={btnSecondary}>🖨 طباعة</button>
          <button onClick={startNew} style={btnPrimary}>+ إضافة حساب</button>
        </div>
      }
    >
      <style>{`
        #coa-print { display: none; }
        @media print {
          body * { visibility: hidden; }
          #coa-print, #coa-print * { visibility: visible; }
          #coa-print { display: block; position: absolute; top: 0; right: 0; left: 0; }
        }
      `}</style>

      <div className="coa-no-print">
        {/* Summary cards — counts per type, clickable to filter */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          <button onClick={() => setFilterType("all")} style={cardBtn(filterType === "all", "#334155")}>
            <div style={{ fontSize: 12, color: "#64748b" }}>الكل</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#0f172a" }}>{counts.all}</div>
          </button>
          {TYPE_ORDER.map((t) => (
            <button key={t} onClick={() => setFilterType(t)} style={cardBtn(filterType === t, TYPE_COLOR[t])}>
              <div style={{ fontSize: 12, color: TYPE_COLOR[t] }}>{TYPE_LABEL[t]}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "#0f172a" }}>{counts[t]}</div>
            </button>
          ))}
        </div>

        <Card>
          <div style={{ marginBottom: 12 }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 بحث بالكود أو الاسم..."
              style={{ ...input, maxWidth: 360 }}
            />
          </div>

          {viewMode === "tree" ? (
            treeRoots.length === 0 ? <Empty text="لا توجد حسابات مطابقة" /> : (
              <Table>
                <thead><tr>
                  <Th>الكود</Th><Th>الاسم</Th><Th>النوع</Th><Th>توجيه التقرير</Th><Th>الحساب الأب</Th>
                  <Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 220 }}>إجراءات</Th>
                </tr></thead>
                <tbody>{treeRoots.map((a) => renderTreeRow(a, 0))}</tbody>
              </Table>
            )
          ) : (
            flatSorted.length === 0 ? <Empty text="لا توجد حسابات مطابقة" /> : (
              <Table>
                <thead><tr>
                  <Th>الكود</Th><Th>الاسم</Th><Th>النوع</Th><Th>توجيه التقرير</Th><Th>الحساب الأب</Th>
                  <Th>طبيعة</Th><Th>الحالة</Th><Th style={{ textAlign: "left" }}>الرصيد</Th><Th style={{ width: 220 }}>إجراءات</Th>
                </tr></thead>
                <tbody>
                  {flatSorted.map((a) => {
                    const parent = a.parentId != null ? byId.get(a.parentId) : null;
                    return (
                      <tr key={a.id} style={{ opacity: a.isActive ? 1 : 0.5 }}>
                        <Td mono>{a.code}</Td>
                        <Td style={{ fontWeight: a.isLeaf ? 400 : 700 }}>{a.nameAr}</Td>
                        <Td><TypeBadge type={a.type} /></Td>
                        <Td><DirectionBadge a={a} /></Td>
                        <Td style={{ color: "#64748b" }}>{parent ? `${parent.code} - ${parent.nameAr}` : "—"}</Td>
                        <Td style={{ fontSize: 12, color: "#475569" }}>{a.isLeaf ? "فرعي" : "تجميعي"}</Td>
                        <Td style={{ fontSize: 12 }}>{a.isActive ? <span style={{ color: "#15803d" }}>نشط</span> : <span style={{ color: "#dc2626" }}>معطّل</span>}</Td>
                        <Td style={{ textAlign: "left" }}><Pill a={a} /></Td>
                        <Td>
                          <button onClick={() => startEdit(a)} style={btnLink}>تعديل</button>{" · "}
                          <button onClick={() => startCopy(a)} style={btnLink}>نسخ</button>{" · "}
                          <button onClick={() => remove(a)} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )
          )}
        </Card>
      </div>

      {/* Printable inventory of the whole chart (code order). */}
      <div id="coa-print">
        <h2 style={{ textAlign: "center", margin: "0 0 4px" }}>شجرة الحسابات</h2>
        <div style={{ textAlign: "center", fontSize: 12, color: "#475569", marginBottom: 12 }}>{new Date().toLocaleDateString("ar-EG")} — {rows.length} حساب</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              {["الكود", "الاسم", "النوع", "توجيه التقرير", "طبيعة", "الحالة", "الرصيد"].map((h) => (
                <th key={h} style={{ border: "1px solid #cbd5e1", padding: "4px 6px", textAlign: "start", background: "#f1f5f9" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...rows].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })).map((a) => {
              const bal = computeBalance(a.id);
              const balStr = Math.abs(bal) < 0.005 ? "0.00" : `${fmt(Math.abs(bal))} ${bal < 0 ? "دائن" : "مدين"}`;
              return (
                <tr key={a.id}>
                  <td style={{ border: "1px solid #cbd5e1", padding: "4px 6px", fontFamily: "monospace" }}>{a.code}</td>
                  <td style={{ border: "1px solid #cbd5e1", padding: "4px 6px" }}>{a.nameAr}</td>
                  <td style={{ border: "1px solid #cbd5e1", padding: "4px 6px" }}>{TYPE_LABEL[a.type]}</td>
                  <td style={{ border: "1px solid #cbd5e1", padding: "4px 6px" }}>{DIRECTION_LABEL[effectiveDirection(a)]}</td>
                  <td style={{ border: "1px solid #cbd5e1", padding: "4px 6px" }}>{a.isLeaf ? "فرعي" : "تجميعي"}</td>
                  <td style={{ border: "1px solid #cbd5e1", padding: "4px 6px" }}>{a.isActive ? "نشط" : "معطّل"}</td>
                  <td style={{ border: "1px solid #cbd5e1", padding: "4px 6px", textAlign: "left" }}>{balStr}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showForm && (
        <Modal title={editId ? "تعديل حساب" : "إضافة حساب"} onCancel={cancel} wide>
          <Row>
            <Field label="الكود *">
              <input ref={codeRef} value={form.code} onChange={(e) => setField("code", e.target.value)} style={input} placeholder="مثال: 110101" />
            </Field>
            <Field label="المستوى">
              <input type="number" min={1} value={form.level} onChange={(e) => setField("level", Number(e.target.value) || 1)} style={input} />
            </Field>
          </Row>
          <Row>
            <Field label="الاسم (عربي) *">
              <input value={form.nameAr} onChange={(e) => setField("nameAr", e.target.value)} style={input} />
            </Field>
            <Field label="الاسم (إنجليزي)">
              <input value={form.nameEn ?? ""} onChange={(e) => setField("nameEn", e.target.value || null)} style={input} />
            </Field>
          </Row>
          <Row>
            <Field label="النوع *">
              <SearchCombobox
                value={form.type}
                onChange={(v) => setField("type", v as AccountType)}
                style={input}
                options={TYPE_ORDER.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
              />
            </Field>
            <Field label="توجيه التقرير">
              <SearchCombobox
                value={form.reportDirection ?? ""}
                onChange={(v) => setField("reportDirection", v === "" ? null : (v as ReportDirection))}
                style={input}
                options={[
                  { value: "", label: `تلقائي حسب النوع (${DIRECTION_LABEL[autoDirection(form.type)]})` },
                  { value: "balance_sheet", label: DIRECTION_LABEL.balance_sheet },
                  { value: "income_statement", label: DIRECTION_LABEL.income_statement },
                ]}
              />
            </Field>
          </Row>
          <Row>
            <Field label="الحساب الأب">
              <SearchCombobox
                value={form.parentId ?? ""}
                onChange={(v) => setField("parentId", v === "" ? null : Number(v))}
                style={input}
                options={parentOptions}
              />
            </Field>
            <Field label="مركز التكلفة">
              <SearchCombobox
                value={form.costCenterId ?? ""}
                onChange={(v) => setField("costCenterId", v === "" ? null : Number(v))}
                style={input}
                options={costCenterOptions}
              />
            </Field>
          </Row>
          <Row>
            <Field label="طبيعة الحساب">
              <SearchCombobox
                value={form.isLeaf ? "1" : "0"}
                onChange={(v) => setField("isLeaf", v === "1")}
                style={input}
                options={[
                  { value: "1", label: "حساب فرعي (يقبل قيود)" },
                  { value: "0", label: "حساب رئيسي (تجميع فقط)" },
                ]}
              />
            </Field>
            <Field label="الحالة">
              <SearchCombobox
                value={form.isActive ? "1" : "0"}
                onChange={(v) => setField("isActive", v === "1")}
                style={input}
                options={[
                  { value: "1", label: "نشط" },
                  { value: "0", label: "معطّل" },
                ]}
              />
            </Field>
          </Row>
          <Field label="ملاحظات">
            <textarea value={form.notes ?? ""} onChange={(e) => setField("notes", e.target.value || null)} style={{ ...input, minHeight: 64, resize: "vertical" }} />
          </Field>
          <ErrorMsg text={err} />
          <Actions>
            <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
            <button onClick={cancel} disabled={busy} style={btnSecondary}>إلغاء</button>
          </Actions>
        </Modal>
      )}
    </Page>
  );
}
