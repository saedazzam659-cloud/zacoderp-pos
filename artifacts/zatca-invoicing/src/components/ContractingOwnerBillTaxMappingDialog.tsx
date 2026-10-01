import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.VITE_API_URL || "";

export type OwnerBillTaxMapping = {
  boqLineId: number;
  ownerContractId: number;
  countryCode: "EG" | "JO";
  provider: "egypt_eta" | "jordan_national";
  providerItemCode: string;
  providerUnitCode: string;
  providerTaxCategoryCode: string;
  updatedAt: string | null;
};

type MappingDraft = Pick<
  OwnerBillTaxMapping,
  "providerItemCode" | "providerUnitCode" | "providerTaxCategoryCode"
>;

export function ContractingOwnerBillTaxMappingDialog({
  projectId,
  boqLineId,
  lineLabel,
  countryCode,
  token,
  actingCompanyId,
  mapping,
  disabled = false,
  onSaved,
}: {
  projectId: number;
  boqLineId: number;
  lineLabel: string;
  countryCode: "EG" | "JO";
  token: string | null;
  actingCompanyId?: number | null;
  mapping?: OwnerBillTaxMapping;
  disabled?: boolean;
  onSaved: (mapping: OwnerBillTaxMapping) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<MappingDraft>({
    providerItemCode: "",
    providerUnitCode: "",
    providerTaxCategoryCode: "",
  });
  const providerName = countryCode === "EG" ? "ETA" : "JoFotara";

  useEffect(() => {
    if (!open) return;
    setDraft({
      providerItemCode: mapping?.providerItemCode ?? "",
      providerUnitCode: mapping?.providerUnitCode ?? "",
      providerTaxCategoryCode: mapping?.providerTaxCategoryCode ?? "",
    });
  }, [mapping, open]);

  async function save() {
    if (!token) {
      toast({ title: "انتهت جلسة الدخول؛ سجّل الدخول مجددًا", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(
        `${API}/api/contracting/projects/${projectId}/boq-lines/${boqLineId}/owner-bill-tax-mapping`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}),
          },
          body: JSON.stringify(draft),
        },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
      onSaved(result as OwnerBillTaxMapping);
      setOpen(false);
      toast({ title: "تم حفظ ربط بند المستخلص" });
    } catch (caught: any) {
      toast({
        title: caught?.message || "تعذر حفظ ربط البند",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className={`text-[10px] ${mapping ? "text-emerald-700" : "text-amber-700"}`}>
          {mapping ? "الربط مكتمل" : "الربط ناقص"}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          data-testid={`owner-bill-tax-mapping-${boqLineId}`}
          onClick={() => setOpen(true)}
        >
          {mapping ? "تعديل الربط" : "إعداد الربط"}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle>ربط بند المستخلص مع {providerName}</DialogTitle>
            <DialogDescription>
              {lineLabel} — أدخل الرموز التي اعتمدها محاسب الشركة من دليل {providerName} فقط.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs leading-5 text-amber-950">
              لا تُستنتج الرموز تلقائيًا من اسم البند أو وحدته. الحفظ لا يرسل فاتورة.
            </div>
            <label className="block space-y-1 text-sm">
              <span>رمز الصنف لدى {providerName}</span>
              <Input
                value={draft.providerItemCode}
                maxLength={128}
                autoComplete="off"
                onChange={(event) => setDraft((value) => ({
                  ...value,
                  providerItemCode: event.target.value,
                }))}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>رمز وحدة القياس لدى {providerName}</span>
              <Input
                value={draft.providerUnitCode}
                maxLength={128}
                autoComplete="off"
                onChange={(event) => setDraft((value) => ({
                  ...value,
                  providerUnitCode: event.target.value,
                }))}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>فئة/رمز الضريبة المعتمد لدى {providerName}</span>
              <Input
                value={draft.providerTaxCategoryCode}
                maxLength={128}
                autoComplete="off"
                onChange={(event) => setDraft((value) => ({
                  ...value,
                  providerTaxCategoryCode: event.target.value,
                }))}
              />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              إلغاء
            </Button>
            <Button type="button" onClick={() => void save()} disabled={saving}>
              {saving ? "جار الحفظ…" : "اعتماد وحفظ الرموز"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}