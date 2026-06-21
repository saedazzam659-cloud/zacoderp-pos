import React, { useEffect, useState } from "react";
import {
  listQuotations, getQuotation, createQuotation, updateQuotation, deleteQuotation,
  setQuotationStatus, convertQuotationToInvoice,
  type Quotation, type QuotationStatus, type SalesLine,
} from "../lib/accounting";
import { listCustomers, type LocalCustomer } from "../lib/customers";
import { listItems, type LocalItem } from "../lib/items";
import { listUom, type Uom } from "../lib/uom";
import { listWarehouses, type Warehouse } from "../lib/inventory";
import { listSalespersons, type Salesperson } from "../lib/salespersons";
import { openWhatsApp, buildDocWhatsAppText } from "../lib/whatsapp";
import { getCompanyProfile } from "../lib/appSettings";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Actions, Empty, Pagination, pageSlice,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
  LineDiscountCell, InvoiceTotals, CurrencyExchangeFields,
} from "./_adminUi";
import { ValidationPanel, collectDocIssues } from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { useInvoiceTaxes } from "./_invoiceTax";
import { baseCurrencyCode, currencyByCode } from "../lib/currency";
import { computeDiscount, lineNet, type DiscType, type DiscFields } from "../lib/discount";

type FLine = SalesLine & DiscFields;

const STATUS: Record<QuotationStatus, { l: string; c: string }> = {
  draft:     { l: "مسودة",  c: "#475569" },
  sent:      { l: "مُرسل",   c: "#1e40af" },
  accepted:  { l: "مقبول",  c: "#15803d" },
  rejected:  { l: "مرفوض",  c: "#b91c1c" },
  converted: { l: "محوّل لفاتورة", c: "#7c3aed" },
};

