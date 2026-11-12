import { useEffect, useMemo, useRef, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  createJournalEntry, getJournalEntryDetail, listAccounts, listJournalEntriesByType,
  unpostJournalEntry, updateJournalEntry, confirmUnpostAction,
  type Account, type ManualJeDetail, type ManualJeLine,
} from "../lib/accounting";
import { Page, Card, Table, Th, Td, Field, Empty, ErrorMsg, Actions, ExportButtons, input, btnPrimary, btnSecondary, fmt, todayStr, SearchCombobox } from "./_adminUi";
import { useDimensions, branchPickerOptions } from "./_reportFilters";
import type { ExportColumn } from "../lib/exporters";
import { useUiLanguage } from "../lib/appSettings";

type Amounts = Record<number, { debit: string; credit: string }>;
type ExportRow = { code: string; name: string; debit: number | string; credit: number | string };

const parseAmount = (value: string) => {
  const amount = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
};
const openingDateDefault = () => `${todayStr().slice(0, 4)}-01-01`;
const openingDescriptionDefault = () => `الأرصدة الافتتاحية ${todayStr().slice(0, 4)}`;

function amountsFromEntry(entry: ManualJeDetail): Amounts {
  const result: Amounts = {};
  for (const line of entry.lines) {
    const previous = result[line.accountId] ?? { debit: "", credit: "" };
    const net = parseAmount(String(previous.debit)) - parseAmount(String(previous.credit))
      + (Number(line.debit) || 0) - (Number(line.credit) || 0);
    result[line.accountId] = net >= 0
      ? { debit: net > 0 ? String(Number(net.toFixed(2))) : "", credit: "" }
      : { debit: "", credit: String(Number((-net).toFixed(2))) };
  }
  return result;
}

