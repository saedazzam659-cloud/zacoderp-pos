import React, { useEffect, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listPurchaseReturns, getPurchaseReturn, createPurchaseReturn, listSuppliers,
  type PurchaseReturn, type PurchaseLine, type Supplier,
} from "../lib/accounting";
import { listItems, type LocalItem } from "../lib/items";
import { listUom, type Uom } from "../lib/uom";
import { listWarehouses, type Warehouse } from "../lib/inventory";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty, Pagination, pageSlice,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
  LineDiscountCell, InvoiceTotals, CurrencyExchangeFields, FormTabs, tabPanel,
  docFormShell, linesPanel, linesScroll, docFormPinned, contentPanel,
  useRowSelect, SelectTh, SelectCell, ActionBar, ActionBtn,
} from "./_adminUi";
import { ValidationPanel, collectDocIssues } from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { useInvoiceTaxes } from "./_invoiceTax";
import { baseCurrencyCode, currencyByCode } from "../lib/currency";
import {
  computeDiscount, lineNet, saveDocDiscount, getDocDiscount,
  type DiscType, type DiscFields,
} from "../lib/discount";
import { takePurchaseReturnPrefill, type PurchaseReturnPrefill } from "../lib/returnPrefill";

type FLine = PurchaseLine & DiscFields;

const RETURN_REASONS = [
  "تالف", "منتهي الصلاحية", "خطأ في الصنف", "زيادة في الكمية",
  "اتفاق مع المورد", "أخرى",
] as const;

