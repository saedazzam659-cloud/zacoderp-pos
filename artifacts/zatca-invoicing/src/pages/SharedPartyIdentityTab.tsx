import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

type PartyRow = { id: number; nameAr: string; code?: string | null; partyIdentityId?: number | null };

async function requestJson(url: string, token: string | null, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || "تعذر إتمام الطلب");
  return body;
}

function rowsFrom(value: any): PartyRow[] {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.rows) ? value.rows : [];
  return rows.filter((row: any) => Number.isInteger(Number(row?.id)) && row?.nameAr);
}

export function SharedPartyIdentityTab({ companyId, token }: { companyId: number; token: string | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [customerId, setCustomerId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const apiBase = import.meta.env.BASE_URL.replace(/\/$/, "");
  const settingsKey = ["party-identity-settings", companyId];
  const settings = useQuery({
    queryKey: settingsKey,
    enabled: companyId > 0,
    queryFn: () => requestJson(`${apiBase}/api/companies/${companyId}/party-identity-settings`, token),
  });
  const customers = useQuery({
    queryKey: ["party-identity-customers", companyId],
    enabled: companyId > 0 && settings.data?.enabled === true,
    queryFn: async () => rowsFrom(await requestJson(`${apiBase}/api/customers?companyId=${companyId}`, token)),
  });
  const suppliers = useQuery({
    queryKey: ["party-identity-suppliers", companyId],
    enabled: companyId > 0 && settings.data?.enabled === true,
    queryFn: async () => rowsFrom(await requestJson(`${apiBase}/api/suppliers?companyId=${companyId}`, token)),
  });
  const identities = useQuery({
    queryKey: ["party-identities", companyId],
    enabled: companyId > 0 && settings.data?.enabled === true,
    queryFn: async () => rowsFrom(await requestJson(`${apiBase}/api/customers/party-identities?companyId=${companyId}`, token)),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => requestJson(`${apiBase}/api/companies/${companyId}/party-identity-settings`, token, {
      method: "PUT", body: JSON.stringify({ enabled }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
    onError: (error: Error) => toast({ title: error.message, variant: "destructive" }),
  });
  const link = useMutation({
    mutationFn: () => requestJson(`${apiBase}/api/customers/link-party-identity`, token, {
      method: "POST",
      body: JSON.stringify({ companyId, customerId: Number(customerId), supplierId: Number(supplierId) }),
    }),
    onSuccess: async () => {
      setCustomerId("");
      setSupplierId("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["party-identities", companyId] }),
        queryClient.invalidateQueries({ queryKey: ["party-identity-customers", companyId] }),
        queryClient.invalidateQueries({ queryKey: ["party-identity-suppliers", companyId] }),
      ]);
      toast({ title: "تم ربط السجلين بهوية مشتركة دون تغيير بياناتهما" });
    },
    onError: (error: Error) => toast({ title: error.message, variant: "destructive" }),
  });
  const enabled = settings.data?.enabled === true;

  return (
    <section className="space-y-5 rounded-xl border bg-card p-5" dir="rtl">
      <div>
        <h2 className="text-lg font-semibold">هوية العميل والمورد</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          ربط اختياري لسجل العميل بسجل المورد لنفس الجهة. لا يغيّر الربط أرقام السجلات أو حساباتها أو أرصدتها أو مستنداتها السابقة.
        </p>
      </div>
      {settings.isLoading ? <p className="text-sm text-muted-foreground">جارٍ تحميل الإعداد…</p> : (
        <label className="flex items-start gap-3 rounded-lg border p-4">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-primary"
            data-testid="input-enable-party-identity"
            checked={enabled}
            disabled={toggle.isPending}
            onChange={(event) => toggle.mutate(event.target.checked)}
          />
          <span>
            <span className="block font-medium">تفعيل إدارة الهوية المشتركة</span>
            <span className="mt-1 block text-sm text-muted-foreground">مغلق افتراضيًا. عند التفعيل يظهر الربط اليدوي بين سجلات العملاء والموردين.</span>
          </span>
        </label>
      )}
      {enabled && (
        <div className="space-y-5 border-t pt-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="shared-party-customer">سجل العميل</Label>
              <select id="shared-party-customer" data-testid="select-shared-party-customer" className="h-10 w-full rounded-md border bg-background px-3"
                value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
                <option value="">اختر عميلًا</option>
                {(customers.data ?? []).filter(row => !row.partyIdentityId).map(row =>
                  <option key={row.id} value={row.id}>{row.nameAr} — #{row.id}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="shared-party-supplier">سجل المورد</Label>
              <select id="shared-party-supplier" data-testid="select-shared-party-supplier" className="h-10 w-full rounded-md border bg-background px-3"
                value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
                <option value="">اختر موردًا</option>
                {(suppliers.data ?? []).filter(row => !row.partyIdentityId).map(row =>
                  <option key={row.id} value={row.id}>{row.nameAr} — #{row.id}</option>)}
              </select>
            </div>
          </div>
          <Button data-testid="button-link-party-identity" disabled={!customerId || !supplierId || link.isPending} onClick={() => link.mutate()}>
            {link.isPending ? "جارٍ الربط…" : "ربط السجلين"}
          </Button>
          <div className="space-y-2">
            <h3 className="font-medium">الهويات المرتبطة</h3>
            {identities.isLoading ? <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>
              : (identities.data?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">لا توجد روابط بعد.</p>
              : <ul className="space-y-2 text-sm">{identities.data!.map((row: any) =>
                <li key={row.id} data-testid={`row-party-identity-${row.id}`} className="rounded-md bg-muted/40 px-3 py-2">
                  {row.code} — {row.nameAr} — عميل #{row.customerId ?? "—"} / مورد #{row.supplierId ?? "—"}
                </li>)}</ul>}
          </div>
        </div>
      )}
    </section>
  );
}
