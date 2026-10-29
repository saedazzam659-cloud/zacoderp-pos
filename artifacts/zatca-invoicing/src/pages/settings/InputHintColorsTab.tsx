import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const COLORS = [
  { value: "#64748b", label: "رمادي" },
  { value: "#2563eb", label: "أزرق" },
  { value: "#0f766e", label: "أخضر" },
  { value: "#7c3aed", label: "بنفسجي" },
  { value: "#c2410c", label: "برتقالي" },
  { value: "#be123c", label: "وردي" },
];

export default function InputHintColorsTab({ companyId, token, enabled, color, onSaved }: {
  companyId: number; token?: string | null; enabled: boolean; color: string;
  onSaved: (enabled: boolean, color: string) => void;
}) {
  const { toast } = useToast();
  const { i18n } = useTranslation();
  const isRtl = i18n.language.toLowerCase().startsWith("ar");
  const [active, setActive] = useState(enabled);
  const [selectedColor, setSelectedColor] = useState(color || "#64748b");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setActive(enabled); setSelectedColor(color || "#64748b"); }, [enabled, color]);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch(`${API}/api/companies/${companyId}/general-settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ inputHintColorsEnabled: active, inputHintColor: selectedColor }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || "تعذر حفظ الإعداد");
      onSaved(active, selectedColor);
      toast({ title: isRtl ? "تم حفظ ألوان التلميحات" : "Hint colors saved" });
    } catch (error: any) {
      toast({ title: error?.message || (isRtl ? "تعذر حفظ الإعداد" : "Could not save settings"), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-5 rounded-2xl border bg-card p-5" dir="rtl" data-testid="input-hint-colors-settings">
      <div>
        <h2 className="text-lg font-bold">{isRtl ? "ألوان تلميحات الحقول" : "Input hint colors"}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{isRtl ? "يُطبّق اللون على النص الإرشادي داخل الحقول في واجهة الشركة، دون تغيير لون البيانات المدخلة." : "Apply a color to placeholder guidance across this company without changing entered data."}</p>
      </div>
      <div className="flex items-center justify-between rounded-xl border p-4">
        <div>
          <Label htmlFor="input-hint-colors-enabled">{isRtl ? "تفعيل ألوان التلميحات" : "Enable hint colors"}</Label>
          <p className="mt-1 text-xs text-muted-foreground">{isRtl ? "الإعداد متوقف افتراضيًا." : "Off by default."}</p>
        </div>
        <Switch id="input-hint-colors-enabled" checked={active} onCheckedChange={setActive} data-testid="switch-input-hint-colors" />
      </div>
      <div className="space-y-3">
        <Label>{isRtl ? "اختر لونًا للتلميحات" : "Choose a hint color"}</Label>
        <div className="flex flex-wrap gap-3">
          {COLORS.map(option => (
            <button key={option.value} type="button" title={option.label} aria-label={option.label}
              aria-pressed={selectedColor === option.value} onClick={() => setSelectedColor(option.value)}
              className="h-9 w-9 rounded-full border-2 ring-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              style={{ backgroundColor: option.value, borderColor: selectedColor === option.value ? "#0f172a" : "white" }}
              data-testid={`button-hint-color-${option.value.slice(1)}`} />
          ))}
          <Input type="color" value={selectedColor} aria-label="لون مخصص" onChange={event => setSelectedColor(event.target.value)}
            className="h-9 w-14 p-1" data-testid="input-custom-hint-color" />
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <style>{`[data-testid="input-hint-color-preview"]::placeholder { color: ${selectedColor} !important; }`}</style>
          <Input placeholder="مثال: اكتب اسم العميل هنا" style={{ color: "inherit" }} aria-label="معاينة التلميح" readOnly data-testid="input-hint-color-preview" />
          <p className="mt-2 text-xs text-muted-foreground">{isRtl ? "معاينة للون التلميح المحدد" : "Preview of the selected hint color"}</p>
        </div>
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving} data-testid="button-save-hint-colors">{saving ? (isRtl ? "جارٍ الحفظ…" : "Saving…") : (isRtl ? "حفظ الإعداد" : "Save settings")}</Button>
      </div>
    </section>
  );
}
