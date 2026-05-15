import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Building2, Save, Loader2, ShieldCheck } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface CompanyProfile {
  id: number;
  nameAr?: string; nameEn?: string;
  vatNumber?: string; crNumber?: string;
  country?: string; city?: string; district?: string;
  street?: string; buildingNumber?: string;
  postalCode?: string; additionalNumber?: string;
  industryName?: string;
}

export default function CompanyProfile() {
  const { t } = useTranslation();
  const { user, token, setUser } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.companyId ?? user?.company?.id;

  const { data, isLoading } = useQuery<CompanyProfile>({
    queryKey: ["company-profile", cid],
    enabled: !!cid && !!token,
    queryFn: async () => {
      const r = await fetch(`${API}/api/companies/${cid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const [form, setForm] = useState<CompanyProfile>({} as any);
  useEffect(() => { if (data) setForm(data); }, [data]);

  const set = (k: keyof CompanyProfile) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, any> = {};
      const keys: (keyof CompanyProfile)[] = [
        "nameAr","nameEn","vatNumber","crNumber","country","city","district",
        "street","buildingNumber","postalCode","additionalNumber","industryName",
      ];
      for (const k of keys) if (form[k] !== undefined) body[k] = form[k] ?? "";
      const r = await fetch(`${API}/api/companies/${cid}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      return r.json() as Promise<CompanyProfile>;
    },
    onSuccess: (updated) => {
      toast({ title: t("companyProfile.saved", "تم حفظ بيانات الشركة بنجاح") });
      qc.invalidateQueries({ queryKey: ["company-profile", cid] });
      // Refresh AuthContext so the new name/VAT show up in the header instantly.
      if (user && setUser) {
        setUser({ ...user, company: { ...(user.company || {}), ...updated } });
      }
    },
    onError: (e: Error) => {
      toast({ variant: "destructive", title: t("error", "خطأ"), description: e.message });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-4xl">
      <div className="mb-6 flex items-center gap-3">
        <div className="rounded-lg bg-indigo-100 p-2 dark:bg-indigo-900/30">
          <Building2 className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">{t("companyProfile.title", "بيانات الشركة")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("companyProfile.subtitle", "تعديل اسم الشركة والرقم الضريبي والسجل التجاري والعنوان")}
          </p>
        </div>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
        className="space-y-6"
      >
        <section className="rounded-lg border bg-card p-4 md:p-6 space-y-4">
          <h2 className="font-semibold text-lg flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-600" />
            {t("companyProfile.identity", "الهوية والامتثال الضريبي")}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>{t("companyProfile.nameAr", "اسم الشركة (عربي)")} *</Label>
              <Input value={form.nameAr ?? ""} onChange={set("nameAr")} required dir="rtl" />
            </div>
            <div>
              <Label>{t("companyProfile.nameEn", "اسم الشركة (إنجليزي)")}</Label>
              <Input value={form.nameEn ?? ""} onChange={set("nameEn")} dir="ltr" />
            </div>
            <div>
              <Label>{t("companyProfile.vatNumber", "الرقم الضريبي (15 رقم)")}</Label>
              <Input
                value={form.vatNumber ?? ""}
                onChange={set("vatNumber")}
                placeholder="3xxxxxxxxxxxxx3"
                maxLength={15}
                dir="ltr"
                pattern="3\d{13}3"
                title={t("companyProfile.vatHint", "15 رقم يبدأ وينتهي بالرقم 3")}
              />
            </div>
            <div>
              <Label>{t("companyProfile.crNumber", "رقم السجل التجاري")}</Label>
              <Input value={form.crNumber ?? ""} onChange={set("crNumber")} maxLength={15} dir="ltr" />
            </div>
            <div>
              <Label>{t("companyProfile.industry", "النشاط / الصناعة")}</Label>
              <Input value={form.industryName ?? ""} onChange={set("industryName")} />
            </div>
          </div>
        </section>

        <section className="rounded-lg border bg-card p-4 md:p-6 space-y-4">
          <h2 className="font-semibold text-lg">{t("companyProfile.address", "العنوان الوطني")}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>{t("companyProfile.country", "الدولة (رمز)")}</Label>
              <Input value={form.country ?? ""} onChange={set("country")} maxLength={2} placeholder="SA" dir="ltr" />
            </div>
            <div>
              <Label>{t("companyProfile.city", "المدينة")}</Label>
              <Input value={form.city ?? ""} onChange={set("city")} />
            </div>
            <div>
              <Label>{t("companyProfile.district", "الحي")}</Label>
              <Input value={form.district ?? ""} onChange={set("district")} />
            </div>
            <div>
              <Label>{t("companyProfile.street", "الشارع")}</Label>
              <Input value={form.street ?? ""} onChange={set("street")} />
            </div>
            <div>
              <Label>{t("companyProfile.buildingNumber", "رقم المبنى")}</Label>
              <Input value={form.buildingNumber ?? ""} onChange={set("buildingNumber")} maxLength={20} />
            </div>
            <div>
              <Label>{t("companyProfile.postalCode", "الرمز البريدي")}</Label>
              <Input value={form.postalCode ?? ""} onChange={set("postalCode")} maxLength={10} />
            </div>
            <div>
              <Label>{t("companyProfile.additionalNumber", "الرقم الإضافي")}</Label>
              <Input value={form.additionalNumber ?? ""} onChange={set("additionalNumber")} maxLength={20} />
            </div>
          </div>
        </section>

        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Loader2 className="ms-2 h-4 w-4 animate-spin" /> : <Save className="ms-2 h-4 w-4" />}
            {t("save", "حفظ")}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground border-t pt-3">
          {t("companyProfile.zatcaWarning",
            "تنبيه: تغيير الرقم الضريبي أو السجل التجاري بعد ربط شهادة ZATCA يتطلب إعادة إصدار الشهادة من شاشة ربط ZATCA.")}
        </p>
      </form>
    </div>
  );
}
