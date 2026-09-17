import { useState, useEffect, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useNextSequenceNumber } from "@/hooks/useNextSequenceNumber";
import {
  Plus, Trash2, ArrowRightLeft, Search, X,
  CheckCircle2, Send, ChevronDown, ChevronUp, Zap, Sparkles, Loader2,
  FileText, Save, Settings2, Boxes, Calculator, Pencil, Truck,
} from "lucide-react";
import { Field, FormGrid } from "@/components/FormPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  rowToneFor, DocColorLegend, buildToneTooltip, type LegendItem,
} from "@/lib/docRowTone";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { useScreenItemModes, annotateItemCombo } from "@/lib/itemUsageClient";
import { AccountCombobox } from "@/components/AccountCombobox";
import { useFmt } from "@/hooks/use-fmt";
import { useTranslation } from "react-i18next";
import { DateField } from "@/components/ui/date-field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const STATUS_CONFIG: Record<string, { color: string }> = {
  draft:     { color: "bg-amber-50 text-amber-700" },
  posted:    { color: "bg-green-50 text-green-700" },
  cancelled: { color: "bg-red-50 text-red-600" },
};
const EMPTY_FORM = {
  transferNumber: "",
  transferDate: new Date().toISOString().slice(0, 10),
  transferType: "warehouse" as "warehouse" | "manufacturing",
  fromWarehouseId: "",
  toWarehouseId: "",
  fromAccountId: "",
  toAccountId: "",
  productionOrderId: "",
  internalTransportAmount: "",
  internalTransportExpenseAccountId: "",
  internalTransportCounterpartAccountId: "",
  notes: "",
};
const newLine = () => ({ itemId: "", unitId: "", qty: "1", costPrice: "0", conversionFactor: "1" });
const escapePrint = (value: unknown) => String(value ?? "—")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

