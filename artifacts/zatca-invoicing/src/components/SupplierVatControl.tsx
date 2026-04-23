import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Save, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Props = {
  suppliers: any[];
  supplierId: string;
  onSupplierChange: (id: string) => void;
};

export function SupplierVatControl({ suppliers, supplierId, onSupplierChange }: Props) {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };

  const selected = suppliers.find((s: any) => String(s.id) === supplierId) ?? null;
  const [vat, setVat] = useState<string>(selected?.vatNumber ?? "");

  useEffect(() => { setVat(selected?.vatNumber ?? ""); }, [selected?.id, selected?.vatNumber]);

  const updateVat = useMutation({
    mutationFn: async (newVat: string) => {
      if (!selected) throw new Error("لم يتم اختيار المورد");
      const body = {
        code:           selected.code           ?? null,
        nameAr:         selected.nameAr,
        nameEn:         selected.nameEn         ?? null,
        vatNumber:      newVat || null,
        crNumber:       selected.crNumber       ?? null,
        email:          selected.email          ?? null,
        phone:          selected.phone          ?? null,
        city:           selected.city           ?? null,
        district:       selected.district       ?? null,
        street:         selected.street         ?? null,
        buildingNumber: selected.buildingNumber ?? null,
        postalCode:     selected.postalCode     ?? null,
        country:        selected.country        ?? "SA",
        accountId:      selected.accountId      ?? null,
      };
      const res = await fetch(`${API}/api/suppliers/${selected.id}`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text(); let msg = txt;
        try { msg = JSON.parse(txt).error ?? txt; } catch {}
        throw new Error(msg || "تعذّر تحديث الرقم الضريبي");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      toast({ title: "تم تحديث الرقم الضريبي" });
    },
    onError: (e: any) => toast({ title: "تعذّر تحديث الرقم الضريبي", description: e?.message, variant: "destructive" }),
  });

  function handleBlur() {
    if (!selected) return;
    const newVat = vat.trim();
    if (newVat === (selected.vatNumber ?? "")) return;
    updateVat.mutate(newVat);
  }

  // Quick-add dialog
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newVat, setNewVat] = useState("");

  const createSupplier = useMutation({
    mutationFn: async () => {
      const nameAr = newName.trim();
      if (nameAr.length < 2) throw new Error("اسم المورد مطلوب");
      const res = await fetch(`${API}/api/suppliers`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: user?.companyId,
          nameAr,
          vatNumber: newVat.trim() || null,
          country: "SA",
        }),
      });
      if (!res.ok) {
        const txt = await res.text(); let msg = txt;
        try { msg = JSON.parse(txt).error ?? txt; } catch {}
        throw new Error(msg || "تعذّر إضافة المورد");
      }
      return res.json();
    },
    onSuccess: (sup: any) => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      toast({ title: "تم إضافة المورد" });
      setOpen(false);
      setNewName(""); setNewVat("");
      if (sup?.id) onSupplierChange(String(sup.id));
    },
    onError: (e: any) => toast({ title: "تعذّر إضافة المورد", description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 leading-none">
        <Label className="text-xs">الرقم الضريبي للمورد</Label>
        <button
          type="button"
          className="text-[11px] leading-none text-primary hover:underline inline-flex items-center gap-0.5"
          onClick={() => { setNewName(""); setNewVat(""); setOpen(true); }}
        >
          <Plus className="h-2.5 w-2.5" />مورد جديد
        </button>
      </div>
      <Input
        className="h-9 text-sm font-mono text-left"
        dir="ltr"
        placeholder={selected ? "31xxxxxxxxxxxx3" : "اختر المورد أو أضف مورد جديد"}
        value={vat}
        onChange={(e) => setVat(e.target.value)}
        onBlur={handleBlur}
        disabled={!selected || updateVat.isPending}
      />
      {selected?.code && (
        <p className="text-[11px] text-muted-foreground" dir="ltr">رقم المورد: <span className="font-mono">{selected.code}</span></p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إضافة مورد جديد</DialogTitle>
            <DialogDescription>أدخل اسم المورد ورقمه الضريبي (اختياري) لإضافته بسرعة.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-sm">اسم المورد (عربي) *</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="شركة التوريدات الوطنية" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">الرقم الضريبي (VAT)</Label>
              <Input value={newVat} onChange={(e) => setNewVat(e.target.value)} placeholder="310000000000003" dir="ltr" className="text-left font-mono" maxLength={15} />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} className="gap-1"><X className="h-4 w-4" />إلغاء</Button>
            <Button type="button" onClick={() => createSupplier.mutate()} disabled={createSupplier.isPending || newName.trim().length < 2} className="gap-1">
              <Save className="h-4 w-4" />{createSupplier.isPending ? "جاري الحفظ..." : "حفظ المورد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