export default function PurchaseReturnsAdmin() {
  const [rows, setRows] = useState<PurchaseReturn[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<PurchaseReturn | null>(null);
  const [creating, setCreating] = useState(false);
  // Prefill handed over from the purchase-invoice list ("إرجاع"). Taken ONCE on
  // mount; when present the create form opens automatically.
  const [prefill, setPrefill] = useState<PurchaseReturnPrefill | null>(null);
  const [deps, setDeps] = useState<{ suppliers: Supplier[]; items: LocalItem[]; warehouses: Warehouse[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  async function refresh() { setRows(await listPurchaseReturns(5000)); }
  useEffect(() => {
    const pf = takePurchaseReturnPrefill();
    if (pf) { setPrefill(pf); setCreating(true); }
    void refresh();
    void (async () => {
      const [suppliers, items, warehouses] = await Promise.all([listSuppliers(), listItems(), listWarehouses()]);
      setDeps({ suppliers, items, warehouses });
    })();
  }, []);

  function closeForm() { setCreating(false); setPrefill(null); }

  const sel = useRowSelect(rows);
  const { start, end, page: clampedPage } = pageSlice(rows.length, page, pageSize);
  const pageRows = rows.slice(start, end);
  useDataRefresh(["invoices"], refresh);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getPurchaseReturn(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  return (
    <Page
      title="مرتجع الشراء"
      subtitle={`${rows.length} مرتجع`}
      right={
        <button onClick={() => setCreating(true)} disabled={!deps || creating}
          style={{ ...btnPrimary, opacity: (!deps || creating) ? 0.5 : 1, cursor: (!deps || creating) ? "not-allowed" : "pointer" }}>
          + مرتجع شراء
        </button>
      }
    >
      {creating && deps && (
        <Card style={{ marginBottom: 12, border: "2px solid #2563eb" }}>
          <div style={{ padding: 16 }}>
            <CreateForm deps={deps} initial={prefill} onCancel={closeForm} onDone={() => { closeForm(); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && !creating && (
        <ActionBar selectedLabel={sel.selected ? sel.selected.returnNo : null}>
          <ActionBtn label={expandedId === sel.selectedId ? "إخفاء" : "عرض"} icon="▼" disabled={!sel.selected}
            onClick={() => { if (sel.selectedId != null) void toggleView(sel.selectedId); }} />
        </ActionBar>
      )}
      {!creating && <Card>
        {rows.length === 0 && !creating ? <Empty text="لا توجد مرتجعات" /> : (
          <Table>
            <thead><tr>
              <SelectTh />
              <Th>رقم المرتجع</Th><Th>التاريخ</Th><Th>المورد</Th>
              <Th style={{ textAlign: "left" }}>المجموع</Th><Th style={{ textAlign: "left" }}>الضريبة</Th>
              <Th style={{ textAlign: "left" }}>الإجمالي</Th>
            </tr></thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <SelectCell id={p.id} selectedId={sel.selectedId} onToggle={sel.toggle} />
                    <Td mono>{p.returnNo}</Td><Td>{p.returnDate}</Td><Td>{p.supplierName}</Td>
                    <Td num>{fmt(p.subtotal)}</Td><Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={7 as any}>
                        {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>... جاري التحميل</div> : (
                          <ReturnDetail r={expandedDetail} />
                        )}
                      </Td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </Table>
        )}
        {rows.length > 0 && (
          <Pagination total={rows.length} page={page} pageSize={pageSize}
            onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
        )}
      </Card>}
    </Page>
  );
}

function ReturnDetail({ r }: { r: PurchaseReturn }) {
  const disc = getDocDiscount("purchase_return", r.id);
  const discTotal = disc ? (disc.lineDiscountTotal + disc.headerDiscountValue) : 0;
  return (
    <div style={{ padding: 12 }}>
      {(r.reason || r.purchaseId) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 10, fontSize: 13, color: "#475569" }}>
          {r.reason && <span>سبب الإرجاع: <b style={{ color: "#0f172a" }}>{r.reason}</b></span>}
          {r.purchaseId && <span>فاتورة الشراء المرتبطة: <b style={{ color: "#0f172a" }}>#{r.purchaseId}</b></span>}
        </div>
      )}
      <Table>
        <thead><tr><Th>الصنف</Th><Th>الوحدة</Th><Th style={{ textAlign: "left" }}>الكمية</Th><Th style={{ textAlign: "left" }}>سعر الوحدة</Th><Th style={{ textAlign: "left" }}>الإجمالي</Th></tr></thead>
        <tbody>
          {r.lines.map((l, i) => (
            <tr key={l.id ?? i}><Td>{l.itemName}</Td><Td>{l.uomName ?? ""}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitCost)}</Td><Td num>{fmt(l.lineTotal)}</Td></tr>
          ))}
          {disc && discTotal > 0.00001 && (
            <>
              <tr style={{ background: "#fff", color: "#475569" }}><Td colSpan={4 as any}>الإجمالي قبل الخصم</Td><Td num>{fmt(disc.grossSubtotal)}</Td></tr>
              <tr style={{ background: "#fff", color: "#b45309" }}><Td colSpan={4 as any}>الخصم</Td><Td num>− {fmt(discTotal)}</Td></tr>
            </>
          )}
          {disc?.currencyCode && disc.currencyCode !== baseCurrencyCode() && (
            <tr style={{ background: "#fff", color: "#475569" }}><Td colSpan={4 as any}>العملة · سعر الصرف</Td><Td num>{disc.currencyCode} · {fmt(disc.exchangeRate ?? 1)}</Td></tr>
          )}
          <tr style={{ background: "#f1f5f9", fontWeight: 700 }}><Td colSpan={4 as any}>الإجمالي</Td><Td num>{fmt(r.grandTotal)}</Td></tr>
        </tbody>
      </Table>
    </div>
  );
}

function CreateForm({ deps, initial, onCancel, onDone }: { deps: { suppliers: Supplier[]; items: LocalItem[]; warehouses: Warehouse[] }; initial?: PurchaseReturnPrefill | null; onCancel: () => void; onDone: () => void }) {
  const [activeTab, setActiveTab] = useState<"basic" | "lines" | "payments">("basic");
  const [supplierId, setSupplierId] = useState<number>(initial?.supplierId ?? deps.suppliers[0]?.id ?? 0);
  const [date, setDate] = useState(todayStr());
  const [warehouseId, setWarehouseId] = useState<number>(
    initial?.warehouseId ?? (deps.warehouses.find((w) => w.is_default) ?? deps.warehouses[0])?.id ?? 0,
  );
  const { branches, costCenters } = useDimensions();
  const [branchId, setBranchId] = useState<number | "">("");
  useEffect(() => { if (branchId === "" && branches.length === 1) setBranchId(branches[0].id); }, [branches]); // eslint-disable-line react-hooks/exhaustive-deps
  const [costCenterId, setCostCenterId] = useState<number | "">("");
  const [reason, setReason] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [uoms] = useState<Uom[]>(() => listUom());
  const defUom = uoms.find((u) => u.isDefault) ?? uoms[0];
  const blankLine = (): FLine => ({
    itemId: 0, qty: 1, unitCost: 0, vatRate: 0, lineTotal: 0, disc: 0, discType: "percent",
    uomId: defUom?.id ?? null, uomName: defUom?.nameAr ?? null, conversionFactor: defUom?.baseQty ?? 1,
  });
  const [lines, setLines] = useState<FLine[]>(() =>
    initial?.lines?.length
      ? initial.lines.map((l) => ({ ...l, disc: 0, discType: "percent" as DiscType }))
      : [blankLine()],
  );
  const [headerDisc, setHeaderDisc] = useState(0);
  const [headerDiscType, setHeaderDiscType] = useState<DiscType>("percent");
  const [currency, setCurrency] = useState<string>(() => baseCurrencyCode());
  const [exchangeRate, setExchangeRate] = useState<number>(1);
  const effRate = currency === baseCurrencyCode() ? 1 : (exchangeRate || 1);
  const docSym = currencyByCode(currency).symbol;
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { taxes, taxId, setTaxId, taxOptions, selectedRate } = useInvoiceTaxes("purchase_return");

  function setLine(i: number, patch: Partial<FLine>) {
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      const next = { ...l, ...patch };
      // Default the line's unit from the chosen item.
      if (patch.itemId !== undefined) {
        const it = deps.items.find((x) => x.id === Number(patch.itemId));
        // VAT comes ONLY from the picked item (0 if it has no registered rate).
        if (it) next.vatRate = it.vatRate ?? 0;
        if (it && it.uomId != null) {
          const u = uoms.find((x) => x.id === it.uomId);
          if (u) { next.uomId = u.id; next.uomName = u.nameAr; next.conversionFactor = u.baseQty; }
        }
      }
      // Unit change: cost stays per SELECTED unit; factor only affects stock.
      if (patch.uomId !== undefined) {
        const u = uoms.find((x) => x.id === Number(patch.uomId));
        if (u) { next.uomName = u.nameAr; next.conversionFactor = u.baseQty; }
      }
      // A selected header tax overrides any per-line rate so one tax applies to
      // the whole invoice.
      if (selectedRate != null) next.vatRate = selectedRate;
      // Per-line الإجمالي reflects the line discount (header shown in totals panel).
      const { net } = lineNet(next.qty, next.unitCost, next.disc, next.discType);
      next.lineTotal = net + net * (Number(next.vatRate) || 0) / 100;
      return next;
    }));
  }
  function addLine() {
    setLines((ls) => {
      const nl = blankLine();
      if (selectedRate != null) nl.vatRate = selectedRate;
      return [...ls, nl];
    });
  }
  function removeLine(i: number) { setLines((ls) => ls.filter((_, k) => k !== i)); }
  function onSelectTax(v: string | number) {
    const id = v === "" ? "" : Number(v);
    setTaxId(id);
    const t = taxes.find((x) => x.id === id);
    if (!t) return;
    const rate = t.rateValue;
    setLines((ls) => ls.map((l) => {
      const { net } = lineNet(l.qty, l.unitCost, l.disc, l.discType);
      return { ...l, vatRate: rate, lineTotal: net + net * rate / 100 };
    }));
  }

  const result = computeDiscount(
    lines.map((l) => ({ qty: l.qty, unit: l.unitCost, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
    headerDisc, headerDiscType,
  );

  async function save() {
    setBusy(true); setErr(null); setIssues([]);
    try {
      const problems = collectDocIssues([
        { label: "المورد", ok: !!supplierId },
        { label: "العملة", ok: !!currency },
        ...(branches.length ? [{ label: "الفرع", ok: branchId !== "" }] : []),
        { label: "المستودع", ok: !!warehouseId },
      ], lines.map((l) => ({ itemId: l.itemId, uomId: l.uomId ?? null, price: l.unitCost, qty: l.qty })), "سعر الشراء");
      if (problems.length) { setIssues(problems); setBusy(false); return; }
      const cleaned = lines.filter((l) => l.itemId && (l.qty || 0) > 0);
      if (currency !== baseCurrencyCode() && !(exchangeRate > 0)) throw new Error("أدخل سعر صرف صحيح للعملة الأجنبية");
      // Fold the discount into each unit cost; Rust recomputes totals from
      // qty × unitCost so VAT lands on the net base (ZATCA-correct).
      const r = computeDiscount(
        cleaned.map((l) => ({ qty: l.qty, unit: l.unitCost, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
        headerDisc, headerDiscType,
      );
      const payloadLines: PurchaseLine[] = cleaned.map((l, i) => {
        // Bake discount AND the FX conversion into the base-currency unit cost.
        const net = r.netUnitPrices[i] * effRate;
        return {
          itemId: l.itemId, itemName: l.itemName, qty: l.qty, unitCost: net, vatRate: l.vatRate,
          lineTotal: l.qty * net * (1 + (Number(l.vatRate) || 0) / 100),
          uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
        };
      });
      const id = await createPurchaseReturn({ supplierId, purchaseId: initial?.purchaseId ?? null, returnDate: date, warehouseId: warehouseId || null, branchId: branchId === "" ? null : branchId, costCenterId: costCenterId === "" ? null : costCenterId, reason: reason || null, notes: notes || null, lines: payloadLines });
      saveDocDiscount("purchase_return", id, {
        grossSubtotal: r.grossSubtotal * effRate, lineDiscountTotal: r.lineDiscountTotal * effRate, headerDiscountValue: r.headerDiscountValue * effRate,
        currencyCode: currency, exchangeRate: effRate,
      });
      onDone();
    } catch (e: any) { setErr(typeof e === "string" ? e : (e?.message ?? "فشل")); }
    finally { setBusy(false); }
  }

  return (
    <div style={docFormShell}>
      <h3 style={{ marginTop: 0, flexShrink: 0 }}>مرتجع شراء جديد</h3>
      <style>{`.zlines-wrap thead th{position:sticky;top:0;z-index:2;}`}</style>
      <FormTabs active={activeTab} onChange={setActiveTab} tabs={[
        { key: "basic", label: "البيانات الأساسية" },
        { key: "lines", label: `بنود الأصناف${lines.length ? ` (${lines.length})` : ""}` },
        { key: "payments", label: "المدفوعات" },
      ]} />

      <div style={contentPanel(activeTab, "basic")}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
        <Field label="المورد *">
          <SearchCombobox
            value={supplierId}
            onChange={(v) => setSupplierId(Number(v))}
            style={input}
            options={[
              { value: 0, label: "— اختر —" },
              ...deps.suppliers.map((s) => ({ value: s.id, label: s.nameAr })),
            ]}
          />
        </Field>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="المستودع">
          <SearchCombobox
            value={warehouseId}
            onChange={(v) => setWarehouseId(Number(v))}
            style={input}
            options={[
              { value: 0, label: "— المستودع الافتراضي —" },
              ...deps.warehouses.map((w) => ({ value: w.id, label: w.name })),
            ]}
          />
        </Field>
        <Field label="الضريبة">
          <SearchCombobox value={taxId} onChange={onSelectTax} options={taxOptions} style={input} />
        </Field>
        <Field label="الفرع">
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label="مركز التكلفة">
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={costCenterPickerOptions(costCenters)} style={input} />
        </Field>
        <CurrencyExchangeFields currency={currency} exchangeRate={exchangeRate} onCurrency={setCurrency} onRate={setExchangeRate} />
      </div>
      </div>

      <div style={linesPanel(activeTab)}>
      <div className="zlines-wrap" style={{ ...linesScroll, marginTop: 10 }}>
      <Table style={{ minWidth: 1250 }}>
        <thead><tr>
          <Th style={{ minWidth: 240 }}>الصنف</Th><Th style={{ width: 130 }}>الوحدة</Th><Th style={{ width: 180 }}>الكمية</Th><Th style={{ width: 240 }}>سعر الوحدة</Th><Th style={{ width: 170 }}>الخصم</Th><Th style={{ width: 80 }}>ض. %</Th>
          <Th style={{ width: 120, textAlign: "left" }}>الإجمالي</Th><Th style={{ width: 40 }}></Th>
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>
                <SearchCombobox
                  value={l.itemId}
                  onChange={(v) => setLine(i, { itemId: Number(v) })}
                  style={input}
                  options={[
                    { value: 0, label: "— اختر —" },
                    ...deps.items.map((it) => ({ value: it.id, label: it.nameAr })),
                  ]}
                />
              </Td>
              <Td>
                <SearchCombobox
                  value={l.uomId ?? 0}
                  onChange={(v) => setLine(i, { uomId: Number(v) })}
                  style={input}
                  options={uoms.map((u) => ({ value: u.id, label: u.baseQty !== 1 ? `${u.nameAr} (×${u.baseQty})` : u.nameAr }))}
                />
              </Td>
              <Td><input type="number" step="0.001" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><LineDiscountCell amount={l.disc ?? 0} type={l.discType ?? "percent"} gross={(Number(l.qty) || 0) * (Number(l.unitCost) || 0)} sym={docSym} onAmount={(v) => setLine(i, { disc: v })} onType={(t) => setLine(i, { discType: t })} /></Td>
              <Td><input type="number" step="0.01" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td num>{fmt(l.lineTotal)}</Td>
              <Td><button onClick={() => removeLine(i)} type="button" style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
            </tr>
          ))}
        </tbody>
      </Table>
      </div>
      <button onClick={addLine} type="button" style={{ ...btnSecondary, marginTop: 8, flexShrink: 0 }}>+ سطر</button>
      <div style={docFormPinned}>
      <InvoiceTotals result={result} headerDisc={headerDisc} headerType={headerDiscType} sym={docSym} rate={effRate} onHeaderDisc={setHeaderDisc} onHeaderType={setHeaderDiscType} />
      </div>
      </div>

      <div style={contentPanel(activeTab, "payments")}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
        <Field label="سبب الإرجاع">
          <SearchCombobox
            value={reason}
            onChange={(v) => setReason(String(v))}
            style={input}
            options={[
              { value: "", label: "— بدون —" },
              ...RETURN_REASONS.map((rr) => ({ value: rr, label: rr })),
            ]}
          />
        </Field>
      </div>
      <Field label="ملاحظات" style={{ marginTop: 12 }}><textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} /></Field>
      </div>

      <div style={docFormPinned}>
      <ValidationPanel issues={issues} />
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : "حفظ وترحيل"}</button>
      </Actions>
      </div>
    </div>
  );
}
