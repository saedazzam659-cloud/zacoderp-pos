import { useEffect, useMemo, useState } from "react";
import {
  listFiscalYears, createFiscalYear, deleteFiscalYear, setFiscalYearStatus,
  listFiscalPeriods, validateFiscalPeriod, closePeriodPl, transferPeriodProfit,
  softClosePeriod, hardClosePeriod, forceReopenPeriod, listAccounts,
  type FiscalYear, type FiscalPeriod, type PeriodValidateResult,
  type ClosePlResult, type TransferProfitResult, type SoftCloseResult,
  type Account,
} from "../lib/accounting";
import {
  Page, Card, Table, Th, Td, Modal, Field, Row, ErrorMsg, Actions, Empty,
  input, btnPrimary, btnSecondary, btnDanger, btnLink, fmt, SearchCombobox,
  type ComboOption,
} from "./_adminUi";
import { currencySymbol } from "../lib/currency";

type Status = FiscalYear["status"];

const STATUS_LABEL: Record<Status, string> = {
  open: "مفتوحة",
  closed: "مغلقة (ناعم)",
  permanently_closed: "مغلقة نهائياً",
};
const STATUS_COLOR: Record<Status, string> = {
  open: "#15803d",
  closed: "#b45309",
  permanently_closed: "#b91c1c",
};

