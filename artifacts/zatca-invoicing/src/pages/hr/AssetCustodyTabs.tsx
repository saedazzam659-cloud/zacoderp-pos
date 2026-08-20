// العهد العينية (أصول بعهدة الموظفين) + تقرير العهد — امتداد لشاشة عهد الموظفين.
// تسليم/استرجاع إداري فقط بدون أي قيد محاسبي؛ يتزامن مع «الموظف المسؤول» في سجل الأصول.
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { DateField } from "@/components/ui/date-field";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, Pencil, Loader2, Package, Undo2, Printer, FileSpreadsheet, FileDown } from "lucide-react";
import { fmt2 } from "@/lib/format";
import { exportToExcel, type ExportColumn } from "@/lib/export";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const today = () => new Date().toISOString().slice(0, 10);
const num = (v: any) => Number(v ?? 0) || 0;
function fmtDmy(iso?: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

const A_EMPTY: any = { assetId: "", employeeId: "", deliveryDate: today(), expectedReturnDate: "", notes: "" };

type Common = { employees: any[]; pickName: (ar?: string, en?: string) => string; isRtl: boolean };

function useAssets() {
  const { user, token } = useAuth() as any;
  const cid = user?.companyId;
  return useQuery<any[]>({
    queryKey: ["fa/assets", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/fixed-assets/assets?companyId=${cid}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    },
    enabled: !!cid,
  });
}

// ─── تبويب العهد العينية ─────────────────────────────────────────────────────
export function AssetCustodyTab({ employees, pickName, isRtl }: Common) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<any>(A_EMPTY);
  const [returnFor, setReturnFor] = useState<any | null>(null);
  const [retDate, setRetDate] = useState(today());

  const { data: assets = [] } = useAssets();
  const { data: rows = [], isLoading } = useQuery<any[]>({
    queryKey: ["asset-custodies", filter],
    queryFn: () => employeesApi.assetCustodies(filter === "all" ? {} : { status: filter }),
  });

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["asset-custodies"] }); qc.invalidateQueries({ queryKey: ["fa/assets"] }); };
  const onError = (e: any) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) });

  const selectedAsset = useMemo(
    () => assets.find((a: any) => String(a.id) === String(form.assetId)) ?? null,
    [assets, form.assetId],
  );

  // عند اختيار أصل له موظف مسؤول، يُقترح تلقائيًا
  function onAssetChange(v: string) {
    const a = assets.find((x: any) => String(x.id) === v);
    setForm((f: any) => ({
      ...f, assetId: v,
      employeeId: f.employeeId || (a?.custodianEmployeeId ? String(a.custodianEmployeeId) : ""),
    }));
  }

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        assetId: Number(form.assetId),
        employeeId: form.employeeId ? Number(form.employeeId) : undefined,
        deliveryDate: form.deliveryDate,
        expectedReturnDate: form.expectedReturnDate || undefined,
        notes: form.notes || undefined,
      };
      return editingId ? employeesApi.updateAssetCustody(editingId, payload) : employeesApi.addAssetCustody(payload);
    },
    onSuccess: () => { invalidate(); setOpen(false); setForm(A_EMPTY); setEditingId(null); toast({ title: editingId ? "تم التعديل" : "تم تسليم العهدة" }); },
    onError,
  });
  const ret = useMutation({
    mutationFn: () => employeesApi.returnAssetCustody(returnFor.id, { actualReturnDate: retDate }),
    onSuccess: () => { invalidate(); setReturnFor(null); toast({ title: "تم استرجاع العهدة" }); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: number) => employeesApi.deleteAssetCustody(id),
    onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); },
    onError,
  });

  const FILTERS: Array<[string, string]> = [["all", "الكل"], ["delivered", "مُسلَّمة"], ["returned", "مسترجعة"]];

  return (
    <div className="space-y-3" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">الحالة:</span>
          {FILTERS.map(([v, l]) => (
            <Button key={v} variant={filter === v ? "default" : "outline"} size="sm" onClick={() => setFilter(v)} data-testid={`filter-asset-${v}`}>{l}</Button>
          ))}
        </div>
        <Button onClick={() => { setEditingId(null); setForm(A_EMPTY); setOpen(true); }} data-testid="btn-new-asset-custody">
          <Plus className="size-4 me-1" /> تسليم عهدة عينية
        </Button>
      </div>

      <div className="rounded-lg border overflow-x-auto bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase">
            <tr>
              <th className="p-2 text-start">الموظف</th>
              <th className="p-2 text-start">الأصل</th>
              <th className="p-2">قيمة الأصل</th>
              <th className="p-2">تاريخ التسليم</th>
              <th className="p-2">الإرجاع المتوقع</th>
              <th className="p-2">الإرجاع الفعلي</th>
              <th className="p-2">الحالة</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={8} className="p-4"><Skeleton className="h-10" /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">لا توجد عهد عينية</td></tr>
            ) : rows.map((c: any) => (
              <tr key={c.id} className="border-t" data-testid={`row-asset-custody-${c.id}`}>
                <td className="p-2">
                  <div className="font-medium">{pickName(c.empNameAr, c.empNameEn)}</div>
                  <div className="text-xs text-muted-foreground">{c.empCode}</div>
                </td>
                <td className="p-2">
                  <div className="font-medium">{c.assetNameAr}</div>
                  <div className="text-xs text-muted-foreground">{c.assetCode}{c.assetLocation ? ` — ${c.assetLocation}` : ""}</div>
                </td>
                <td className="p-2 text-end text-xs tabular-nums" dir="ltr">{fmt2(num(c.assetValue))}</td>
                <td className="p-2 text-center text-xs" dir="ltr">{c.deliveryDate}</td>
                <td className="p-2 text-center text-xs" dir="ltr">{c.expectedReturnDate || "—"}</td>
                <td className="p-2 text-center text-xs" dir="ltr">{c.actualReturnDate || "—"}</td>
                <td className="p-2 text-center">
                  {c.status === "delivered"
                    ? <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">بعهدة الموظف</Badge>
                    : <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">مسترجعة</Badge>}
                </td>
                <td className="p-2 text-end whitespace-nowrap">
                  {c.status === "delivered" && (
                    <Button size="sm" variant="ghost" title="استرجاع" onClick={() => { setReturnFor(c); setRetDate(today()); }} data-testid={`btn-return-asset-${c.id}`}>
                      <Undo2 className="size-3.5 text-emerald-600" />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => {
                    setEditingId(c.id);
                    setForm({
                      assetId: String(c.assetId), employeeId: String(c.employeeId),
                      deliveryDate: c.deliveryDate, expectedReturnDate: c.expectedReturnDate || "", notes: c.notes || "",
                    });
                    setOpen(true);
                  }} data-testid={`btn-edit-asset-custody-${c.id}`}>
                    <Pencil className="size-3.5 text-sky-600" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { if (confirm("حذف سجل العهدة؟")) del.mutate(c.id); }} data-testid={`btn-del-asset-custody-${c.id}`}>
                    <Trash2 className="size-3.5 text-rose-600" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-muted-foreground">
        تسليم العهدة العينية إجراء إداري فقط ولا يُنشئ أي قيد محاسبي — الأصل يبقى مسجلًا في سجل الأصول الثابتة، ويُحدَّث «الموظف المسؤول» تلقائيًا.
      </div>

      {/* نموذج تسليم/تعديل */}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setForm(A_EMPTY); setEditingId(null); } }}>
        <DialogContent className="max-w-lg" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader><DialogTitle>{editingId ? "تعديل عهدة عينية" : "تسليم عهدة عينية"}</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <label className="text-xs font-medium">الأصل</label>
              <SearchCombobox
                items={assets.filter((a: any) => a.status === "active" || String(a.id) === String(form.assetId)).map((a: any) => ({
                  value: String(a.id), code: a.code, label: a.nameAr || a.nameEn || `#${a.id}`,
                  description: a.location || undefined,
                }))}
                value={form.assetId}
                onValueChange={onAssetChange}
                placeholder="اختر الأصل"
                className="w-full"
                disabled={!!editingId}
              />
            </div>
            {selectedAsset && (
              <div className="rounded border bg-muted/30 p-2 text-xs grid grid-cols-2 gap-1" data-testid="asset-info">
                <div><span className="text-muted-foreground">الكود:</span> {selectedAsset.code}</div>
                <div><span className="text-muted-foreground">القيمة:</span> {fmt2(num(selectedAsset.purchaseValue))}</div>
                <div><span className="text-muted-foreground">القيمة الدفترية:</span> {fmt2(num(selectedAsset.bookValue))}</div>
                <div><span className="text-muted-foreground">الموقع:</span> {selectedAsset.location || "—"}</div>
              </div>
            )}
            <div>
              <label className="text-xs font-medium">الموظف المستلم</label>
              <SearchCombobox
                items={employees.filter((e: any) => e.status === "active" || String(e.id) === String(form.employeeId)).map((e: any) => ({
                  value: String(e.id), code: e.code, label: pickName(e.nameAr, e.nameEn),
                }))}
                value={form.employeeId}
                onValueChange={(v) => setForm({ ...form, employeeId: v })}
                placeholder="اختر الموظف"
                className="w-full"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium">تاريخ التسليم</label>
                <DateField value={form.deliveryDate} onChange={(e) => setForm({ ...form, deliveryDate: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-medium">تاريخ الإرجاع المتوقع (اختياري)</label>
                <DateField value={form.expectedReturnDate} onChange={(e) => setForm({ ...form, expectedReturnDate: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium">ملاحظات</label>
              <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !form.assetId || !form.employeeId || !form.deliveryDate} data-testid="btn-save-asset-custody">
              {save.isPending && <Loader2 className="size-4 me-1 animate-spin" />} حفظ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* استرجاع */}
      <Dialog open={!!returnFor} onOpenChange={(o) => { if (!o) setReturnFor(null); }}>
        <DialogContent className="max-w-sm" dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader><DialogTitle>استرجاع العهدة</DialogTitle></DialogHeader>
          {returnFor && (
            <div className="space-y-3 text-sm">
              <div className="rounded border bg-muted/30 p-2 text-xs">
                <strong>{returnFor.assetNameAr}</strong> ({returnFor.assetCode}) — بعهدة {pickName(returnFor.empNameAr, returnFor.empNameEn)}
              </div>
              <div>
                <label className="text-xs font-medium">تاريخ الإرجاع الفعلي</label>
                <DateField value={retDate} onChange={(e) => setRetDate(e.target.value)} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturnFor(null)}>إلغاء</Button>
            <Button onClick={() => ret.mutate()} disabled={ret.isPending || !retDate} data-testid="btn-confirm-asset-return">
              {ret.isPending && <Loader2 className="size-4 me-1 animate-spin" />} تأكيد الاسترجاع
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── تقرير العهد ─────────────────────────────────────────────────────────────
// يجمع العهد المالية والعينية مع فلاتر + طباعة نموذج إخلاء/كشف عهدة لكل موظف + تصدير.
export function CustodyReportTab({ employees, pickName, isRtl }: Common) {
  const { toast } = useToast();
  const { user } = useAuth() as any;
  const company = user?.company ?? null;
  const [empFilter, setEmpFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const { data: financial = [] } = useQuery<any[]>({
    queryKey: ["custodies", "all"],
    queryFn: () => employeesApi.custodies({}),
  });
  const { data: assetRows = [] } = useQuery<any[]>({
    queryKey: ["asset-custodies", "all"],
    queryFn: () => employeesApi.assetCustodies({}),
  });

  const remainingOf = (c: any) => +(num(c.amount) - num(c.settledAmount) - num(c.returnedAmount)).toFixed(2);

  const rows = useMemo(() => {
    const fin = financial.map((c: any) => ({
      kind: "مالية", employeeId: c.employeeId, employee: pickName(c.empNameAr, c.empNameEn), empCode: c.empCode,
      item: c.purpose || "عهدة مالية", code: "", date: c.custodyDate,
      value: num(c.amount), remaining: remainingOf(c),
      status: c.status === "active" ? "قائمة" : c.status === "settled" ? "مصفّاة" : "ملغاة",
      open: c.status === "active",
    }));
    const ast = assetRows.map((c: any) => ({
      kind: "عينية", employeeId: c.employeeId, employee: pickName(c.empNameAr, c.empNameEn), empCode: c.empCode,
      item: c.assetNameAr, code: c.assetCode, date: c.deliveryDate,
      value: num(c.assetValue), remaining: c.status === "delivered" ? num(c.assetValue) : 0,
      status: c.status === "delivered" ? "بعهدة الموظف" : "مسترجعة",
      open: c.status === "delivered",
    }));
    return [...fin, ...ast]
      .filter((r) => !empFilter || String(r.employeeId) === empFilter)
      .filter((r) => statusFilter === "all" ? true : statusFilter === "open" ? r.open : !r.open)
      .filter((r) => (!from || r.date >= from) && (!to || r.date <= to))
      .sort((a, b) => (a.employee || "").localeCompare(b.employee || "") || (a.date < b.date ? 1 : -1));
  }, [financial, assetRows, empFilter, statusFilter, from, to, pickName]);

  const totals = useMemo(() => ({
    count: rows.length,
    open: rows.filter((r) => r.open).length,
    value: rows.reduce((s, r) => s + r.value, 0),
    remaining: rows.reduce((s, r) => s + r.remaining, 0),
  }), [rows]);

  function exportExcel() {
    const fmt = "#,##0.00";
    const cols: ExportColumn[] = [
      { key: "employee", header: "الموظف" },
      { key: "empCode", header: "كود الموظف" },
      { key: "kind", header: "نوع العهدة" },
      { key: "item", header: "البيان / الأصل" },
      { key: "code", header: "كود الأصل" },
      { key: "date", header: "التاريخ" },
      { key: "value", header: "القيمة", numFmt: fmt },
      { key: "remaining", header: "المتبقي بالعهدة", numFmt: fmt },
      { key: "status", header: "الحالة" },
    ];
    exportToExcel(rows.map((r) => ({ ...r, date: fmtDmy(r.date) })), cols, "تقرير العهد", "تقرير العهد");
  }

  function buildReportHtml(forPrint: boolean, empName?: string): string {
    const data = empName ? rows.filter((r) => r.employee === empName) : rows;
    const title = empName ? `كشف عهد الموظف: ${empName}` : "تقرير العهد";
    const body = data.map((r) => `
      <tr>
        <td>${r.employee}</td><td>${r.kind}</td><td>${r.item}${r.code ? ` (${r.code})` : ""}</td>
        <td>${fmtDmy(r.date)}</td><td class="num">${fmt2(r.value)}</td><td class="num">${fmt2(r.remaining)}</td><td>${r.status}</td>
      </tr>`).join("");
    const tot = data.reduce((s, r) => s + r.remaining, 0);
    return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${title}</title>
      <style>
        body{font-family:Tahoma,Arial,sans-serif;font-size:12px;color:#111;margin:24px}
        h1{font-size:16px;margin:0 0 4px} .sub{color:#555;font-size:11px;margin-bottom:12px}
        table{width:100%;border-collapse:collapse} th,td{border:1px solid #999;padding:5px 7px;text-align:right}
        th{background:#f1f5f9} td.num,th.num{text-align:left;font-variant-numeric:tabular-nums}
        tfoot td{font-weight:bold;background:#f8fafc}
        .sig{margin-top:40px;display:flex;justify-content:space-between}
        .sig div{width:40%;border-top:1px solid #333;padding-top:6px;text-align:center}
      </style></head><body>
      <h1>${title}</h1>
      <div class="sub">${company?.nameAr || ""} — تاريخ الطباعة: ${fmtDmy(today())}</div>
      <table><thead><tr><th>الموظف</th><th>النوع</th><th>البيان / الأصل</th><th>التاريخ</th><th class="num">القيمة</th><th class="num">المتبقي</th><th>الحالة</th></tr></thead>
      <tbody>${body || `<tr><td colspan="7" style="text-align:center;color:#777">لا توجد بيانات</td></tr>`}</tbody>
      <tfoot><tr><td colspan="5">إجمالي المتبقي بالعهدة</td><td class="num">${fmt2(tot)}</td><td></td></tr></tfoot></table>
      ${empName ? `<div class="sig"><div>توقيع الموظف</div><div>توقيع مسؤول العهد</div></div>` : ""}
      ${forPrint ? `<script>window.onload=()=>{window.print();}</script>` : ""}
      </body></html>`;
  }

  function printReport(empName?: string) {
    const w = window.open("", "_blank");
    if (!w) { toast({ variant: "destructive", title: "خطأ", description: "المتصفح منع فتح نافذة الطباعة" }); return; }
    w.document.write(buildReportHtml(true, empName));
    w.document.close();
  }

  const empOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (r.employeeId) seen.set(String(r.employeeId), r.employee);
    // include all employees so filtering works even before data loads
    for (const e of employees) if (!seen.has(String(e.id))) seen.set(String(e.id), pickName(e.nameAr, e.nameEn));
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [rows, employees, pickName]);

  const selectedEmpName = empFilter ? (empOptions.find((o) => o.value === empFilter)?.label || "") : "";

  return (
    <div className="space-y-3" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-end gap-2 flex-wrap">
        <div className="w-56">
          <label className="text-xs font-medium">الموظف</label>
          <SearchCombobox items={empOptions} value={empFilter} onValueChange={setEmpFilter} placeholder="كل الموظفين" className="w-full" />
        </div>
        <div>
          <label className="text-xs font-medium">الحالة</label>
          <div className="flex gap-1">
            {([["all", "الكل"], ["open", "قائمة"], ["closed", "منتهية"]] as const).map(([v, l]) => (
              <Button key={v} size="sm" variant={statusFilter === v ? "default" : "outline"} onClick={() => setStatusFilter(v)}>{l}</Button>
            ))}
          </div>
        </div>
        <div className="w-36"><label className="text-xs font-medium">من تاريخ</label><DateField value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="w-36"><label className="text-xs font-medium">إلى تاريخ</label><DateField value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="ms-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={exportExcel} disabled={!rows.length} data-testid="btn-report-excel">
            <FileSpreadsheet className="size-4 me-1" /> Excel
          </Button>
          <Button variant="outline" size="sm" onClick={() => printReport()} disabled={!rows.length} data-testid="btn-report-print">
            <Printer className="size-4 me-1" /> طباعة / PDF
          </Button>
          {empFilter && (
            <Button size="sm" onClick={() => printReport(selectedEmpName)} data-testid="btn-report-emp-sheet">
              <FileDown className="size-4 me-1" /> كشف عهدة الموظف
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border p-3 bg-card"><div className="text-xs text-muted-foreground">عدد السجلات</div><div className="text-xl font-semibold tabular-nums">{totals.count}</div></div>
        <div className="rounded-lg border p-3 bg-amber-50/50 border-amber-200"><div className="text-xs text-amber-700">عهد قائمة</div><div className="text-xl font-semibold text-amber-700 tabular-nums">{totals.open}</div></div>
        <div className="rounded-lg border p-3 bg-card"><div className="text-xs text-muted-foreground">إجمالي القيمة</div><div className="text-xl font-semibold tabular-nums">{fmt2(totals.value)}</div></div>
        <div className="rounded-lg border p-3 bg-rose-50/50 border-rose-200"><div className="text-xs text-rose-700">المتبقي بالعهدة</div><div className="text-xl font-semibold text-rose-700 tabular-nums">{fmt2(totals.remaining)}</div></div>
      </div>

      <div className="rounded-lg border overflow-x-auto bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase">
            <tr>
              <th className="p-2 text-start">الموظف</th>
              <th className="p-2">النوع</th>
              <th className="p-2 text-start">البيان / الأصل</th>
              <th className="p-2">التاريخ</th>
              <th className="p-2">القيمة</th>
              <th className="p-2">المتبقي</th>
              <th className="p-2">الحالة</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا توجد بيانات مطابقة</td></tr>
            ) : rows.map((r, i) => (
              <tr key={`${r.kind}-${i}`} className="border-t">
                <td className="p-2"><div className="font-medium">{r.employee}</div><div className="text-xs text-muted-foreground">{r.empCode}</div></td>
                <td className="p-2 text-center"><Badge variant="outline" className={r.kind === "مالية" ? "bg-sky-50 text-sky-700 border-sky-200" : "bg-violet-50 text-violet-700 border-violet-200"}>{r.kind}</Badge></td>
                <td className="p-2 text-xs">{r.item}{r.code ? ` (${r.code})` : ""}</td>
                <td className="p-2 text-center text-xs" dir="ltr">{r.date}</td>
                <td className="p-2 text-end text-xs tabular-nums" dir="ltr">{fmt2(r.value)}</td>
                <td className="p-2 text-end text-xs tabular-nums font-medium" dir="ltr">{fmt2(r.remaining)}</td>
                <td className="p-2 text-center text-xs">{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
