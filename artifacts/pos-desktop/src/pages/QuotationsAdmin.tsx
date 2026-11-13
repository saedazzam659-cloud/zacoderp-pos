import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDataRefresh } from "../lib/dataBus";
import {
  listQuotations, getQuotation, createQuotation, updateQuotation, deleteQuotation,
  setQuotationStatus, convertQuotationToInvoice,
  type Quotation, type QuotationStatus, type SalesLine,
} from "../lib/accounting";
import { listCustomers, type LocalCustomer } from "../lib/customers";
import { createItem, listItems, type LocalItem } from "../lib/items";
import { listUom, type Uom } from "../lib/uom";
import QuickCreateDialog from "../components/QuickCreateDialog";
import { DocumentItemPicker, ItemCodeHistoryButton, ItemHistoryDialog, NoCustomerHistoryDialog } from "../components/DocumentItemDialogs";
import { listBrands, setItemBrands } from "../lib/brands";
import { listWarehouses, type Warehouse } from "../lib/inventory";
import { listSalespersons, type Salesperson } from "../lib/salespersons";
import { openWhatsApp, buildDocWhatsAppText } from "../lib/whatsapp";
import { getCompanyProfile, setDocumentEditorLayout, uiText, useDocumentEditorLayout, useShowFreeQuantityColumn, useUiLanguage } from "../lib/appSettings";
import { DocumentEditorSection, DocumentEditorShell } from "../components/DocumentEditorShell";
import { saveText } from "../lib/saveFile";
import { printQuotationDocs, printQuotationSummary } from "../lib/invoicePrint";
import {
  Page, Card, Table, Th, Td, Field, ErrorMsg, Empty, Pagination, pageSlice,
  input, btnPrimary, btnSecondary, btnLink, fmt, todayStr, SearchCombobox,
  LineDiscountCell, InvoiceTotals, CurrencyExchangeFields, EmptyItemsRow,
  ActionBtn, useGridFilter, GridToolbar, SortableTh, GridFilterRow,
  ExportButtons, gridToExportCols, type GridColumn,
} from "./_adminUi";
import { ValidationPanel, collectDocIssues } from "./_adminUi";
import { useDimensions, branchPickerOptions, costCenterPickerOptions } from "./_reportFilters";
import { useInvoiceTaxes } from "./_invoiceTax";
import { baseCurrencyCode, currencyByCode } from "../lib/currency";
import { computeDiscount, lineNet, type DiscType, type DiscFields } from "../lib/discount";

type FLine = SalesLine & DiscFields;

const STATUS: Record<QuotationStatus, { l: string; en: string; c: string }> = {
  draft:     { l: "مسودة",  en: "Draft", c: "#475569" },
  sent:      { l: "مُرسل",   en: "Sent", c: "#1e40af" },
  accepted:  { l: "مقبول",  en: "Accepted", c: "#15803d" },
  rejected:  { l: "مرفوض",  en: "Rejected", c: "#b91c1c" },
  converted: { l: "محوّل لفاتورة", en: "Converted", c: "#7c3aed" },
};

function statusLabel(s: QuotationStatus, language: string): string {
  const x = STATUS[s];
  return language === "en" ? x.en : x.l;
}

