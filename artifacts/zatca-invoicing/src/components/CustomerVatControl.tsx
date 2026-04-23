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
  customers: any[];
  customerId: string;
  onCustomerChange: (id: string) => void;
};

export function CustomerVatControl({ customers, customerId, onCustomerChange }: Props) {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };

  const selected = customers.find((c: any) => String(c.id) === customerId) ?? null;
  const [vat, setVat] = useState<string>(selected?.vatNumber ?? "");

  useEffect(() => { setVat(selected?.vatNumber ?? ""); }, [selected?.id, selected?.vatNumber]);

  const updateVat = useMutation({
    mutationFn: async (newVat: string) => {
      if (!selected) throw new Error("لم يتم اختيار العميل");
      const body = {
        companyId:      selected.companyId ?? user?.companyId,
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
      const res = await fetch(`${API}/api/customers/${selected.id}`, {
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
      qc.invalidateQueries({ queryKey: ["customers"] });
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

  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newVat, setNewVat] = useState("");

  const createCustomer = useMutation({
    mutationFn: async () => {
      const nameAr = newName.trim();
      if (nameAr.length < 2) throw new Error("اسم العميل مطلوب");
      const res = await fetch(`${API}/api/customers`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: user?.companyId,
          nameAr,
          vatNumber: newVat.trim() || undefined,
          country: "SA",
        }),
      });
      if (!res.ok) {
        const txt = await res.text(); let msg = txt;
        try { msg = JSON.parse(txt).error ?? txt; } catch {}
        throw new Error(msg || "تعذّر إضافة العميل");
      }
      return res.json();
    },
    onSuccess: (cus: any) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast({ title: "تم إضافة العميل" });
      setOpen(false);
      setNewName(""); setNewVat("");
      if (cus?.id) onCustomerChange(String(cus.id));
    },
    onError: (e: any) => toast({ title: "تعذّر إضافة العميل", description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 leading-none">
        <Label className="text-xs font-medium text-foreground/80">الرقم الضريبي للعميل</Label>
        <button
          type="button"
          className="text-[11px] leading-none text-primary hover:underline inline-flex items-center gap-0.5"
          onClick={() => { setNewName(""); setNewVat(""); setOpen(true); }}
        >
          <Plus className="h-2.5 w-2.5" />عميل جديد
        </button>
      </div>
      <Input
        className="h-9 text-sm font-mono text-left"
        dir="ltr"
        placeholder={selected ? "31xxxxxxxxxxxx3" : "اختر العميل أو أضف عميل جديد"}
        value={vat}
        onChange={(e) => setVat(e.target.value)}
        onBlur={handleBlur}
        disabled={!selected || updateVat.isPending}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إضافة عميل جديد</DialogTitle>
            <DialogDescription>أدخل اسم العميل ورقمه الضريبي (اختياري) لإضافته بسرعة. سيتم إنشاء حساب له تلقائياً في شجرة الحسابات.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-sm">اسم العميل (عربي) *</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="شركة العملاء المحدودة" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">الرقم الضريبي (VAT)</Label>
              <Input value={newVat} onChange={(e) => setNewVat(e.target.value)} placeholder="310000000000003" dir="ltr" className="text-left font-mono" maxLength={15} />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} className="gap-1"><X className="h-4 w-4" />إلغاء</Button>
            <Button type="button" onClick={() => createCustomer.mutate()} disabled={createCustomer.isPending || newName.trim().length < 2} className="gap-1">
              <Save className="h-4 w-4" />{createCustomer.isPending ? "جاري الحفظ..." : "حفظ العميل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
