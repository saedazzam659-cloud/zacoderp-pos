import "./_group.css";
import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchCombobox } from "@/components/ui/search-combobox";

const childItems = [
  { value: "", label: "— اختر الصنف —" },
  { value: "tablet", code: "ITM-0002", label: "جهاز التابلت" },
  { value: "cable", code: "ITM-0003", label: "كابل شحن" },
];

const unitItems = [
  { value: "piece", code: "PCS", label: "حبة — الوحدة الأساسية" },
  { value: "box", code: "BOX", label: "علبة (×12)" },
];

function DraftRow({ selected = false, index }: { selected?: boolean; index: number }) {
  const [childId, setChildId] = useState(selected ? "tablet" : "");
  const [unitId, setUnitId] = useState(selected ? "piece" : "");

  return (
    <div className="rounded-md border bg-background p-2">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(150px,2.8fr)_minmax(74px,1fr)_minmax(140px,2.5fr)_minmax(100px,2fr)_36px]">
        <div className="min-w-0">
          <Label htmlFor={`bundle-child-${index}`} className="mb-1 block whitespace-nowrap text-[11px] leading-4">الصنف الفرعي *</Label>
          <SearchCombobox
            id={`bundle-child-${index}`}
            items={childItems}
            value={childId}
            onValueChange={value => {
              setChildId(value);
              setUnitId(value ? "piece" : "");
            }}
            placeholder="— اختر الصنف —"
            searchPlaceholder="ابحث بالاسم أو الكود..."
            emptyText="لا توجد أصناف مطابقة"
          />
        </div>
        <div className="min-w-0">
          <Label className="mb-1 block whitespace-nowrap text-[11px] leading-4">الكمية *</Label>
          <Input type="number" defaultValue="1" className="h-9 min-w-0 px-2" />
        </div>
        <div className="min-w-0">
          <Label htmlFor={`bundle-unit-${index}`} className="mb-1 block whitespace-nowrap text-[11px] leading-4">وحدة القياس *</Label>
          <SearchCombobox
            id={`bundle-unit-${index}`}
            items={childId ? unitItems : []}
            value={unitId}
            onValueChange={setUnitId}
            placeholder={childId ? "اختر الوحدة" : "لا توجد وحدة مسجلة"}
            searchPlaceholder="ابحث عن الوحدة..."
            emptyText="لا توجد وحدات مطابقة"
            disabled={!childId}
          />
        </div>
        <div className="min-w-0">
          <Label className="mb-1 block whitespace-nowrap text-[11px] leading-4">ملاحظات</Label>
          <Input defaultValue="" className="h-9 min-w-0 px-2" />
        </div>
        <div className="flex items-end justify-center">
          <Button type="button" size="icon" variant="ghost" className="h-9 w-9 text-destructive" aria-label="حذف السطر">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SingleRow() {
  return (
    <main dir="rtl" className="min-h-screen bg-background p-4 font-sans">
      <section className="mx-auto max-w-6xl rounded-lg border bg-background/50 p-3">
        <header className="mb-3">
          <p className="text-sm font-semibold">المكونات لكل وحدة من الصنف المركب</p>
          <p className="mt-1 text-xs text-muted-foreground">وحدة الصنف المركب: عبوة</p>
        </header>
        <div className="space-y-2">
          <DraftRow selected index={0} />
          <DraftRow index={1} />
          <DraftRow index={2} />
        </div>
        <footer className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Button type="button" size="sm" variant="outline" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            إضافة سطر
          </Button>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost">إلغاء</Button>
            <Button type="button" size="sm" className="gap-1.5">
              <Save className="h-3.5 w-3.5" />
              حفظ جميع المكونات
            </Button>
          </div>
        </footer>
      </section>
    </main>
  );
}