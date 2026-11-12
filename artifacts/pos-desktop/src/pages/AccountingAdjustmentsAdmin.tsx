import { useEffect, useMemo, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import { listAccounts, type Account } from "../lib/accounting";
import { listCostCenters, type CostCenter } from "../lib/costCenters";
import {
  carryForwardAccountingAdjustment,
  createAccountingAdjustment,
  deleteAccountingAdjustment,
  generateAccountingAdjustment,
  listAccountingAdjustments,
  runDueAccountingAdjustments,
  setAccountingAdjustmentStatus,
  updateAccountingAdjustment,
  type AccountingAdjustment,
  type AccountingAdjustmentInput,
  type AccountingAdjustmentType,
} from "../lib/accountingAdjustments";
import { useUiLanguage } from "../lib/appSettings";
import {
  Actions, Card, Empty, ErrorMsg, Field, fmt, input, btnPrimary, btnSecondary, btnDanger,
  Modal, Page, Row, SearchCombobox, Table, Th, Td,
} from "./_adminUi";

type FormState = {
  type: AccountingAdjustmentType;
  name: string;
  expenseAccountId: string;
  contraAccountId: string;
  costCenterId: string;
  totalAmount: string;
  startDate: string;
  endDate: string;
  autoGenerate: boolean;
  carryForwardEnabled: boolean;
  notes: string;
};

const anniversaryMonths = (start: string, end: string) => {
  if (!start || !end) return 0;
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  return Math.max(0, (ey - sy) * 12 + (em - sm) - (ed < sd ? 1 : 0) + 1);
};

const localToday = () => {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

function defaultEndDate() {
  const start = localToday();
  const [year, month, day] = start.split("-").map(Number);
  const end = new Date(Date.UTC(year, month - 1, day));
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function emptyForm(): FormState {
  return {
    type: "prepaid", name: "", expenseAccountId: "", contraAccountId: "", costCenterId: "",
    totalAmount: "", startDate: localToday(), endDate: defaultEndDate(), autoGenerate: true,
    carryForwardEnabled: true, notes: "",
  };
}

const statusLabels: Record<AccountingAdjustment["status"], [string, string]> = {
  active: ["نشط", "Active"],
  completed: ["مكتمل", "Completed"],
  cancelled: ["ملغى", "Cancelled"],
  carried_forward: ["مُرحَّل", "Carried forward"],
};

export default function AccountingAdjustmentsAdmin() {
  const language = useUiLanguage();
  const t = (ar: string, en: string) => language === "en" ? en : ar;
  const [adjustments, setAdjustments] = useState<AccountingAdjustment[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<AccountingAdjustment | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [carryFor, setCarryFor] = useState<AccountingAdjustment | null>(null);
  const [carryStart, setCarryStart] = useState("");
  const [carryEnd, setCarryEnd] = useState("");

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [nextAdjustments, nextAccounts, nextCenters] = await Promise.all([
        listAccountingAdjustments(), listAccounts(), listCostCenters(),
      ]);
      setAdjustments(nextAdjustments);
      setAccounts(nextAccounts);
      setCostCenters(nextCenters);
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? t("تعذر تحميل التسويات", "Could not load adjustments"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useDataRefresh(["journal", "accounts", "costCenters"], () => { void refresh(); });

  const postableAccounts = useMemo(
    () => accounts.filter((account) => account.isLeaf && account.isActive)
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    [accounts],
  );
  const expenseOptions = useMemo(() => postableAccounts
    .filter((account) => account.type === "expense")
    .map((account) => ({ value: account.id, label: `${account.code} — ${language === "en" ? account.nameEn || account.nameAr : account.nameAr}` })),
  [postableAccounts, language]);
  const contraOptions = useMemo(() => postableAccounts
    .filter((account) => account.type === (form.type === "prepaid" ? "asset" : "liability"))
    .map((account) => ({ value: account.id, label: `${account.code} — ${language === "en" ? account.nameEn || account.nameAr : account.nameAr}` })),
  [postableAccounts, form.type, language]);
  const centerOptions = useMemo(() => [
    { value: "", label: t("بدون مركز تكلفة", "No cost center") },
    ...costCenters.filter((center) => center.isActive && center.isPosting)
      .map((center) => ({ value: center.id, label: `${center.code} — ${language === "en" ? center.nameEn || center.nameAr : center.nameAr}` })),
  ], [costCenters, language]);

  const installments = anniversaryMonths(form.startDate, form.endDate);
  const total = Number(form.totalAmount) || 0;
  const remainingInstallments = Math.max(0, installments - (editing?.runCount ?? 0));
  const recognized = editing?.recognizedAmount ?? 0;
  const monthlyPreview = remainingInstallments > 0
    ? Math.round((Math.max(0, total - recognized) / remainingInstallments) * 100) / 100
    : 0;
  const formValid = form.name.trim().length > 0 && Number(form.expenseAccountId) > 0
    && Number(form.contraAccountId) > 0 && Number(form.expenseAccountId) !== Number(form.contraAccountId)
    && Number.isFinite(total) && total > 0 && installments > 0 && form.endDate >= form.startDate;

  function startCreate() {
    setEditing(null);
    setForm(emptyForm());
    setError(null);
    setNotice(null);
    setShowForm(true);
  }

  function startEdit(item: AccountingAdjustment) {
    setEditing(item);
    setForm({
      type: item.type, name: item.name, expenseAccountId: String(item.expenseAccountId),
      contraAccountId: String(item.contraAccountId), costCenterId: item.costCenterId == null ? "" : String(item.costCenterId),
      totalAmount: String(item.totalAmount), startDate: item.startDate.slice(0, 10), endDate: item.endDate.slice(0, 10),
      autoGenerate: item.autoGenerate, carryForwardEnabled: item.carryForwardEnabled, notes: item.notes ?? "",
    });
    setError(null);
    setShowForm(true);
  }

  function payload(): AccountingAdjustmentInput {
    return {
      type: form.type, name: form.name.trim(), expenseAccountId: Number(form.expenseAccountId),
      contraAccountId: Number(form.contraAccountId), costCenterId: form.costCenterId ? Number(form.costCenterId) : null,
      totalAmount: Math.round(total * 100) / 100, startDate: form.startDate, endDate: form.endDate,
      autoGenerate: form.autoGenerate, carryForwardEnabled: form.carryForwardEnabled,
      notes: form.notes.trim() || null,
    };
  }

  async function save() {
    if (!formValid || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let id: number;
      if (editing) {
        await updateAccountingAdjustment(editing.id, payload());
        id = editing.id;
      } else {
        id = await createAccountingAdjustment(payload());
      }
      setShowForm(false);
      setEditing(null);
      if (form.autoGenerate && (!editing || editing.status === "active")) {
        try {
          const result = await generateAccountingAdjustment(id, localToday());
          if (result.created.length || result.skipped.length) {
            setNotice(t(
              `تم الحفظ؛ أُنشئ ${result.created.length} قيد، وتُرك ${result.skipped.length} شهر بسبب إقفال أو غياب فترة مالية.`,
              `Saved; created ${result.created.length} entries. ${result.skipped.length} month(s) were skipped because the fiscal period is closed or missing.`,
            ));
          } else {
            setNotice(t("تم الحفظ. لا توجد أقساط مستحقة اليوم.", "Saved. No installments are due today."));
          }
        } catch (e) {
          setNotice(t(
            `تم الحفظ، لكن تعذر تشغيل الأقساط المستحقة: ${typeof e === "string" ? e : (e as Error)?.message ?? ""}`,
            `Saved, but due installments could not run: ${typeof e === "string" ? e : (e as Error)?.message ?? ""}`,
          ));
        }
      } else {
        setNotice(t("تم حفظ التسوية.", "Adjustment saved."));
      }
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? t("تعذر حفظ التسوية", "Could not save adjustment"));
    } finally {
      setBusy(false);
    }
  }

  async function runDue() {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await runDueAccountingAdjustments(localToday());
      const skipped = result.summary.reduce((sum, item) => sum + item.skipped.length, 0);
      setNotice(t(
        `اكتمل التشغيل: ${result.total} قيد جديد${skipped ? `، ${skipped} شهر متخطّى` : ""}.`,
        `Run complete: ${result.total} new entries${skipped ? `, ${skipped} month(s) skipped` : ""}.`,
      ));
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? t("تعذر تشغيل التسويات", "Could not run adjustments"));
    } finally { setBusy(false); }
  }

  async function generateOne(item: AccountingAdjustment) {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await generateAccountingAdjustment(item.id, localToday());
      const firstSkip = result.skipped[0]?.reason;
      setNotice(result.created.length
        ? t(`تم إنشاء ${result.created.length} قيد للتسوية «${item.name}».`, `Created ${result.created.length} entry/entries for “${item.name}”.`)
        : firstSkip
          ? t(`لم يُنشأ قيد: ${firstSkip}`, `No entry created: ${firstSkip}`)
          : t("لا توجد أقساط مستحقة لهذه التسوية اليوم.", "No installments are due for this adjustment today."));
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? t("تعذر توليد القيود", "Could not generate entries"));
    } finally { setBusy(false); }
  }

  async function changeStatus(item: AccountingAdjustment, status: "active" | "cancelled") {
    const prompt = status === "cancelled"
      ? t("إلغاء الجدول؟ القيود المولّدة ستبقى في دفتر الأستاذ.", "Cancel this schedule? Generated entries remain in the ledger.")
      : t("إعادة تفعيل هذا الجدول؟", "Reactivate this schedule?");
    if (!window.confirm(prompt)) return;
    setBusy(true); setError(null);
    try {
      await setAccountingAdjustmentStatus(item.id, status);
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? t("تعذر تحديث الحالة", "Could not update status"));
    } finally { setBusy(false); }
  }

  async function remove(item: AccountingAdjustment) {
    if (!window.confirm(t(
      `حذف التسوية «${item.name}» نهائيًا؟ لا يمكن الحذف بعد إنشاء قيود.`,
      `Permanently delete “${item.name}”? Schedules with generated entries cannot be deleted.`,
    ))) return;
    setBusy(true); setError(null);
    try { await deleteAccountingAdjustment(item.id); await refresh(); }
    catch (e) { setError(typeof e === "string" ? e : (e as Error)?.message ?? t("تعذر حذف التسوية", "Could not delete adjustment")); }
    finally { setBusy(false); }
  }

  function startCarry(item: AccountingAdjustment) {
    const nextYear = Number(item.endDate.slice(0, 4)) + 1;
    setCarryFor(item);
    setCarryStart(`${nextYear}-01-01`);
    setCarryEnd(`${nextYear}-12-31`);
    setError(null);
  }

  async function carryForward() {
    if (!carryFor || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await carryForwardAccountingAdjustment(carryFor.id, carryStart, carryEnd);
      setNotice(t("تم إنشاء جدول جديد بالمبلغ المتبقي، وإغلاق الجدول الأصلي كمرحّل.", "A new schedule was created for the remaining balance, and the original was marked carried forward."));
      setCarryFor(null);
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? t("تعذر ترحيل المتبقي", "Could not carry forward the remaining amount"));
    } finally { setBusy(false); }
  }

  const accountName = (id: number) => {
    const account = accounts.find((item) => item.id === id);
    return account ? `${account.code} — ${language === "en" ? account.nameEn || account.nameAr : account.nameAr}` : `#${id}`;
  };
  const statusColor: Record<AccountingAdjustment["status"], string> = {
    active: "#047857", completed: "#475569", cancelled: "#b91c1c", carried_forward: "#7e22ce",
  };

  return (
    <Page
      title={t("التسويات الشهرية", "Monthly adjustments")}
      subtitle={t(
        "جدولة المصروفات المدفوعة مقدمًا والمستحقة بقيود محلية مرتبطة بدفتر الأستاذ.",
        "Schedule prepaid and accrued expenses with local journal entries linked to the general ledger.",
      )}
      right={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={btnSecondary} disabled={busy || adjustments.length === 0} onClick={() => void runDue()}>
            {busy ? "…" : t("تشغيل المستحق", "Run due")}
          </button>
          <button type="button" style={btnPrimary} disabled={busy} onClick={startCreate}>
            {t("تسوية جديدة", "New adjustment")}
          </button>
        </div>
      }
    >
      <div style={{ marginBottom: 12, padding: "10px 12px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, color: "#1e40af", fontSize: 13 }}>
        {t(
          "التشغيل محلي عند الضغط على «تشغيل المستحق»؛ لا يعمل التطبيق دون اتصال في الخلفية. القيود تتبع إعداد الترحيل العام، وتُحترم الفترات المالية المقفلة.",
          "Processing runs locally when you choose “Run due”; the offline app does not run a background scheduler. Entries follow posting settings and fiscal-period locks.",
        )}
      </div>
      {error && <ErrorMsg text={error} />}
      {notice && <div role="status" style={{ marginBottom: 10, padding: 9, borderRadius: 6, background: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0", fontSize: 13 }}>{notice}</div>}

      <Card>
        {loading ? <Empty text={t("جارٍ تحميل التسويات…", "Loading adjustments…")} /> : adjustments.length === 0 ? (
          <Empty text={t("لا توجد تسويات. أنشئ جدولًا للمصروف المدفوع مقدمًا أو المستحق.", "No adjustments yet. Create a schedule for a prepaid or accrued expense.")} />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <Table>
              <thead><tr>
                <Th>{t("التسوية", "Adjustment")}</Th>
                <Th>{t("الحسابات", "Accounts")}</Th>
                <Th>{t("الفترة / القسط", "Schedule / installment")}</Th>
                <Th style={{ textAlign: "left" }}>{t("الإجمالي / المعترف به", "Total / recognized")}</Th>
                <Th>{t("الحالة", "Status")}</Th>
                <Th>{t("إجراءات", "Actions")}</Th>
              </tr></thead>
              <tbody>
                {adjustments.map((item) => (
                  <tr key={item.id}>
                    <Td>
                      <div style={{ fontWeight: 700 }}>{item.name}</div>
                      <div style={{ color: "#64748b", fontSize: 12 }}>
                        {item.type === "prepaid" ? t("مصروف مدفوع مقدمًا", "Prepaid expense") : t("مصروف مستحق", "Accrued expense")}
                        {item.costCenterId != null && <span> · {costCenters.find((c) => c.id === item.costCenterId)?.code ?? t("مركز تكلفة", "Cost center")}</span>}
                      </div>
                    </Td>
                    <Td style={{ fontSize: 12 }}>
                      <div>{t("مصروف", "Expense")}: {accountName(item.expenseAccountId)}</div>
                      <div>{item.type === "prepaid" ? t("أصل مقدم", "Prepaid asset") : t("التزام", "Liability")}: {accountName(item.contraAccountId)}</div>
                    </Td>
                    <Td mono>
                      <div>{item.startDate.slice(0, 10)} → {item.endDate.slice(0, 10)}</div>
                      <div style={{ color: "#64748b", fontSize: 12 }}>
                        {fmt(item.monthlyAmount)} / {t("شهر", "month")} · {item.runCount} {t("قيد", "entry/entries")}
                        {item.lastGeneratedMonth ? ` · ${t("آخر", "last")} ${item.lastGeneratedMonth}` : ""}
                      </div>
                    </Td>
                    <Td num>
                      <div>{fmt(item.totalAmount)}</div>
                      <div style={{ color: "#64748b", fontSize: 12 }}>{t("معترف", "recognized")}: {fmt(item.recognizedAmount)}</div>
                      <div style={{ color: item.remainingAmount > 0.01 ? "#b45309" : "#047857", fontSize: 12 }}>{t("متبقٍ", "remaining")}: {fmt(item.remainingAmount)}</div>
                    </Td>
                    <Td>
                      <span style={{ display: "inline-block", padding: "3px 8px", borderRadius: 20, fontSize: 12, fontWeight: 700, color: statusColor[item.status], background: `${statusColor[item.status]}14` }}>
                        {t(...statusLabels[item.status])}
                      </span>
                      <div style={{ color: "#64748b", fontSize: 11, marginTop: 4 }}>
                        {item.autoGenerate ? t("ضمن تشغيل المستحق", "Included in Run due") : t("توليد يدوي", "Manual generation")}
                      </div>
                    </Td>
                    <Td>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minWidth: 210 }}>
                        {item.status === "active" && <button style={btnPrimary} disabled={busy} onClick={() => void generateOne(item)}>{t("توليد", "Generate")}</button>}
                        {(item.status === "active" || item.status === "completed") && <button style={btnSecondary} disabled={busy} onClick={() => startEdit(item)}>{t("تعديل", "Edit")}</button>}
                        {item.status === "active" && item.carryForwardEnabled && item.remainingAmount > 0.01 && (
                          <button style={btnSecondary} disabled={busy} onClick={() => startCarry(item)}>{t("ترحيل المتبقي", "Carry forward")}</button>
                        )}
                        {(item.status === "active" || item.status === "cancelled") && (
                          <button style={btnSecondary} disabled={busy} onClick={() => void changeStatus(item, item.status === "active" ? "cancelled" : "active")}>
                            {item.status === "active" ? t("إلغاء", "Cancel") : t("تفعيل", "Reactivate")}
                          </button>
                        )}
                        {item.runCount === 0 && item.status !== "carried_forward" && (
                          <button style={btnDanger} disabled={busy} onClick={() => void remove(item)}>{t("حذف", "Delete")}</button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      {showForm && (
        <Modal title={editing ? t("تعديل التسوية", "Edit adjustment") : t("إنشاء تسوية شهرية", "Create monthly adjustment")} onCancel={() => { if (!busy) setShowForm(false); }} wide>
          <Row>
            <Field label={t("نوع التسوية", "Adjustment type")}>
              <select value={form.type} onChange={(e) => setForm((current) => ({ ...current, type: e.target.value as AccountingAdjustmentType, contraAccountId: "" }))} style={input} disabled={!!editing && editing.runCount > 0}>
                <option value="prepaid">{t("مصروف مدفوع مقدمًا", "Prepaid expense")}</option>
                <option value="accrued">{t("مصروف مستحق", "Accrued expense")}</option>
              </select>
            </Field>
            <Field label={t("اسم التسوية", "Adjustment name")}>
              <input value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} style={input} maxLength={180} />
            </Field>
          </Row>
          <Row>
            <Field label={t("حساب المصروف", "Expense account")}>
              <SearchCombobox value={form.expenseAccountId ? Number(form.expenseAccountId) : ""} onChange={(value) => setForm((current) => ({ ...current, expenseAccountId: value === "" ? "" : String(value) }))} options={expenseOptions} style={input} />
            </Field>
            <Field label={form.type === "prepaid" ? t("حساب الأصل المدفوع مقدمًا", "Prepaid asset account") : t("حساب الالتزام", "Accrued liability account")}>
              <SearchCombobox value={form.contraAccountId ? Number(form.contraAccountId) : ""} onChange={(value) => setForm((current) => ({ ...current, contraAccountId: value === "" ? "" : String(value) }))} options={contraOptions} style={input} />
            </Field>
          </Row>
          <Row>
            <Field label={t("مركز تكلفة اختياري", "Optional cost center")}>
              <SearchCombobox value={form.costCenterId ? Number(form.costCenterId) : ""} onChange={(value) => setForm((current) => ({ ...current, costCenterId: value === "" ? "" : String(value) }))} options={centerOptions} style={input} />
            </Field>
            <Field label={t("المبلغ الإجمالي", "Total amount")}>
              <input type="number" min="0.01" step="0.01" value={form.totalAmount} onChange={(e) => setForm((current) => ({ ...current, totalAmount: e.target.value }))} style={{ ...input, direction: "ltr", textAlign: "right" }} />
            </Field>
          </Row>
          <Row>
            <Field label={t("تاريخ بداية العقد", "Schedule start date")}>
              <input type="date" value={form.startDate} onChange={(e) => setForm((current) => ({ ...current, startDate: e.target.value }))} style={input} disabled={!!editing && editing.runCount > 0} />
            </Field>
            <Field label={t("تاريخ نهاية العقد", "Schedule end date")}>
              <input type="date" value={form.endDate} onChange={(e) => setForm((current) => ({ ...current, endDate: e.target.value }))} style={input} />
            </Field>
          </Row>
          <div style={{ padding: "9px 11px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 7, fontSize: 13, marginBottom: 10 }}>
            {monthlyPreview > 0
              ? `${t("عدد الأقساط المتبقية", "Remaining installments")}: ${remainingInstallments} · ${t("القسط الشهري التقديري", "Estimated monthly installment")}: ${fmt(monthlyPreview)}`
              : t("أدخل فترة صالحة ومبلغًا أكبر من صفر لعرض القسط.", "Enter a valid period and a positive amount to preview the installment.")}
            {editing?.runCount ? <div style={{ color: "#64748b", marginTop: 3 }}>{t("سيعاد توزيع المتبقي على الأشهر غير المولّدة؛ القيود السابقة لا تتغير.", "The remaining balance is spread over ungenerated months; existing entries are unchanged.")}</div> : null}
          </div>
          <div style={{ display: "grid", gap: 8, marginBottom: 10, fontSize: 13 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={form.autoGenerate} onChange={(e) => setForm((current) => ({ ...current, autoGenerate: e.target.checked }))} />
              {t("ضمّنها عند الضغط على تشغيل المستحق", "Include this schedule when Run due is selected")}
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={form.carryForwardEnabled} onChange={(e) => setForm((current) => ({ ...current, carryForwardEnabled: e.target.checked }))} />
              {t("السماح بترحيل الرصيد المتبقي إلى جدول جديد", "Allow the remaining balance to be carried into a new schedule")}
            </label>
          </div>
          <Field label={t("ملاحظات", "Notes")}>
            <textarea value={form.notes} onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))} style={{ ...input, minHeight: 66, resize: "vertical" }} maxLength={1200} />
          </Field>
          <ErrorMsg text={error} />
          <Actions>
            <button type="button" style={btnSecondary} disabled={busy} onClick={() => setShowForm(false)}>{t("إلغاء", "Cancel")}</button>
            <button type="button" style={{ ...btnPrimary, opacity: !formValid || busy ? 0.55 : 1 }} disabled={!formValid || busy} onClick={() => void save()}>
              {busy ? "…" : editing ? t("حفظ التعديلات", "Save changes") : t("إنشاء التسوية", "Create schedule")}
            </button>
          </Actions>
        </Modal>
      )}

      {carryFor && (
        <Modal title={t("ترحيل المبلغ المتبقي", "Carry forward remaining balance")} onCancel={() => { if (!busy) setCarryFor(null); }}>
          <p style={{ marginTop: 0, fontSize: 13, color: "#475569" }}>
            {t("سيُنشأ جدول جديد، وتُعلّم التسوية الحالية كمُرحّلة. القيود السابقة تبقى كما هي.", "A new schedule will be created and the current one marked carried forward. Existing entries remain unchanged.")}
          </p>
          <div style={{ marginBottom: 12, padding: 10, background: "#f8fafc", borderRadius: 6, fontSize: 13 }}>
            {t("المتبقي", "Remaining")}: <strong>{fmt(carryFor.remainingAmount)}</strong>
          </div>
          <Row>
            <Field label={t("بداية الجدول الجديد", "New schedule start")}>
              <input type="date" value={carryStart} onChange={(e) => setCarryStart(e.target.value)} style={input} />
            </Field>
            <Field label={t("نهاية الجدول الجديد", "New schedule end")}>
              <input type="date" value={carryEnd} onChange={(e) => setCarryEnd(e.target.value)} style={input} />
            </Field>
          </Row>
          <ErrorMsg text={error} />
          <Actions>
            <button type="button" style={btnSecondary} disabled={busy} onClick={() => setCarryFor(null)}>{t("إلغاء", "Cancel")}</button>
            <button type="button" style={btnPrimary} disabled={busy || !carryStart || !carryEnd || carryEnd < carryStart} onClick={() => void carryForward()}>
              {busy ? "…" : t("إنشاء جدول الترحيل", "Create carry-forward schedule")}
            </button>
          </Actions>
        </Modal>
      )}
    </Page>
  );
}
