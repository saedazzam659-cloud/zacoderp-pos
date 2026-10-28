import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { exportData, downloadBlob } from "@/lib/dataIoApi";

type ImportKind = "receipt" | "payment" | "customer_credit" | "customer_debit" | "supplier_credit" | "supplier_debit";
type Row = Record<string, any>;
type LookupData = Record<string, any[]>;

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const voucherFields = [
  "source_doc_number", "document_date", "party_code", "branch_code", "payment_type",
  "cash_box_code", "bank_account_code", "amount", "source_invoice_number", "description",
];
const noteFields = [
  "source_doc_number", "document_date", "party_code", "branch_code", "contra_account_code",
  "amount", "vat_enabled", "vat_rate", "vat_amount", "vat_account_code", "reference_number", "reference_date", "description",
];
const kindLabels: Record<ImportKind, string> = {
  receipt: "سند قبض",
  payment: "سند صرف",
  customer_credit: "إشعار دائن لعميل",
  customer_debit: "إشعار مدين لعميل",
  supplier_credit: "إشعار دائن لمورد",
  supplier_debit: "إشعار مدين لمورد",
};

function text(value: unknown) { return String(value ?? "").trim(); }
function isoDate(value: string) {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized;
}
function codeMatch(rows: any[], code: string) {
  const matches = rows.filter((row) => text(row.code).toLocaleLowerCase() === code.toLocaleLowerCase());
  return matches.length === 1 ? matches[0] : null;
}
function rowHeaders(kind: ImportKind) { return kind === "receipt" || kind === "payment" ? voucherFields : noteFields; }
function partyType(kind: ImportKind) {
  if (kind === "receipt" || kind.startsWith("customer")) return "customer";
  return "supplier";
}
function noteType(kind: ImportKind) { return kind.endsWith("credit") ? "credit" : "debit"; }
function authHeaders(token: string | null, json = false): HeadersInit {
  const actingCompanyId = localStorage.getItem("zatca_acting_company_id");
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(actingCompanyId ? { "x-acting-company-id": actingCompanyId } : {}),
  };
}
async function requestJson(path: string, token: string | null, method = "GET", body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: authHeaders(token, body !== undefined),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error ?? data?.message ?? "تعذر تنفيذ الطلب");
  return data;
}
function parseWorkbook(file: File): Promise<Row[]> {
  return file.arrayBuffer().then((buffer) => {
    const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error("الملف لا يحتوي ورقة بيانات.");
    const matrix = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: "", raw: false });
    const headers = (matrix[0] ?? []).map((value) => text(value).toLowerCase());
    if (!headers.length) throw new Error("صف العناوين فارغ.");
    const rows = matrix.slice(1).filter((row) => row.some((value) => text(value))).map((values) => {
      const result: Row = {};
      headers.forEach((header, index) => { if (header) result[header] = text(values[index]); });
      return result;
    });
    if (!rows.length) throw new Error("الملف لا يحتوي صفوف بيانات.");
    return rows;
  });
}

