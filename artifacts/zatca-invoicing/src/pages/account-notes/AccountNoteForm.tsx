import { useEffect, useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { FileText, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { useToast } from "@/hooks/use-toast";
import { accountNotesApi, type AccountNotePartyType, type AccountNoteType } from "@/lib/accountNotesApi";
import { useCostCenters } from "@/hooks/useCostCenters";
import { DateField } from "@/components/ui/date-field";

interface Props {
  partyType: AccountNotePartyType;
  noteType:  AccountNoteType;
}

const TITLES: Record<string, string> = {
  "customer.credit": "إشعار دائن - عميل",
  "customer.debit":  "إشعار مدين - عميل",
  "supplier.credit": "إشعار دائن - مورد",
  "supplier.debit":  "إشعار مدين - مورد",
};

const ROUTE_BASE: Record<string, string> = {
  "customer.credit": "/sales/customer-credit-notes",
  "customer.debit":  "/sales/customer-debit-notes",
  "supplier.credit": "/purchasing/supplier-credit-notes",
  "supplier.debit":  "/purchasing/supplier-debit-notes",
};

// Hint about which contra account to pick — purely informational.
const CONTRA_HINTS: Record<string, string> = {
  "customer.credit": "مثال: خصم مسموح به / مصروف / مردودات مبيعات",
  "customer.debit":  "مثال: إيرادات أخرى / غرامات تأخير",
  "supplier.credit": "مثال: خصم مكتسب / مردودات مشتريات",
  "supplier.debit":  "مثال: مصاريف إضافية / غرامات",
};

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  const acting = localStorage.getItem("zatca_acting_company_id");
  const h: Record<string, string> = {};
  if (t) h["Authorization"] = `Bearer ${t}`;
  if (acting) h["x-acting-company-id"] = acting;
  return h;
}
async function fetchJson(path: string) {
  const r = await fetch(import.meta.env.BASE_URL.replace(/\/$/, "") + path, { headers: authHeaders() });
  if (!r.ok) return [];
  return r.json();
}

export default function AccountNoteForm({ partyType, noteType }: Props) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const key = `${partyType}.${noteType}`;
  const base = ROUTE_BASE[key];
  const [, params] = useRoute(`${base}/:id`);
  const editingId = params?.id && params.id !== "new" ? Number(params.id) : null;

  const [form, setForm] = useState<any>({
    noteDate: new Date().toISOString().slice(0, 10),
    partyId: "",
    partyAccountId: "",
    contraAccountId: "",
    amount: "",
    vatEnabled: false,
    vatRate: "15",
    vatAccountId: "",
    description: "",
    notes: "",
    operationNumber: "",
    referenceNumber: "",
    referenceDate: "",
    costCenter: "",
    projectId: "",
  });

  const partiesPath = partyType === "customer" ? "/api/customers" : "/api/suppliers";
  const { data: parties = [] } = useQuery<any[]>({ queryKey: [partiesPath], queryFn: () => fetchJson(partiesPath) });
  const { data: costCenters = [] } = useCostCenters();
  const { data: projects = [] } = useQuery<any[]>({
    queryKey: ["/api/contracting/projects"],
    queryFn: () => fetchJson("/api/contracting/projects"),
  });

  // Load existing for edit mode.
  useQuery({
    queryKey: ["account-note", editingId],
    enabled: !!editingId,
    queryFn: async () => {
      const n = await accountNotesApi.get(editingId!);
      setForm({
        noteDate: n.noteDate,
        partyId: String(n.partyId),
        partyAccountId: String(n.partyAccountId),
        contraAccountId: String(n.contraAccountId),
        amount: String(Number(n.amount)),
        vatEnabled: n.vatEnabled,
        vatRate: String(Number(n.vatRate)),
        vatAccountId: n.vatAccountId ? String(n.vatAccountId) : "",
        description: n.description ?? "",
        notes: n.notes ?? "",
        operationNumber: n.operationNumber ?? "",
        referenceNumber: n.referenceNumber ?? "",
        referenceDate:   n.referenceDate   ?? "",
        costCenter:      n.costCenter      ?? "",
        projectId:       n.projectId ? String(n.projectId) : "",
      });
      return n;
    },
  });

  // When party changes, auto-fill partyAccountId from the party row.
  useEffect(() => {
    if (!form.partyId || form.partyAccountId) return;
    const p = (parties as any[]).find((x: any) => String(x.id) === String(form.partyId));
    if (p?.accountId) setForm((f: any) => ({ ...f, partyAccountId: String(p.accountId) }));
  }, [form.partyId, parties]); // eslint-disable-line react-hooks/exhaustive-deps

  const amount    = Number(form.amount || 0);
  const vatAmount = form.vatEnabled ? +(amount * Number(form.vatRate || 0) / 100).toFixed(2) : 0;
  const total     = +(amount + vatAmount).toFixed(2);

  const saveMut = useMutation({
    mutationFn: async (postAfter: boolean) => {
      const body: any = {
        partyType, noteType,
        noteDate: form.noteDate,
        partyId: Number(form.partyId),
        partyAccountId: Number(form.partyAccountId),
        contraAccountId: Number(form.contraAccountId),
        amount: form.amount,
        vatEnabled: !!form.vatEnabled,
        vatRate: form.vatRate,
        vatAccountId: form.vatEnabled ? Number(form.vatAccountId) : null,
        description: form.description || null,
        notes: form.notes || null,
        operationNumber: form.operationNumber || null,
        referenceNumber: form.referenceNumber || null,
        referenceDate:   form.referenceDate   || null,
        costCenter:      form.costCenter      || null,
        projectId:       form.projectId ? Number(form.projectId) : null,
      };
      let id = editingId;
      if (editingId) {
        await accountNotesApi.update(editingId, body);
      } else {
        const created = await accountNotesApi.create(body);
        id = created.id;
      }
      if (postAfter && id) await accountNotesApi.post(id);
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["account-notes", partyType, noteType] });
      toast({ title: "تم الحفظ" });
      setLocation(base);
    },
    onError: (e: any) => toast({ title: "خطأ", description: String(e?.message || e), variant: "destructive" }),
  });

  function validate(): string | null {
    if (!form.partyId)         return "اختر الطرف";
    if (!form.partyAccountId)  return "حدّد حساب الذمم للطرف";
    if (!form.contraAccountId) return "حدّد الحساب المقابل";
    if (!(Number(form.amount) > 0)) return "أدخل مبلغاً صحيحاً";
    if (form.vatEnabled && !form.vatAccountId) return "حدّد حساب ضريبة القيمة المضافة";
    return null;
  }

  function submit(e: React.FormEvent, postAfter: boolean) {
    e.preventDefault();
    const err = validate();
    if (err) { toast({ title: err, variant: "destructive" }); return; }
    saveMut.mutate(postAfter);
  }

  const partyLabel = partyType === "customer" ? "العميل" : "المورد";
  const selectedParty = useMemo(
    () => (parties as any[]).find((p: any) => String(p.id) === String(form.partyId)),
    [parties, form.partyId],
  );
  const partyAccountFilter = useMemo(
    () => partyType === "customer" ? ["asset"] : ["liability"],
    [partyType]
  );
  const contraTypeFilter = useMemo(() => {
    if (partyType === "customer" && noteType === "credit") return ["expense", "revenue"];
    if (partyType === "customer" && noteType === "debit")  return ["revenue"];
    if (partyType === "supplier" && noteType === "credit") return ["revenue", "expense"];
    return ["expense"];
  }, [partyType, noteType]);

  return (
    <form onSubmit={(e) => submit(e, false)} className="p-6 space-y-4">
      <h1 className="text-xl font-bold flex items-center gap-2"><FileText className="h-5 w-5" /> {TITLES[key]}</h1>

      {/* 3-column grid — each field gets a labelled cell, naturally ~1/3
          screen wide on desktop. البيان/ملاحظات span the full row. The
          same form drives all 4 إشعارات routes (customer/supplier ×
          credit/debit), so this layout applies everywhere. */}
      <Card><CardContent className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4 pt-6">
        <label className="flex flex-col gap-1"><span className="text-sm font-medium">التاريخ *</span>
          <DateField value={form.noteDate}
            onChange={e => setForm({ ...form, noteDate: e.target.value })} data-testid="input-date" />
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">{partyLabel} *</span>
          <select className="w-full border rounded h-9 px-2 bg-background" value={form.partyId}
            onChange={e => setForm({ ...form, partyId: e.target.value, partyAccountId: "" })}
            data-testid="select-party">
            <option value="">اختر…</option>
            {(parties as any[]).filter((p: any) => p.isActive !== false).map((p: any) =>
              <option key={p.id} value={p.id}>{p.nameAr}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">الرقم الضريبي للطرف</span>
          {/* Auto-derived from the chosen party; read-only display. */}
          <Input value={selectedParty?.vatNumber ?? ""} readOnly disabled
            className="bg-muted/40"
            placeholder="—" data-testid="display-party-vat" />
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">رقم العملية</span>
          <Input value={form.operationNumber}
            onChange={e => setForm({ ...form, operationNumber: e.target.value })}
            data-testid="input-operation-number" />
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">حساب ذمم {partyLabel} *</span>
          <AccountCombobox
            value={form.partyAccountId ? String(form.partyAccountId) : undefined}
            onValueChange={(v) => setForm({ ...form, partyAccountId: v })}
            filterTypes={partyAccountFilter as any}
            placeholder="ابحث عن الحساب…"
            data-testid="select-party-account"
          />
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">الحساب المقابل *</span>
          <AccountCombobox
            value={form.contraAccountId ? String(form.contraAccountId) : undefined}
            onValueChange={(v) => setForm({ ...form, contraAccountId: v })}
            filterTypes={contraTypeFilter as any}
            placeholder="ابحث عن الحساب…"
            data-testid="select-contra-account"
          />
          <span className="text-xs text-muted-foreground">{CONTRA_HINTS[key]}</span>
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">المبلغ (قبل الضريبة) *</span>
          <Input type="number" min="0" step="0.01" value={form.amount}
            onChange={e => setForm({ ...form, amount: e.target.value })}
            data-testid="input-amount" />
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">رقم المرجع</span>
          <Input value={form.referenceNumber}
            onChange={e => setForm({ ...form, referenceNumber: e.target.value })}
            data-testid="input-reference-number" />
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">تاريخ المرجع</span>
          <DateField value={form.referenceDate}
            onChange={e => setForm({ ...form, referenceDate: e.target.value })}
            data-testid="input-reference-date" />
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">مركز التكلفة</span>
          <select className="w-full border rounded h-9 px-2 bg-background"
            value={form.costCenter}
            onChange={e => setForm({ ...form, costCenter: e.target.value })}
            data-testid="select-cost-center">
            <option value="">— الرجاء الاختيار —</option>
            {(costCenters as any[]).map((c: any) =>
              <option key={c.id} value={c.code}>{c.code} — {c.nameAr}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">المشروع</span>
          <select className="w-full border rounded h-9 px-2 bg-background"
            value={form.projectId}
            onChange={e => setForm({ ...form, projectId: e.target.value })}
            data-testid="select-project">
            <option value="">— الرجاء الاختيار —</option>
            {(projects as any[]).filter((p: any) => p.isActive !== false).map((p: any) =>
              <option key={p.id} value={p.id}>{p.nameAr ?? p.name ?? `#${p.id}`}</option>)}
          </select>
        </label>

        <label className="flex items-center gap-2 mt-2 md:col-start-1">
          <Checkbox checked={form.vatEnabled}
            onCheckedChange={(v) => setForm({ ...form, vatEnabled: !!v })}
            data-testid="checkbox-vat" />
          <span className="text-sm font-medium">يشمل ضريبة القيمة المضافة</span>
        </label>

        {form.vatEnabled && (
          <>
            <label className="flex flex-col gap-1"><span className="text-sm font-medium">نسبة الضريبة %</span>
              <Input type="number" min="0" step="0.01" value={form.vatRate}
                onChange={e => setForm({ ...form, vatRate: e.target.value })}
                data-testid="input-vat-rate" />
            </label>
            <label className="flex flex-col gap-1"><span className="text-sm font-medium">حساب ضريبة القيمة المضافة *</span>
              <AccountCombobox
                value={form.vatAccountId ? String(form.vatAccountId) : undefined}
                onValueChange={(v) => setForm({ ...form, vatAccountId: v })}
                filterTypes={["liability", "asset"]}
                placeholder="ابحث عن حساب الضريبة…"
                data-testid="select-vat-account"
              />
            </label>
          </>
        )}

        <label className="md:col-span-3 flex flex-col gap-1"><span className="text-sm font-medium">البيان</span>
          <Input value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            data-testid="input-description" />
        </label>

        <label className="md:col-span-3 flex flex-col gap-1"><span className="text-sm font-medium">ملاحظات</span>
          <Input value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })}
            data-testid="input-notes" />
        </label>
      </CardContent></Card>

      <Card><CardContent className="grid grid-cols-3 gap-4 pt-6 text-center">
        <div><div className="text-xs text-muted-foreground">المبلغ</div><div className="text-lg font-semibold">{amount.toFixed(2)}</div></div>
        <div><div className="text-xs text-muted-foreground">الضريبة</div><div className="text-lg font-semibold">{vatAmount.toFixed(2)}</div></div>
        <div><div className="text-xs text-muted-foreground">الإجمالي</div><div className="text-lg font-bold text-primary" data-testid="total-amount">{total.toFixed(2)}</div></div>
      </CardContent></Card>

      <div className="flex gap-2">
        <Button type="submit" variant="outline" disabled={saveMut.isPending} data-testid="btn-save-draft">
          <Save className="h-4 w-4 ml-1" /> حفظ كمسودة
        </Button>
        <Button type="button" disabled={saveMut.isPending}
          onClick={(e) => submit(e as any, true)}
          data-testid="btn-save-post">
          <Save className="h-4 w-4 ml-1" /> حفظ وترحيل
        </Button>
        <Button type="button" variant="ghost" onClick={() => setLocation(base)}>إلغاء</Button>
      </div>
    </form>
  );
}
