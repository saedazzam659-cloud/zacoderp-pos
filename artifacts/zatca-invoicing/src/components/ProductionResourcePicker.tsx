import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export type ResourceCatalog = {
  workCenters: { id: number; name?: string; nameAr?: string }[];
  machines: { id: number; name: string; workCenterId?: number | null; fixedAssetId?: number | null }[];
  assets: { id: number; name?: string; nameAr?: string; code?: string }[];
};

export function ProductionResourcePicker({ workCenterId, machineId, catalog, disabled, canCreate, endpoint, headers, onChange, onCreated }: {
  workCenterId: string; machineId: string; catalog: ResourceCatalog; disabled: boolean; canCreate: boolean;
  endpoint: string; headers: Record<string, string>;
  onChange: (values: { workCenterId: string; machineId: string }) => void;
  onCreated: (kind: "work-centers" | "machines", row: any) => void;
}) {
  const { toast } = useToast();
  const [kind, setKind] = useState<"work-centers" | "machines" | null>(null);
  const [name, setName] = useState("");
  const [center, setCenter] = useState("");
  const [asset, setAsset] = useState("");
  const [mode, setMode] = useState("unlinked");
  const [saving, setSaving] = useState(false);
  const centers = catalog.workCenters.map(row => ({ value: String(row.id), label: row.nameAr || row.name || String(row.id) }));
  const machines = catalog.machines.filter(row => !workCenterId || String(row.workCenterId ?? "") === workCenterId);
  const selectedMachine = catalog.machines.find(row => String(row.id) === machineId);
  const linkedAsset = catalog.assets.find(row => row.id === selectedMachine?.fixedAssetId);
  const open = (type: "work-centers" | "machines") => {
    setKind(type); setName(""); setCenter(workCenterId); setAsset(""); setMode("unlinked");
  };
  const save = async () => {
    if (!kind || !canCreate || saving || !name.trim() || (kind === "machines" && mode === "linked" && !asset)) return;
    setSaving(true);
    try {
      const res = await fetch(`${endpoint}/setup/${kind}`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), ...(kind === "machines" ? {
          workCenterId: center ? Number(center) : null,
          fixedAssetId: mode === "linked" ? Number(asset) : null,
        } : {}) }),
      });
      const row = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(row.error || "تعذر الحفظ");
      if (!row.id) throw new Error("لم يُرجع الخادم بيانات العنصر المحفوظ");
      onCreated(kind, row);
      onChange(kind === "work-centers"
        ? { workCenterId: String(row.id), machineId: "" }
        : { workCenterId: row.workCenterId ? String(row.workCenterId) : "", machineId: String(row.id) });
      setKind(null);
      toast({ title: "تمت الإضافة والاختيار", description: "احفظ بيانات المرحلة لتثبيت الاختيار على الأمر." });
    } catch (e: any) {
      toast({ title: e.message || "تعذر الحفظ", variant: "destructive" });
    } finally { setSaving(false); }
  };
  return <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <div className="flex justify-between items-center"><Label className="text-xs">مركز العمل</Label>
          {canCreate && <Button type="button" variant="ghost" size="sm" className="h-7 px-2" disabled={disabled} onClick={() => open("work-centers")}><Plus className="h-3 w-3 me-1" />إضافة</Button>}
        </div>
        <SearchCombobox value={workCenterId} items={[{ value: "", label: "بدون مركز" }, ...centers]}
          onValueChange={value => onChange({ workCenterId: value, machineId: selectedMachine && String(selectedMachine.workCenterId ?? "") === value ? machineId : "" })}
          disabled={disabled} placeholder="اختر مركز العمل" />
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between items-center"><Label className="text-xs">الآلة</Label>
          {canCreate && <Button type="button" variant="ghost" size="sm" className="h-7 px-2" disabled={disabled} onClick={() => open("machines")}><Plus className="h-3 w-3 me-1" />إضافة</Button>}
        </div>
        <SearchCombobox value={machineId} items={[{ value: "", label: "بدون آلة" }, ...machines.map(row => ({ value: String(row.id), label: row.name }))]}
          onValueChange={value => {
            const row = catalog.machines.find(machine => String(machine.id) === value);
            onChange({ machineId: value, workCenterId: row ? String(row.workCenterId ?? "") : workCenterId });
          }} disabled={disabled} placeholder="اختر الآلة" />
      </div>
    </div>
    {selectedMachine?.fixedAssetId && <p className="text-xs text-violet-700">مرتبطة بالأصل: {linkedAsset?.nameAr || linkedAsset?.name || `#${selectedMachine.fixedAssetId}`} — الربط لا ينشئ إهلاكًا أو تحميلًا إضافيًا.</p>}
    <Dialog open={kind !== null} onOpenChange={value => { if (!value && !saving) setKind(null); }}>
      <DialogContent dir="rtl">
        <DialogHeader><DialogTitle>{kind === "work-centers" ? "إضافة مركز عمل" : "إضافة آلة إنتاج"}</DialogTitle>
          <DialogDescription>إضافة مورد تشغيلي دون مغادرة الأمر أو تغيير قواعد تحميل التكاليف.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>الاسم</Label><Input value={name} onChange={e => setName(e.target.value)} maxLength={200} disabled={saving} /></div>
          {kind === "machines" && <>
            <div className="space-y-1.5"><Label>مركز العمل</Label><SearchCombobox value={center} onValueChange={setCenter} items={[{ value: "", label: "بدون مركز" }, ...centers]} disabled={saving} /></div>
            <div className="space-y-1.5"><Label>ربط الأصل الثابت</Label><SearchCombobox value={mode} onValueChange={setMode} disabled={saving}
              items={[{ value: "unlinked", label: "آلة بدون أصل / مؤجرة" }, { value: "linked", label: "ربط بأصل ثابت موجود" }]} /></div>
            {mode === "linked" && <div className="space-y-1.5"><Label>الأصل الثابت</Label><SearchCombobox value={asset}
              onValueChange={value => { setAsset(value); const row = catalog.assets.find(x => String(x.id) === value); if (!name.trim() && row) setName(row.nameAr || row.name || ""); }}
              items={catalog.assets.map(row => ({ value: String(row.id), label: `${row.code ? `${row.code} — ` : ""}${row.nameAr || row.name || row.id}` }))}
              disabled={saving} placeholder="ابحث عن أصل ثابت" />
              {!catalog.assets.length && <p className="text-xs text-amber-700">لا توجد أصول متاحة للربط ضمن نطاق هذا الأمر.</p>}
            </div>}
            <p className="text-xs text-slate-500">لن يتم نسخ الأصل أو إنشاء إهلاك جديد. مصادر الإهلاك وتحميل الساعات تظل كما هي.</p>
          </>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={saving} onClick={() => setKind(null)}>إلغاء</Button>
            <Button type="button" disabled={saving || !name.trim() || (kind === "machines" && mode === "linked" && !asset)} onClick={() => void save()}>{saving ? "جاري الحفظ…" : "حفظ واختيار"}</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}