function StatusBadge({ status }: { status: Status }) {
  const c = STATUS_COLOR[status];
  return (
    <span style={{ background: c + "20", color: c, padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function FiscalPeriods() {
  const sym = currencySymbol();

  const [years, setYears] = useState<FiscalYear[]>([]);
  const [loadingYears, setLoadingYears] = useState(true);
  const [yearsErr, setYearsErr] = useState<string | null>(null);

  const [selectedYearId, setSelectedYearId] = useState<number | null>(null);
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [loadingPeriods, setLoadingPeriods] = useState(false);
  const [periodsErr, setPeriodsErr] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);

  // New-year modal
  const [showNew, setShowNew] = useState(false);

  // Wizard modal
  const [wizard, setWizard] = useState<FiscalPeriod | null>(null);
  // Force-reopen modal
  const [reopen, setReopen] = useState<FiscalPeriod | null>(null);

  async function refreshYears() {
    setLoadingYears(true); setYearsErr(null);
    try {
      const rows = await listFiscalYears();
      setYears(rows);
      if (selectedYearId == null && rows.length > 0) setSelectedYearId(rows[0].id);
      else if (selectedYearId != null && !rows.some((y) => y.id === selectedYearId)) {
        setSelectedYearId(rows.length > 0 ? rows[0].id : null);
      }
    } catch (e: any) { setYearsErr(e?.message ?? "فشل تحميل السنوات المالية"); }
    finally { setLoadingYears(false); }
  }

  async function refreshPeriods(yearId: number | null) {
    if (yearId == null) { setPeriods([]); return; }
    setLoadingPeriods(true); setPeriodsErr(null);
    try {
      setPeriods(await listFiscalPeriods(yearId));
    } catch (e: any) { setPeriodsErr(e?.message ?? "فشل تحميل الفترات"); }
    finally { setLoadingPeriods(false); }
  }

  useEffect(() => { void refreshYears(); void (async () => { try { setAccounts(await listAccounts()); } catch { /* ignore */ } })(); }, []);
  useEffect(() => { void refreshPeriods(selectedYearId); }, [selectedYearId]);

  const accountOptions: ComboOption[] = useMemo(
    () => [
      { value: "", label: "— اختر حساباً —" },
      ...accounts
        .filter((a) => a.isLeaf && a.isActive)
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
        .map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}`, hint: a.nameEn ?? undefined })),
    ],
    [accounts],
  );

  const selectedYear = useMemo(() => years.find((y) => y.id === selectedYearId) ?? null, [years, selectedYearId]);

  async function onDeleteYear(y: FiscalYear) {
    if (!confirm(`حذف السنة المالية «${y.name}»؟\nلا يمكن الحذف إلا إذا كانت جميع فتراتها مفتوحة وبدون حركة.`)) return;
    try {
      await deleteFiscalYear(y.id);
      await refreshYears();
    } catch (e: any) { alert(e?.message ?? "فشل الحذف"); }
  }

  async function onSetYearStatus(y: FiscalYear, status: Status) {
    try {
      await setFiscalYearStatus(y.id, status);
      await refreshYears();
    } catch (e: any) { alert(e?.message ?? "فشل تغيير الحالة"); }
  }

  async function afterPeriodMutation() {
    await refreshPeriods(selectedYearId);
    await refreshYears();
  }

  return (
    <Page
      title="الفترات المحاسبية"
      subtitle="إدارة السنوات المالية وفتراتها الشهرية ومعالج إقفال الفترات (إقفال الأرباح والخسائر → ترحيل الأرباح → إقفال ناعم → إقفال نهائي)."
      right={<button onClick={() => setShowNew(true)} style={btnPrimary}>+ سنة مالية جديدة</button>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16, alignItems: "start" }}>
        {/* ── Years pane ── */}
        <Card>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid #f1f5f9", fontWeight: 700, fontSize: 14 }}>
            السنوات المالية
          </div>
          {yearsErr && <div style={{ padding: 12 }}><ErrorMsg text={yearsErr} /></div>}
          {loadingYears ? (
            <Empty text="جارٍ التحميل..." />
          ) : years.length === 0 ? (
            <Empty text="لا توجد سنوات مالية — أنشئ واحدة للبدء" />
          ) : (
            <div>
              {years.map((y) => {
                const active = y.id === selectedYearId;
                return (
                  <div
                    key={y.id}
                    onClick={() => setSelectedYearId(y.id)}
                    style={{
                      padding: "12px 14px", borderBottom: "1px solid #f1f5f9", cursor: "pointer",
                      background: active ? "#eff6ff" : "transparent",
                      borderInlineStart: active ? "3px solid #2563eb" : "3px solid transparent",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{y.name}</span>
                      <StatusBadge status={y.status} />
                    </div>
                    <div dir="ltr" style={{ fontSize: 12, color: "#64748b", marginTop: 4, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {y.startDate} ← {y.endDate}
                    </div>
                    <div style={{ marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
                      {y.status === "open" ? (
                        <button style={btnLink} onClick={() => onSetYearStatus(y, "closed")}>إقفال السنة</button>
                      ) : y.status === "closed" ? (
                        <button style={btnLink} onClick={() => onSetYearStatus(y, "open")}>إعادة فتح السنة</button>
                      ) : (
                        <span style={{ fontSize: 12, color: "#94a3b8" }}>مغلقة نهائياً</span>
                      )}
                      {y.status === "open" && (
                        <button style={{ ...btnLink, color: "#dc2626" }} onClick={() => onDeleteYear(y)}>حذف</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* ── Periods pane ── */}
        <Card>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid #f1f5f9", fontWeight: 700, fontSize: 14 }}>
            {selectedYear ? `فترات ${selectedYear.name}` : "الفترات"}
          </div>
          {periodsErr && <div style={{ padding: 12 }}><ErrorMsg text={periodsErr} /></div>}
          {selectedYearId == null ? (
            <Empty text="اختر سنة مالية لعرض فتراتها" />
          ) : loadingPeriods ? (
            <Empty text="جارٍ التحميل..." />
          ) : periods.length === 0 ? (
            <Empty text="لا توجد فترات لهذه السنة" />
          ) : (
            <Table>
              <thead><tr>
                <Th>الفترة</Th>
                <Th style={{ width: 200 }}>المدى</Th>
                <Th style={{ width: 140 }}>الحالة</Th>
                <Th style={{ width: 200 }}>إجراءات</Th>
              </tr></thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id}>
                    <Td style={{ fontWeight: 600 }}>{p.name}</Td>
                    <Td mono num style={{ color: "#64748b", fontSize: 12 }}>{p.startDate} ← {p.endDate}</Td>
                    <Td><StatusBadge status={p.status} /></Td>
                    <Td>
                      {p.status === "open" && (
                        <button style={btnLink} onClick={() => setWizard(p)}>معالج الإقفال</button>
                      )}
                      {p.status === "closed" && (
                        <button style={btnLink} onClick={() => setWizard(p)}>متابعة الإقفال</button>
                      )}
                      {p.status === "permanently_closed" && (
                        <button style={{ ...btnLink, color: "#dc2626" }} onClick={() => setReopen(p)}>إعادة فتح (إجباري)</button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      {showNew && (
        <NewYearModal
          onClose={() => setShowNew(false)}
          onSaved={async () => { setShowNew(false); await refreshYears(); }}
        />
      )}

      {wizard && (
        <ClosingWizard
          period={wizard}
          accountOptions={accountOptions}
          sym={sym}
          onClose={() => setWizard(null)}
          onMutated={async () => { await afterPeriodMutation(); }}
          onPeriodGone={() => setWizard(null)}
        />
      )}

      {reopen && (
        <ForceReopenModal
          period={reopen}
          onClose={() => setReopen(null)}
          onDone={async () => { setReopen(null); await afterPeriodMutation(); }}
        />
      )}
    </Page>
  );
}

// ─── New fiscal year modal ────────────────────────────────────────────
function NewYearModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState(todayISO().slice(0, 4) + "-01-01");
  const [endDate, setEndDate] = useState(todayISO().slice(0, 4) + "-12-31");
  const [generateMonthly, setGenerateMonthly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) { setErr("اسم السنة المالية مطلوب"); return; }
    if (!startDate || !endDate) { setErr("تاريخا البداية والنهاية مطلوبان"); return; }
    if (endDate <= startDate) { setErr("تاريخ النهاية يجب أن يكون بعد تاريخ البداية"); return; }
    setBusy(true); setErr(null);
    try {
      await createFiscalYear({ name: name.trim(), startDate, endDate, generateMonthly });
      onSaved();
    } catch (e: any) { setErr(e?.message ?? "فشل الإنشاء"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="سنة مالية جديدة" onCancel={onClose}>
      <Field label="اسم السنة المالية *">
        <input value={name} onChange={(e) => setName(e.target.value)} style={input} placeholder="مثال: السنة المالية 2026" autoFocus />
      </Field>
      <Row>
        <Field label="تاريخ البداية *">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={input} />
        </Field>
        <Field label="تاريخ النهاية *">
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={input} />
        </Field>
      </Row>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontSize: 14, cursor: "pointer" }}>
        <input type="checkbox" checked={generateMonthly} onChange={(e) => setGenerateMonthly(e.target.checked)} />
        توليد فترات شهرية تلقائياً
      </label>
      <ErrorMsg text={err} />
      <Actions>
        <button style={btnSecondary} onClick={onClose} disabled={busy}>إلغاء</button>
        <button style={btnPrimary} onClick={save} disabled={busy}>{busy ? "..." : "إنشاء"}</button>
      </Actions>
    </Modal>
  );
}

// ─── Force-reopen modal ───────────────────────────────────────────────
function ForceReopenModal({ period, onClose, onDone }: {
  period: FiscalPeriod; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = reason.trim().length >= 10;

  async function submit() {
    if (!ok) { setErr("سبب فك القفل مطلوب (10 أحرف على الأقل)"); return; }
    setBusy(true); setErr(null);
    try {
      await forceReopenPeriod(period.id, reason.trim());
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل فك القفل"); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`إعادة فتح إجبارية — ${period.name}`} onCancel={onClose}>
      <div style={{ fontSize: 13, color: "#991b1b", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: 10, marginBottom: 12 }}>
        ⚠️ فك قفل فترة مغلقة نهائياً عملية حساسة تتطلب صلاحية مدير/سوبر أدمن. يُرجى توثيق السبب.
      </div>
      <Field label="سبب فك القفل (10 أحرف على الأقل) *">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          style={{ ...input, resize: "vertical" }}
          placeholder="اكتب سبباً واضحاً لإعادة فتح هذه الفترة..."
          autoFocus
        />
      </Field>
      <div style={{ fontSize: 12, color: ok ? "#15803d" : "#94a3b8" }}>{reason.trim().length}/10</div>
      <ErrorMsg text={err} />
      <Actions>
        <button style={btnSecondary} onClick={onClose} disabled={busy}>إلغاء</button>
        <button style={btnDanger} onClick={submit} disabled={busy || !ok}>{busy ? "..." : "تأكيد فك القفل"}</button>
      </Actions>
    </Modal>
  );
}

// ─── Closing wizard ───────────────────────────────────────────────────
function ClosingWizard({ period, accountOptions, sym, onClose, onMutated, onPeriodGone }: {
  period: FiscalPeriod;
  accountOptions: ComboOption[];
  sym: string;
  onClose: () => void;
  onMutated: () => Promise<void>;
  onPeriodGone: () => void;
}) {
  const [validation, setValidation] = useState<PeriodValidateResult | null>(null);
  const [plResult, setPlResult] = useState<ClosePlResult | null>(null);
  const [transferResult, setTransferResult] = useState<TransferProfitResult | null>(null);
  const [softResult, setSoftResult] = useState<SoftCloseResult | null>(null);

  const [plSummaryId, setPlSummaryId] = useState<string | number>("");
  const [retainedId, setRetainedId] = useState<string | number>("");
  const [force, setForce] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const requiresPlClose = validation?.requiresPlClose ?? false;

  async function run<T>(key: string, fn: () => Promise<T>, after?: (r: T) => void) {
    setBusy(key); setErr(null);
    try {
      const r = await fn();
      after?.(r);
      await onMutated();
    } catch (e: any) { setErr(e?.message ?? "فشل تنفيذ الخطوة"); }
    finally { setBusy(null); }
  }

  function doValidate() {
    return run("validate", () => validateFiscalPeriod(period.id), (r) => { setValidation(r); });
  }
  function doClosePl() {
    if (!plSummaryId) { setErr("اختر حساب ملخص الأرباح والخسائر أولاً"); return; }
    return run("pl", () => closePeriodPl(period.id, Number(plSummaryId)), (r) => { setPlResult(r); });
  }
  function doTransfer() {
    if (!plSummaryId) { setErr("اختر حساب ملخص الأرباح والخسائر أولاً"); return; }
    if (!retainedId) { setErr("اختر حساب الأرباح المحتجزة أولاً"); return; }
    return run("transfer", () => transferPeriodProfit(period.id, Number(plSummaryId), Number(retainedId)), (r) => { setTransferResult(r); });
  }
  function doSoftClose() {
    return run("soft", () => softClosePeriod(period.id, force), (r) => { setSoftResult(r); });
  }
  function doHardClose() {
    return run("hard", () => hardClosePeriod(period.id), () => { setDone(true); onPeriodGone(); });
  }

  const stepBox: React.CSSProperties = { border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, marginBottom: 12 };
  const stepTitle: React.CSSProperties = { fontWeight: 700, fontSize: 14, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 };

  return (
    <Modal title={`معالج الإقفال — ${period.name}`} onCancel={onClose} wide>
      <div dir="ltr" style={{ textAlign: "right", fontSize: 12, color: "#64748b", marginBottom: 12, fontVariantNumeric: "tabular-nums" }}>
        {period.startDate} ← {period.endDate} · <StatusBadge status={period.status} />
      </div>

      {/* Step 1 — validate */}
      <div style={stepBox}>
        <div style={stepTitle}><span>1)</span> فحص الفترة (التحقق)</div>
        <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 8px" }}>
          يكشف القيود غير المرحّلة وغير المتوازنة وأرصدة الإيرادات/المصروفات المفتوحة قبل الإقفال.
        </p>
        <button style={btnPrimary} onClick={doValidate} disabled={busy != null}>
          {busy === "validate" ? "جارٍ الفحص..." : "تشغيل الفحص"}
        </button>
        {validation && (
          <div style={{ marginTop: 12 }}>
            <div style={{
              padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 8,
              background: validation.ok ? "#ecfdf5" : "#fffbeb",
              color: validation.ok ? "#047857" : "#92400e",
              border: `1px solid ${validation.ok ? "#a7f3d0" : "#fde68a"}`,
            }}>
              {validation.ok ? "✓ لا توجد مشاكل تمنع الإقفال" : "⚠️ توجد ملاحظات يجب مراجعتها"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
              <Stat label="قيود غير مرحّلة" value={validation.drafts} warn={validation.drafts > 0} />
              <Stat label="قيود غير متوازنة" value={validation.unbalanced} warn={validation.unbalanced > 0} />
              <Stat label="حسابات إيراد مفتوحة" value={validation.openRevenueAccounts} warn={validation.openRevenueAccounts > 0} />
              <Stat label="حسابات مصروف مفتوحة" value={validation.openExpenseAccounts} warn={validation.openExpenseAccounts > 0} />
            </div>
            {validation.requiresPlClose && (
              <div style={{ fontSize: 13, color: "#92400e" }}>↳ يلزم إقفال الأرباح والخسائر قبل الإقفال الناعم (أو استخدم خيار «فرض» لاحقاً).</div>
            )}
            {validation.issues.length > 0 && (
              <ul style={{ margin: "8px 0 0", paddingInlineStart: 18, fontSize: 13, color: "#92400e" }}>
                {validation.issues.map((it, i) => <li key={i}>{it}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Step 2 — close P/L */}
      <div style={stepBox}>
        <div style={stepTitle}><span>2)</span> إقفال الأرباح والخسائر</div>
        <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 8px" }}>
          ترحيل أرصدة الإيرادات والمصروفات إلى حساب ملخص الأرباح والخسائر.
        </p>
        <Field label="حساب ملخص الأرباح والخسائر">
          <SearchCombobox
            value={plSummaryId}
            onChange={(v) => setPlSummaryId(v === "" ? "" : Number(v))}
            options={accountOptions}
            placeholder="— اختر حساباً —"
          />
        </Field>
        <button style={btnPrimary} onClick={doClosePl} disabled={busy != null || !plSummaryId}>
          {busy === "pl" ? "جارٍ الإقفال..." : "إقفال الأرباح والخسائر"}
        </button>
        {plResult && (
          <div style={{ marginTop: 10, fontSize: 13, color: "#0f172a", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: 10 }}>
            <div>إجمالي الإيرادات: <b style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(plResult.totalRevenue)} {sym}</b></div>
            <div>إجمالي المصروفات: <b style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(plResult.totalExpense)} {sym}</b></div>
            <div style={{ color: plResult.netIncome >= 0 ? "#047857" : "#b91c1c" }}>
              {plResult.netIncome >= 0 ? "صافي ربح" : "صافي خسارة"}: <b style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(Math.abs(plResult.netIncome))} {sym}</b>
            </div>
          </div>
        )}
      </div>

      {/* Step 3 — transfer profit */}
      <div style={stepBox}>
        <div style={stepTitle}><span>3)</span> ترحيل الأرباح إلى الأرباح المحتجزة</div>
        <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 8px" }}>
          نقل رصيد ملخص الأرباح والخسائر إلى حساب الأرباح المحتجزة.
        </p>
        <Row>
          <Field label="حساب ملخص الأرباح والخسائر">
            <SearchCombobox
              value={plSummaryId}
              onChange={(v) => setPlSummaryId(v === "" ? "" : Number(v))}
              options={accountOptions}
              placeholder="— اختر حساباً —"
            />
          </Field>
          <Field label="حساب الأرباح المحتجزة">
            <SearchCombobox
              value={retainedId}
              onChange={(v) => setRetainedId(v === "" ? "" : Number(v))}
              options={accountOptions}
              placeholder="— اختر حساباً —"
            />
          </Field>
        </Row>
        <button style={btnPrimary} onClick={doTransfer} disabled={busy != null || !plSummaryId || !retainedId}>
          {busy === "transfer" ? "جارٍ الترحيل..." : "ترحيل الأرباح"}
        </button>
        {transferResult && (
          <div style={{ marginTop: 10, fontSize: 13, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: 10 }}>
            <span style={{ color: transferResult.isProfit ? "#047857" : "#b91c1c" }}>
              {transferResult.isProfit ? "تم ترحيل ربح" : "تم ترحيل خسارة"}: <b style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(Math.abs(transferResult.amount))} {sym}</b>
            </span>
          </div>
        )}
      </div>

      {/* Step 4 — soft close */}
      <div style={stepBox}>
        <div style={stepTitle}><span>4)</span> الإقفال الناعم</div>
        <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 8px" }}>
          إقفال الفترة مع إمكانية إعادة فتحها لاحقاً. يمنع ترحيل قيود جديدة داخل الفترة.
        </p>
        {requiresPlClose && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 13, cursor: "pointer", color: "#92400e" }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            فرض الإقفال الناعم رغم وجود أرصدة أرباح وخسائر مفتوحة (force)
          </label>
        )}
        <button style={btnPrimary} onClick={doSoftClose} disabled={busy != null}>
          {busy === "soft" ? "جارٍ الإقفال..." : "إقفال ناعم"}
        </button>
        {softResult && (
          <div style={{ marginTop: 10, fontSize: 13, color: "#047857", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 6, padding: 10 }}>
            ✓ تم الإقفال الناعم{softResult.forced ? " (بالفرض)" : ""}{softResult.plClosed ? " — تم إقفال الأرباح والخسائر" : ""}
          </div>
        )}
      </div>

      {/* Step 5 — hard close */}
      <div style={stepBox}>
        <div style={stepTitle}><span>5)</span> الإقفال النهائي</div>
        <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 8px" }}>
          إقفال نهائي للفترة. لا يمكن التراجع عنه إلا بفك قفل إجباري (صلاحية مدير).
        </p>
        <button style={btnDanger} onClick={doHardClose} disabled={busy != null}>
          {busy === "hard" ? "جارٍ الإقفال النهائي..." : "إقفال نهائي"}
        </button>
        {done && (
          <div style={{ marginTop: 10, fontSize: 13, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: 10 }}>
            ✓ تم الإقفال النهائي للفترة.
          </div>
        )}
      </div>

      <ErrorMsg text={err} />
      <Actions>
        <button style={btnSecondary} onClick={onClose} disabled={busy != null}>إغلاق</button>
      </Actions>
    </Modal>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", textAlign: "center", background: warn ? "#fffbeb" : "#f8fafc" }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: warn ? "#b45309" : "#0f172a", fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{label}</div>
    </div>
  );
}
