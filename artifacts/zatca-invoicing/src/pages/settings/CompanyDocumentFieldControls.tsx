import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, LockKeyhole, Save, ShieldCheck } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
type Scope =
  | "sales_invoice" | "purchase_invoice" | "sales_return" | "purchase_return"
  | "sales_quotation" | "sales_order" | "purchase_order" | "goods_receipt" | "delivery_note";
type Rule = { mode: "editable" | "readonly" | "hidden" | "required"; dateConstraint?: string };
type Bundle = Record<string, Record<string, Rule>>;
type Field = { key: string; labelAr: string; labelEn: string };
type SettingsResponse = { bundle: Bundle; catalogue: Record<string, Field[]> };

const MODES = [
  { value: "editable", label: "ظاهر وقابل للتعديل" },
  { value: "readonly", label: "للقراءة فقط" },
  { value: "hidden", label: "مخفي" },
] as const;

const DOCUMENTS: { scope: Scope; label: string }[] = [
  { scope: "sales_invoice", label: "فاتورة مبيعات" },
  { scope: "purchase_invoice", label: "فاتورة مشتريات" },
  { scope: "sales_return", label: "مرتجع مبيعات" },
  { scope: "purchase_return", label: "مرتجع مشتريات" },
  { scope: "sales_quotation", label: "عرض سعر" },
  { scope: "sales_order", label: "أمر بيع" },
  { scope: "purchase_order", label: "أمر شراء" },
  { scope: "goods_receipt", label: "استلام بضاعة" },
  { scope: "delivery_note", label: "تسليم بضاعة" },
];

export default function CompanyDocumentFieldControls() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const query = useQuery<SettingsResponse>({
    queryKey: ["company-document-field-controls"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/invoice-field-policies/company-default`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? "تعذّر تحميل إعدادات الحقول");
      return body;
    },
    enabled: !!token,
    staleTime: 0,
  });
  useEffect(() => {
    if (query.data) setBundle(query.data.bundle);
  }, [query.data]);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/invoice-field-policies/company-default`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ bundle }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? "تعذّر حفظ إعدادات الحقول");
      return body as { bundle: Bundle };
    },
    onSuccess: async (result) => {
      setBundle(result.bundle);
      await qc.invalidateQueries({ queryKey: ["invoice-field-policies", "me"] });
      toast({ title: "تم حفظ إعدادات الحقول لجميع مستخدمي الشركة" });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  function setMode(scope: Scope, key: string, mode: Rule["mode"]) {
    setBundle((current) => current ? {
      ...current,
      [scope]: { ...current[scope], [key]: { ...current[scope]?.[key], mode } },
    } : current);
  }

  if (query.isError) {
    return <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      {(query.error as Error).message}
    </div>;
  }
  if (query.isLoading || !bundle) {
    return <div className="flex items-center justify-center rounded-xl border p-10"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  const renderScope = (scope: Scope) => {
    const fields = query.data?.catalogue?.[scope] ?? [];
    return (
      <div className="space-y-2">
        {fields.map((field) => {
          const mode = bundle[scope]?.[field.key]?.mode ?? (field.key === "taxRate" ? "readonly" : "editable");
          return (
            <div key={field.key} className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">{field.labelAr}</p>
                <p className="text-xs text-muted-foreground" dir="ltr">{field.labelEn}</p>
              </div>
              <select
                aria-label={`حالة الحقل: ${field.labelAr}`}
                className="h-9 min-w-48 rounded-md border bg-background px-3 text-sm"
                value={mode === "required" ? "editable" : mode}
                onChange={(e) => setMode(scope, field.key, e.target.value as Rule["mode"])}
              >
                {MODES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-5" dir="rtl">
      <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900 dark:bg-amber-950/20">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-amber-700" />
          <div>
            <h2 className="font-semibold">التحكم في حقول المستندات</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              هذه الإعدادات تسري على جميع مستخدمي الشركة، بمن فيهم المدير. نسبة الضريبة في سطر الصنف للقراءة فقط افتراضيًا.
            </p>
          </div>
        </div>
      </div>
      <Tabs defaultValue="sales_invoice" dir="rtl">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-3">
          {DOCUMENTS.map((document) => (
            <TabsTrigger key={document.scope} value={document.scope}>{document.label}</TabsTrigger>
          ))}
        </TabsList>
        {DOCUMENTS.map((document) => (
          <TabsContent key={document.scope} value={document.scope} className="mt-4">
            {renderScope(document.scope)}
          </TabsContent>
        ))}
      </Tabs>
      <div className="flex items-center justify-between border-t pt-4">
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><LockKeyhole className="h-4 w-4" />يتطلب تعديل هذه الإعدادات تفعيل الميزة من السوبر أدمن.</p>
        <Button onClick={() => save.mutate()} disabled={save.isPending || query.isLoading}>
          {save.isPending ? <Loader2 className="ms-2 h-4 w-4 animate-spin" /> : <Save className="ms-2 h-4 w-4" />}
          حفظ الإعدادات
        </Button>
      </div>
    </div>
  );
}
