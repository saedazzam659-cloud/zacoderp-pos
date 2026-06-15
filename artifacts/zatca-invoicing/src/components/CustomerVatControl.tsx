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
  /** سياسة الحقول (الحوكمة): إخفاء الأداة بالكامل من شاشة الفاتورة. */
  hidden?: boolean;
  /** سياسة الحقول (الحوكمة): تعطيل زر «+ عميل جديد» (للقراءة فقط). */
  readOnly?: boolean;
};

export function CustomerVatControl({ customers, customerId, onCustomerChange, hidden, readOnly }: Props) {
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
  const [newPhone, setNewPhone] = useState("");
  // National Address (العنوان الوطني) — all optional, used by ZATCA & B2B invoices
  const [newBuildingNumber, setNewBuildingNumber] = useState("");
  const [newStreet,         setNewStreet]         = useState("");
  const [newDistrict,       setNewDistrict]       = useState("");
  const [newCity,           setNewCity]           = useState("");
  const [newPostalCode,     setNewPostalCode]     = useState("");

  function resetForm() {
    setNewName(""); setNewVat(""); setNewPhone("");
    setNewBuildingNumber(""); setNewStreet(""); setNewDistrict("");
    setNewCity(""); setNewPostalCode("");
  }

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
          vatNumber:      newVat.trim()            || undefined,
          phone:          newPhone.trim()          || undefined,
          buildingNumber: newBuildingNumber.trim() || undefined,
          street:         newStreet.trim()         || undefined,
          district:       newDistrict.trim()       || undefined,
          city:           newCity.trim()           || undefined,
          postalCode:     newPostalCode.trim()     || undefined,
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
      resetForm();
      if (cus?.id) onCustomerChange(String(cus.id));
    },
    onError: (e: any) => toast({ title: "تعذّر إضافة العميل", description: e?.message, variant: "destructive" }),
  });

  if (hidden) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 leading-none">
        <Label className="text-xs font-medium text-foreground/80">الرقم الضريبي للعميل</Label>
        <button
          type="button"
          disabled={readOnly}
          title={readOnly ? "غير مسموح حسب سياسة الحقول" : undefined}
          className="text-[11px] leading-none text-primary hover:underline inline-flex items-center gap-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
          onClick={() => { if (readOnly) return; resetForm(); setOpen(true); }}
        >
          <Plus className="h-2.5 w-2.5" />عميل جديد
        </button>
      </div>
      {/* الرقم الضريبي السعودي: 15 رقم بالضبط — نمنع إدخال أكثر من 15
          (maxLength) ونحجب أي حرف غير رقمي عبر تنقية القيمة قبل التحديث،
          لتجنّب أخطاء التحقق لاحقًا عند الحفظ/الإرسال إلى زاتكا. */}
      <Input
        className="h-9 text-sm font-mono text-left"
        dir="ltr"
        inputMode="numeric"
        pattern="\d*"
        maxLength={15}
        placeholder={selected ? "31xxxxxxxxxxxx3" : "اختر العميل أو أضف عميل جديد"}
        value={vat}
        onChange={(e) => setVat(e.target.value.replace(/\D/g, "").slice(0, 15))}
        onBlur={handleBlur}
        disabled={!selected || updateVat.isPending}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent dir="rtl" className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>إضافة عميل جديد</DialogTitle>
            <DialogDescription>أدخل اسم العميل ورقمه الضريبي ورقم هاتفه والعنوان الوطني (اختياري) لإضافته بسرعة. سيتم إنشاء حساب له تلقائياً في شجرة الحسابات.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-sm">اسم العميل (عربي) *</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="شركة العملاء المحدودة" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">الرقم الضريبي (VAT)</Label>
              <Input value={newVat} onChange={(e) => setNewVat(e.target.value.replace(/\D/g, "").slice(0, 15))} placeholder="310000000000003" dir="ltr" inputMode="numeric" pattern="\d*" className="text-left font-mono" maxLength={15} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">رقم الهاتف</Label>
              <Input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="0501234567"
                dir="ltr"
                inputMode="tel"
                className="text-left font-mono"
                maxLength={20}
              />
            </div>

            {/* National Address — العنوان الوطني (Saudi Post) */}
            <div className="space-y-3 rounded-md border bg-muted/30 p-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold">العنوان الوطني (اختياري)</Label>
                <span className="text-[10px] text-muted-foreground">يُستخدم في طباعة الفاتورة الضريبية</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">رقم المبنى</Label>
                  <Input value={newBuildingNumber} onChange={(e) => setNewBuildingNumber(e.target.value)} placeholder="1234" dir="ltr" inputMode="numeric" maxLength={4} className="text-left font-mono h-9" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">الرمز البريدي</Label>
                  <Input value={newPostalCode} onChange={(e) => setNewPostalCode(e.target.value)} placeholder="12345" dir="ltr" inputMode="numeric" maxLength={5} className="text-left font-mono h-9" />
                </div>
                <div className="space-y-1 col-span-2">
                  <Label className="text-xs text-muted-foreground">اسم الشارع</Label>
                  <Input value={newStreet} onChange={(e) => setNewStreet(e.target.value)} placeholder="شارع الملك فهد" className="h-9" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">الحي</Label>
                  <Input value={newDistrict} onChange={(e) => setNewDistrict(e.target.value)} placeholder="حي العليا" className="h-9" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">المدينة</Label>
                  <Input value={newCity} onChange={(e) => setNewCity(e.target.value)} placeholder="الرياض" className="h-9" />
                </div>
              </div>
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
