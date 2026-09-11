import { Factory, Link2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type IndustrialCostDraft = {
  costType: string;
  factoryId: string;
  costCenter: string;
  period: string;
  allocationDriver: string;
  sourcePurchaseLineId?: string;
};

type SourceLine = {
  _id: string;
  itemName: string;
  itemCode?: string;
  lineTotal: string;
  industrialCost?: IndustrialCostDraft | null;
};

const COST_TYPES = [
  { value: "electricity", label: "كهرباء وطاقة" },
  { value: "maintenance", label: "صيانة" },
  { value: "industrial_services", label: "خدمات صناعية" },
  { value: "indirect_materials", label: "مواد صناعية غير مباشرة" },
  { value: "other_industrial_overhead", label: "تكاليف صناعية أخرى" },
];

const DRIVERS = [
  { value: "machine_hours", label: "ساعات تشغيل الآلة" },
  { value: "labor_hours", label: "ساعات العمل" },
  { value: "production_quantity", label: "كمية الإنتاج" },
  { value: "percentage", label: "نسبة" },
  { value: "direct_cost", label: "تكلفة مباشرة" },
];

const blankTag = (): IndustrialCostDraft => ({
  costType: "electricity", factoryId: "", costCenter: "", period: new Date().toISOString().slice(0, 7), allocationDriver: "machine_hours",
});

export default function IndustrialCostsTab({
  lines,
  onChange,
  branches,
  costCenters,
  disabled = false,
}: {
  lines: SourceLine[];
  onChange: (lineId: string, tag: IndustrialCostDraft | null) => void;
  branches: any[];
  costCenters: any[];
  disabled?: boolean;
}) {
  const plantItems = [
    { value: "", label: "اختر المصنع / موقع التكلفة" },
    ...branches.filter((b) => b.status !== "inactive").map((b) => ({
      value: String(b.id),
      label: `${b.code ? `${b.code} — ` : ""}${b.nameAr ?? b.nameEn ?? `#${b.id}`}`,
    })),
  ];
  const costCenterItems = [
    { value: "", label: "اختر مركز التكلفة" },
    ...costCenters.filter((c) => c.isActive !== false && c.isPosting !== false).map((c) => ({
      value: String(c.code),
      label: `${c.code} — ${c.nameAr ?? c.nameEn ?? ""}`,
    })),
  ];

  return (
    <fieldset disabled={disabled} className="m-0 space-y-4 border-0 p-0 disabled:opacity-100">
      <div className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50/60 p-4 text-sky-950">
        <div className="mt-0.5 rounded-lg bg-sky-100 p-2"><Zap className="h-4 w-4 text-sky-700" /></div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold">مصادر التكاليف الصناعية الفعلية</h3>
          <p className="mt-1 text-xs leading-relaxed text-sky-800">
            اختيار السطر يحفظ مصدر التكلفة الأصلي فقط. تُحتسب الفواتير المعتمدة ناقص المرتجعات المعتمدة؛
            سندات الدفع لا تُنشئ تكلفة جديدة ولا يتم إنشاء قيد تصنيع من هنا.
          </p>
        </div>
      </div>

      {lines.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
          أضف سطر مشتريات أولاً ثم حدده كمصدر تكلفة صناعية عند الحاجة.
        </div>
      ) : (
        <div className="space-y-3">
          {lines.map((line, index) => {
            const tag = line.industrialCost ?? null;
            const patch = (change: Partial<IndustrialCostDraft>) => onChange(line._id, { ...(tag ?? blankTag()), ...change });
            return (
              <section key={line._id} className={`overflow-hidden rounded-xl border transition-colors ${tag ? "border-sky-300 bg-sky-50/30" : "bg-card"}`}>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold">{index + 1}</span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{line.itemName || "سطر بدون صنف"}</p>
                      <p className="text-[11px] text-muted-foreground">
                        <span dir="ltr">{line.itemCode || "—"}</span> · مصدر السطر · قيمة المستند {Number(line.lineTotal || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                    </div>
                  </div>
                  <Button type="button" size="sm" variant={tag ? "outline" : "default"} className={tag ? "border-sky-300 text-sky-800" : ""} onClick={() => onChange(line._id, tag ? null : blankTag())}>
                    <Link2 className="me-1.5 h-3.5 w-3.5" />{tag ? "إلغاء وسم التكلفة" : "اعتبار مصدر تكلفة"}
                  </Button>
                </div>
                {tag && (
                  <div className="grid gap-4 border-t bg-background/70 p-4 sm:grid-cols-2 xl:grid-cols-5">
                    <div className="space-y-1.5">
                      <Label className="text-xs">نوع التكلفة <span className="text-destructive">*</span></Label>
                      <Select value={tag.costType} onValueChange={(costType) => patch({ costType })}>
                        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>{COST_TYPES.map((type) => <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs flex items-center gap-1"><Factory className="h-3.5 w-3.5" />المصنع / موقع التكلفة <span className="text-destructive">*</span></Label>
                      <SearchCombobox items={plantItems} value={tag.factoryId} onValueChange={(factoryId) => patch({ factoryId })} placeholder="اختر المصنع" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">مركز التكلفة <span className="text-destructive">*</span></Label>
                      <SearchCombobox items={costCenterItems} value={tag.costCenter} onValueChange={(costCenter) => patch({ costCenter })} placeholder="اختر المركز" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">الفترة <span className="text-destructive">*</span></Label>
                      <DateField required className="h-9 text-xs" value={`${tag.period || blankTag().period}-01`} onChange={(e) => patch({ period: e.target.value.slice(0, 7) })} title="يتم حفظ الشهر بصيغة YYYY-MM" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">أساس التحميل <span className="text-destructive">*</span></Label>
                      <Select value={tag.allocationDriver} onValueChange={(allocationDriver) => patch({ allocationDriver })}>
                        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>{DRIVERS.map((driver) => <SelectItem key={driver.value} value={driver.value}>{driver.label}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}