export default function OpeningBalancesAdmin() {
  const language = useUiLanguage();
  const t = (ar: string, en: string) => language === "en" ? en : ar;
  const { branches } = useDimensions();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entry, setEntry] = useState<ManualJeDetail | null>(null);
  const [entryCount, setEntryCount] = useState(0);
  const [amounts, setAmounts] = useState<Amounts>({});
  const [entryDate, setEntryDate] = useState(openingDateDefault);
  const [description, setDescription] = useState(openingDescriptionDefault);
  const [branchId, setBranchId] = useState<number | "">("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const [nextAccounts, openings] = await Promise.all([listAccounts(), listJournalEntriesByType("opening")]);
      setAccounts(nextAccounts);
      setEntryCount(openings.length);
      if (openings.length > 1) {
        setEntry(null);
        setAmounts({});
        setErr(t("وُجد أكثر من قيد افتتاحي. لن يتم إنشاء أو تعديل أي قيد حتى تتم مراجعة القيود المكررة من شاشة القيود اليومية.",
          "Multiple opening entries were found. Review the duplicates in Journal Entries before creating or editing one."));
        return;
      }
      if (openings.length === 0) {
        setEntry(null);
        setAmounts({});
        setEntryDate(openingDateDefault());
        setDescription(openingDescriptionDefault());
        setBranchId("");
        dirtyRef.current = false;
        return;
      }
      const detail = await getJournalEntryDetail(openings[0].id);
      setEntry(detail);
      setAmounts(amountsFromEntry(detail));
      setEntryDate(detail.entryDate.slice(0, 10));
      setDescription(detail.description ?? "");
      setBranchId(detail.branchId ?? "");
      dirtyRef.current = false;
    } catch (e) {
      setErr(typeof e === "string" ? e : (e as Error)?.message ?? t("تعذر تحميل الأرصدة الافتتاحية", "Could not load opening balances"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useDataRefresh(["accounts", "journal"], () => {
    if (!dirtyRef.current) void refresh();
  });

  useEffect(() => {
    if (entry || branchId !== "") return;
    const defaultBranch = branches.find((branch) => branch.isActive);
    if (defaultBranch) setBranchId(defaultBranch.id);
  }, [entry, branches, branchId]);

  const postableAccounts = useMemo(() => {
    const existingIds = new Set(entry?.lines.map((line) => line.accountId) ?? []);
    return accounts.filter((account) => (account.isLeaf && account.isActive) || existingIds.has(account.id))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [accounts, entry]);
  const visibleAccounts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return postableAccounts.filter((account) =>
      (typeFilter === "all" || account.type === typeFilter) &&
      (!query || account.code.toLowerCase().includes(query)
        || account.nameAr.toLowerCase().includes(query)
        || (account.nameEn ?? "").toLowerCase().includes(query))
    );
  }, [postableAccounts, typeFilter, search]);

  const totals = useMemo(() => postableAccounts.reduce((sum, account) => {
    const row = amounts[account.id];
    sum.debit += parseAmount(row?.debit ?? "");
    sum.credit += parseAmount(row?.credit ?? "");
    return sum;
  }, { debit: 0, credit: 0 }), [postableAccounts, amounts]);
  const balanced = Math.abs(totals.debit - totals.credit) < 0.01 && totals.debit > 0;
  const duplicateOpenings = entryCount > 1;
  const sourceLocked = !!entry && entry.sourceType !== null && entry.sourceType !== "manual";
  const readOnly = duplicateOpenings || entry?.status === "posted" || sourceLocked;

  const exportRows: ExportRow[] = visibleAccounts.map((account) => {
    const row = amounts[account.id];
    return {
      code: account.code,
      name: account.nameAr,
      debit: parseAmount(row?.debit ?? "") || "",
      credit: parseAmount(row?.credit ?? "") || "",
    };
  });
  const exportColumns: ExportColumn<ExportRow>[] = [
    { header: t("كود الحساب", "Account code"), cell: (row) => row.code },
    { header: t("الحساب", "Account"), cell: (row) => row.name },
    { header: t("مدين", "Debit"), cell: (row) => row.debit },
    { header: t("دائن", "Credit"), cell: (row) => row.credit },
  ];

  function changeAmount(accountId: number, side: "debit" | "credit", value: string) {
    dirtyRef.current = true;
    setAmounts((current) => ({
      ...current,
      [accountId]: side === "debit"
        ? { debit: value, credit: "" }
        : { debit: "", credit: value },
    }));
  }

  function buildLines(): ManualJeLine[] {
    return postableAccounts.flatMap((account) => {
      const row = amounts[account.id];
      const debit = parseAmount(row?.debit ?? "");
      const credit = parseAmount(row?.credit ?? "");
      return debit || credit
        ? [{ accountId: account.id, debit, credit, description: description.trim() || null }]
        : [];
    });
  }

  async function save(status: "draft" | "posted") {
    if (readOnly) return;
    const invalidAmount = postableAccounts.some((account) => {
      const row = amounts[account.id];
      return [row?.debit ?? "", row?.credit ?? ""].some((raw) => {
        const value = raw.trim();
        return value !== "" && (!/^\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value)));
      });
    });
    if (invalidAmount) {
      setErr(t("تحقق من المبالغ؛ استخدم أرقامًا موجبة وبحد أقصى منزلتين عشريتين.", "Check the amounts: use positive numbers with at most two decimal places."));
      return;
    }
    const lines = buildLines();
    if (lines.length < 2) {
      setErr(t("أدخل أرصدة لحسابين على الأقل", "Enter balances for at least two accounts"));
      return;
    }
    if (!balanced) {
      setErr(t("يجب توازن إجمالي المدين والدائن قبل حفظ الأرصدة.", "Debit and credit totals must balance before saving."));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        entryDate,
        description: description.trim() || null,
        entryType: "opening" as const,
        status,
        branchId: branchId === "" ? null : branchId,
        lines,
      };
      if (entry) {
        await updateJournalEntry(entry.id, payload);
      } else {
        await createJournalEntry(payload);
      }
      dirtyRef.current = false;
      await refresh();
    } catch (e) {
      setErr(typeof e === "string" ? e : (e as Error)?.message ?? t("تعذر حفظ الأرصدة الافتتاحية", "Could not save opening balances"));
    } finally {
      setBusy(false);
    }
  }

  async function unpost() {
    if (!entry || entry.status !== "posted") return;
    if (!(await confirmUnpostAction(
      t("قيد الأرصدة الافتتاحية", "opening balance entry"),
      entry.entryNo,
      language === "en",
    ))) return;
    setBusy(true);
    dirtyRef.current = true;
    setErr(null);
    try {
      await unpostJournalEntry(entry.id);
      dirtyRef.current = false;
      await refresh();
    } catch (e) {
      dirtyRef.current = false;
      setErr(typeof e === "string" ? e : (e as Error)?.message ?? t("تعذر فك ترحيل القيد", "Could not unpost the entry"));
    } finally {
      setBusy(false);
    }
  }

  const branchOptions = branchPickerOptions(branches);

  return (
    <Page
      title={t("الأرصدة الافتتاحية", "Opening balances")}
      subtitle={t("أدخل الأرصدة على الحسابات الترحيلية. عند الترحيل تُحفظ كقيد افتتاحي في الأستاذ العام.",
        "Enter balances for posting accounts. Posting records them as an opening journal entry in the general ledger.")}
      right={entry && <span style={{ fontSize: 12, color: "#64748b" }}>{entry.entryNo} · {entry.status === "posted" ? t("مرحّل", "Posted") : t("مسودة", "Draft")}</span>}
    >
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <Field label={t("تاريخ الأرصدة", "Balance date")}>
            <input type="date" value={entryDate} onChange={(e) => { dirtyRef.current = true; setEntryDate(e.target.value); }} style={input} disabled={readOnly} />
          </Field>
          <Field label={t("الفرع", "Branch")}>
            <SearchCombobox
              value={branchId}
              onChange={(value) => { dirtyRef.current = true; setBranchId(value === "" ? "" : Number(value)); }}
              options={branchOptions}
              style={input}
              disabled={readOnly}
            />
          </Field>
          <Field label={t("البيان", "Description")}>
            <input value={description} onChange={(e) => { dirtyRef.current = true; setDescription(e.target.value); }} style={{ ...input, minWidth: 280 }} disabled={readOnly} />
          </Field>
          <Field label={t("بحث", "Search")}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("كود أو اسم الحساب", "Account code or name")} style={input} />
          </Field>
          <Field label={t("نوع الحساب", "Account type")}>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={input}>
              <option value="all">{t("كل الأنواع", "All types")}</option>
              <option value="asset">{t("أصول", "Assets")}</option>
              <option value="liability">{t("خصوم", "Liabilities")}</option>
              <option value="equity">{t("حقوق ملكية", "Equity")}</option>
              <option value="revenue">{t("إيرادات", "Revenue")}</option>
              <option value="expense">{t("مصروفات", "Expenses")}</option>
            </select>
          </Field>
        </div>
        {err && <ErrorMsg text={err} />}
      </Card>

      <Card>
        {loading ? <Empty text={t("جارٍ تحميل الحسابات...", "Loading accounts...")} /> : postableAccounts.length === 0 ? (
          <Empty text={t("لا توجد حسابات ترحيلية نشطة. أضفها أولاً من شجرة الحسابات.", "No active posting accounts. Add them in Chart of Accounts first.")} />
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
              <ExportButtons columns={exportColumns} rows={exportRows} filenameBase={t("الأرصدة-الافتتاحية", "opening-balances")} title={`${t("الأرصدة الافتتاحية", "Opening balances")} — ${entryDate}`} />
            </div>
            <Table>
              <thead><tr><Th style={{ width: 140 }}>{t("كود الحساب", "Account code")}</Th><Th>{t("الحساب", "Account")}</Th><Th style={{ width: 210, textAlign: "left" }}>{t("مدين", "Debit")}</Th><Th style={{ width: 210, textAlign: "left" }}>{t("دائن", "Credit")}</Th></tr></thead>
              <tbody>
                {visibleAccounts.map((account) => {
                  const row = amounts[account.id] ?? { debit: "", credit: "" };
                  return (
                    <tr key={account.id}>
                      <Td mono>{account.code}</Td>
                      <Td>{account.nameAr}</Td>
                      <Td num>
                        <input
                          inputMode="decimal"
                          value={row.debit}
                          onChange={(e) => changeAmount(account.id, "debit", e.target.value)}
                          style={{ ...input, direction: "ltr", textAlign: "right", width: 170 }}
                          disabled={readOnly}
                          aria-label={`${t("مدين", "Debit")} ${account.nameAr}`}
                        />
                      </Td>
                      <Td num>
                        <input
                          inputMode="decimal"
                          value={row.credit}
                          onChange={(e) => changeAmount(account.id, "credit", e.target.value)}
                          style={{ ...input, direction: "ltr", textAlign: "right", width: 170 }}
                          disabled={readOnly}
                          aria-label={`${t("دائن", "Credit")} ${account.nameAr}`}
                        />
                      </Td>
                    </tr>
                  );
                })}
                {visibleAccounts.length === 0 && <tr><Td colSpan={4}><Empty text={t("لا توجد حسابات مطابقة", "No matching accounts")} /></Td></tr>}
                <tr style={{ fontWeight: 700, background: "#f8fafc" }}>
                  <Td colSpan={2}>{t("الإجمالي", "Total")}</Td>
                  <Td num>{fmt(totals.debit)}</Td>
                  <Td num>{fmt(totals.credit)}</Td>
                </tr>
              </tbody>
            </Table>
            <div style={{
              marginTop: 12, padding: "9px 12px", borderRadius: 7, fontWeight: 700, fontSize: 13,
              color: balanced ? "#047857" : "#b91c1c", background: balanced ? "#ecfdf5" : "#fef2f2",
            }}>
              {balanced ? t("الأرصدة متوازنة وجاهزة للترحيل", "Balances are even and ready to post") : `${t("الفرق", "Difference")}: ${fmt(Math.abs(totals.debit - totals.credit))}`}
            </div>
          </>
        )}
      </Card>

      <Actions>
        {entry?.status === "posted" && !sourceLocked && <button onClick={unpost} disabled={busy} style={btnSecondary}>{t("فك الترحيل للتعديل", "Unpost to edit")}</button>}
        {!readOnly && (
          <>
            <button onClick={() => void save("draft")} disabled={busy || !balanced || buildLines().length < 2} style={btnSecondary}>{busy ? "..." : t("حفظ كمسودة", "Save draft")}</button>
            <button onClick={() => void save("posted")} disabled={busy || !balanced || buildLines().length < 2} style={btnPrimary}>{busy ? "..." : t("حفظ وترحيل", "Save and post")}</button>
          </>
        )}
        {entry?.status === "posted" && !sourceLocked && <span style={{ color: "#64748b", fontSize: 12 }}>{t("فك ترحيل القيد أولاً لتعديل الأرصدة.", "Unpost the entry before editing balances.")}</span>}
        {sourceLocked && <span style={{ color: "#b91c1c", fontSize: 12 }}>{t("هذا القيد مرتبط بمصدر نظامي؛ عدّله من المستند المصدر.", "This entry is system-linked; edit it from its source document.")}</span>}
        {duplicateOpenings && <span style={{ color: "#b91c1c", fontSize: 12 }}>{t("تم إيقاف التعديل بسبب وجود قيود افتتاحية مكررة.", "Editing is disabled because duplicate opening entries exist.")}</span>}
      </Actions>
    </Page>
  );
}
