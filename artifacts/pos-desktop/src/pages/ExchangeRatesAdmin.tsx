import { useEffect, useMemo, useState } from "react";
import { listCurrencies, listCurrencyRates, upsertCurrencyRate, deleteCurrencyRate, type Currency, type CurrencyRate } from "../lib/accounting";
import { Page, Card, Table, Th, Td, Empty, input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox, Field, Row, ErrorMsg } from "./_adminUi";

type Draft = { currencyCode: string; rateToBase: string; asOfDate: string; notes: string };

export default function ExchangeRatesAdmin() {
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [rows, setRows] = useState<CurrencyRate[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [draft, setDraft] = useState<Draft>({ currencyCode: "", rateToBase: "", asOfDate: todayStr(), notes: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const [cur, list] = await Promise.all([listCurrencies(false), listCurrencyRates(filter || undefined, 500)]);
    setCurrencies(cur); setRows(list);
    if (!draft.currencyCode) {
      const firstNonBase = cur.find(c => !c.isBase && c.isActive);
      if (firstNonBase) setDraft(d => ({ ...d, currencyCode: firstNonBase.code }));
    }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [filter]);

  const baseCode = currencies.find(c => c.isBase)?.code ?? "SAR";

  const nonBaseCurrencies = useMemo(() => currencies.filter(c => !c.isBase), [currencies]);

  async function save() {
    if (!draft.currencyCode) { setErr("اختر العملة"); return; }
    const rate = Number(draft.rateToBase);
    if (!isFinite(rate) || rate <= 0) { setErr("سعر الصرف يجب أن يكون رقمًا موجبًا"); return; }
    setBusy(true); setErr(null);
    try {
      await upsertCurrencyRate({
        currencyCode: draft.currencyCode,
        rateToBase: rate,
        asOfDate: draft.asOfDate,
        notes: draft.notes.trim() || null,
      });
      setDraft({ ...draft, rateToBase: "", notes: "" });
      await refresh();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }
  async function remove(r: CurrencyRate) {
    if (!confirm(`حذف سعر الصرف ${r.currencyCode} = ${r.rateToBase} في ${r.asOfDate}؟`)) return;
    try { await deleteCurrencyRate(r.id); await refresh(); } catch (e: any) { alert(e?.message ?? "فشل"); }
  }

  return (
    <Page
      title="أسعار الصرف"
      subtitle={`السعر = كم وحدة من العملة الأساسية (${baseCode}) تساوي وحدة واحدة من العملة. مثال: USD 3.75 يعني 1$ = 3.75 ${baseCode}.`}
    >
      <Card style={{ padding: 16, marginBottom: 16 }}>
        <h4 style={{ margin: "0 0 12px" }}>📝 إضافة / تحديث سعر</h4>
        <Row>
          <Field label="العملة">
            <SearchCombobox
              value={draft.currencyCode}
              onChange={(v) => setDraft({ ...draft, currencyCode: String(v) })}
              options={nonBaseCurrencies.map(c => ({ value: c.code, label: `${c.code} — ${c.nameAr}` }))}
              placeholder="— اختر —"
            />
          </Field>
          <Field label="التاريخ">
            <input type="date" value={draft.asOfDate} onChange={(e) => setDraft({ ...draft, asOfDate: e.target.value })} style={input} />
          </Field>
        </Row>
        <Row>
          <Field label={`السعر مقابل ${baseCode}`}>
            <input type="number" step="0.0001" min="0" value={draft.rateToBase} onChange={(e) => setDraft({ ...draft, rateToBase: e.target.value })} style={input} placeholder="3.7500" />
          </Field>
          <Field label="ملاحظات (اختياري)">
            <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} style={input} placeholder="مصدر السعر — مثلاً البنك المركزي" />
          </Field>
        </Row>
        <ErrorMsg text={err} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? "..." : "حفظ السعر"}</button>
          <button onClick={() => setDraft({ ...draft, rateToBase: "", notes: "" })} disabled={busy} style={btnSecondary}>تفريغ</button>
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #f1f5f9", background: "#f8fafc" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "#64748b" }}>تصفية:</span>
            <div style={{ minWidth: 200 }}>
              <SearchCombobox
                value={filter}
                onChange={(v) => setFilter(String(v))}
                options={[{ value: "", label: "كل العملات" }, ...nonBaseCurrencies.map(c => ({ value: c.code, label: `${c.code} — ${c.nameAr}` }))]}
              />
            </div>
          </div>
          <span style={{ fontSize: 13, color: "#64748b" }}>{rows.length} سجل</span>
        </div>
        {rows.length === 0 ? <Empty text="لا توجد أسعار صرف مسجلة" /> : (
          <Table>
            <thead><tr>
              <Th style={{ width: 120 }}>العملة</Th>
              <Th style={{ width: 140 }}>التاريخ</Th>
              <Th style={{ textAlign: "left", width: 160 }}>السعر</Th>
              <Th>ملاحظات</Th>
              <Th style={{ width: 100 }}>إجراءات</Th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td mono style={{ fontWeight: 700 }}>{r.currencyCode}</Td>
                  <Td mono>{r.asOfDate}</Td>
                  <Td num style={{ fontWeight: 600 }}>{fmt(r.rateToBase)}</Td>
                  <Td style={{ color: "#64748b", fontSize: 13 }}>{r.notes ?? "—"}</Td>
                  <Td><button onClick={() => remove(r)} style={{ ...btnLink, color: "#dc2626" }}>حذف</button></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