export function HistoricalCashNotesMigration({ cid, token, toast }: {
  cid: number;
  token: string | null;
  toast: (args: any) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<ImportKind>("receipt");
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState("");
  const [lookup, setLookup] = useState<LookupData | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmPosting, setConfirmPosting] = useState(false);
  const [confirmBaseCurrency, setConfirmBaseCurrency] = useState(false);
  const [results, setResults] = useState<Array<{ source: string; status: string; detail: string }>>([]);
  const headers = rowHeaders(kind);

  function downloadTemplate() {
    const example = kind === "receipt" || kind === "payment"
      ? ["RAGM-R-001", "2022-01-15", "CUST-001", "BR-01", "cash", "CASH-01", "", "100.00", "", "تحصيل تاريخي"]
      : ["RAGM-N-001", "2022-01-15", kind.startsWith("customer") ? "CUST-001" : "SUP-001", "BR-01", "4101", "100.00", "false", "15", "0", "", "INV-OLD-001", "2022-01-10", "إشعار تاريخي"];
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([headers, example]);
    XLSX.utils.book_append_sheet(workbook, sheet, "ترحيل");
    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    downloadBlob(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `نموذج_${kindLabels[kind]}.xlsx`);
  }

  async function loadLookups() {
    if (lookup) return lookup;
    const blob = await exportData(token, {
      companyId: cid,
      types: ["customers", "suppliers", "branches", "accounts", "cashBoxes", "bankAccounts"],
      format: "json",
    });
    const payload = JSON.parse(await blob.text());
    if (payload?.meta?.truncated && Object.keys(payload.meta.truncated).length) {
      throw new Error("بيانات المطابقة مبتورة؛ أوقفنا الاستيراد حتى لا نربط المستند بطرف أو حساب غير ظاهر.");
    }
    const data = payload?.data ?? {};
    setLookup(data);
    return data;
  }

  async function onFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setRows([]);
    setResults([]);
    setConfirmPosting(false);
    setConfirmBaseCurrency(false);
    setFileName(file.name);
    try {
      const parsed = await parseWorkbook(file);
      const missing = headers.filter((header) => !Object.prototype.hasOwnProperty.call(parsed[0], header));
      if (missing.length) throw new Error(`أعمدة النموذج ناقصة: ${missing.join("، ")}`);
      const references = await loadLookups();
      const needsInvoiceLookup = (kind === "receipt" || kind === "payment")
        && parsed.some((row) => text(row.source_invoice_number));
      if (needsInvoiceLookup && kind === "receipt") {
        references.salesInvoices = await requestJson(`/api/sales/sales-invoices?companyId=${cid}&source=all`, token);
      }
      if (needsInvoiceLookup && kind === "payment") {
        references.purchaseInvoices = await requestJson(`/api/purchasing/purchase-invoices?companyId=${cid}`, token);
      }
      setLookup(references);
      const checked = parsed.map((row, index) => {
        const issues: string[] = [];
        if (!text(row.source_doc_number)) issues.push("رقم المصدر مطلوب");
        if (!isoDate(text(row.document_date))) issues.push("التاريخ يجب أن يكون YYYY-MM-DD");
        const amount = Number(text(row.amount).replaceAll(",", ""));
        if (!Number.isFinite(amount) || amount <= 0) issues.push("المبلغ يجب أن يكون أكبر من صفر");
        const parties = partyType(kind) === "customer" ? references.customers ?? [] : references.suppliers ?? [];
        const party = codeMatch(parties, text(row.party_code));
        if (!party?.id) issues.push("كود العميل/المورد غير مطابق أو غير فريد");
        if (!party?.accountId) issues.push("الطرف ليس مرتبطًا بحساب ذمم");
        const branch = codeMatch(references.branches ?? [], text(row.branch_code));
        if (!branch?.id) issues.push("كود الفرع غير مطابق أو غير فريد");
        if (kind === "receipt" || kind === "payment") {
          const payment = text(row.payment_type).toLowerCase();
          if (!["cash", "bank", "نقدي", "بنكي"].includes(payment)) issues.push("طريقة السداد يجب أن تكون cash أو bank");
          if (["cash", "نقدي"].includes(payment) && !codeMatch(references.cashBoxes ?? [], text(row.cash_box_code))?.id) issues.push("كود الخزنة غير مطابق");
          if (["bank", "بنكي"].includes(payment) && !codeMatch(references.bankAccounts ?? [], text(row.bank_account_code))?.id) issues.push("كود البنك غير مطابق");
          const legacyInvoiceNumber = text(row.source_invoice_number);
          if (legacyInvoiceNumber) {
            const invoices = kind === "receipt" ? references.salesInvoices ?? [] : references.purchaseInvoices ?? [];
            const matches = invoices.filter((invoice: any) =>
              [invoice.docNumber, invoice.legacyDocNumber, invoice.supplierInvoiceNumber]
                .some((number) => text(number).toLocaleLowerCase() === legacyInvoiceNumber.toLocaleLowerCase()),
            );
            if (matches.length !== 1) issues.push(matches.length ? "رقم الفاتورة المصدر يطابق أكثر من فاتورة" : "الفاتورة المصدر غير موجودة في النظام الجديد");
            else {
              const linkedPartyId = kind === "receipt" ? matches[0].customerId : matches[0].supplierId;
              if (Number(linkedPartyId) !== Number(party?.id)) issues.push("الطرف في الفاتورة المصدر لا يطابق كود الطرف");
              if (matches[0].status !== "posted") issues.push("رحّل الفاتورة المصدر أولاً قبل ربط سند التسوية بها");
              if (String(matches[0].currencyCode ?? "SAR").toUpperCase() !== "SAR") issues.push("الفاتورة المصدر ليست بالريال السعودي؛ هذا النموذج لا يدعم التسوية بعملة أجنبية");
            }
          }
        } else {
          if (!codeMatch(references.accounts ?? [], text(row.contra_account_code))?.id) issues.push("الحساب المقابل غير مطابق");
          const vatEnabled = ["true", "1", "yes", "نعم"].includes(text(row.vat_enabled).toLowerCase());
          if (vatEnabled) {
            const rate = Number(text(row.vat_rate));
            if (!Number.isFinite(rate) || rate < 0 || rate > 100) issues.push("نسبة الضريبة غير صالحة");
            const vatAmount = Number(text(row.vat_amount).replaceAll(",", ""));
            if (!Number.isFinite(vatAmount) || vatAmount < 0) issues.push("مبلغ الضريبة غير صالح");
            else if (Number.isFinite(amount) && Number.isFinite(rate) && Math.abs(vatAmount - +(amount * rate / 100).toFixed(4)) > 0.0001) {
              issues.push("مبلغ الضريبة لا يطابق النسبة؛ راجع التقريب في المصدر");
            }
            if (!codeMatch(references.accounts ?? [], text(row.vat_account_code))?.id) issues.push("حساب الضريبة غير مطابق");
          }
        }
        return { ...row, __rowIndex: index + 2, __issues: issues };
      });
      setRows(checked);
    } catch (error: any) {
      setFileName("");
      toast({ title: error?.message ?? "تعذر قراءة الملف", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const invalidCount = useMemo(() => rows.filter((row) => row.__issues?.length).length, [rows]);

  async function preflightPostedSequences(references: LookupData) {
    const [sequences, years] = await Promise.all([
      requestJson(`/api/sequences?companyId=${cid}`, token) as Promise<any[]>,
      requestJson(`/api/fiscal/years?companyId=${cid}`, token) as Promise<any[]>,
    ]);
    const details = await Promise.all(years.map((year) => requestJson(`/api/fiscal/years/${year.id}?companyId=${cid}`, token)));
    const periods = details.flatMap((detail: any) => detail.periods ?? []);
    const seen = new Set<string>();
    for (const row of rows) {
      const date = text(row.document_date);
      const branch: any = codeMatch(references.branches ?? [], text(row.branch_code));
      const paymentType = kind === "receipt" || kind === "payment"
        ? (["cash", "نقدي"].includes(text(row.payment_type).toLowerCase()) ? "cash" : "bank")
        : "";
      const txType = kind === "receipt"
        ? "receipt_voucher"
        : kind === "payment"
          ? "payment_voucher"
          : `account_note_${partyType(kind)}_${noteType(kind)}`;
      const key = JSON.stringify([txType, date, branch?.id, paymentType]);
      if (seen.has(key)) continue;
      seen.add(key);
      const period = periods.find((candidate: any) => String(candidate.startDate) <= date && String(candidate.endDate) >= date);
      if (!period) throw new Error(`لا توجد فترة مالية تغطي تاريخ ${date}؛ أضف السنة والفترات يدويًا ثم أعد المحاولة.`);
      const query = new URLSearchParams({ companyId: String(cid), date, branchId: String(branch.id) });
      if (paymentType) query.set("paymentType", paymentType);
      const preview = await requestJson(`/api/sequences/peek/${encodeURIComponent(txType)}?${query}`, token) as any;
      if (!preview?.hasSequence || !preview.sequenceCode || !preview.number) {
        throw new Error(`لا يوجد مسلسل سنوي صالح لـ ${kindLabels[kind]} بتاريخ ${date} والفرع المحدد.`);
      }
      const sequence = sequences.find((candidate: any) => String(candidate.code) === String(preview.sequenceCode));
      const periodIds = Array.isArray(sequence?.fiscalPeriodIds) ? sequence.fiscalPeriodIds.map(Number) : [];
      if (!sequence?.isActive || !periodIds.includes(Number(period.id))) {
        throw new Error(`المسلسل ${preview.sequenceCode} غير مخصص للفترة المالية التي تغطي ${date}.`);
      }
      const fiscalYears = new Set(periodIds
        .map((id: number) => periods.find((candidate: any) => Number(candidate.id) === id)?.fiscalYearId)
        .filter((id: unknown) => id != null)
        .map(Number));
      if (fiscalYears.size !== 1 || !fiscalYears.has(Number(period.fiscalYearId))) {
        throw new Error(`المسلسل ${preview.sequenceCode} يجب أن يكون مستقلًا للسنة المالية ${period.fiscalYearId}.`);
      }
    }
  }

  async function importRows() {
    if (!rows.length || invalidCount) return;
    setBusy(true);
    setResults([]);
    const currentResults: Array<{ source: string; status: string; detail: string }> = [];
    try {
      const references = await loadLookups();
      await preflightPostedSequences(references);
      const partyRows = partyType(kind) === "customer" ? references.customers ?? [] : references.suppliers ?? [];
      const partyIndex = new Map(partyRows.map((item: any) => [text(item.code).toLowerCase(), item]));
      const branchIndex = new Map((references.branches ?? []).map((item: any) => [text(item.code).toLowerCase(), item]));
      const accountIndex = new Map((references.accounts ?? []).map((item: any) => [text(item.code).toLowerCase(), item]));
      const cashIndex = new Map((references.cashBoxes ?? []).map((item: any) => [text(item.code).toLowerCase(), item]));
      const bankIndex = new Map((references.bankAccounts ?? []).map((item: any) => [text(item.code).toLowerCase(), item]));
      const voucherImport = kind === "receipt" || kind === "payment";
      const voucherPath = kind === "receipt" ? "/api/receipt-vouchers" : "/api/payment-vouchers";
      const existingRows = voucherImport
        ? await requestJson(`${voucherPath}?companyId=${cid}`, token)
        : await requestJson(`/api/account-notes?companyId=${cid}&partyType=${partyType(kind)}`, token);
      const existingList: any[] = Array.isArray(existingRows) ? existingRows : (existingRows?.data ?? []);
      const importedKeys = new Set(existingList.map((item: any) => voucherImport
        ? [item.refType, text(item.refNumber), item.date, item.entityId].join("|")
        : [item.operationNumber, item.noteDate, item.partyId, item.noteType].join("|")));

      for (const row of rows) {
        const sourceNumber = text(row.source_doc_number);
        try {
          const party: any = partyIndex.get(text(row.party_code).toLowerCase());
          const branch: any = branchIndex.get(text(row.branch_code).toLowerCase());
          const amount = Number(text(row.amount).replaceAll(",", ""));
          let created: any;
          if (kind === "receipt" || kind === "payment") {
            const paymentType = ["cash", "نقدي"].includes(text(row.payment_type).toLowerCase()) ? "cash" : "bank";
            const refType = "legacy_ragmcloud";
            const path = kind === "receipt" ? "/api/receipt-vouchers" : "/api/payment-vouchers";
            const duplicateKey = [refType, sourceNumber, text(row.document_date), party.id].join("|");
            if (importedKeys.has(duplicateKey)) {
              const duplicate = existingList.find((voucher: any) => [voucher.refType, text(voucher.refNumber), voucher.date, voucher.entityId].join("|") === duplicateKey);
              currentResults.push({ source: sourceNumber, status: "مكرر — تم التخطي", detail: `موجود بالفعل${duplicate?.code ? ` برقم النظام ${duplicate.code}` : " أو تكرر في الملف"}` });
              setResults([...currentResults]);
              continue;
            }
            const body: any = {
              companyId: cid,
              date: text(row.document_date),
              branchId: Number(branch.id),
              paymentType,
              cashBoxId: paymentType === "cash" ? Number((cashIndex.get(text(row.cash_box_code).toLowerCase()) as any)?.id) : null,
              bankAccountId: paymentType === "bank" ? Number((bankIndex.get(text(row.bank_account_code).toLowerCase()) as any)?.id) : null,
              entityType: partyType(kind),
              entityId: Number(party.id),
              entityName: party.nameAr ?? party.nameEn ?? "",
              amount: amount.toFixed(2),
              currencyId: null,
              exchangeRate: "1",
              ...(text(row.source_invoice_number) ? {
                salesInvoiceId: Number((references.salesInvoices ?? []).find((invoice: any) =>
                  [invoice.docNumber, invoice.legacyDocNumber].some((number) => text(number).toLocaleLowerCase() === text(row.source_invoice_number).toLocaleLowerCase()),
                )?.id),
                purchaseInvoiceId: Number((references.purchaseInvoices ?? []).find((invoice: any) =>
                  [invoice.docNumber, invoice.supplierInvoiceNumber].some((number) => text(number).toLocaleLowerCase() === text(row.source_invoice_number).toLocaleLowerCase()),
                )?.id),
              } : {}),
              refType,
              refNumber: sourceNumber,
              description: text(row.description) || `ترحيل تاريخي من RAGM Cloud — ${sourceNumber}`,
              notes: null,
            };
            created = await requestJson(path, token, "POST", body);
            importedKeys.add(duplicateKey);
            try {
              await requestJson(`${path}/${created.id}/post`, token, "POST");
            } catch (error: any) {
              currentResults.push({ source: sourceNumber, status: "المسودة حُفظت ولم تُرحّل", detail: error?.message ?? "تعذر الترحيل" });
              setResults([...currentResults]);
              continue;
            }
          } else {
            const partyId = Number(party.id);
            const sourceMarker = `RAGM:${sourceNumber}`;
            const duplicateKey = [sourceMarker, text(row.document_date), partyId, noteType(kind)].join("|");
            if (importedKeys.has(duplicateKey)) {
              const duplicate = existingList.find((note: any) => [note.operationNumber, note.noteDate, note.partyId, note.noteType].join("|") === duplicateKey);
              currentResults.push({ source: sourceNumber, status: "مكرر — تم التخطي", detail: `موجود بالفعل${duplicate?.noteNumber ? ` برقم النظام ${duplicate.noteNumber}` : " أو تكرر في الملف"}` });
              setResults([...currentResults]);
              continue;
            }
            const vatEnabled = ["true", "1", "yes", "نعم"].includes(text(row.vat_enabled).toLowerCase());
            const contra = accountIndex.get(text(row.contra_account_code).toLowerCase()) as any;
            const vatAccount = accountIndex.get(text(row.vat_account_code).toLowerCase()) as any;
            const body = {
              companyId: cid,
              partyType: partyType(kind),
              noteType: noteType(kind),
              noteDate: text(row.document_date),
              branchId: Number(branch.id),
              partyId,
              partyAccountId: Number(party.accountId),
              contraAccountId: Number(contra.id),
              amount: amount.toFixed(4),
              vatEnabled,
              vatRate: vatEnabled ? text(row.vat_rate) : "0",
              vatAccountId: vatEnabled ? Number(vatAccount.id) : null,
              description: text(row.description) || `ترحيل تاريخي من RAGM Cloud — ${sourceNumber}`,
              notes: "ترحيل تاريخي؛ الرقم الأصلي محفوظ في رقم العملية.",
              operationNumber: `RAGM:${sourceNumber}`,
              referenceNumber: text(row.reference_number) || null,
              referenceDate: text(row.reference_date) || null,
            };
            created = await requestJson("/api/account-notes", token, "POST", body);
            importedKeys.add(duplicateKey);
            try {
              await requestJson(`/api/account-notes/${created.id}/post`, token, "POST");
            } catch (error: any) {
              currentResults.push({ source: sourceNumber, status: "المسودة حُفظت ولم تُرحّل", detail: error?.message ?? "تعذر الترحيل" });
              setResults([...currentResults]);
              continue;
            }
          }
          currentResults.push({
            source: sourceNumber,
            status: "تم الإنشاء والترحيل",
            detail: `رقم النظام الجديد: ${created.code ?? created.noteNumber ?? created.id}`,
          });
        } catch (error: any) {
          currentResults.push({ source: sourceNumber, status: "تعذر الاستيراد", detail: error?.message ?? "خطأ غير معروف" });
        }
        setResults([...currentResults]);
      }
      toast({ title: `اكتملت معالجة ${currentResults.length} مستندًا` });
    } catch (error: any) {
      toast({ title: error?.message ?? "تعذر الاستيراد", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="historical-cash-notes-migration">
      <Card className="border-sky-200">
        <CardContent className="space-y-3 p-4">
          <div>
            <h2 className="text-lg font-bold">ترحيل سندات القبض والصرف والإشعارات</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              جهّز ملف Excel من البيانات التي تراجعها في RAGM Cloud. كل صف يمثل سندًا أو إشعارًا واحدًا. تتم المطابقة مع بيانات الشركة الحالية، ويُنشأ المستند عبر مساره الأصلي.
            </p>
          </div>
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
            <AlertTriangle className="ml-1 inline h-4 w-4" />
            لا نقرأ حساب RAGM Cloud تلقائيًا. راجع البيانات المنقولة من الشاشات، وتأكد من عدم تكرار أثر المستند قبل اختيار ترحيله محاسبيًا.
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-64 space-y-1 text-sm">
              <span className="font-medium">نوع البيانات</span>
              <Select value={kind} onValueChange={(value) => { setKind(value as ImportKind); setRows([]); setResults([]); setFileName(""); setConfirmPosting(false); setConfirmBaseCurrency(false); }}>
                <SelectTrigger data-testid="select-historical-financial-kind"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(kindLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <Button variant="outline" onClick={downloadTemplate} className="gap-2" data-testid="button-download-financial-template">
              <Download className="h-4 w-4" />تنزيل نموذج Excel
            </Button>
            <input ref={fileRef} className="hidden" type="file" accept=".xlsx,.xls,.csv" onChange={(event) => void onFile(event.target.files?.[0])} />
            <Button onClick={() => fileRef.current?.click()} disabled={busy} className="gap-2" data-testid="button-upload-financial-file">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}رفع ملف البيانات
            </Button>
            {fileName && <Badge variant="outline">{fileName}</Badge>}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            الأعمدة ثابتة في النموذج. أرقام المستندات القديمة تُحفظ كمرجع، بينما النظام يولّد أرقامه الجديدة. هذه النسخة للمبالغ بالريال السعودي وبسعر صرف 1 فقط؛ لا ترفع مستندًا بعملة أجنبية. لا تُنشأ بيانات تأسيسية تلقائيًا؛ الأكواد غير المطابقة توقف الاستيراد.
          </div>
          {!!rows.length && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{rows.length} صف</Badge>
                <Badge variant={invalidCount ? "destructive" : "secondary"}>{invalidCount} أخطاء مطابقة</Badge>
                <label className="mr-auto flex items-center gap-2 rounded border p-2 text-sm">
                  <input type="checkbox" checked={confirmPosting} onChange={(event) => setConfirmPosting(event.target.checked)} data-testid="checkbox-post-historical-financial" />
                  أؤكد ترحيل جميع المستندات المطابقة بعد فحص الفترة والمسلسل
                </label>
                <label className="flex items-center gap-2 rounded border p-2 text-sm">
                  <input type="checkbox" checked={confirmBaseCurrency} onChange={(event) => setConfirmBaseCurrency(event.target.checked)} data-testid="checkbox-historical-base-currency" />
                  أؤكد أن المبالغ بالريال السعودي وسعر الصرف 1
                </label>
              </div>
              {confirmPosting && <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-950">
                سيُرحّل كل مستند صالح مباشرة ويؤثر على الأرصدة والقيود. لن يبدأ الاستيراد قبل تحقق الفترات والمسلسلات السنوية.
              </div>}
              <div className="max-h-[420px] overflow-auto rounded border">
                <table className="min-w-[850px] text-xs">
                  <thead className="sticky top-0 bg-muted"><tr className="text-right">
                    <th className="p-2">الصف</th><th className="p-2">رقم المصدر</th><th className="p-2">التاريخ</th><th className="p-2">كود الطرف</th><th className="p-2">المبلغ</th><th className="p-2">الحالة</th>
                  </tr></thead>
                  <tbody>{rows.map((row, index) => <tr key={`${row.source_doc_number}-${index}`} className="border-t">
                    <td className="p-2">{row.__rowIndex}</td><td className="p-2">{row.source_doc_number || "—"}</td>
                    <td className="p-2" dir="ltr">{row.document_date || "—"}</td><td className="p-2">{row.party_code || "—"}</td>
                    <td className="p-2" dir="ltr">{row.amount || "—"}</td>
                    <td className="p-2">{row.__issues?.length
                      ? <span className="text-red-700">{row.__issues.join("؛ ")}</span>
                      : <span className="text-emerald-700"><CheckCircle2 className="ml-1 inline h-3.5 w-3.5" />جاهز للمراجعة</span>}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <Button onClick={() => void importRows()} disabled={busy || !rows.length || invalidCount > 0 || !confirmPosting || !confirmBaseCurrency} data-testid="button-import-historical-financial">
                {busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="ml-2 h-4 w-4" />}
                استيراد وترحيل المستندات
              </Button>
              {invalidCount > 0 && <p className="text-sm text-amber-800">أصلح الأخطاء في ملف المصدر وأعد رفعه قبل الاستيراد.</p>}
            </>
          )}
          {!!results.length && <div className="max-h-60 overflow-auto rounded border" role="status" data-testid="historical-financial-import-results">
            {results.map((result, index) => <div key={`${result.source}-${index}`} className="border-t p-2 text-sm">
              <strong>{result.source}</strong> — {result.status}: {result.detail}
            </div>)}
          </div>}
        </CardContent>
      </Card>
    </div>
  );
}