function StatusBadge({ s }: { s: QuotationStatus }) {
  const x = STATUS[s];
  return <span style={{ background: x.c + "20", color: x.c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{x.l}</span>;
}

export default function QuotationsAdmin() {
  const [rows, setRows] = useState<Quotation[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<Quotation | null>(null);
  const [creating, setCreating] = useState(false);
  const [editDoc, setEditDoc] = useState<Quotation | null>(null);
  const [deps, setDeps] = useState<{ customers: LocalCustomer[]; items: LocalItem[]; warehouses: Warehouse[]; salespersons: Salesperson[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const formOpen = creating || editDoc !== null;

  async function refresh() { setRows(await listQuotations(5000)); }
  useEffect(() => {
    void refresh();
    void (async () => {
      const [customers, items, warehouses, salespersons] = await Promise.all([listCustomers(), listItems(), listWarehouses(), listSalespersons(false)]);
      setDeps({ customers, items, warehouses, salespersons });
    })();
  }, []);

  const { start, end, page: clampedPage } = pageSlice(rows.length, page, pageSize);
  const pageRows = rows.slice(start, end);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    const fetched = await getQuotation(id);
    setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
  }

  async function changeStatus(id: number, s: QuotationStatus) {
    setBusyId(id); setErr(null);
    try { await setQuotationStatus(id, s); await refresh(); }
    catch (e: any) { setErr(e?.message ?? "فشل تغيير الحالة"); }
    finally { setBusyId(null); }
  }

  async function convert(id: number) {
    setBusyId(id); setErr(null);
    try { await convertQuotationToInvoice(id); await refresh(); }
    catch (e: any) { setErr(e?.message ?? "فشل التحويل إلى فاتورة"); }
    finally { setBusyId(null); }
  }

  async function startEdit(id: number) {
    setBusyId(id); setErr(null);
    try {
      const full = await getQuotation(id);
      setCreating(false); setExpandedId(null); setExpandedDetail(null);
      setEditDoc(full);
    } catch (e: any) { setErr(e?.message ?? "فشل تحميل العرض"); }
    finally { setBusyId(null); }
  }

  async function remove(id: number, docNo: string) {
    if (!window.confirm(`حذف عرض السعر ${docNo}؟ لا يمكن التراجع.`)) return;
    setBusyId(id); setErr(null);
    try { await deleteQuotation(id); await refresh(); }
    catch (e: any) { setErr(e?.message ?? "فشل حذف العرض"); }
    finally { setBusyId(null); }
  }

  return (
    <Page
      title="عروض الأسعار"
      subtitle={`${rows.length} عرض — مستند غير مالي؛ يمكن تحويله إلى فاتورة مبيعات`}
      right={
        <button onClick={() => setCreating(true)} disabled={!deps || formOpen}
          style={{ ...btnPrimary, opacity: (!deps || formOpen) ? 0.5 : 1, cursor: (!deps || formOpen) ? "not-allowed" : "pointer" }}>
          + عرض سعر
        </button>
      }
    >
      <ErrorMsg text={err} />
      {formOpen && deps && (
        <Card style={{ marginBottom: 12, border: "2px solid #2563eb" }}>
          <div style={{ padding: 16 }}>
            <CreateForm key={editDoc?.id ?? "new"} deps={deps} initial={editDoc}
              onCancel={() => { setCreating(false); setEditDoc(null); }}
              onDone={() => { setCreating(false); setEditDoc(null); void refresh(); }} />
          </div>
        </Card>
      )}
      <Card>
        {rows.length === 0 && !formOpen ? <Empty text="لا توجد عروض أسعار" /> : (
          <Table>
            <thead><tr>
              <Th>رقم العرض</Th><Th>التاريخ</Th><Th>صالح حتى</Th><Th>العميل</Th><Th>الحالة</Th>
              <Th style={{ textAlign: "left" }}>المجموع</Th><Th style={{ textAlign: "left" }}>الضريبة</Th>
              <Th style={{ textAlign: "left" }}>الإجمالي</Th><Th style={{ width: 280 }}></Th>
            </tr></thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <Td mono>{p.docNo}</Td>
                    <Td>{p.quotationDate}</Td>
                    <Td>{p.validUntil ?? "—"}</Td>
                    <Td>{p.customerName ?? "بدون عميل"}</Td>
                    <Td><StatusBadge s={p.status} /></Td>
                    <Td num>{fmt(p.subtotal)}</Td>
                    <Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                    <Td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                        <button onClick={() => void toggleView(p.id)} disabled={formOpen} aria-expanded={expandedId === p.id}
                          style={{ ...btnLink, opacity: formOpen ? 0.5 : 1, cursor: formOpen ? "not-allowed" : "pointer" }}>
                          {expandedId === p.id ? "▲ إخفاء" : "▼ عرض"}
                        </button>
                        {p.status === "draft" && (
                          <button onClick={() => void changeStatus(p.id, "sent")} disabled={busyId === p.id} style={btnLink}>إرسال</button>
                        )}
                        {p.status === "sent" && (
                          <>
                            <button onClick={() => void changeStatus(p.id, "accepted")} disabled={busyId === p.id} style={{ ...btnLink, color: "#15803d" }}>قبول</button>
                            <button onClick={() => void changeStatus(p.id, "rejected")} disabled={busyId === p.id} style={{ ...btnLink, color: "#b91c1c" }}>رفض</button>
                          </>
                        )}
                        {p.status !== "converted" && p.status !== "rejected" && (
                          <button onClick={() => void convert(p.id)} disabled={busyId === p.id} style={{ ...btnPrimary, padding: "4px 10px", fontSize: 12 }}>↪ إلى فاتورة</button>
                        )}
                        {p.status !== "converted" && (
                          <>
                            <button onClick={() => void startEdit(p.id)} disabled={busyId === p.id || formOpen} style={btnLink}>تعديل</button>
                            <button onClick={() => void remove(p.id, p.docNo)} disabled={busyId === p.id || formOpen} style={{ ...btnLink, color: "#dc2626" }}>حذف</button>
                          </>
                        )}
                        {p.status === "converted" && p.convertedInvoiceId && (
                          <span style={{ fontSize: 12, color: "#7c3aed" }}>فاتورة #{p.convertedInvoiceId}</span>
                        )}
                      </div>
                    </Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={9 as any}>
                        {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>... جاري التحميل</div> : (
                          <DocDetail p={expandedDetail} />
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
      </Card>
    </Page>
  );
}

function DocDetail({ p }: { p: Quotation }) {
  return (
    <div style={{ padding: 12 }}>
      <Table>
        <thead><tr><Th>الصنف</Th><Th>الوحدة</Th><Th style={{ textAlign: "left" }}>الكمية</Th><Th style={{ textAlign: "left" }}>سعر الوحدة</Th><Th style={{ textAlign: "left" }}>الضريبة %</Th><Th style={{ textAlign: "left" }}>الإجمالي</Th></tr></thead>
        <tbody>
          {p.lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <Td>{l.itemName}</Td><Td>{l.uomName ?? ""}</Td><Td num>{l.qty}</Td><Td num>{fmt(l.unitPrice)}</Td><Td num>{l.vatRate}</Td><Td num>{fmt(l.lineTotal)}</Td>
            </tr>
          ))}
          <tr style={{ background: "#fff", fontWeight: 700 }}><Td colSpan={5 as any}>الإجمالي قبل الضريبة</Td><Td num>{fmt(p.subtotal)}</Td></tr>
          <tr style={{ background: "#fff" }}><Td colSpan={5 as any}>ضريبة القيمة المضافة</Td><Td num>{fmt(p.vatTotal)}</Td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 800, fontSize: 16 }}><Td colSpan={5 as any}>الإجمالي النهائي</Td><Td num>{fmt(p.grandTotal)}</Td></tr>
          {p.notes && <tr style={{ background: "#fff", color: "#64748b" }}><Td colSpan={6 as any}>ملاحظات: {p.notes}</Td></tr>}
        </tbody>
      </Table>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={() => openWhatsApp(buildDocWhatsAppText({ kind: "quotation", companyName: getCompanyProfile().name, docNo: p.docNo, date: p.quotationDate, grandTotal: p.grandTotal, customerName: p.buyerName ?? p.customerName }))} style={{ ...btnSecondary, color: "#075e54", borderColor: "#25d366" }}>💬 واتساب</button>
      </div>
    </div>
  );
}

function CreateForm({ deps, initial, onCancel, onDone }: {
  deps: { customers: LocalCustomer[]; items: LocalItem[]; warehouses: Warehouse[]; salespersons: Salesperson[] };
  initial?: Quotation | null;
  onCancel: () => void; onDone: () => void;
}) {
  const isEdit = !!initial;
  const [customerId, setCustomerId] = useState<number>(initial?.customerId ?? 0);
  const [date, setDate] = useState(initial?.quotationDate ?? todayStr());
  const [validUntil, setValidUntil] = useState(initial?.validUntil ?? "");
  const [warehouseId, setWarehouseId] = useState<number>(
    initial?.warehouseId ?? (deps.warehouses.find((w) => w.is_default) ?? deps.warehouses[0])?.id ?? 0,
  );
  const { branches, costCenters } = useDimensions();
  const [branchId, setBranchId] = useState<number | "">(initial?.branchId ?? "");
  useEffect(() => { if (!isEdit && branchId === "" && branches.length === 1) setBranchId(branches[0].id); }, [branches]); // eslint-disable-line react-hooks/exhaustive-deps
  const [costCenterId, setCostCenterId] = useState<number | "">(initial?.costCenterId ?? "");
  const [salesRepId, setSalesRepId] = useState<number | "">(initial?.salesRepId ?? "");
  const [invoiceType, setInvoiceType] = useState<"simplified" | "standard">(
    (initial?.invoiceType as "simplified" | "standard") ?? "simplified",
  );
  const [buyerName, setBuyerName] = useState(initial?.buyerName ?? "");
  const [buyerVat, setBuyerVat] = useState(initial?.buyerVat ?? "");
  const [buyerAddress, setBuyerAddress] = useState(initial?.buyerAddress ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [uoms] = useState<Uom[]>(() => listUom());
  const defUom = uoms.find((u) => u.isDefault) ?? uoms[0];
  const blankLine = (): FLine => ({
    itemId: 0, qty: 1, unitPrice: 0, vatRate: 15, lineTotal: 0, disc: 0, discType: "percent",
    uomId: defUom?.id ?? null, uomName: defUom?.nameAr ?? null, conversionFactor: defUom?.baseQty ?? 1,
  });
  const [lines, setLines] = useState<FLine[]>(() =>
    initial && initial.lines.length
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
  const { taxes, taxId, setTaxId, taxOptions, selectedRate } = useInvoiceTaxes("sales");

  const selectedCustomer = deps.customers.find((c) => c.id === customerId) ?? null;

  const skipCustomerFill = React.useRef(isEdit);
  useEffect(() => {
    if (skipCustomerFill.current) { skipCustomerFill.current = false; return; }
    if (!selectedCustomer) {
      setBuyerName(""); setBuyerVat(""); setBuyerAddress(""); setInvoiceType("simplified");
      return;
    }
    setBuyerName(selectedCustomer.nameAr ?? "");
    setBuyerVat(selectedCustomer.vatNumber ?? "");
    const addr = [selectedCustomer.street, selectedCustomer.district, selectedCustomer.city]
      .filter((x) => x && String(x).trim()).join("، ");
    setBuyerAddress(addr);
    setInvoiceType(selectedCustomer.vatNumber ? "standard" : "simplified");
  }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  function setLine(i: number, patch: Partial<FLine>) {
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      const next = { ...l, ...patch };
      if (patch.itemId !== undefined) {
        const it = deps.items.find((x) => x.id === Number(patch.itemId));
        if (it) {
          if (!next.unitPrice) next.unitPrice = it.salePrice ?? 0;
          next.vatRate = it.vatRate ?? next.vatRate;
          if (it.uomId != null) {
            const u = uoms.find((x) => x.id === it.uomId);
            if (u) { next.uomId = u.id; next.uomName = u.nameAr; next.conversionFactor = u.baseQty; }
          }
        }
      }
      if (patch.uomId !== undefined) {
        const u = uoms.find((x) => x.id === Number(patch.uomId));
        if (u) { next.uomName = u.nameAr; next.conversionFactor = u.baseQty; }
      }
      if (selectedRate != null) next.vatRate = selectedRate;
      const { net } = lineNet(next.qty, next.unitPrice, next.disc, next.discType);
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
      const { net } = lineNet(l.qty, l.unitPrice, l.disc, l.discType);
      return { ...l, vatRate: rate, lineTotal: net + net * rate / 100 };
    }));
  }

  const result = computeDiscount(
    lines.map((l) => ({ qty: l.qty, unit: l.unitPrice, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
    headerDisc, headerDiscType,
  );

  async function save() {
    setBusy(true); setErr(null); setIssues([]);
    try {
      const problems = collectDocIssues([
        { label: "العملة", ok: !!currency },
        ...(branches.length ? [{ label: "الفرع", ok: branchId !== "" }] : []),
        { label: "المستودع", ok: !!warehouseId },
      ], lines.map((l) => ({ itemId: l.itemId, uomId: l.uomId ?? null, price: l.unitPrice, qty: l.qty })), "سعر البيع");
      if (problems.length) { setIssues(problems); setBusy(false); return; }
      const cleaned = lines.filter((l) => l.itemId && (l.qty || 0) > 0);
      if (currency !== baseCurrencyCode() && !(exchangeRate > 0)) throw new Error("أدخل سعر صرف صحيح للعملة الأجنبية");
      const r = computeDiscount(
        cleaned.map((l) => ({ qty: l.qty, unit: l.unitPrice, vatRate: l.vatRate, disc: l.disc, discType: l.discType })),
        headerDisc, headerDiscType,
      );
      const payloadLines: SalesLine[] = cleaned.map((l, i) => {
        const net = r.netUnitPrices[i] * effRate;
        return {
          itemId: l.itemId, itemName: l.itemName, qty: l.qty, unitPrice: net, vatRate: l.vatRate,
          lineTotal: l.qty * net * (1 + (Number(l.vatRate) || 0) / 100),
          uomId: l.uomId, uomName: l.uomName, conversionFactor: l.conversionFactor,
          freeQty: l.freeQty || 0, note: l.note?.trim() ? l.note.trim() : null,
        };
      });
      const payload = {
        customerId: customerId || null, quotationDate: date, validUntil: validUntil || null,
        warehouseId: warehouseId || null,
        branchId: branchId === "" ? null : branchId,
        costCenterId: costCenterId === "" ? null : costCenterId,
        salesRepId: salesRepId === "" ? null : salesRepId,
        commissionPct: salesRepId === "" ? null : (deps.salespersons.find((s) => s.id === salesRepId)?.commissionPct ?? 0),
        invoiceType,
        buyerName: invoiceType === "standard" ? (buyerName.trim() || null) : null,
        buyerVat: invoiceType === "standard" ? (buyerVat.trim() || null) : null,
        buyerAddress: invoiceType === "standard" ? (buyerAddress.trim() || null) : null,
        notes: notes || null, lines: payloadLines,
      };
      if (isEdit && initial) await updateQuotation(initial.id, payload);
      else await createQuotation(payload);
      onDone();
    } catch (e: any) { setErr(e?.message ?? "فشل"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{isEdit ? `تعديل عرض السعر ${initial?.docNo ?? ""}` : "عرض سعر جديد"}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
        <Field label="العميل *">
          <SearchCombobox
            value={customerId}
            onChange={(v) => setCustomerId(Number(v))}
            style={input}
            options={[
              { value: 0, label: "— بدون عميل —" },
              ...deps.customers.map((c) => ({ value: c.id, label: c.nameAr })),
            ]}
          />
        </Field>
        <Field label="التاريخ"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
        <Field label="صالح حتى"><input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} style={input} /></Field>
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
        <Field label="مندوب المبيعات">
          <SearchCombobox
            value={salesRepId}
            onChange={(v) => setSalesRepId(v === "" ? "" : Number(v))}
            style={input}
            options={[
              { value: "", label: "— بدون —" },
              ...deps.salespersons.map((s) => ({ value: s.id, label: s.nameAr })),
            ]}
          />
        </Field>
        <Field label="نوع المستند (زاتكا)">
          <SearchCombobox
            value={invoiceType}
            onChange={(v) => setInvoiceType(v as "simplified" | "standard")}
            style={input}
            options={[
              { value: "simplified", label: "مبسّطة (B2C)" },
              { value: "standard", label: "ضريبية (B2B)" },
            ]}
          />
        </Field>
        <CurrencyExchangeFields currency={currency} exchangeRate={exchangeRate} onCurrency={setCurrency} onRate={setExchangeRate} />
        {invoiceType === "standard" && (
          <div style={{ gridColumn: "1 / -1", marginBottom: 10, padding: 10, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>بيانات المشتري</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px" }}>
              <Field label="اسم المشتري">
                <input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} style={input} />
              </Field>
              <Field label="الرقم الضريبي للمشتري">
                <input value={buyerVat} onChange={(e) => setBuyerVat(e.target.value)} style={input} />
              </Field>
              <Field label="عنوان المشتري">
                <input value={buyerAddress} onChange={(e) => setBuyerAddress(e.target.value)} style={input} />
              </Field>
            </div>
          </div>
        )}
      </div>

      <div style={{ overflowX: "auto", marginTop: 10 }}>
      <Table style={{ minWidth: 1250 }}>
        <thead><tr>
          <Th style={{ minWidth: 240 }}>الصنف</Th>
          <Th style={{ width: 130 }}>الوحدة</Th>
          <Th style={{ width: 180 }}>الكمية</Th>
          <Th style={{ width: 80 }}>مجاني</Th>
          <Th style={{ width: 240 }}>سعر الوحدة</Th>
          <Th style={{ width: 170 }}>الخصم</Th>
          <Th style={{ width: 80 }}>ض. %</Th>
          <Th style={{ width: 150 }}>ملاحظة</Th>
          <Th style={{ width: 120, textAlign: "left" }}>الإجمالي</Th>
          <Th style={{ width: 40 }}></Th>
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
              <Td><input type="number" step="0.001" value={l.freeQty ?? 0} onChange={(e) => setLine(i, { freeQty: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input type="number" step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><LineDiscountCell amount={l.disc ?? 0} type={l.discType ?? "percent"} gross={(Number(l.qty) || 0) * (Number(l.unitPrice) || 0)} sym={docSym} onAmount={(v) => setLine(i, { disc: v })} onType={(t) => setLine(i, { discType: t })} /></Td>
              <Td><input type="number" step="0.01" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input value={l.note ?? ""} onChange={(e) => setLine(i, { note: e.target.value })} style={input} /></Td>
              <Td num>{fmt(l.lineTotal)}</Td>
              <Td><button onClick={() => removeLine(i)} style={{ ...btnLink, color: "#dc2626" }}>×</button></Td>
            </tr>
          ))}
        </tbody>
      </Table>
      </div>
      <button onClick={addLine} type="button" style={{ ...btnSecondary, marginTop: 8 }}>+ سطر</button>
      <InvoiceTotals result={result} headerDisc={headerDisc} headerType={headerDiscType} sym={docSym} rate={effRate} onHeaderDisc={setHeaderDisc} onHeaderType={setHeaderDiscType} />

      <Field label="ملاحظات" style={{ marginTop: 12 }}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} />
      </Field>
      <ValidationPanel issues={issues} />
      <ErrorMsg text={err} />
      <Actions>
        <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
        <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
      </Actions>
    </div>
  );
}
