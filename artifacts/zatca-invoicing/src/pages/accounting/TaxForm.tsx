import { useState, useEffect, useMemo } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Percent, ArrowRight, Lock, Building2, Wallet, Settings2, ShieldCheck } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Tax = {
  id: number; companyId: number; code: string; nameAr: string; nameEn: string | null;
  rate: string; rateType: "percent" | "fixed"; currencyCode: string | null;
  branchId: number | null; costCenter: string | null;
  accountId: number | null; salesTaxAccountId: number | null; purchaseTaxAccountId: number | null;
  isActive: boolean; isDefault: boolean; isSystem: boolean; notes: string | null;
};

const EMPTY: any = {
  code: "", nameAr: "", nameEn: "", rate: "15", rateType: "percent",
  currencyCode: "", branchId: "", costCenter: "",
  accountId: "", salesTaxAccountId: "", purchaseTaxAccountId: "",
  isActive: true, isDefault: false, notes: "",
};

export default function TaxForm() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [matchNew] = useRoute("/accounting/taxes/new");
  const [, params] = useRoute("/accounting/taxes/:id");
  const isNew = !!matchNew;
  const editId = !isNew && params?.id ? Number(params.id) : null;

  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [form, setForm] = useState<any>(EMPTY);
  const [tab, setTab] = useState("basic");

  const { data: existing, isLoading } = useQuery<Tax>({
    queryKey: ["tax", editId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/taxes/${editId}${cid ? `?companyId=${cid}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error("تعذّر تحميل الضريبة");
      return r.json();
    },
    enabled: !!editId,
  });

  useEffect(() => {
    if (existing) {
      setForm({
        code: existing.code, nameAr: existing.nameAr, nameEn: existing.nameEn ?? "",
        rate: existing.rate, rateType: existing.rateType,
        currencyCode: existing.currencyCode ?? "", branchId: existing.branchId ? String(existing.branchId) : "",
        costCenter: existing.costCenter ?? "",
        accountId: existing.accountId ? String(existing.accountId) : "",
        salesTaxAccountId: existing.salesTaxAccountId ? String(existing.salesTaxAccountId) : "",
        purchaseTaxAccountId: existing.purchaseTaxAccountId ? String(existing.purchaseTaxAccountId) : "",
        isActive: existing.isActive, isDefault: existing.isDefault, notes: existing.notes ?? "",
      });
    }
  }, [existing]);

  const isSystem = !!existing?.isSystem;

  const { data: currencies = [] } = useQuery<any[]>({
    queryKey: ["currencies", cid],
    queryFn: () => fetch(`${API}/api/currencies${cid ? `?companyId=${cid}` : ""}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.ok ? r.json() : []),
    enabled: !!user,
  });
  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: () => fetch(`${API}/api/org/branches${cid ? `?companyId=${cid}` : ""}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.ok ? r.json() : []),
    enabled: !!user,
  });
  const { data: costCenters = [] } = useQuery<any[]>({
    queryKey: ["cost-centers", cid],
    queryFn: () => fetch(`${API}/api/cost-centers${cid ? `?companyId=${cid}` : ""}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.ok ? r.json() : []),
    enabled: !!user,
  });

  const currencyOptions = useMemo(() => ([
    { value: "", label: "— عملة الشركة الأساسية —" },
    ...currencies.map((c: any) => ({ value: c.code, label: `${c.code} — ${c.nameAr || c.nameEn || ""}` })),
  ]), [currencies]);
  const branchOptions = useMemo(() => ([
    { value: "", label: "— كل الفروع —" },
    ...branches.map((b: any) => ({ value: String(b.id), label: b.nameAr || b.nameEn || `فرع ${b.id}` })),
  ]), [branches]);
  const costCenterOptions = useMemo(() => ([
    { value: "", label: "— بدون مركز تكلفة —" },
    ...costCenters.map((c: any) => ({ value: String(c.code), label: `${c.code} — ${c.nameAr || c.nameEn || ""}` })),
  ]), [costCenters]);

  const saveMut = useMutation({
    mutationFn: async () => {
      const url = editId ? `${API}/api/taxes/${editId}` : `${API}/api/taxes`;
      const method = editId ? "PUT" : "POST";
      const body = JSON.stringify({
        code: form.code, nameAr: form.nameAr, nameEn: form.nameEn || null,
        rate: form.rate, rateType: form.rateType,
        currencyCode: form.currencyCode || null,
        branchId: form.branchId ? Number(form.branchId) : null,
        costCenter: form.costCenter || null,
        accountId: form.accountId ? Number(form.accountId) : null,
        salesTaxAccountId: form.salesTaxAccountId ? Number(form.salesTaxAccountId) : null,
        purchaseTaxAccountId: form.purchaseTaxAccountId ? Number(form.purchaseTaxAccountId) : null,
        isActive: form.isActive, isDefault: form.isDefault, notes: form.notes || null,
      });
      const r = await fetch(url, { method, headers, body });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "تعذّر حفظ الضريبة");
      return d;
    },
    onSuccess: () => {
      toast({ title: editId ? "تم تحديث الضريبة" : "تم إنشاء الضريبة" });
      qc.invalidateQueries({ queryKey: ["taxes"] });
      qc.invalidateQueries({ queryKey: ["tax", editId] });
      navigate("/accounting/taxes");
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  if (editId && isLoading) {
    return <div className="space-y-3 max-w-3xl mx-auto"><Skeleton className="h-12 w-full" /><Skeleton className="h-64 w-full" /></div>;
  }

  const canSave = form.code.trim() && form.nameAr.trim() && !saveMut.isPending;

  return (
    <div className="max-w-3xl mx-auto">
      <FormPanel
        icon={Percent}
        title={
          <div className="flex items-center gap-2">
            {editId ? "تعديل الضريبة" : "ضريبة جديدة"}
            {isSystem && <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 gap-1"><ShieldCheck className="h-3 w-3" /> ضريبة النظام (زاتكا)</Badge>}
          </div>
        }
        subtitle="عرّف ضريبة ديناميكية تُطبَّق على المستندات والقيود"
        width="3xl"
        onClose={() => navigate("/accounting/taxes")}
        onSave={() => saveMut.mutate()}
        saving={saveMut.isPending}
        saveDisabled={!canSave}
        saveLabel="حفظ"
      >
        {isSystem && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            <Lock className="h-4 w-4 mt-0.5 shrink-0" />
            <span>هذه ضريبة النظام المخصّصة لهيئة الزكاة والضريبة والدخل. النسبة ونوعها مقفلان عند 15% للحفاظ على توافق زاتكا، ولا يمكن حذفها أو تعطيلها. يمكنك تعديل الأسماء والحسابات فقط.</span>
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="basic" className="gap-1.5"><Settings2 className="h-4 w-4" /> البيانات الأساسية</TabsTrigger>
            <TabsTrigger value="accounts" className="gap-1.5"><Wallet className="h-4 w-4" /> الحسابات</TabsTrigger>
            <TabsTrigger value="scope" className="gap-1.5"><Building2 className="h-4 w-4" /> النطاق</TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="mt-4">
            <FormGrid>
              <Field label="الكود" required>
                <Input value={form.code} dir="ltr" className="text-left font-mono"
                  onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))} />
              </Field>
              <Field label="الاسم بالعربية" required>
                <Input value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} />
              </Field>
              <Field label="الاسم بالإنجليزية">
                <Input dir="ltr" className="text-left" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
              </Field>
              <Field label="نوع الضريبة">
                <SearchCombobox
                  items={[{ value: "percent", label: "نسبة مئوية (%)" }, { value: "fixed", label: "قيمة ثابتة" }]}
                  value={form.rateType}
                  onValueChange={(v) => setForm((p: any) => ({ ...p, rateType: v }))}
                  disabled={isSystem}
                />
              </Field>
              <Field label={form.rateType === "fixed" ? "القيمة" : "النسبة %"} required>
                <Input type="number" step="0.01" min="0" dir="ltr" className="text-left" value={form.rate}
                  disabled={isSystem}
                  onChange={e => setForm((p: any) => ({ ...p, rate: e.target.value }))} />
              </Field>
              <Field label="ملاحظات" className="md:col-span-2">
                <Input value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
              </Field>
            </FormGrid>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/20">
                <div>
                  <Label className="text-xs font-semibold">مفعّلة</Label>
                  <p className="text-[11px] text-muted-foreground">تظهر للاختيار في المستندات والقيود</p>
                </div>
                <Switch checked={form.isActive} disabled={isSystem} onCheckedChange={(v: boolean) => setForm((p: any) => ({ ...p, isActive: v }))} />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/20">
                <div>
                  <Label className="text-xs font-semibold">الضريبة الافتراضية</Label>
                  <p className="text-[11px] text-muted-foreground">تُطبَّق تلقائياً على المستندات الجديدة</p>
                </div>
                <Switch checked={form.isDefault} onCheckedChange={(v: boolean) => setForm((p: any) => ({ ...p, isDefault: v }))} />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="accounts" className="mt-4">
            <FormGrid>
              <Field label="حساب الضريبة (عام)" className="md:col-span-2">
                <AccountCombobox value={form.accountId} onValueChange={(v) => setForm((p: any) => ({ ...p, accountId: v }))} />
              </Field>
              <Field label="حساب ضريبة المبيعات (مستحقة)">
                <AccountCombobox value={form.salesTaxAccountId} onValueChange={(v) => setForm((p: any) => ({ ...p, salesTaxAccountId: v }))} />
              </Field>
              <Field label="حساب ضريبة المشتريات (مدخلة)">
                <AccountCombobox value={form.purchaseTaxAccountId} onValueChange={(v) => setForm((p: any) => ({ ...p, purchaseTaxAccountId: v }))} />
              </Field>
            </FormGrid>
          </TabsContent>

          <TabsContent value="scope" className="mt-4">
            <FormGrid>
              <Field label="العملة">
                <SearchCombobox items={currencyOptions} value={form.currencyCode} onValueChange={(v) => setForm((p: any) => ({ ...p, currencyCode: v }))} />
              </Field>
              <Field label="الفرع">
                <SearchCombobox items={branchOptions} value={form.branchId} onValueChange={(v) => setForm((p: any) => ({ ...p, branchId: v }))} />
              </Field>
              <Field label="مركز التكلفة" className="md:col-span-2">
                <SearchCombobox items={costCenterOptions} value={form.costCenter} onValueChange={(v) => setForm((p: any) => ({ ...p, costCenter: v }))} />
              </Field>
            </FormGrid>
          </TabsContent>
        </Tabs>
      </FormPanel>

      <div className="max-w-3xl mx-auto mt-3 flex justify-start">
        <Button variant="ghost" onClick={() => navigate("/accounting/taxes")} className="gap-2">
          <ArrowRight className="h-4 w-4" /> العودة للقائمة
        </Button>
      </div>
    </div>
  );
}