export default function StockTransfer() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const pickName = (ar?: string | null, en?: string | null) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";
  const { fmt, fmtQty } = useFmt();
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const usageModes = useScreenItemModes("stock_transfer");
  const qc = useQueryClient();
  const { toast } = useToast();
  const [aiLoading, setAiLoading] = useState(false);
  const [aiReasoning, setAiReasoning] = useState<string>("");

  const [search, setSearch] = useState("");
  const [form, setForm] = useState<any>(EMPTY_FORM);
  const [lines, setLines] = useState<any[]>([newLine()]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deliveryTab, setDeliveryTab] = useState<"basic" | "items" | "costs">("basic");
  const [linkOrderId, setLinkOrderId] = useState("");

  const seqPeek = useNextSequenceNumber("stock_transfer", showForm);
  useEffect(() => {
    if (!showForm) return;
    if (seqPeek.hasSequence && seqPeek.number) {
      setForm((p: any) => (p.transferNumber === seqPeek.number ? p : { ...p, transferNumber: seqPeek.number }));
    }
  }, [showForm, seqPeek.hasSequence, seqPeek.number]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // itemUnitsMap: itemId → array of unit-price rows (cached after first fetch)
  const [itemUnitsMap, setItemUnitsMap] = useState<Record<string, any[]>>({});

  const { data: transfers = [], isLoading } = useQuery({
    queryKey: ["stock-transfers", cid],
    queryFn: () => inventoryApi.getTransfers(cid),
  });
  const { data: warehouses = [] } = useQuery({
    queryKey: ["warehouses", cid],
    queryFn: () => inventoryApi.getWarehouses(cid),
  });
  const { data: items = [] } = useQuery({
    queryKey: ["items", cid],
    queryFn: () => inventoryApi.getItems(cid),
  });
  const {
    data: manufacturingOptions,
    isLoading: manufacturingOptionsLoading,
    isError: manufacturingOptionsError,
    refetch: refetchManufacturingOptions,
  } = useQuery({
    queryKey: ["stock-transfer-manufacturing-options", cid],
    queryFn: () => inventoryApi.getManufacturingTransferOptions(),
    enabled: !!token,
    staleTime: 60_000,
  });
  const { data: trDetail } = useQuery({
    queryKey: ["transfer-detail", expandedId],
    queryFn: () => inventoryApi.getTransfer(expandedId!),
    enabled: expandedId !== null,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["stock-transfers"] });
  const createMut = useMutation({
    mutationFn: async (d: any) => {
      const created: any = await inventoryApi.createTransfer(d);
      // Manufacturing delivery is always saved as a draft first. Ordinary
      // warehouse transfers retain the established one-click create/post
      // behavior, while retaining the persisted id if posting fails so a
      // retry can post that row instead of creating a duplicate.
      if (d.transferType !== "manufacturing" && created?.id && (created.status ?? "draft") === "draft") {
        try {
          return await inventoryApi.postTransfer(created.id);
        } catch (e: any) {
          const failure = new Error(t("stockTransferPage.savedButPostFailed", { error: e?.message || e }));
          (failure as any).transferId = created.id;
          throw failure;
        }
      }
      return created;
    },
    onSuccess: (created: any, variables: any) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      if (variables.transferType === "manufacturing" && created?.id) {
        // Keep the saved delivery open with its server id available for an
        // immediate edit/post action; no second create can be triggered.
        setEditingId(Number(created.id));
        setExpandedId(Number(created.id));
        setShowForm(true);
      } else {
        reset();
      }
      toast({ title: t("stockTransferPage.toastCreated") });
    },
    onError: (e: any) => {
      if (e?.transferId) invalidate();
      toast({
        title: e?.message || "تعذر حفظ الحركة",
        description: e?.transferId ? `تم حفظ المسودة رقم #${e.transferId} ويمكن ترحيلها من القائمة دون إنشاء مستند جديد.` : undefined,
        variant: "destructive",
      });
    },
  });
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => inventoryApi.updateTransfer(id, data),
    onSuccess: (_row, variables) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["transfer-detail", variables.id] });
      reset();
      toast({ title: t("stockTransferPage.toastCreated") });
    },
    onError: (e: any) => toast({ title: e?.message || String(e), variant: "destructive" }),
  });
  const postMut = useMutation({
    mutationFn: (id: number) => inventoryApi.postTransfer(id),
    onSuccess: (_row, id) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      qc.invalidateQueries({ queryKey: ["transfer-detail", id] });
      toast({ title: t("stockTransferPage.toastPosted") });
    },
    onError: (e: any) => toast({ title: e?.message || "تعذر ترحيل الحركة", variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => inventoryApi.deleteTransfer(id),
    onSuccess: (_row, id) => {
      invalidate();
      qc.removeQueries({ queryKey: ["transfer-detail", id] });
      toast({ title: t("stockTransferPage.toastDeleted") });
    },
    onError: (e: any) => toast({ title: e?.message || "تعذر حذف الحركة", variant: "destructive" }),
  });
  const linkMut = useMutation({
    mutationFn: ({ id, productionOrderId }: { id: number; productionOrderId: number | null }) =>
      inventoryApi.linkTransferProductionOrder(id, productionOrderId),
    onSuccess: (_row, variables) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["transfer-detail", variables.id] });
      toast({ title: variables.productionOrderId ? "تم ربط الإذن بأمر التصنيع" : "تم فك ربط الإذن بأمر التصنيع" });
    },
    onError: (e: any) => toast({ title: e?.message || "تعذر تحديث ربط أمر التصنيع", variant: "destructive" }),
  });

  function reset() {
    setForm({ ...EMPTY_FORM, transferType: "warehouse" });
    setLines([newLine()]);
    setEditingId(null);
    setDeliveryTab("basic");
    setShowForm(false);
  }

  useEffect(() => {
    if (!editingId || !trDetail || (trDetail.id != null && trDetail.id !== editingId) ||
        (trDetail.transfer?.id != null && trDetail.transfer.id !== editingId)) return;
    const header = trDetail.transfer ?? trDetail;
    if (header.status && header.status !== "draft") return;
    setForm({
      ...EMPTY_FORM,
      transferNumber: header.transferNumber ?? "",
      transferDate: header.transferDate ?? EMPTY_FORM.transferDate,
      transferType: header.transferType === "manufacturing" ? "manufacturing" : "warehouse",
      fromWarehouseId: header.fromWarehouseId == null ? "" : String(header.fromWarehouseId),
      toWarehouseId: header.toWarehouseId == null ? "" : String(header.toWarehouseId),
      fromAccountId: header.fromAccountId == null ? "" : String(header.fromAccountId),
      toAccountId: header.toAccountId == null ? "" : String(header.toAccountId),
      productionOrderId: header.productionOrderId == null ? "" : String(header.productionOrderId),
      internalTransportAmount: header.internalTransportAmount == null ? "" : String(header.internalTransportAmount),
      internalTransportExpenseAccountId: header.internalTransportExpenseAccountId == null ? "" : String(header.internalTransportExpenseAccountId),
      internalTransportCounterpartAccountId: header.internalTransportCounterpartAccountId == null ? "" : String(header.internalTransportCounterpartAccountId),
      notes: header.notes ?? "",
    });
    const detailLines = (trDetail.items ?? []).map((line: any) => ({
      itemId: line.itemId == null ? "" : String(line.itemId),
      unitId: line.unitId == null ? "" : String(line.unitId),
      qty: String(line.qty ?? "1"),
      costPrice: String(line.costPrice ?? "0"),
      conversionFactor: String(line.conversionFactor ?? "1"),
    })).filter((line: any) => line.itemId);
    setLines(detailLines.length ? detailLines : [newLine()]);
  }, [editingId, trDetail]);

  useEffect(() => {
    if (expandedId !== null && trDetail?.id === expandedId) {
      setLinkOrderId(trDetail.productionOrderId == null ? "" : String(trDetail.productionOrderId));
    }
  }, [expandedId, trDetail]);

  // Fetch unit prices for an item and cache them, then return the array
  async function fetchItemUnits(itemId: string): Promise<any[]> {
    if (!itemId) return [];
    // Return cached value if already fetched
    if (itemUnitsMap[itemId] !== undefined) return itemUnitsMap[itemId];
    try {
      const ups = await inventoryApi.getItemUnits(Number(itemId));
      // Persist to cache
      setItemUnitsMap(prev => ({ ...prev, [itemId]: ups }));
      return ups;
    } catch {
      setItemUnitsMap(prev => ({ ...prev, [itemId]: [] }));
      return [];
    }
  }

  // When user picks an item: load unit prices, pre-select base unit, auto-fill cost
  async function handleItemSelect(lineIdx: number, itemId: string) {
    const item = (items as any[]).find((it: any) => String(it.id) === itemId);
    const ups = await fetchItemUnits(itemId);
    const baseUp = ups.find((u: any) => u.isBase) ?? ups[0] ?? null;
    setLines(prev =>
      prev.map((l, idx) =>
        idx === lineIdx
          ? {
              ...l,
              itemId,
              unitId: baseUp ? String(baseUp.unitId) : "",
              costPrice: baseUp
                ? String(baseUp.costPrice)
                : (item?.costPrice ?? "0"),
              conversionFactor: baseUp ? String(baseUp.conversionFactor) : "1",
            }
          : l
      )
    );
  }

  // When user changes the unit: look up cost from cached unit prices
  function handleUnitSelect(lineIdx: number, unitId: string) {
    setLines(prev =>
      prev.map((l, idx) => {
        if (idx !== lineIdx) return l;
        const ups: any[] = itemUnitsMap[l.itemId] ?? [];
        const up = unitId
          ? ups.find((u: any) => String(u.unitId) === unitId)
          : ups.find((u: any) => u.isBase || Number(u.conversionFactor ?? 1) === 1);
        return {
          ...l,
          unitId: unitId || (up ? String(up.unitId) : ""),
          costPrice: up ? String(up.costPrice) : l.costPrice,
          conversionFactor: up ? String(up.conversionFactor ?? 1) : "1",
        };
      })
    );
  }

  function updateLine(idx: number, key: string, val: string) {
    setLines(prev => prev.map((l, i) => (i === idx ? { ...l, [key]: val } : l)));
  }
  function addLine() { setLines(prev => [...prev, newLine()]); }
  function removeLine(idx: number) { setLines(prev => prev.filter((_, i) => i !== idx)); }

  async function printTransfer(id: number) {
    const printWindow = window.open("", "_blank", "noopener,noreferrer");
    if (!printWindow) {
      toast({ title: "تعذر فتح نافذة الطباعة", description: "اسمح بالنوافذ المنبثقة ثم حاول مرة أخرى.", variant: "destructive" });
      return;
    }
    try {
      const detail: any = await inventoryApi.getTransfer(id);
      const from = pickName(detail.fromWarehouse?.nameAr, detail.fromWarehouse?.nameEn);
      const to = pickName(detail.toWarehouse?.nameAr, detail.toWarehouse?.nameEn);
      const linesHtml = (detail.items ?? []).map((line: any, index: number) => `
        <tr><td>${index + 1}</td><td>${escapePrint(line.item?.code || line.item?.nameAr || line.itemId)}</td>
        <td>${escapePrint(pickName(line.item?.nameAr, line.item?.nameEn) || line.itemId)}</td>
        <td>${escapePrint(pickName(line.unit?.nameAr, line.unit?.nameEn) || "الوحدة الأساسية")}</td>
        <td dir="ltr">${escapePrint(line.qty)}</td><td dir="ltr">${escapePrint(line.conversionFactor ?? "1")}</td>
        <td dir="ltr">${escapePrint(line.costPrice)}</td></tr>`).join("");
      const transport = Number(detail.internalTransportAmount ?? 0);
      printWindow.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
        <title>${escapePrint(detail.transferNumber || "إذن تحويل")}</title>
        <style>
          *{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#172033;margin:32px;line-height:1.5}
          h1{font-size:22px;margin:0 0 4px}.muted{color:#64748b;font-size:12px}.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;border:1px solid #dbe3ef;padding:14px;border-radius:8px;margin:22px 0}
          .meta b{display:block;font-size:12px;color:#64748b;font-weight:normal}.meta span{font-size:14px;font-weight:600}
          table{width:100%;border-collapse:collapse;margin-top:18px;font-size:12px}th,td{border:1px solid #dbe3ef;padding:8px;text-align:right}th{background:#f1f5f9}
          .cost{margin-top:18px;border:1px solid #f5c56b;background:#fff8e8;padding:12px;border-radius:8px}.notes{margin-top:18px;border:1px solid #dbe3ef;padding:12px;min-height:54px}
          .signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:72px}.signature{border-top:1px solid #94a3b8;padding-top:8px;text-align:center;font-size:12px;color:#64748b}
          @media print{body{margin:12mm}}
        </style></head><body>
        <h1>${escapePrint(detail.transferType === "manufacturing" ? "إذن تسليم داخلي إلى التصنيع" : "إذن تحويل مخزني")}</h1>
        <div class="muted">مستند محفوظ — لا تعتمد هذه الطباعة على حالة تبويب غير ظاهر</div>
        <div class="meta">
          <div><b>رقم الإذن</b><span dir="ltr">${escapePrint(detail.transferNumber)}</span></div>
          <div><b>التاريخ</b><span dir="ltr">${escapePrint(detail.transferDate)}</span></div>
          <div><b>من</b><span>${escapePrint(from)}</span></div><div><b>إلى</b><span>${escapePrint(to)}</span></div>
          ${detail.productionOrderId != null ? `<div><b>أمر التصنيع</b><span>#${escapePrint(detail.productionOrderId)}</span></div>` : ""}
          <div><b>الحالة</b><span>${escapePrint(detail.status)}</span></div>
        </div>
        <table><thead><tr><th>#</th><th>الكود</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>معامل التحويل</th><th>تكلفة الوحدة</th></tr></thead>
        <tbody>${linesHtml || `<tr><td colspan="7">لا توجد أصناف</td></tr>`}</tbody></table>
        ${detail.transferType === "manufacturing" ? `<div class="cost"><b>تكلفة النقل الداخلي:</b> <span dir="ltr">${escapePrint(transport.toFixed(2))} ر.س</span>
          <br><span class="muted">حساب المصروف: ${escapePrint(detail.internalTransportExpenseAccountId)} — الحساب المقابل: ${escapePrint(detail.internalTransportCounterpartAccountId)}</span></div>` : ""}
        <div class="notes"><b>الملاحظات</b><br>${escapePrint(detail.notes || "—")}</div>
        <div class="signatures"><div class="signature">إعداد المستند<br>الاسم والتوقيع</div><div class="signature">تسليم<br>الاسم والتوقيع</div><div class="signature">استلام المستودع<br>الاسم والتوقيع</div></div>
        <script>window.onload=function(){window.print();}</script></body></html>`);
      printWindow.document.close();
    } catch (e: any) {
      printWindow.close();
      toast({ title: "تعذر تجهيز مستند الطباعة", description: e?.message || String(e), variant: "destructive" });
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.fromWarehouseId || !form.toWarehouseId) {
      toast({ title: t("stockTransferPage.errSelectWarehouses"), variant: "destructive" });
      return;
    }
    const validLines = lines.filter(l => l.itemId && Number(l.qty) > 0);
    if (!validLines.length) {
      toast({ title: t("stockTransferPage.errAddItem"), variant: "destructive" });
      return;
    }
    const transportAmount = form.transferType === "manufacturing"
      ? String(form.internalTransportAmount || "").trim()
      : "";
    if (form.transferType === "manufacturing" && transportAmount !== "") {
      const parsedAmount = Number(transportAmount);
      if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
        toast({ title: "أدخل تكلفة نقل صحيحة (صفر أو أكثر)", variant: "destructive" });
        return;
      }
      if (parsedAmount > 0 && (!form.internalTransportExpenseAccountId || !form.internalTransportCounterpartAccountId)) {
        toast({
          title: "حسابات تكلفة النقل مطلوبة",
          description: "المبلغ الموجب يتطلب حساب المصروف والحساب المقابل.",
          variant: "destructive",
        });
        return;
      }
    }
    const payload = {
      ...form,
      transferType: form.transferType,
      fromWarehouseId: Number(form.fromWarehouseId),
      toWarehouseId:   Number(form.toWarehouseId),
      fromAccountId:   form.fromAccountId ? Number(form.fromAccountId) : null,
      toAccountId:     form.toAccountId   ? Number(form.toAccountId)   : null,
      productionOrderId: form.transferType === "manufacturing" && form.productionOrderId
        ? Number(form.productionOrderId) : null,
      internalTransportAmount: form.transferType === "manufacturing" && transportAmount !== ""
        ? transportAmount : "0",
      internalTransportExpenseAccountId: form.transferType === "manufacturing" && form.internalTransportExpenseAccountId
        ? Number(form.internalTransportExpenseAccountId) : null,
      internalTransportCounterpartAccountId: form.transferType === "manufacturing" && form.internalTransportCounterpartAccountId
        ? Number(form.internalTransportCounterpartAccountId) : null,
      items: validLines.map(l => ({
        itemId: Number(l.itemId),
        unitId: l.unitId ? Number(l.unitId) : null,
        qty: l.qty,
        costPrice: l.costPrice,
        conversionFactor: l.conversionFactor || "1",
      })),
    };
    if (editingId) updateMut.mutate({ id: editingId, data: payload });
    else createMut.mutate(payload);
  }

  // Get only units linked to this item's active unit-price rows.
  function getLineUnits(line: any): { id: number; nameAr?: string | null; nameEn?: string | null; code?: string }[] {
    const cached = itemUnitsMap[line.itemId];
    if (cached && cached.length > 0) {
      return cached.filter((u: any) => u.isActive !== false).map((u: any) => ({
        id: u.unitId,
        nameAr: u.unit?.nameAr ?? null,
        nameEn: u.unit?.nameEn ?? null,
        code: u.unit?.code,
      }));
    }
    // Never fall back to the company's global unit list: a transaction unit
    // must be linked to this item so the central engine can resolve it.
    return [];
  }

  // Check if the current unit has an auto-filled price
  function isAutoFilled(line: any): boolean {
    const cached = itemUnitsMap[line.itemId] ?? [];
    return !!line.unitId && cached.some((u: any) => String(u.unitId) === line.unitId);
  }

  const filtered = (transfers as any[]).filter(
    (t: any) =>
      t.transferNumber.includes(search) ||
      (t.fromWarehouse?.nameAr ?? "").includes(search) ||
      (t.fromWarehouse?.nameEn ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (t.toWarehouse?.nameAr ?? "").includes(search) ||
      (t.toWarehouse?.nameEn ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6" dir={isRtl ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ArrowRightLeft className="h-6 w-6 text-primary" />
            {t("stockTransferPage.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("stockTransferPage.subtitle")}
          </p>
        </div>
        <Button
          size="sm"
          className="gap-2"
          onClick={() => { reset(); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
        >
          <Plus className="h-4 w-4" />{t("stockTransferPage.newTransfer")}
        </Button>
      </div>

      {/* ─── Form (designed to match سند القبض pattern) ──────────────────── */}
      {showForm && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          {/* ─── Form header bar ────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b bg-muted/30 flex-wrap">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ArrowRightLeft className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="font-semibold text-sm sm:text-base text-foreground truncate">{t("stockTransferPage.formTitle")}</h2>
                <p className="text-xs text-muted-foreground truncate mt-0.5">{t("stockTransferPage.formSubtitle")}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border bg-amber-50 text-amber-700 border-amber-200">
                {t("stockTransferPage.status.draft")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={reset}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                aria-label={t("stockTransferPage.close")}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* ─── Two-column body: form on left, sticky JE preview on right ─ */}
          <div className="p-4 sm:p-5">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5 items-start">
              {/* ── Left column: stacked sections ─────────────────────── */}
              <div className="space-y-4">
                {form.transferType === "manufacturing" && (
                  <Tabs value={deliveryTab} onValueChange={(value) => setDeliveryTab(value as "basic" | "items" | "costs")} dir={isRtl ? "rtl" : "ltr"}>
                    <TabsList className="grid h-10 w-full grid-cols-3 rounded-lg border bg-muted/30 p-1">
                      <TabsTrigger value="basic" className="text-xs">البيانات الأساسية</TabsTrigger>
                      <TabsTrigger value="items" className="text-xs">الأصناف ({lines.filter(l => l.itemId).length})</TabsTrigger>
                      <TabsTrigger value="costs" className="text-xs">تكلفة النقل</TabsTrigger>
                    </TabsList>
                  </Tabs>
                )}
                <Card className="border-2 border-primary/20">
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">نوع الحركة</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          اختر التحويل المعتاد أو إذن التسليم الداخلي إلى التصنيع.
                        </p>
                      </div>
                      <div className="inline-flex rounded-lg border bg-muted/30 p-1" role="radiogroup" aria-label="نوع الحركة">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={form.transferType === "warehouse"}
                          className={cn(
                            "rounded-md px-3 py-1.5 text-xs transition-colors",
                            form.transferType === "warehouse" && "bg-background font-semibold shadow-sm",
                          )}
                          onClick={() => setForm((p: any) => ({
                            ...p,
                            transferType: "warehouse",
                            productionOrderId: "",
                            internalTransportAmount: "",
                            internalTransportExpenseAccountId: "",
                            internalTransportCounterpartAccountId: "",
                          }))}
                        >
                          تحويل مستودعي
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={form.transferType === "manufacturing"}
                          className={cn(
                            "rounded-md px-3 py-1.5 text-xs transition-colors",
                            form.transferType === "manufacturing" && "bg-primary text-primary-foreground font-semibold shadow-sm",
                          )}
                          onClick={() => { setDeliveryTab("basic"); setForm((p: any) => ({ ...p, transferType: "manufacturing" })); }}
                        >
                          <Truck className="inline h-3.5 w-3.5 me-1" />
                          تسليم إلى التصنيع
                        </button>
                      </div>
                    </div>
                    {form.transferType === "manufacturing" && manufacturingOptionsError && (
                      <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                        <span>تعذر تحميل أوامر التصنيع وحسابات النقل.</span>
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => void refetchManufacturingOptions()}>
                          إعادة المحاولة
                        </Button>
                      </div>
                    )}
                    {form.transferType === "manufacturing" && manufacturingOptions?.enabled === false && (
                      <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        إذن التسليم إلى التصنيع غير مفعّل في إعدادات الشركة.
                      </p>
                    )}
                  </CardContent>
                </Card>
                {/* Section 1: Transfer header info */}
                <Card className="border-2" hidden={form.transferType === "manufacturing" && deliveryTab !== "basic"}>
                  <CardHeader className="py-3 px-4 border-b bg-muted/30">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <FileText className="h-4 w-4 text-amber-700" />
                      {t("stockTransferPage.transferDataTitle")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 pb-4">
                    <FormGrid cols={2}>
                      <Field label={t("stockTransferPage.transferNumber")}>
                        <Input
                          placeholder={seqPeek.loading ? "…" : t("stockTransferPage.transferNumberPlaceholder")}
                          dir="ltr"
                          className={cn("text-left h-9 text-sm", seqPeek.hasSequence && "bg-muted/40 cursor-not-allowed")}
                          value={form.transferNumber}
                          onChange={e => { if (!seqPeek.hasSequence) setForm((p: any) => ({ ...p, transferNumber: e.target.value })); }}
                          readOnly={seqPeek.hasSequence}
                          title={seqPeek.hasSequence ? t("stockTransferPage.sequenceTitle", { code: seqPeek.sequenceCode ?? "" }) : undefined}
                        />
                      </Field>
                      <Field label={t("stockTransferPage.date")} required>
                        <DateField className="h-9 text-sm" value={form.transferDate} onChange={e => setForm((p: any) => ({ ...p, transferDate: e.target.value }))} />
                      </Field>
                      <Field label={t("stockTransferPage.fromWarehouse")} required>
                        <SearchCombobox items={(warehouses as any[]).map((w: any) => ({ value: String(w.id), code: w.code, label: pickName(w.nameAr, w.nameEn) }))} value={form.fromWarehouseId} onValueChange={v => setForm((p: any) => ({ ...p, fromWarehouseId: v }))} placeholder={t("stockTransferPage.fromWarehousePlaceholder")} />
                      </Field>
                      <Field label={t("stockTransferPage.toWarehouse")} required>
                        <SearchCombobox items={(warehouses as any[]).filter((w: any) => String(w.id) !== form.fromWarehouseId).map((w: any) => ({ value: String(w.id), code: w.code, label: pickName(w.nameAr, w.nameEn) }))} value={form.toWarehouseId} onValueChange={v => setForm((p: any) => ({ ...p, toWarehouseId: v }))} placeholder={t("stockTransferPage.toWarehousePlaceholder")} />
                      </Field>
                      <Field label={t("stockTransferPage.notes")} className="md:col-span-2">
                        <Input className="h-9 text-sm" placeholder={t("stockTransferPage.notesPlaceholder")} value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
                      </Field>
                    </FormGrid>
                      {form.transferType === "manufacturing" && (
                        <div className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3">
                          <Field label="أمر التصنيع (اختياري)">
                            <SearchCombobox
                              items={[
                                { value: "", label: "بدون ربط بأمر تصنيع" },
                                ...(manufacturingOptions?.orders ?? []).map((order: any) => ({
                                  value: String(order.id),
                                  code: order.orderNumber,
                                  label: `${order.orderNumber} — ${order.productName}`,
                                })),
                              ]}
                              value={form.productionOrderId}
                              onValueChange={v => setForm((p: any) => ({ ...p, productionOrderId: v }))}
                              placeholder={manufacturingOptionsLoading ? "جاري تحميل أوامر التصنيع…" : "اختر أمر تصنيع (اختياري)"}
                              disabled={manufacturingOptionsLoading || manufacturingOptions?.enabled === false}
                            />
                          </Field>
                          <p className="mt-2 text-[10px] text-muted-foreground">
                            يمكن ربط عدة أذونات بأمر تصنيع واحد، كما يمكن حفظ الإذن دون ربط.
                          </p>
                        </div>
                      )}
                  </CardContent>
                </Card>

                {/* Section 2: Accounting accounts (with AI suggest button) */}
                <Card className="border-2 border-blue-100" hidden={form.transferType === "manufacturing" && deliveryTab !== "basic"}>
                  <CardHeader className="py-3 px-4 border-b bg-blue-50/40">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2 text-blue-900">
                        <Settings2 className="h-4 w-4" />
                        {t("stockTransferPage.accountsTitle")}
                      </CardTitle>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1.5 h-7 text-[11px] border-purple-300 text-purple-700 hover:bg-purple-50 shrink-0"
                        disabled={!form.fromWarehouseId || !form.toWarehouseId || aiLoading}
                        onClick={async () => {
                          setAiLoading(true);
                          setAiReasoning("");
                          try {
                            const apiBase = import.meta.env.VITE_API_URL ?? "";
                            const itemsPayload = lines
                              .filter(l => l.itemId)
                              .map(l => {
                                const it: any = (items as any[]).find((x: any) => String(x.id) === String(l.itemId));
                                return { nameAr: it?.nameAr ?? "", qty: Number(l.qty || 0) };
                              });
                            const r = await fetch(`${apiBase}/api/ai/suggest-transfer-accounts`, {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                              },
                              body: JSON.stringify({
                                fromWarehouseId: Number(form.fromWarehouseId),
                                toWarehouseId:   Number(form.toWarehouseId),
                                items: itemsPayload,
                                notes: form.notes,
                              }),
                            });
                            const j = await r.json();
                            if (!r.ok) throw new Error(j?.error || t("stockTransferPage.aiErrSuggest"));
                            if (j.fromAccountId && j.toAccountId) {
                              setForm((p: any) => ({
                                ...p,
                                fromAccountId: String(j.fromAccountId),
                                toAccountId:   String(j.toAccountId),
                              }));
                              setAiReasoning(`${j.reasoning || ""}${j.source === "ai" ? t("stockTransferPage.aiSuggestAi") : t("stockTransferPage.aiSuggestAuto")}`);
                              toast({ title: t("stockTransferPage.toastAccountsSuggested"), description: `${j.fromAccountLabel} ⇄ ${j.toAccountLabel}` });
                            } else {
                              throw new Error(j?.reasoning || t("stockTransferPage.aiErrNoAccounts"));
                            }
                          } catch (e: any) {
                            toast({ title: t("stockTransferPage.aiErrSuggest"), description: e?.message || t("stockTransferPage.aiErrUnknown"), variant: "destructive" });
                          } finally {
                            setAiLoading(false);
                          }
                        }}
                      >
                        {aiLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                        {t("stockTransferPage.aiSuggest")}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-4 pb-4 space-y-3">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {t("stockTransferPage.accountsHintStart")}<b className="text-blue-700">{t("stockTransferPage.debit")}</b>{t("stockTransferPage.accountsHintDest")}<b className="text-rose-700">{t("stockTransferPage.credit")}</b>{t("stockTransferPage.accountsHintSource")}
                    </p>
                    <FormGrid cols={2}>
                      <Field label={t("stockTransferPage.fromAccountLabel")}>
                        <AccountCombobox value={form.fromAccountId} onValueChange={v => setForm((p: any) => ({ ...p, fromAccountId: v }))} placeholder={t("stockTransferPage.selectAccountPlaceholder")} filterTypes={["asset"]} grouped={false} />
                      </Field>
                      <Field label={t("stockTransferPage.toAccountLabel")}>
                        <AccountCombobox value={form.toAccountId} onValueChange={v => setForm((p: any) => ({ ...p, toAccountId: v }))} placeholder={t("stockTransferPage.selectAccountPlaceholder")} filterTypes={["asset"]} grouped={false} />
                      </Field>
                    </FormGrid>
                    {aiReasoning && (
                      <div className="text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded p-2 leading-relaxed">
                        <Sparkles className="h-3 w-3 inline ml-1" />{aiReasoning}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {form.transferType === "manufacturing" && (
                  <Card className="border-2 border-amber-200" hidden={deliveryTab !== "costs"}>
                    <CardHeader className="py-3 px-4 border-b bg-amber-50/50">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2 text-amber-900">
                        <Truck className="h-4 w-4" />
                        تكلفة النقل الداخلي
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-4 pb-4 space-y-3">
                      <p className="text-[11px] text-muted-foreground">
                        التكلفة منفصلة عن قيمة الأصناف، وتُحفظ مع هذا الإذن فقط.
                      </p>
                      <FormGrid cols={2}>
                        <Field label="مبلغ النقل (ر.س)">
                          <Input
                            type="number"
                            min="0"
                            step="any"
                            dir="ltr"
                            className="h-9 text-left font-mono"
                            value={form.internalTransportAmount}
                            onChange={e => setForm((p: any) => ({ ...p, internalTransportAmount: e.target.value }))}
                            placeholder="0"
                          />
                        </Field>
                        <div className="hidden sm:block" />
                        <Field label="حساب المصروف">
                          <AccountCombobox
                            value={form.internalTransportExpenseAccountId}
                            onValueChange={v => setForm((p: any) => ({ ...p, internalTransportExpenseAccountId: v }))}
                            placeholder="اختر حساب المصروف"
                            grouped={false}
                          />
                        </Field>
                        <Field label="الحساب المقابل">
                          <AccountCombobox
                            value={form.internalTransportCounterpartAccountId}
                            onValueChange={v => setForm((p: any) => ({ ...p, internalTransportCounterpartAccountId: v }))}
                            placeholder="اختر الحساب المقابل"
                            grouped={false}
                          />
                        </Field>
                      </FormGrid>
                      <p className="text-[10px] text-muted-foreground">
                        الحسابان مطلوبان فقط عند إدخال مبلغ موجب. المبالغ التاريخية تبقى مقروءة حتى عند تعطيل الإعداد.
                      </p>
                    </CardContent>
                  </Card>
                )}

                {/* Section 3: Items table */}
                <Card className="border-2 border-slate-100" hidden={form.transferType === "manufacturing" && deliveryTab !== "items"}>
                  <CardHeader className="py-3 px-4 border-b bg-slate-50/40">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <Boxes className="h-4 w-4 text-slate-700" />
                        {t("stockTransferPage.itemsTitle")}
                        {lines.filter(l => l.itemId).length > 0 && (
                          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary/15 text-primary text-[10px] font-bold">
                            {lines.filter(l => l.itemId).length}
                          </span>
                        )}
                      </CardTitle>
                      <Button type="button" size="sm" variant="outline" onClick={addLine} className="gap-1 h-7 text-xs">
                        <Plus className="h-3 w-3" />{t("stockTransferPage.addItem")}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-3 pb-3 space-y-2">
                    {/* ── Items grid (سند نمط فواتير المبيعات) ─────────────── */}
                    {(() => {
                      const gridCols = "240px 110px 160px 90px 140px 140px 40px";
                      const headers = [t("stockTransferPage.colItem"), t("stockTransferPage.colItemCode"), t("stockTransferPage.colUnit"), t("stockTransferPage.colQty"), t("stockTransferPage.colCostPrice"), t("stockTransferPage.colTotal"), ""];
                      const totalLabel = t("stockTransferPage.colTotal");
                      return (
                        <div className="rounded-xl border bg-card overflow-x-auto">
                          <div className="min-w-max">
                            {/* Sticky header */}
                            <div
                              className="grid gap-2 px-3 py-2 border-b bg-muted/40 sticky top-0"
                              style={{ gridTemplateColumns: gridCols }}
                            >
                              {headers.map((h, i) => (
                                <p
                                  key={i}
                                  className={cn(
                                    "text-[11px] font-medium truncate",
                                    h === totalLabel ? "font-semibold text-primary" : "text-muted-foreground"
                                  )}
                                  title={h}
                                >
                                  {h}
                                </p>
                              ))}
                            </div>

                            {/* Rows */}
                            <div className="divide-y">
                              {lines.map((line, i) => {
                                const lineUnits = getLineUnits(line);
                                const cf = Number(line.conversionFactor || "1");
                                const baseQtyHint = cf !== 1
                                  ? t("stockTransferPage.baseQtyHint", { cf, qty: fmtQty(Number(line.qty || 0) * cf) })
                                  : null;
                                const autoFilled = isAutoFilled(line);
                                const selectedItem: any = (items as any[]).find(
                                  (it: any) => String(it.id) === String(line.itemId)
                                );
                                const itemCode = selectedItem?.code ?? "";
                                const lineTotal = Number(line.qty || 0) * Number(line.costPrice || 0);

                                return (
                                  <div
                                    key={i}
                                    className="px-3 py-2 hover:bg-muted/30 transition-colors"
                                  >
                                    <div
                                      className="grid gap-2 items-center"
                                      style={{ gridTemplateColumns: gridCols }}
                                    >
                                      {/* الصنف */}
                                      <SearchCombobox
                                        items={annotateItemCombo((items as any[])
                                          .filter((it: any) => it.itemType === "stock")
                                          .map((it: any) => ({
                                            value: String(it.id),
                                            code: it.code,
                                            label: pickName(it.nameAr, it.nameEn),
                                            labelEn: it.nameEn,
                                          })), usageModes)}
                                        value={line.itemId}
                                        onValueChange={v => handleItemSelect(i, v)}
                                        placeholder={t("stockTransferPage.selectItemPlaceholder")}
                                        className="h-8 text-xs"
                                      />

                                      {/* كود الصنف (تلقائي) */}
                                      <Input
                                        className="h-8 text-xs bg-muted/40 font-mono"
                                        readOnly
                                        placeholder={t("stockTransferPage.autoPlaceholder")}
                                        value={itemCode}
                                        title={itemCode}
                                      />

                                      {/* الوحدة */}
                                      <div>
                                        <SearchCombobox
                                          items={[
                                            { value: "", label: t("stockTransferPage.baseUnit") },
                                            ...lineUnits.map(u => ({ value: String(u.id), label: pickName(u.nameAr, u.nameEn) || "—" })),
                                          ]}
                                          value={line.unitId}
                                          onValueChange={v => handleUnitSelect(i, v)}
                                          placeholder={t("stockTransferPage.baseUnit")}
                                          className="h-8 text-xs"
                                        />
                                        {baseQtyHint && (
                                          <p className="text-[10px] text-purple-600 mt-0.5 font-medium leading-tight truncate" title={baseQtyHint}>
                                            {baseQtyHint}
                                          </p>
                                        )}
                                      </div>

                                      {/* الكمية */}
                                      <Input
                                        type="number"
                                        step="any"
                                        min="0.001"
                                        dir="ltr"
                                        className="h-8 text-xs text-left"
                                        value={line.qty}
                                        data-hide-default-one
                                        onChange={e => updateLine(i, "qty", e.target.value)}
                                      />

                                      {/* سعر التكلفة */}
                                      <div className="relative">
                                        <Input
                                          type="number"
                                          step="any"
                                          min="0"
                                          dir="ltr"
                                          className={cn(
                                            "h-8 text-xs text-left",
                                            autoFilled && "border-amber-300 bg-amber-50/60"
                                          )}
                                          value={line.costPrice}
                                          onChange={e => updateLine(i, "costPrice", e.target.value)}
                                        />
                                        {autoFilled && (
                                          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[8px] font-bold text-amber-600 bg-amber-100 rounded px-0.5">
                                            {t("stockTransferPage.autoBadge")}
                                          </span>
                                        )}
                                        {cf !== 1 && (
                                          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                                            {t("stockTransferPage.baseCostHint", {
                                              cost: fmt(Number(line.costPrice || 0) / cf),
                                            })}
                                          </p>
                                        )}
                                      </div>

                                      {/* الإجمالي */}
                                      <Input
                                        className="h-8 text-xs bg-primary/5 font-semibold text-primary font-mono text-left"
                                        dir="ltr"
                                        readOnly
                                        value={fmt(lineTotal)}
                                      />

                                      {/* حذف */}
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 text-destructive"
                                        onClick={() => removeLine(i)}
                                        disabled={lines.length <= 1}
                                        aria-label={t("stockTransferPage.deleteItem")}
                                        title={t("stockTransferPage.deleteItem")}
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {/* ── إجمالي التحويل (تحت الجريد) ─────────────────────── */}
                    <div className="flex items-center justify-end gap-3 px-3 py-2 rounded-lg bg-muted/30 border">
                      <span className="text-xs font-semibold text-muted-foreground">{t("stockTransferPage.totalTransfer")}</span>
                      <span className="text-sm font-bold tabular-nums font-mono text-primary">
                        {fmt(lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.costPrice || 0), 0))} {t("stockTransferPage.sar")}
                      </span>
                    </div>

                    <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                      <Zap className="h-3 w-3 text-amber-500" />
                      {t("stockTransferPage.autoFillHint")}
                    </p>
                  </CardContent>
                </Card>
              </div>

              {/* ── Right column: live JE preview (sticky on desktop) ── */}
              <aside className="lg:sticky lg:top-4 space-y-4">
                <Card className="border-2 border-blue-200 bg-blue-50/40">
                  <CardHeader className="py-3 px-4 border-b border-blue-200/60">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2 text-blue-900">
                      <Calculator className="h-4 w-4" />
                      {t("stockTransferPage.jePreviewTitle")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-3 pb-3">
                    {(() => {
                      const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.costPrice || 0), 0);
                      if (total <= 0) {
                        return (
                          <p className="text-xs text-muted-foreground text-center py-6">
                            {t("stockTransferPage.jeAddItemsHint")}
                          </p>
                        );
                      }
                      const fromWh: any = (warehouses as any[]).find((w: any) => String(w.id) === form.fromWarehouseId);
                      const toWh:   any = (warehouses as any[]).find((w: any) => String(w.id) === form.toWarehouseId);
                      const fromAcc = form.fromAccountId ? Number(form.fromAccountId) : (fromWh?.accountId ?? null);
                      const toAcc   = form.toAccountId   ? Number(form.toAccountId)   : (toWh?.accountId   ?? null);
                      const fromSrc = form.fromAccountId ? t("stockTransferPage.manualSelection") : (fromWh?.accountId ? t("stockTransferPage.warehouseDefault") : null);
                      const toSrc   = form.toAccountId   ? t("stockTransferPage.manualSelection") : (toWh?.accountId   ? t("stockTransferPage.warehouseDefault") : null);
                      if (!fromAcc || !toAcc) {
                        return (
                          <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 leading-relaxed">
                            {t("stockTransferPage.noJeWarning")}
                          </div>
                        );
                      }
                      if (fromAcc === toAcc) {
                        return (
                          <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 leading-relaxed">
                            {t("stockTransferPage.sameAccountWarning")}
                          </div>
                        );
                      }
                      return (
                        <>
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-blue-800/70 border-b border-blue-200/60">
                                <th className="text-start pb-1.5 font-medium">{t("stockTransferPage.colAccount")}</th>
                                <th className="text-left pb-1.5 font-medium">{t("stockTransferPage.debit")}</th>
                                <th className="text-left pb-1.5 font-medium">{t("stockTransferPage.credit")}</th>
                              </tr>
                            </thead>
                            <tbody className="font-mono">
                              <tr className="border-b border-blue-200/40">
                                <td className="py-1.5 text-start text-[11px]">
                                  {t("stockTransferPage.destWarehouse")}
                                  {toSrc && <div className="text-[9px] text-muted-foreground font-sans">{toSrc}</div>}
                                </td>
                                <td className="text-left text-green-700 font-semibold tabular-nums">{fmt(total)}</td>
                                <td className="text-left text-muted-foreground">—</td>
                              </tr>
                              <tr>
                                <td className="py-1.5 text-start text-[11px]">
                                  {t("stockTransferPage.sourceWarehouse")}
                                  {fromSrc && <div className="text-[9px] text-muted-foreground font-sans">{fromSrc}</div>}
                                </td>
                                <td className="text-left text-muted-foreground">—</td>
                                <td className="text-left text-red-700 font-semibold tabular-nums">{fmt(total)}</td>
                              </tr>
                            </tbody>
                            <tfoot className="border-t border-blue-200/60">
                              <tr>
                                <td className="pt-1.5 text-start text-[10px] font-semibold text-blue-900">{t("stockTransferPage.totalLabel")}</td>
                                <td className="pt-1.5 text-left text-[11px] font-bold text-blue-900 tabular-nums">{fmt(total)}</td>
                                <td className="pt-1.5 text-left text-[11px] font-bold text-blue-900 tabular-nums">{fmt(total)}</td>
                              </tr>
                            </tfoot>
                          </table>
                          <p className="text-[10px] text-blue-800/70 mt-2 leading-relaxed">
                            {t("stockTransferPage.jeBalancedHint")}
                          </p>
                        </>
                      );
                    })()}
                  </CardContent>
                </Card>

                <div className="text-[11px] text-muted-foreground leading-relaxed bg-muted/20 border rounded-lg p-3">
                  <p className="font-semibold mb-1">{t("stockTransferPage.shortcutsTitle")}</p>
                  <ul className="space-y-0.5 list-disc list-inside">
                    <li>{t("stockTransferPage.shortcut1")}</li>
                    <li>{t("stockTransferPage.shortcut2")}</li>
                    <li>{t("stockTransferPage.shortcut3")}</li>
                  </ul>
                </div>
              </aside>
            </div>
          </div>

          {/* ─── Bottom action bar ──────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t bg-muted/20 flex-wrap">
            <Button variant="ghost" size="sm" onClick={reset} disabled={createMut.isPending}>
              {t("stockTransferPage.cancel")}
            </Button>
            <Button
              size="sm"
              className="gap-1.5 min-w-[140px]"
              onClick={() => handleSubmit({ preventDefault() {} } as any)}
               disabled={
                 createMut.isPending || updateMut.isPending ||
                 (form.transferType === "manufacturing" && manufacturingOptions?.enabled === false) ||
                 !form.fromWarehouseId || !form.toWarehouseId || !form.transferDate
               }
            >
               {createMut.isPending || updateMut.isPending
                 ? <Loader2 className="h-4 w-4 animate-spin" />
                 : <Save className="h-4 w-4" />}
               {editingId ? "تحديث المسودة" : t("stockTransferPage.saveDraft")}
            </Button>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pr-9"
          placeholder={t("stockTransferPage.searchPlaceholder")}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* List */}
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
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-8" />
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("stockTransferPage.colNumber")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground">{t("stockTransferPage.colDate")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">{t("stockTransferPage.colFromWarehouse")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground hidden sm:table-cell">{t("stockTransferPage.colToWarehouse")}</th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">{t("stockTransferPage.colStatus")}</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground w-32">{t("stockTransferPage.colActions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? [...Array(4)].map((_, i) => (
                  <tr key={i}>
                    <td colSpan={7} className="px-4 py-3">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))
              : filtered.length === 0
              ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    <ArrowRightLeft className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    {t("stockTransferPage.emptyState")}
                  </td>
                </tr>
              )
              : filtered.map((tr: any) => {
                  const st = STATUS_CONFIG[tr.status] ?? STATUS_CONFIG.draft;
                  const statusKey = STATUS_CONFIG[tr.status] ? tr.status : "draft";
                  return (
                    <Fragment key={tr.id}>
                      <tr data-status={tr.status}
                          className={cn("transition-colors", rowToneFor({ status: tr.status }))}
                          title={buildToneTooltip({ status: tr.status })}>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => setExpandedId(expandedId === tr.id ? null : tr.id)}
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={expandedId === tr.id ? t("stockTransferPage.collapseDetails") : t("stockTransferPage.expandDetails")}
                            aria-expanded={expandedId === tr.id}
                            title={expandedId === tr.id ? t("stockTransferPage.collapseDetails") : t("stockTransferPage.expandDetails")}
                          >
                            {expandedId === tr.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                        </td>
                         <td className="px-4 py-3 font-mono text-xs font-bold">
                           <div>{tr.transferNumber}</div>
                           {tr.transferType === "manufacturing" && (
                             <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 font-sans text-[9px] font-medium text-violet-700">
                               <Truck className="h-2.5 w-2.5" />تسليم تصنيع
                             </span>
                           )}
                         </td>
                        <td className="px-4 py-3 text-muted-foreground">{tr.transferDate}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">{pickName(tr.fromWarehouse?.nameAr, tr.fromWarehouse?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">{pickName(tr.toWarehouse?.nameAr, tr.toWarehouse?.nameEn) || "—"}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn("text-[10px] font-medium rounded-full px-2.5 py-1", st.color)}>
                            {t(`stockTransferPage.status.${statusKey}`)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 items-center">
                             <Button
                               size="sm"
                               variant="ghost"
                               className="h-7 text-xs"
                               onClick={() => void printTransfer(tr.id)}
                               title="طباعة المستند المحفوظ"
                             >
                               <FileText className="h-3 w-3" />
                             </Button>
                            {tr.status === "draft" && (
                              <>
                                 <Button
                                   size="sm"
                                   variant="outline"
                                   className="h-7 text-xs gap-1"
                                   onClick={() => {
                                     setEditingId(tr.id);
                                     setExpandedId(tr.id);
                                     setShowForm(true);
                                     window.scrollTo({ top: 0, behavior: "smooth" });
                                   }}
                                   title="تعديل المسودة"
                                 >
                                   <Pencil className="h-3 w-3" />تعديل
                                 </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs gap-1 text-green-700 border-green-200 hover:bg-green-50"
                                  onClick={() => { if (confirm(t("stockTransferPage.confirmPost"))) postMut.mutate(tr.id); }}
                                >
                                  <Send className="h-3 w-3" />{t("stockTransferPage.post")}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive"
                                  onClick={() => { if (confirm(t("stockTransferPage.confirmDelete"))) deleteMut.mutate(tr.id); }}
                                  aria-label={t("stockTransferPage.deleteTransfer")}
                                  title={t("stockTransferPage.deleteTransfer")}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                            {tr.status === "posted" && (
                              <CheckCircle2 className="h-4 w-4 text-green-600" />
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expanded detail */}
                      {expandedId === tr.id && (
                        <tr className="bg-muted/10">
                          <td colSpan={7} className="px-6 py-4">
                            {!trDetail?.items?.length
                              ? <p className="text-xs text-muted-foreground">{t("stockTransferPage.noItems")}</p>
                              : (
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-muted-foreground border-b">
                                      <th className="text-right pb-2 pr-0">{t("stockTransferPage.colItem")}</th>
                                      <th className="text-right pb-2">{t("stockTransferPage.colUnit")}</th>
                                      <th className="text-right pb-2">{t("stockTransferPage.colQty")}</th>
                                      <th className="text-right pb-2">{t("stockTransferPage.detailColCost")}</th>
                                      <th className="text-right pb-2">{t("stockTransferPage.colTotal")}</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border/50">
                                    {trDetail.items.map((l: any) => (
                                      <tr key={l.id}>
                                        <td className="py-1.5 pr-0">{pickName(l.item?.nameAr, l.item?.nameEn) || l.itemId}</td>
                                        <td className="py-1.5">{pickName(l.unit?.nameAr, l.unit?.nameEn) || t("stockTransferPage.baseUnit")}</td>
                                        <td className="py-1.5 tabular-nums">
                                          <div>{fmtQty(l.qty)}</div>
                                          {Number(l.conversionFactor ?? 1) !== 1 && (
                                            <div className="text-[10px] text-purple-600">
                                              {t("stockTransferPage.baseQtyHint", {
                                                cf: l.conversionFactor,
                                                qty: fmtQty(Number(l.qty) * Number(l.conversionFactor)),
                                              })}
                                            </div>
                                          )}
                                        </td>
                                        <td className="py-1.5 tabular-nums">
                                          <div>{fmt(l.costPrice)}</div>
                                          {Number(l.conversionFactor ?? 1) !== 1 && (
                                            <div className="text-[10px] text-muted-foreground">
                                              {t("stockTransferPage.baseCostHint", {
                                                cost: fmt(Number(l.costPrice) / Number(l.conversionFactor)),
                                              })}
                                            </div>
                                          )}
                                        </td>
                                        <td className="py-1.5 tabular-nums font-medium">
                                          {fmt(Number(l.qty) * Number(l.costPrice))}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            {tr.status === "posted" && tr.transferType === "manufacturing" && (
                              <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50/40 p-3">
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                  <div>
                                    <p className="text-xs font-semibold text-violet-900">ربط الإذن بأمر التصنيع</p>
                                    <p className="text-[10px] text-muted-foreground">يمكن تغيير الرابط أو فكه بعد الترحيل؛ لا يُنشأ أمر تصنيع جديد.</p>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <SearchCombobox
                                      className="h-8 min-w-[240px] text-xs"
                                      items={[
                                        { value: "", label: "بدون ربط" },
                                        ...(manufacturingOptions?.orders ?? []).map((order: any) => ({
                                          value: String(order.id),
                                          code: order.orderNumber,
                                          label: `${order.orderNumber} — ${order.productName}`,
                                        })),
                                      ]}
                                      value={linkOrderId}
                                      onValueChange={setLinkOrderId}
                                      placeholder="اختر أمر تصنيع"
                                    />
                                    <Button
                                      size="sm"
                                      className="h-8 text-xs"
                                      disabled={linkMut.isPending || (linkOrderId === String(trDetail?.productionOrderId ?? "") && trDetail?.productionOrderId != null)}
                                      onClick={() => linkMut.mutate({ id: tr.id, productionOrderId: linkOrderId ? Number(linkOrderId) : null })}
                                    >
                                      {linkMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "حفظ الرابط"}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && (
          <div className="px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">
            {t("stockTransferPage.transferCount", { count: filtered.length })}
          </div>
        )}
      </div>
    </div>
  );
}
