import "./_group.css";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function DraftRow({ selected = false }: { selected?: boolean }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
        <div className="sm:col-span-5">
          <Label className="mb-1 block text-xs">الصنف الفرعي *</Label>
          <select
            defaultValue={selected ? "tablet" : ""}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="">— اختر الصنف —</option>
            <option value="tablet">جهاز التابلت (ITM-0002)</option>
            <option value="cable">كابل شحن (ITM-0003)</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <Label className="mb-1 block text-xs">الكمية *</Label>
          <Input type="number" defaultValue="1" className="h-9" />
        </div>
        <div className="sm:col-span-4">
          <Label className="mb-1 block text-xs">وحدة القياس *</Label>
          <select
            defaultValue={selected ? "piece" : ""}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="">لا توجد وحدة مسجلة</option>
            <option value="piece">حبة — الوحدة الأساسية</option>
            <option value="box">علبة (×12)</option>
          </select>
        </div>
        <div className="flex items-end justify-end sm:col-span-1">
          <Button type="button" size="icon" variant="ghost" className="h-9 w-9 text-destructive" aria-label="حذف السطر">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        <div className="sm:col-span-11">
          <Label className="mb-1 block text-xs">ملاحظات</Label>
          <Input defaultValue="" className="h-9" />
        </div>
      </div>
    </div>
  );
}

export function Current() {
  return (
    <main dir="rtl" className="min-h-screen bg-background p-4 font-sans">
      <section className="mx-auto max-w-6xl rounded-lg border bg-background/50 p-3">
        <header className="mb-3">
          <p className="text-sm font-semibold">المكونات لكل وحدة من الصنف المركب</p>
          <p className="mt-1 text-xs text-muted-foreground">وحدة الصنف المركب: عبوة</p>
        </header>
        <div className="space-y-3">
          <DraftRow selected />
          <DraftRow />
          <DraftRow />
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