function StatusBadge({ s, language }: { s: QuotationStatus; language: string }) {
  const x = STATUS[s];
  return <span style={{ background: x.c + "20", color: x.c, padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{statusLabel(s, language)}</span>;
}

export default function QuotationsAdmin() {
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const [rows, setRows] = useState<Quotation[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<Quotation | null>(null);
  const [creating, setCreating] = useState(false);
  const [editDoc, setEditDoc] = useState<Quotation | null>(null);
  const [deps, setDeps] = useState<{ customers: LocalCustomer[]; items: LocalItem[]; warehouses: Warehouse[]; salespersons: Salesperson[] } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [statusFilter, setStatusFilter] = useState<QuotationStatus | "all">("all");
  const [err, setErr] = useState<string | null>(null);
  const formOpen = creating || editDoc !== null;

  async function refresh() { setRows(await listQuotations(5000)); }
  async function refreshDeps() {
    const [customers, items, warehouses, salespersons] = await Promise.all([listCustomers(), listItems(), listWarehouses(), listSalespersons(false)]);
    setDeps({ customers, items, warehouses, salespersons });
  }
  useEffect(() => {
    void refresh();
    void refreshDeps();
  }, []);

  const columns = useMemo<GridColumn<Quotation>[]>(() => [
    { key: "docNo", label: text("رقم العرض", "Quotation number"), value: (r) => r.docNo, text: (r) => r.docNo },
    { key: "date", label: text("التاريخ", "Date"), value: (r) => r.quotationDate, text: (r) => r.quotationDate },
    { key: "validUntil", label: text("صالح حتى", "Valid until"), value: (r) => r.validUntil ?? "", text: (r) => r.validUntil ?? "" },
    { key: "customer", label: text("العميل", "Customer"), value: (r) => r.buyerName ?? r.customerName ?? "", text: (r) => r.buyerName ?? r.customerName ?? "" },
    { key: "status", label: text("الحالة", "Status"), value: (r) => statusLabel(r.status, language), text: (r) => statusLabel(r.status, language) },
    { key: "subtotal", label: text("المجموع", "Subtotal"), type: "number", value: (r) => r.subtotal, text: (r) => fmt(r.subtotal) },
    { key: "vat", label: text("الضريبة", "VAT"), type: "number", value: (r) => r.vatTotal, text: (r) => fmt(r.vatTotal) },
    { key: "grandTotal", label: text("الإجمالي", "Total"), type: "number", value: (r) => r.grandTotal, text: (r) => fmt(r.grandTotal) },
  ], [language]);
  const grid = useGridFilter(rows, columns);
  const visibleRows = useMemo(
    () => grid.view.filter((row) => statusFilter === "all" || row.status === statusFilter),
    [grid.view, statusFilter],
  );
  const { start, end, page: clampedPage } = pageSlice(visibleRows.length, page, pageSize);
  const pageRows = visibleRows.slice(start, end);
  const selectedRows = rows.filter((row) => selectedIds.has(row.id));
  const selectedSendable = selectedRows.filter((row) => row.status === "draft");
  const selectedAcceptable = selectedRows.filter((row) => row.status === "draft" || row.status === "sent");
  const selectedDeletable = selectedRows.filter((row) => row.status !== "converted");
  const singleSelected = selectedRows.length === 1 ? selectedRows[0] : null;
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((row) => selectedIds.has(row.id));
  const someVisibleSelected = visibleRows.some((row) => selectedIds.has(row.id));
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [someVisibleSelected, allVisibleSelected]);
  useEffect(() => {
    const available = new Set(rows.map((row) => row.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [rows]);
  useDataRefresh(["invoices"], refresh);
  useEffect(() => { if (clampedPage !== page) setPage(clampedPage); }, [clampedPage, page]);

  function toggleSelection(id: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleRows.forEach((row) => next.delete(row.id));
      else visibleRows.forEach((row) => next.add(row.id));
      return next;
    });
  }

  async function toggleView(id: number) {
    if (expandedId === id) { setExpandedId(null); setExpandedDetail(null); return; }
    setExpandedId(id); setExpandedDetail(null);
    try {
      const fetched = await getQuotation(id);
      setExpandedId((cur) => { if (cur === id) setExpandedDetail(fetched); return cur; });
    } catch (e: any) {
      setErr(e?.message ?? text("تعذر تحميل تفاصيل العرض", "Could not load quotation details."));
    }
  }

  async function changeStatus(id: number, s: QuotationStatus) {
    setBusyId(id); setErr(null); setBulkNotice(null);
    try {
      await setQuotationStatus(id, s);
      await refresh();
      setSelectedIds(new Set());
      setBulkNotice(text(`تم تحديث حالة العرض إلى ${statusLabel(s, "ar")}`, `Quotation status changed to ${statusLabel(s, "en")}`));
    }
    catch (e: any) { setErr(e?.message ?? text("فشل تغيير الحالة", "Could not change status.")); }
    finally { setBusyId(null); }
  }

  async function convert(id: number) {
    setBusyId(id); setErr(null); setBulkNotice(null);
    try {
      const invoiceId = await convertQuotationToInvoice(id);
      await refresh();
      setSelectedIds(new Set());
      setBulkNotice(text(`تم التحويل إلى فاتورة #${invoiceId}`, `Converted to invoice #${invoiceId}`));
    }
    catch (e: any) { setErr(e?.message ?? text("فشل التحويل إلى فاتورة", "Could not convert to invoice.")); }
    finally { setBusyId(null); }
  }

  async function startEdit(id: number) {
    setBusyId(id); setErr(null); setBulkNotice(null);
    try {
      const full = await getQuotation(id);
      setCreating(false); setExpandedId(null); setExpandedDetail(null);
      setSelectedIds(new Set());
      setEditDoc(full);
    } catch (e: any) { setErr(e?.message ?? "فشل تحميل العرض"); }
    finally { setBusyId(null); }
  }

  async function runBulkAction(
    targets: Quotation[],
    successAr: string,
    successEn: string,
    action: (id: number) => Promise<unknown>,
  ) {
    if (!targets.length) return;
    setBulkBusy(true); setErr(null); setBulkNotice(null);
    let succeeded = 0;
    const failures: string[] = [];
    try {
      for (const row of targets) {
        try { await action(row.id); succeeded += 1; }
        catch (e: any) { failures.push(e?.message ?? `${row.docNo}: ${text("فشل الإجراء", "Action failed")}`); }
      }
      if (succeeded) await refresh();
      setSelectedIds(new Set());
      if (failures.length) {
        setErr(text(
          `${successAr}: نجح ${succeeded} وفشل ${failures.length}. ${failures[0]}`,
          `${successEn}: ${succeeded} succeeded, ${failures.length} failed. ${failures[0]}`,
        ));
      } else {
        setBulkNotice(text(`${successAr}: ${succeeded}`, `${successEn}: ${succeeded}`));
      }
    } catch (e: any) {
      setErr(e?.message ?? text("تعذر تحديث قائمة العروض", "Could not refresh quotations."));
    } finally { setBulkBusy(false); }
  }

  function bulkSend() {
    return runBulkAction(selectedSendable, "تم إرسال العروض", "Quotations sent", (id) => setQuotationStatus(id, "sent"));
  }

  function bulkAccept() {
    return runBulkAction(selectedAcceptable, "تم قبول العروض", "Quotations accepted", (id) => setQuotationStatus(id, "accepted"));
  }

  async function bulkDelete() {
    if (!selectedDeletable.length) return;
    if (!window.confirm(text(
      `حذف ${selectedDeletable.length} عرض سعر غير محوّل نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.`,
      `Permanently delete ${selectedDeletable.length} non-converted quotations? This cannot be undone.`,
    ))) return;
    await runBulkAction(selectedDeletable, "تم حذف العروض", "Quotations deleted", deleteQuotation);
  }

  function exportCsv() {
    if (!visibleRows.length) return;
    const quoteCell = (value: unknown, numeric = false) => {
      const raw = String(value ?? "");
      const safe = !numeric && /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = [
      columns.map((column) => quoteCell(column.label)).join(","),
      ...visibleRows.map((row) => columns.map((column) => {
        const value = column.value(row);
        return quoteCell(column.type === "number" ? value : column.text ? column.text(row) : value, column.type === "number");
      }).join(",")),
    ].join("\r\n");
    setErr(null);
    void saveText(`\uFEFF${csv}`, `sales-quotations-${new Date().toISOString().slice(0, 10)}.csv`)
      .catch((e: unknown) => setErr(typeof e === "string" ? e : e instanceof Error ? e.message : text("تعذر حفظ ملف CSV", "Could not save CSV file.")));
  }

  function printSelectedSummary() {
    try {
      printQuotationSummary(selectedRows.map((row) => ({
        docNo: row.docNo,
        quotationDate: row.quotationDate,
        validUntil: row.validUntil,
        customerName: row.buyerName ?? row.customerName,
        statusLabel: statusLabel(row.status, language),
        subtotal: row.subtotal,
        vatTotal: row.vatTotal,
        grandTotal: row.grandTotal,
      })));
    } catch (e: any) { setErr(e?.message ?? text("تعذرت طباعة ملخص العروض", "Could not print quotation summary.")); }
  }

  async function printSelectedDocs() {
    if (!selectedRows.length) return;
    setBulkBusy(true); setErr(null);
    try {
      const fullDocs = await Promise.all(selectedRows.map((row) => getQuotation(row.id)));
      printQuotationDocs(fullDocs);
    } catch (e: any) {
      setErr(e?.message ?? text("تعذر تحميل العروض للطباعة", "Could not load quotations for printing."));
    } finally { setBulkBusy(false); }
  }

  return (
    <Page
      title={text("عروض الأسعار", "Quotations")}
      subtitle={text(`${rows.length} عرض — مستند غير مالي؛ يمكن تحويله إلى فاتورة مبيعات`, `${rows.length} quotations — non-fiscal documents that can be converted to sales invoices`)}
      right={
        <button onClick={() => { setSelectedIds(new Set()); setBulkNotice(null); setCreating(true); }} disabled={!deps || formOpen}
          style={{ ...btnPrimary, opacity: (!deps || formOpen) ? 0.5 : 1, cursor: (!deps || formOpen) ? "not-allowed" : "pointer" }}>
          + {text("عرض سعر", "Quotation")}
        </button>
      }
    >
      <ErrorMsg text={err} />
      {bulkNotice && <div role="status" style={{ marginBottom: 12, padding: "9px 12px", borderRadius: 8, color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0" }}>{bulkNotice}</div>}
      {formOpen && deps && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ padding: 16 }}>
            <CreateForm key={editDoc?.id ?? "new"} deps={deps} initial={editDoc}
              onItemCreated={(item) => setDeps((current) => current
                ? { ...current, items: current.items.some((existing) => existing.id === item.id) ? current.items : [...current.items, item] }
                : current)}
              onCancel={() => { setCreating(false); setEditDoc(null); setSelectedIds(new Set()); }}
              onDone={() => { setCreating(false); setEditDoc(null); setSelectedIds(new Set()); void refresh(); }} />
          </div>
        </Card>
      )}
      {rows.length > 0 && !formOpen && (
        <>
          <GridToolbar
            grid={grid}
            placeholder={text("🔍 بحث في عروض الأسعار…", "🔍 Search quotations…")}
            extra={
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <ExportButtons columns={gridToExportCols(columns)} rows={visibleRows} filenameBase="sales-quotations" title={text("عروض الأسعار", "Quotations")} />
                <button type="button" disabled={!visibleRows.length} onClick={exportCsv}
                  style={{ ...btnSecondary, opacity: visibleRows.length ? 1 : 0.5, cursor: visibleRows.length ? "pointer" : "not-allowed" }}>
                  {text("تصدير CSV", "Export CSV")}
                </button>
              </div>
            }
          />
          <div role="group" aria-label={text("تصفية حالة العرض", "Filter quotation status")}
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 12 }}>
            {(["all", "draft", "sent", "accepted", "rejected", "converted"] as const).map((status) => {
              const label = status === "all" ? text("كل الحالات", "All statuses") : statusLabel(status, language);
              const active = statusFilter === status;
              return <button key={status} type="button" onClick={() => { setStatusFilter(status); setPage(1); }}
                aria-pressed={active}
                style={{ ...btnSecondary, padding: "6px 10px", borderColor: active ? "#2563eb" : "#cbd5e1", background: active ? "#eff6ff" : "#fff", color: active ? "#1d4ed8" : "#334155" }}>
                {label}
              </button>;
            })}
            <span style={{ marginInlineStart: "auto", color: "#64748b", fontSize: 12 }}>
              {visibleRows.length}{visibleRows.length !== rows.length ? ` / ${rows.length}` : ""} {text("عرض", "quotations")}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12, padding: "10px 12px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10 }}>
            <span style={{ minWidth: 150, fontSize: 12.5, fontWeight: 700, color: "#475569" }}>
              {selectedIds.size ? text(`محدد ${selectedIds.size} عرض`, `${selectedIds.size} selected`) : text("حدد عروضًا لتفعيل الإجراءات", "Select quotations to enable actions")}
            </span>
            <div style={{ flex: 1 }} />
            <ActionBtn label={text("طباعة ملخص", "Print summary")} icon="▤" disabled={!selectedRows.length || bulkBusy} onClick={printSelectedSummary} />
            <ActionBtn label={text("طباعة العروض المحددة", "Print selected quotations")} icon="🖨" disabled={!selectedRows.length || bulkBusy} onClick={() => void printSelectedDocs()} />
            <ActionBtn label={text(`إرسال (${selectedSendable.length})`, `Send (${selectedSendable.length})`)} icon="↗" disabled={!selectedSendable.length || bulkBusy} onClick={() => void bulkSend()} />
            <ActionBtn label={text(`قبول (${selectedAcceptable.length})`, `Accept (${selectedAcceptable.length})`)} icon="✔" tone="success" disabled={!selectedAcceptable.length || bulkBusy} onClick={() => void bulkAccept()} />
            {singleSelected?.status === "sent" && (
              <ActionBtn label={text("رفض", "Reject")} icon="✖" tone="danger" disabled={bulkBusy || busyId === singleSelected.id} onClick={() => void changeStatus(singleSelected.id, "rejected")} />
            )}
            {singleSelected && singleSelected.status !== "converted" && singleSelected.status !== "rejected" && (
              <ActionBtn label={text("إلى فاتورة", "Convert to invoice")} icon="↪" tone="purple" disabled={bulkBusy || busyId === singleSelected.id} onClick={() => void convert(singleSelected.id)} />
            )}
            {singleSelected && singleSelected.status !== "converted" && (
              <ActionBtn label={text("تعديل", "Edit")} icon="✎" disabled={bulkBusy || busyId === singleSelected.id} onClick={() => void startEdit(singleSelected.id)} />
            )}
            <ActionBtn label={text(`حذف (${selectedDeletable.length})`, `Delete (${selectedDeletable.length})`)} icon="🗑" tone="danger" disabled={!selectedDeletable.length || bulkBusy} onClick={() => void bulkDelete()} />
            {singleSelected?.status === "converted" && singleSelected.convertedInvoiceId && (
              <span style={{ fontSize: 12, color: "#7c3aed" }}>{text("فاتورة", "Invoice")} #{singleSelected.convertedInvoiceId}</span>
            )}
          </div>
        </>
      )}
      <Card>
        {rows.length === 0 && !formOpen ? <Empty text={text("لا توجد عروض أسعار", "No quotations")} />
          : visibleRows.length === 0 && !formOpen ? <Empty text={text("لا توجد نتائج مطابقة للفلاتر", "No quotations match these filters")} /> : (
          <Table>
            <thead>
              <tr>
                <Th style={{ width: 38, textAlign: "center" }}>
                  <input ref={selectAllRef} type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible}
                    aria-label={text("تحديد كل النتائج", "Select all filtered quotations")} disabled={!visibleRows.length || bulkBusy}
                    style={{ width: 16, height: 16, accentColor: "#2563eb", cursor: "pointer" }} />
                </Th>
                <SortableTh grid={grid} colKey="docNo">{text("رقم العرض", "Quotation number")}</SortableTh>
                <SortableTh grid={grid} colKey="date">{text("التاريخ", "Date")}</SortableTh>
                <SortableTh grid={grid} colKey="validUntil">{text("صالح حتى", "Valid until")}</SortableTh>
                <SortableTh grid={grid} colKey="customer">{text("العميل", "Customer")}</SortableTh>
                <SortableTh grid={grid} colKey="status">{text("الحالة", "Status")}</SortableTh>
                <SortableTh grid={grid} colKey="subtotal" style={{ textAlign: language === "en" ? "right" : "left" }}>{text("المجموع", "Subtotal")}</SortableTh>
                <SortableTh grid={grid} colKey="vat" style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الضريبة", "VAT")}</SortableTh>
                <SortableTh grid={grid} colKey="grandTotal" style={{ textAlign: language === "en" ? "right" : "left" }}>{text("الإجمالي", "Total")}</SortableTh>
                <Th>{text("الإجراءات", "Actions")}</Th>
              </tr>
              <GridFilterRow grid={grid} columns={columns} leading={1} trailing={1} />
            </thead>
            <tbody>
              {pageRows.map((p) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <Td style={{ width: 38, textAlign: "center" }}>
                      <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleSelection(p.id)}
                        aria-label={text(`تحديد العرض ${p.docNo}`, `Select quotation ${p.docNo}`)}
                        style={{ width: 16, height: 16, accentColor: "#2563eb", cursor: "pointer" }} />
                    </Td>
                    <Td mono>{p.docNo}</Td>
                    <Td>{p.quotationDate}</Td>
                    <Td>{p.validUntil ?? "—"}</Td>
                    <Td>{p.buyerName ?? p.customerName ?? text("بدون عميل", "No customer")}</Td>
                    <Td><StatusBadge s={p.status} language={language} /></Td>
                    <Td num>{fmt(p.subtotal)}</Td>
                    <Td num>{fmt(p.vatTotal)}</Td>
                    <Td num style={{ fontWeight: 600 }}>{fmt(p.grandTotal)}</Td>
                    <Td><button type="button" onClick={() => void toggleView(p.id)} style={btnLink}>
                      {expandedId === p.id ? text("إخفاء", "Hide") : text("عرض", "View")}
                    </button></Td>
                  </tr>
                  {expandedId === p.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <Td colSpan={10 as any}>
                        {!expandedDetail ? <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>{text("جارٍ التحميل…", "Loading…")}</div> : (
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
        {visibleRows.length > 0 && (
          <Pagination total={visibleRows.length} page={page} pageSize={pageSize}
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

function CreateForm({ deps, initial, onCancel, onDone, onItemCreated }: {
  deps: { customers: LocalCustomer[]; items: LocalItem[]; warehouses: Warehouse[]; salespersons: Salesperson[] };
  initial?: Quotation | null;
  onCancel: () => void; onDone: () => void;
  onItemCreated: (item: LocalItem) => void;
}) {
  const isEdit = !!initial;
  const language = useUiLanguage();
  const text = (ar: string, en: string) => uiText(ar, en, language);
  const documentLayout = useDocumentEditorLayout();
  const showFreeQuantityColumn = useShowFreeQuantityColumn();
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
    itemId: 0, qty: 1, unitPrice: 0, vatRate: 0, lineTotal: 0, disc: 0, discType: "percent",
    uomId: defUom?.id ?? null, uomName: defUom?.nameAr ?? null, conversionFactor: defUom?.baseQty ?? 1,
  });
  const [lines, setLines] = useState<FLine[]>(() =>
    initial && initial.lines.length
      ? initial.lines.map((l) => ({ ...l, disc: 0, discType: "percent" as DiscType }))
      : [],
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
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [quickCreateBusy, setQuickCreateBusy] = useState(false);
  const [quickCreateError, setQuickCreateError] = useState<string | null>(null);
  const [itemPickerOpen, setItemPickerOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<{ item: LocalItem; customer: LocalCustomer } | null>(null);
  const [historyNeedsCustomer, setHistoryNeedsCustomer] = useState(false);
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
          next.vatRate = it.vatRate ?? 0;
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
  function appendCatalogItems(items: LocalItem[]) {
    setLines((current) => [...current, ...items.map((item) => {
      const uom = item.uomId != null ? uoms.find((unit) => unit.id === item.uomId) : defUom;
      const line: FLine = {
        ...blankLine(), itemId: item.id, itemName: item.nameAr, unitPrice: item.salePrice ?? 0,
        vatRate: selectedRate ?? item.vatRate ?? 0,
        uomId: uom?.id ?? null, uomName: uom?.nameAr ?? null, conversionFactor: uom?.baseQty ?? 1,
      };
      const { net } = lineNet(line.qty, line.unitPrice, line.disc, line.discType);
      line.lineTotal = net + net * (Number(line.vatRate) || 0) / 100;
      return line;
    })]);
  }
  function openItemHistory(itemId: number) {
    if (!customerId) { setHistoryNeedsCustomer(true); return; }
    const item = deps.items.find((entry) => entry.id === itemId);
    const customer = deps.customers.find((entry) => entry.id === customerId);
    if (item && customer) setHistoryTarget({ item, customer });
  }
  async function createQuickItem(itemInput: { nameAr: string; code: string; barcode: string; salePrice: number; vatRate: number; nature: "stock" | "service"; uomId: number; brandId: number | null; quantity?: number }, action: "close" | "add-another" = "close") {
    if (!itemInput.nameAr.trim()) { setQuickCreateError("اكتب اسم الصنف بالعربية"); return false; }
    if (!Number.isFinite(itemInput.salePrice) || itemInput.salePrice < 0) { setQuickCreateError("أدخل سعرًا صحيحًا"); return false; }
    if (!Number.isFinite(itemInput.quantity ?? 1) || (itemInput.quantity ?? 1) <= 0) { setQuickCreateError("أدخل كمية أكبر من صفر"); return false; }
    if (!Number.isFinite(itemInput.vatRate) || itemInput.vatRate < 0 || itemInput.vatRate > 100) { setQuickCreateError("نسبة الضريبة يجب أن تكون بين 0 و100"); return false; }
    const uom = uoms.find((unit) => unit.id === itemInput.uomId);
    if (!uom) { setQuickCreateError("اختر وحدة قياس للصنف"); return false; }
    setQuickCreateBusy(true);
    setQuickCreateError(null);
    try {
      const item = await createItem({
        nameAr: itemInput.nameAr.trim(),
        code: itemInput.code.trim() || null,
        barcode: itemInput.barcode.trim() || null,
        salePrice: itemInput.salePrice,
        vatRate: selectedRate ?? itemInput.vatRate,
        costPrice: 0,
        uomId: uom.id,
        nature: itemInput.nature,
      });
      const chosenBrand = itemInput.brandId == null ? null : listBrands().find((brand) => brand.id === itemInput.brandId) ?? null;
      if (chosenBrand) setItemBrands(item.id, [{ brandId: chosenBrand.id, salePrice1: item.salePrice, status: "active" }]);
      onItemCreated(item);
      setLines((current) => {
        const next: FLine = {
          ...blankLine(),
          itemId: item.id,
          itemName: item.nameAr,
          qty: itemInput.quantity ?? 1,
          unitPrice: item.salePrice,
          vatRate: selectedRate ?? item.vatRate,
          uomId: item.uomId ?? uom.id,
          uomName: uom.nameAr,
          conversionFactor: uom.baseQty,
        };
        const { net } = lineNet(next.qty, next.unitPrice, next.disc, next.discType);
        next.lineTotal = net + net * (Number(next.vatRate) || 0) / 100;
        return [...current, next];
      });
      if (action === "close") setQuickCreateOpen(false);
      return true;
    } catch (e: any) {
      setQuickCreateError(e?.message ?? "تعذر إضافة الصنف");
      return false;
    } finally {
      setQuickCreateBusy(false);
    }
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
      <DocumentEditorShell
        layout={documentLayout}
        onLayoutChange={setDocumentEditorLayout}
        label={text("تصميم المستند", "Document layout")}
        helperText={text("يُطبّق الاختيار على جميع المستندات", "This choice applies to all document forms")}
        selectorAriaLabel={text("اختيار تصميم المستند", "Choose document layout")}
      >
      <DocumentEditorSection>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0 10px", alignItems: "start" }}>
        <Field label={text("التاريخ", "Date")}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} /></Field>
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
        <Field label={text("مندوب المبيعات", "Sales representative")}>
          <SearchCombobox
            value={salesRepId}
            onChange={(v) => setSalesRepId(v === "" ? "" : Number(v))}
            style={input}
            options={[
              { value: "", label: text("— بدون —", "— None —") },
              ...deps.salespersons.map((s) => ({ value: s.id, label: s.nameAr })),
            ]}
          />
        </Field>
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
        <Field label="صالح حتى"><input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} style={input} /></Field>
        <Field label="الضريبة">
          <SearchCombobox value={taxId} onChange={onSelectTax} options={taxOptions} style={input} />
        </Field>
        <Field label="الفرع">
          <SearchCombobox value={branchId} onChange={(v) => setBranchId(v === "" ? "" : Number(v))} options={branchPickerOptions(branches)} style={input} />
        </Field>
        <Field label="مركز التكلفة">
          <SearchCombobox value={costCenterId} onChange={(v) => setCostCenterId(v === "" ? "" : Number(v))} options={costCenterPickerOptions(costCenters)} style={input} />
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
      </DocumentEditorSection>

      <DocumentEditorSection>
      <div className="zlines-wrap" style={{ overflowX: "auto", overflowY: "auto", maxHeight: 390, scrollbarGutter: "stable", overscrollBehavior: "contain", marginTop: 10, border: "1px solid #e2e8f0", borderRadius: 8 }}>
      <Table style={{ minWidth: 1250 }}>
        <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
        <tr>
          <Th style={{ minWidth: 240 }}>الصنف</Th>
          <Th style={{ width: 130 }}>الوحدة</Th>
          <Th style={{ width: 180 }}>الكمية</Th>
          {showFreeQuantityColumn && <Th style={{ width: 80 }}>مجاني</Th>}
          <Th style={{ width: 240 }}>سعر الوحدة</Th>
          <Th style={{ width: 170 }}>الخصم</Th>
          <Th style={{ width: 80 }}>ض. %</Th>
          <Th style={{ width: 150 }}>ملاحظة</Th>
          <Th style={{ width: 120, textAlign: "left" }}>الإجمالي</Th>
          <Th style={{ width: 110 }}>إجراءات</Th>
        </tr></thead>
        <tbody>
          {lines.length === 0 && <EmptyItemsRow colSpan={showFreeQuantityColumn ? 10 : 9} />}
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>
                <div style={{ display: "flex", alignItems: "center", gap: 5, direction: "rtl" }}>
                  <ItemCodeHistoryButton
                    code={deps.items.find((item) => item.id === l.itemId)?.code}
                    itemName={l.itemName ?? text("الصنف", "item")}
                    disabled={!l.itemId}
                    onClick={() => openItemHistory(l.itemId)}
                  />
                  <div style={{ flex: "1 1 0%", minWidth: 0 }}>
                    <SearchCombobox
                      value={l.itemId}
                      onChange={(v) => setLine(i, { itemId: Number(v) })}
                      style={{ ...input, minWidth: 0 }}
                      options={[
                        { value: 0, label: "— اختر —" },
                        ...deps.items.map((it) => ({ value: it.id, label: it.nameAr })),
                      ]}
                    />
                  </div>
                </div>
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
              {showFreeQuantityColumn && <Td><input type="number" step="0.001" value={l.freeQty ?? 0} onChange={(e) => setLine(i, { freeQty: Number(e.target.value) || 0 })} style={input} /></Td>}
              <Td><input type="number" step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><LineDiscountCell amount={l.disc ?? 0} type={l.discType ?? "percent"} gross={(Number(l.qty) || 0) * (Number(l.unitPrice) || 0)} sym={docSym} onAmount={(v) => setLine(i, { disc: v })} onType={(t) => setLine(i, { discType: t })} /></Td>
              <Td><input type="number" step="0.01" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })} style={input} /></Td>
              <Td><input value={l.note ?? ""} onChange={(e) => setLine(i, { note: e.target.value })} style={input} /></Td>
              <Td num>{fmt(l.lineTotal)}</Td>
              <Td>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <button type="button" onClick={() => openItemHistory(l.itemId)} disabled={!l.itemId}
                    aria-label={`عرض سجل مبيعات ${l.itemName ?? "الصنف"}`} title="سجل فواتير المبيعات المُرحّلة لهذا العميل"
                    style={{ ...btnLink, color: "#315e56", whiteSpace: "nowrap" }}>السجل</button>
                  <button type="button" onClick={() => removeLine(i)} aria-label="حذف السطر" style={{ ...btnLink, color: "#dc2626" }}>×</button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      </div>
      <InvoiceTotals layout="compact" result={result} headerDisc={headerDisc} headerType={headerDiscType} sym={docSym} rate={effRate} onHeaderDisc={setHeaderDisc} onHeaderType={setHeaderDiscType} />
      </DocumentEditorSection>

      <DocumentEditorSection>
      <Field label="ملاحظات" style={{ marginTop: 12 }}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...input, minHeight: 50 }} />
      </Field>
      <ValidationPanel issues={issues} />
      <ErrorMsg text={err} />
      </DocumentEditorSection>
      <DocumentEditorSection>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            onClick={addLine}
            type="button"
            title="إضافة سطر"
            aria-label="إضافة سطر"
            style={{ ...btnSecondary, padding: "5px 9px", color: "#087f69", borderColor: "#9bd6c9", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}
          >
            + إضافة صنف
          </button>
          <button
            onClick={() => setItemPickerOpen(true)}
            type="button"
            title="اختيار عدة أصناف موجودة"
            aria-label="اختيار عدة أصناف موجودة"
            style={{ ...btnSecondary, padding: "5px 9px", color: "#315e56", borderColor: "#b8d4cb", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}
          >
            اختيار أصناف
          </button>
          <button
            onClick={() => { setQuickCreateError(null); setQuickCreateOpen(true); }}
            type="button"
            title="إضافة صنف جديد سريعًا"
            aria-label="إضافة صنف جديد سريعًا"
            style={{ ...btnSecondary, padding: "5px 9px", color: "#7c3aed", borderColor: "#c4b5fd", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}
          >
            ✨ صنف جديد
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={onCancel} type="button" style={btnSecondary}>إلغاء</button>
          <button onClick={save} disabled={busy} type="button" style={btnPrimary}>{busy ? "..." : "حفظ"}</button>
        </div>
      </div>
      </DocumentEditorSection>
      {quickCreateOpen && (
        <QuickCreateDialog
          kind="item"
          documentLabel={{ ar: "عرض السعر", en: "quotation" }}
          initialVatRate={selectedRate ?? 0}
          includeQuantity
          busy={quickCreateBusy}
          error={quickCreateError}
          onCancel={() => { if (!quickCreateBusy) setQuickCreateOpen(false); }}
          onSubmit={(payload, action) => payload.kind === "item" ? createQuickItem(payload, action) : undefined}
          uoms={uoms}
        />
      )}
      {itemPickerOpen && <DocumentItemPicker items={deps.items} onCancel={() => setItemPickerOpen(false)} onAdd={appendCatalogItems} />}
      {historyTarget && (
        <ItemHistoryDialog itemId={historyTarget.item.id} itemName={historyTarget.item.nameAr}
          customerId={historyTarget.customer.id} customerName={historyTarget.customer.nameAr}
          onClose={() => setHistoryTarget(null)} />
      )}
      {historyNeedsCustomer && <NoCustomerHistoryDialog onClose={() => setHistoryNeedsCustomer(false)} />}
      </DocumentEditorShell>
    </div>
  );
}
