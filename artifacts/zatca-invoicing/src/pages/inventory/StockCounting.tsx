import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import { Plus, Trash2, ClipboardList, Search, Send, ChevronDown, ChevronUp, Save, Sparkles } from "lucide-react";
import * as XLSX from "xlsx";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { cn } from "@/lib/utils";
import { SearchCombobox } from "@/components/ui/search-combobox";

import { useFmt } from "@/hooks/use-fmt";
import ExportButtons from "@/components/ExportButtons";

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft:  { label: "مسودة",  color: "bg-amber-50 text-amber-700" },
  posted: { label: "مُعتمد", color: "bg-green-50 text-green-700" },
};

export default function StockCounting() {
  const { fmt, fmtQty } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>({ countNumber: "", countDate: new Date().toISOString().slice(0, 10), warehouseId: "", notes: "" });
  const [showForm, setShowForm] = useState(false);

  const seqPeek = useNextSequenceNumber("stock_count", showForm);
  useEffect(() => {
    if (!showForm) return;
    if (seqPeek.hasSequence && seqPeek.number) {
      setForm((p: any) => (p.countNumber === seqPeek.number ? p : { ...p, countNumber: seqPeek.number }));
    }
  }, [showForm, seqPeek.hasSequence, seqPeek.number]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editedLines, setEditedLines] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [aiUploading, setAiUploading] = useState(false);
  const [aiReport, setAiReport] = useState<{ matched: number; unmatched: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: counts = [], isLoading } = useQuery({ queryKey: ["stock-counts", cid], queryFn: () => inventoryApi.getCounts(cid) });
  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses", cid], queryFn: () => inventoryApi.getWarehouses(cid) });
  const { data: countDetail, refetch: refetchDetail } = useQuery({ queryKey: ["count-detail", expandedId], queryFn: () => inventoryApi.getCount(expandedId!), enabled: expandedId !== null });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["stock-counts"] });
  const createMut = useMutation({ mutationFn: inventoryApi.createCount, onSuccess: () => { invalidate(); reset(); toast({ title: "تم إنشاء ورقة الجرد وتحميل الأرصدة الحالية" }); } });
  const postMut   = useMutation({ mutationFn: inventoryApi.postCount, onSuccess: () => { invalidate(); qc.invalidateQueries({ queryKey: ["stock-balance"] }); toast({ title: "تم اعتماد الجرد وتحديث أرصدة المخزون" }); } });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteCount, onSuccess: () => { invalidate(); toast({ title: "تم الحذف" }); } });

  function reset() { setForm({ countNumber: "", countDate: new Date().toISOString().slice(0, 10), warehouseId: "", notes: "" }); setShowForm(false); }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.warehouseId) return;
    createMut.mutate({ ...form, warehouseId: Number(form.warehouseId) });
  }

  async function handleAiUpload(file: File) {
    if (!countDetail?.items?.length) {
      toast({ title: "افتح ورقة الجرد أولاً", variant: "destructive" });
      return;
    }
    setAiUploading(true);
    setAiReport(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
      if (!rows.length) throw new Error("الملف فارغ");

      const token = localStorage.getItem("token");
      const API = (import.meta as any).env?.VITE_API_URL || "";
      const res = await fetch(`${API}/api/ai/parse-stock-count`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "فشل التحليل");

      const aiItems: { code?: string; name?: string; barcode?: string; qty: number }[] = data.items || [];
      const norm = (s: any) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      const updates: Record<number, string> = {};
      const unmatched: string[] = [];

      for (const ai of aiItems) {
        const aiCode = norm(ai.code);
        const aiName = norm(ai.name);
        const aiBar  = norm(ai.barcode);
        const found = countDetail.items.find((it: any) => {
          const c = norm(it.item?.code);
          const n = norm(it.item?.nameAr);
          const ne = norm(it.item?.nameEn);
          const b = norm(it.item?.barcode);
          if (aiCode && c && aiCode === c) return true;
          if (aiBar  && b && aiBar  === b) return true;
          if (aiName && n && (n === aiName || n.includes(aiName) || aiName.includes(n))) return true;
          if (aiName && ne && (ne === aiName || ne.includes(aiName) || aiName.includes(ne))) return true;
          return false;
        });
        if (found) {
          updates[found.id] = String(ai.qty ?? 0);
        } else {
          unmatched.push(`${ai.code || ""} ${ai.name || ""}`.trim() || "(صف بدون تعريف)");
        }
      }

      setEditedLines(p => ({ ...p, ...updates }));
      setAiReport({ matched: Object.keys(updates).length, unmatched });
      toast({ title: `✓ تم استخراج ${Object.keys(updates).length} صنف من الملف` });
    } catch (e: any) {
      toast({ title: e.message || "فشل تحليل الملف", variant: "destructive" });
    } finally {
      setAiUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function saveActualQty(countId: number) {
    if (!countDetail?.items) return;
    setSavingId(countId);
    const updatedItems = countDetail.items.map((it: any) => ({
      id: it.id,
      actualQty: editedLines[it.id] !== undefined ? editedLines[it.id] : it.actualQty,
      systemQty: it.systemQty,
    }));
    await inventoryApi.updateCount(countId, { items: updatedItems });
    await refetchDetail();
    setEditedLines({});
    setSavingId(null);
    toast({ title: "تم حفظ الكميات الفعلية" });
  }

  const filtered = counts.filter((c: any) =>
    c.countNumber.includes(search) || (c.warehouse?.nameAr ?? "").includes(search)
  );

  // Export rows for count detail
  const countExportRows = (countDetail?.items ?? []).map((it: any) => ({
    itemCode:   it.item?.code ?? "",
    itemNameAr: it.item?.nameAr ?? "",
    systemQty:  fmtQty(it.systemQty),
    actualQty:  fmtQty(it.actualQty),
    diff:       fmtQty(it.diff),
    costPrice:  fmt(it.costPrice),
    totalDiff:  fmt(Number(it.diff) * Number(it.costPrice)),
  }));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ClipboardList className="h-6 w-6 text-primary" />الجرد المخزني</h1>
          <p className="text-muted-foreground text-sm mt-1">مقارنة الكميات الفعلية بالكميات النظامية واعتماد الفروقات</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />جرد جديد
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={ClipboardList}
          title="ورقة جرد جديدة"
          subtitle="سيتم تحميل أرصدة المخزن الحالية لإدخال الكميات الفعلية"
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending}
          saveDisabled={!form.warehouseId || !form.countDate}
          saveLabel="إنشاء ورقة الجرد"
        >
          <FormGrid>
            <Field label="رقم الجرد"><Input
              placeholder={seqPeek.loading ? "…" : "CNT-001 (تلقائي)"}
              dir="ltr"
              className={cn("text-left", seqPeek.hasSequence && "bg-muted/40 cursor-not-allowed")}
              value={form.countNumber}
              onChange={e => { if (!seqPeek.hasSequence) setForm((p: any) => ({ ...p, countNumber: e.target.value })); }}
              readOnly={seqPeek.hasSequence}
              title={seqPeek.hasSequence ? `مسلسل: ${seqPeek.sequenceCode ?? ""}` : undefined}
            /></Field>
            <Field label="التاريخ" required><Input type="date" value={form.countDate} onChange={e => setForm((p: any) => ({ ...p, countDate: e.target.value }))} /></Field>
            <Field label="المخزن" required className="md:col-span-2">
              <SearchCombobox
                items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: w.nameAr }))}
                value={form.warehouseId}
                onValueChange={v => setForm((p: any) => ({ ...p, warehouseId: v }))}
                placeholder="— اختر مخزن —"
              />
            </Field>
            <Field label="ملاحظات" className="md:col-span-2"><Input placeholder="ملاحظات اختيارية" value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} /></Field>
            <p className="md:col-span-2 text-xs text-muted-foreground bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">سيتم تحميل جميع أرصدة المخزن الحالية تلقائياً لإدخال الكميات الفعلية</p>
          </FormGrid>
        </FormPanel>
      )}

      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pr-9" placeholder="بحث برقم الجرد أو المخزن..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-8"></th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">رقم الجرد</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">التاريخ</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">المخزن</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">الحالة</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-32">إجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={6}><Skeleton className="h-6 m-4" /></td></tr>)
              : filtered.length === 0 ? <tr><td colSpan={6} className="py-10 text-center text-muted-foreground"><ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-30" />لا توجد أوراق جرد</td></tr>
              : filtered.map((cnt: any) => {
                  const st = STATUS_CONFIG[cnt.status] ?? STATUS_CONFIG.draft;
                  return (
                    <>
                      <tr key={cnt.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <button onClick={() => { setExpandedId(expandedId === cnt.id ? null : cnt.id); setEditedLines({}); }} className="text-muted-foreground">
                            {expandedId === cnt.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs font-bold">{cnt.countNumber}</td>
                        <td className="px-4 py-3 text-muted-foreground">{cnt.countDate}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">{cnt.warehouse?.nameAr ?? "—"}</td>
                        <td className="px-4 py-3 text-center"><span className={cn("text-[10px] font-medium rounded-full px-2.5 py-1", st.color)}>{st.label}</span></td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                            {cnt.status === "draft" && (
                              <>
                                <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-green-700 border-green-200 hover:bg-green-50" onClick={() => { if (confirm("اعتماد الجرد وتحديث أرصدة المخزون بناءً على الكميات الفعلية؟")) postMut.mutate(cnt.id); }}>
                                  <Send className="h-3 w-3" />اعتماد
                                </Button>
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => { if (confirm("حذف ورقة الجرد؟")) deleteMut.mutate(cnt.id); }}>
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expandedId === cnt.id && (
                        <tr key={`exp-${cnt.id}`} className="bg-muted/5">
                          <td colSpan={6} className="px-4 py-4">
                            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                              <h3 className="text-xs font-semibold">تفاصيل الجرد</h3>
                              <div className="flex gap-2 flex-wrap">
                                {cnt.status === "draft" && (
                                  <>
                                    <input
                                      ref={fileInputRef}
                                      type="file"
                                      accept=".xlsx,.xls,.csv"
                                      className="hidden"
                                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAiUpload(f); }}
                                    />
                                    <Button
                                      size="sm" variant="outline"
                                      className="h-7 text-xs gap-1 text-purple-700 border-purple-200 hover:bg-purple-50"
                                      onClick={() => fileInputRef.current?.click()}
                                      disabled={aiUploading}
                                    >
                                      <Sparkles className="h-3 w-3" />
                                      {aiUploading ? "جاري التحليل..." : "رفع Excel (AI)"}
                                    </Button>
                                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => saveActualQty(cnt.id)} disabled={savingId === cnt.id}>
                                      <Save className="h-3 w-3" />{savingId === cnt.id ? "جاري الحفظ..." : "حفظ الكميات الفعلية"}
                                    </Button>
                                  </>
                                )}
                                <ExportButtons
                                  rows={countExportRows}
                                  columns={[
                                    { key: "itemCode",   header: "كود الصنف",     width: 16 },
                                    { key: "itemNameAr", header: "اسم الصنف",     width: 30 },
                                    { key: "systemQty",  header: "الكمية النظامية", width: 18 },
                                    { key: "actualQty",  header: "الكمية الفعلية", width: 18 },
                                    { key: "diff",       header: "الفرق",          width: 14 },
                                    { key: "costPrice",  header: "سعر التكلفة",    width: 16 },
                                    { key: "totalDiff",  header: "قيمة الفرق",     width: 16 },
                                  ]}
                                  filename={`جرد-${cnt.countNumber}`}
                                  title="تقرير الجرد المخزني"
                                  subtitle={`${cnt.warehouse?.nameAr ?? ""} — ${cnt.countDate}`}
                                  size="sm"
                                />
                              </div>
                            </div>
                            {!countDetail?.items?.length ? <p className="text-xs text-muted-foreground">لا توجد أصناف</p> : (
                              <div className="rounded-lg border overflow-hidden">
                                <table className="w-full text-xs">
                                  <thead className="bg-muted/50 border-b">
                                    <tr>
                                      <th className="px-3 py-2 text-right font-semibold text-muted-foreground">الصنف</th>
                                      <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-28">الكمية النظامية</th>
                                      <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-32">الكمية الفعلية</th>
                                      <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-24">الفرق</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y">
                                    {countDetail.items.map((it: any) => {
                                      const actualVal = editedLines[it.id] !== undefined ? editedLines[it.id] : String(it.actualQty);
                                      const diff = Number(actualVal) - Number(it.systemQty);
                                      return (
                                        <tr key={it.id} className={cn(diff !== 0 ? "bg-amber-50/50" : "")}>
                                          <td className="px-3 py-2">
                                            <p className="font-medium">{it.item?.nameAr ?? it.itemId}</p>
                                            <p className="text-[10px] text-muted-foreground font-mono">{it.item?.code}</p>
                                          </td>
                                          <td className="px-3 py-2 text-center tabular-nums">{fmtQty(it.systemQty)}</td>
                                          <td className="px-3 py-2">
                                            {cnt.status === "draft" ? (
                                              <Input
                                                type="number"
                                                step="any"
                                                className="h-7 text-xs text-center"
                                                value={actualVal}
                                                onChange={e => setEditedLines(p => ({ ...p, [it.id]: e.target.value }))}
                                              />
                                            ) : (
                                              <p className="text-center tabular-nums">{fmtQty(it.actualQty)}</p>
                                            )}
                                          </td>
                                          <td className="px-3 py-2 text-center">
                                            <span className={cn("font-bold tabular-nums", diff > 0 ? "text-green-600" : diff < 0 ? "text-red-600" : "text-muted-foreground")}>
                                              {diff >= 0 ? "+" : ""}{fmtQty(diff)}
                                            </span>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">{filtered.length} ورقة جرد</div>}
      </div>
    </div>
  );
}
