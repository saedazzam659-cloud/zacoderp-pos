import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
import {
  rowToneFor, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";
import { SearchCombobox } from "@/components/ui/search-combobox";

import { useFmt } from "@/hooks/use-fmt";
import ExportButtons from "@/components/ExportButtons";

const STATUS_CONFIG: Record<string, { labelKey: string; color: string }> = {
  draft:  { labelKey: "statusDraft",  color: "bg-amber-50 text-amber-700" },
  posted: { labelKey: "statusPosted", color: "bg-green-50 text-green-700" },
};

export default function StockCounting() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";
  const tr = (k: string, opts?: any): string => t(`stockCountingPage.${k}`, opts) as string;
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
  const createMut = useMutation({ mutationFn: inventoryApi.createCount, onSuccess: () => { invalidate(); reset(); toast({ title: tr("toastCreated") }); } });
  const postMut   = useMutation({ mutationFn: inventoryApi.postCount, onSuccess: () => { invalidate(); qc.invalidateQueries({ queryKey: ["stock-balance"] }); toast({ title: tr("toastApproved") }); } });
  const deleteMut = useMutation({ mutationFn: inventoryApi.deleteCount, onSuccess: () => { invalidate(); toast({ title: tr("toastDeleted") }); } });

  function reset() { setForm({ countNumber: "", countDate: new Date().toISOString().slice(0, 10), warehouseId: "", notes: "" }); setShowForm(false); }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.warehouseId) return;
    createMut.mutate({ ...form, warehouseId: Number(form.warehouseId) });
  }

  async function handleAiUpload(file: File) {
    if (!countDetail?.items?.length) {
      toast({ title: tr("openCountFirst"), variant: "destructive" });
      return;
    }
    setAiUploading(true);
    setAiReport(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
      if (!rows.length) throw new Error(tr("fileEmpty"));

      const token = localStorage.getItem("token");
      const API = (import.meta as any).env?.VITE_API_URL || "";
      const res = await fetch(`${API}/api/ai/parse-stock-count`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || tr("analyzeFailed"));

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
          unmatched.push(`${ai.code || ""} ${ai.name || ""}`.trim() || tr("rowNoDefinition"));
        }
      }

      setEditedLines(p => ({ ...p, ...updates }));
      setAiReport({ matched: Object.keys(updates).length, unmatched });
      toast({ title: tr("extractedItems", { count: Object.keys(updates).length }) });
    } catch (e: any) {
      toast({ title: e.message || tr("analyzeFileFailed"), variant: "destructive" });
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
    toast({ title: tr("actualQtySaved") });
  }

  const filtered = counts.filter((c: any) =>
    c.countNumber.includes(search) || (c.warehouse?.nameAr ?? "").includes(search) || (c.warehouse?.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  // Export rows for count detail
  const countExportRows = (countDetail?.items ?? []).map((it: any) => ({
    itemCode:   it.item?.code ?? "",
    itemNameAr: pickName(it.item?.nameAr, it.item?.nameEn),
    systemQty:  fmtQty(it.systemQty),
    actualQty:  fmtQty(it.actualQty),
    diff:       fmtQty(it.diff),
    costPrice:  fmt(it.costPrice),
    totalDiff:  fmt(Number(it.diff) * Number(it.costPrice)),
  }));

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ClipboardList className="h-6 w-6 text-primary" />{tr("title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{tr("subtitle")}</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { reset(); setShowForm(true); }}>
          <Plus className="h-4 w-4" />{tr("newCount")}
        </Button>
      </div>

      {showForm && (
        <FormPanel
          icon={ClipboardList}
          title={tr("formTitle")}
          subtitle={tr("formSubtitle")}
          width="4xl"
          onClose={reset}
          onSave={() => handleSubmit({ preventDefault() {} } as any)}
          saving={createMut.isPending}
          saveDisabled={!form.warehouseId || !form.countDate}
          saveLabel={tr("saveCount")}
        >
          <FormGrid>
            <Field label={tr("countNumber")}><Input
              placeholder={seqPeek.loading ? tr("loadingPlaceholder") : tr("countNumberPlaceholder")}
              dir="ltr"
              className={cn("text-left", seqPeek.hasSequence && "bg-muted/40 cursor-not-allowed")}
              value={form.countNumber}
              onChange={e => { if (!seqPeek.hasSequence) setForm((p: any) => ({ ...p, countNumber: e.target.value })); }}
              readOnly={seqPeek.hasSequence}
              title={seqPeek.hasSequence ? tr("sequenceTooltip", { code: seqPeek.sequenceCode ?? "" }) : undefined}
            /></Field>
            <Field label={tr("date")} required><Input type="date" value={form.countDate} onChange={e => setForm((p: any) => ({ ...p, countDate: e.target.value }))} /></Field>
            <Field label={tr("warehouse")} required className="md:col-span-2">
              <SearchCombobox
                items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: pickName(w.nameAr, w.nameEn) }))}
                value={form.warehouseId}
                onValueChange={v => setForm((p: any) => ({ ...p, warehouseId: v }))}
                placeholder={tr("selectWarehouse")}
              />
            </Field>
            <Field label={tr("notes")} className="md:col-span-2"><Input placeholder={tr("notesPlaceholder")} value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} /></Field>
            <p className="md:col-span-2 text-xs text-muted-foreground bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">{tr("loadBalancesHint")}</p>
          </FormGrid>
        </FormPanel>
      )}

      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pr-9" placeholder={tr("searchPlaceholder")} value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {(() => {
        const items: LegendItem[] = [
          { kind: "draft",     count: filtered.filter((x: any) => x.status === "draft").length },
          { kind: "posted",    count: filtered.filter((x: any) => x.status === "posted").length },
          { kind: "cancelled", count: filtered.filter((x: any) => x.status === "cancelled").length },
        ];
        return <DocColorLegend items={items} />;
      })()}

      <div className="rounded-xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-8"></th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{tr("colCountNumber")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{tr("colDate")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">{tr("colWarehouse")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{tr("colStatus")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-32">{tr("colActions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading ? [...Array(4)].map((_, i) => <tr key={i}><td colSpan={6}><Skeleton className="h-6 m-4" /></td></tr>)
              : filtered.length === 0 ? <tr><td colSpan={6} className="py-10 text-center text-muted-foreground"><ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-30" />{tr("noCounts")}</td></tr>
              : filtered.map((cnt: any) => {
                  const st = STATUS_CONFIG[cnt.status] ?? STATUS_CONFIG.draft;
                  return (
                    <>
                      <tr key={cnt.id}
                          data-status={cnt.status}
                          className={cn("transition-colors", rowToneFor({ status: cnt.status }))}
                          title={buildToneTooltip({ status: cnt.status })}>
                        <td className="px-4 py-3">
                          <button onClick={() => { setExpandedId(expandedId === cnt.id ? null : cnt.id); setEditedLines({}); }} className="text-muted-foreground">
                            {expandedId === cnt.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs font-bold">{cnt.countNumber}</td>
                        <td className="px-4 py-3 text-muted-foreground">{cnt.countDate}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">{pickName(cnt.warehouse?.nameAr, cnt.warehouse?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 text-center"><span className={cn("text-[10px] font-medium rounded-full px-2.5 py-1", st.color)}>{tr(st.labelKey)}</span></td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                            {cnt.status === "draft" && (
                              <>
                                <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-green-700 border-green-200 hover:bg-green-50" onClick={() => { if (confirm(tr("confirmPost"))) postMut.mutate(cnt.id); }}>
                                  <Send className="h-3 w-3" />{tr("approve")}
                                </Button>
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => { if (confirm(tr("confirmDelete"))) deleteMut.mutate(cnt.id); }}>
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
                              <h3 className="text-xs font-semibold">{tr("countDetails")}</h3>
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
                                      {aiUploading ? tr("analyzing") : tr("uploadExcelAi")}
                                    </Button>
                                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => saveActualQty(cnt.id)} disabled={savingId === cnt.id}>
                                      <Save className="h-3 w-3" />{savingId === cnt.id ? tr("saving") : tr("saveActualQty")}
                                    </Button>
                                  </>
                                )}
                                <ExportButtons
                                  rows={countExportRows}
                                  columns={[
                                    { key: "itemCode",   header: tr("colItemCode"),   width: 16 },
                                    { key: "itemNameAr", header: tr("colItemName"),   width: 30 },
                                    { key: "systemQty",  header: tr("colSystemQty"),  width: 18 },
                                    { key: "actualQty",  header: tr("colActualQty"),  width: 18 },
                                    { key: "diff",       header: tr("colDiff"),       width: 14 },
                                    { key: "costPrice",  header: tr("colCostPrice"),  width: 16 },
                                    { key: "totalDiff",  header: tr("colTotalDiff"),  width: 16 },
                                  ]}
                                  filename={`${tr("exportFilenamePrefix")}-${cnt.countNumber}`}
                                  title={tr("exportTitle")}
                                  subtitle={`${pickName(cnt.warehouse?.nameAr, cnt.warehouse?.nameEn)} — ${cnt.countDate}`}
                                  size="sm"
                                />
                              </div>
                            </div>
                            {!countDetail?.items?.length ? <p className="text-xs text-muted-foreground">{tr("noItems")}</p> : (
                              <div className="rounded-lg border overflow-hidden">
                                <table className="w-full text-xs">
                                  <thead className="bg-muted/50 border-b">
                                    <tr>
                                      <th className="px-3 py-2 text-right font-semibold text-muted-foreground">{tr("colItem")}</th>
                                      <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-28">{tr("colSystemQty")}</th>
                                      <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-32">{tr("colActualQty")}</th>
                                      <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-24">{tr("colDiff")}</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y">
                                    {countDetail.items.map((it: any) => {
                                      const actualVal = editedLines[it.id] !== undefined ? editedLines[it.id] : String(it.actualQty);
                                      const diff = Number(actualVal) - Number(it.systemQty);
                                      return (
                                        <tr key={it.id} className={cn(diff !== 0 ? "bg-amber-50/50" : "")}>
                                          <td className="px-3 py-2">
                                            <p className="font-medium">{pickName(it.item?.nameAr, it.item?.nameEn) || it.itemId}</p>
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
        {!isLoading && <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">{filtered.length} {tr("countUnit")}</div>}
      </div>
    </div>
  );
}
