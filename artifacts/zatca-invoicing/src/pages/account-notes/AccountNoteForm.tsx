import { useEffect, useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { FileText, Save, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { AccountCombobox } from "@/components/AccountCombobox";
import { SearchCombobox, type ComboboxItem } from "@/components/ui/search-combobox";
import { useToast } from "@/hooks/use-toast";
import { accountNotesApi, type AccountNote, type AccountNotePartyType, type AccountNoteType } from "@/lib/accountNotesApi";
import { printAccountNote } from "@/lib/accountNotePrint";
import { useCostCenters } from "@/hooks/useCostCenters";
import { DateField } from "@/components/ui/date-field";
import { useAuth } from "@/contexts/AuthContext";
import { fmt2 } from "@/lib/format";

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
  const { user } = useAuth() as any;
  const qc = useQueryClient();
  const key = `${partyType}.${noteType}`;
  const base = ROUTE_BASE[key];
  const [, params] = useRoute(`${base}/:id`);
  const editingId = params?.id && params.id !== "new" ? Number(params.id) : null;
  // Full persisted note (edit mode) — needed for printing (number/status/JE).
  const [existing, setExisting] = useState<AccountNote | null>(null);
  // Guards the one-time defaults auto-fill so it never fights manual edits.
  const autoFilledRef = useRef(false);

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
  // Invoices of the SELECTED party — powers the invoice-number picker so the
  // user references an ACTUAL linked invoice instead of typing it by hand.
  const invoicesPath = partyType === "customer"
    ? "/api/sales/sales-invoices"
    : "/api/purchasing/purchase-invoices";
  const { data: partyInvoices = [] } = useQuery<any[]>({
    queryKey: [invoicesPath],
    enabled: !!form.partyId,
    queryFn: () => fetchJson(invoicesPath),
    staleTime: 30_000,
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
      setExisting(n);
      return n;
    },
  });

  // When party changes, auto-fill partyAccountId from the party row.
  useEffect(() => {
    if (!form.partyId || form.partyAccountId) return;
    const p = (parties as any[]).find((x: any) => String(x.id) === String(form.partyId));
    if (p?.accountId) setForm((f: any) => ({ ...f, partyAccountId: String(p.accountId) }));
  }, [form.partyId, parties]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-fill contra + VAT accounts on a NEW note ──────────────────
  // Pulls the company's mapped revenue/VAT accounts so the note posts to
  // the SAME accounts as its sales/purchase invoices. Runs once, only fills
  // EMPTY fields (never overrides manual edits), and skips the contra when
  // its account type isn't selectable in this route's picker (else it would
  // display blank — see AccountCombobox filterTypes).
  const { data: defaults } = useQuery({
    queryKey: ["account-note-defaults", partyType, noteType],
    enabled: !editingId,
    staleTime: 60_000,
    queryFn: () => accountNotesApi.defaults(partyType, noteType),
  });
  useEffect(() => {
    if (editingId || !defaults || autoFilledRef.current) return;
    autoFilledRef.current = true;
    setForm((f: any) => {
      const next = { ...f };
      if (!f.contraAccountId && defaults.contraAccountId &&
          defaults.contraAccountType && contraTypeFilter.includes(defaults.contraAccountType)) {
        next.contraAccountId = String(defaults.contraAccountId);
      }
      if (defaults.vatAccountId && !f.vatAccountId) {
        next.vatAccountId = String(defaults.vatAccountId);
        if (!f.vatEnabled) next.vatEnabled = true;
      }
      return next;
    });
  }, [defaults, editingId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Searchable-dropdown item lists (system-wide SearchCombobox pattern) ──
  const partyItems: ComboboxItem[] = useMemo(
    () => (parties as any[])
      .filter((p: any) => p.isActive !== false)
      .map((p: any) => ({
        value: String(p.id),
        label: p.nameAr ?? p.nameEn ?? `#${p.id}`,
        code: p.code ?? undefined,
      })),
    [parties],
  );
  // Optional fields carry an explicit empty row so a value can be cleared back
  // to blank in edit mode (SearchCombobox has no built-in clear affordance).
  const costCenterItems: ComboboxItem[] = useMemo(
    () => [
      { value: "", label: "— بدون —" },
      ...(costCenters as any[]).map((c: any) => ({
        value: c.code, label: `${c.code} — ${c.nameAr}`, code: c.code,
      })),
    ],
    [costCenters],
  );
  const projectItems: ComboboxItem[] = useMemo(
    () => [
      { value: "", label: "— بدون —" },
      ...(projects as any[])
        .filter((p: any) => p.isActive !== false)
        .map((p: any) => ({ value: String(p.id), label: p.nameAr ?? p.name ?? `#${p.id}` })),
    ],
    [projects],
  );
  // Invoice picker items — only the chosen party's real, non-cancelled invoices.
  const invoicePartyKey = partyType === "customer" ? "customerId" : "supplierId";
  const invoiceItems: ComboboxItem[] = useMemo(() => {
    const pid = String(form.partyId);
    const list: ComboboxItem[] = pid
      ? [
          { value: "", label: "— بدون —" },
          ...(partyInvoices as any[])
            .filter((inv: any) => String(inv[invoicePartyKey]) === pid && inv.status !== "cancelled")
            .map((inv: any) => ({
              value: inv.docNumber ?? String(inv.id),
              label: inv.docNumber ?? `#${inv.id}`,
              description: `${String(inv.invoiceDate ?? "").slice(0, 10)} — ${fmt2(inv.totalAmount ?? 0)}`,
            })),
        ]
      : [];
    // EDIT mode only: keep a manually-stored legacy reference visible even when
    // it isn't among the party's current invoices. Create mode always holds a
    // freshly-picked real invoice, and changing the party clears the reference,
    // so no stale cross-party value can survive here.
    if (editingId && form.referenceNumber && !list.some((i) => i.value === form.referenceNumber)) {
      list.push({ value: form.referenceNumber, label: form.referenceNumber });
    }
    return list;
  }, [partyInvoices, form.partyId, form.referenceNumber, invoicePartyKey, editingId]);

  // ── Print the persisted note (sales-invoice-style A4, no item lines) ──
  function printNote() {
    if (!existing) return;
    printAccountNote({
      note: existing,
      party: selectedParty ?? null,
      company: user?.company ?? {},
      partyLabel,
      preparedBy: (existing as any).createdByName ?? user?.username ?? null,
      onError: (msg) => toast({ title: msg, variant: "destructive" }),
    });
  }

  return (
    <form onSubmit={(e) => submit(e, false)} className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2"><FileText className="h-5 w-5" /> {TITLES[key]}</h1>
        {editingId && existing && (
          <Button type="button" variant="outline" size="sm" onClick={printNote} data-testid="button-print">
            <Printer className="h-4 w-4 ms-1" /> طباعة
          </Button>
        )}
      </div>

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
          <div data-testid="select-party">
            <SearchCombobox
              items={partyItems}
              value={form.partyId || undefined}
              onValueChange={(v) => setForm({ ...form, partyId: v, partyAccountId: "", referenceNumber: "", referenceDate: "" })}
              placeholder={`اختر ${partyLabel}…`}
              searchPlaceholder="ابحث بالاسم أو الكود…"
            />
          </div>
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

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">{partyType === "customer" ? "رقم فاتورة المبيعات" : "رقم فاتورة المشتريات"}</span>
          <div data-testid="input-reference-number">
            <SearchCombobox
              items={invoiceItems}
              value={form.referenceNumber || undefined}
              onValueChange={(v) => {
                const inv = (partyInvoices as any[]).find((x: any) => (x.docNumber ?? String(x.id)) === v);
                setForm((f: any) => ({
                  ...f,
                  referenceNumber: v,
                  referenceDate: inv?.invoiceDate ? String(inv.invoiceDate).slice(0, 10) : f.referenceDate,
                }));
              }}
              disabled={!form.partyId}
              placeholder={form.partyId ? "اختر الفاتورة…" : "اختر الطرف أولاً"}
              searchPlaceholder="ابحث برقم الفاتورة…"
              emptyText="لا توجد فواتير لهذا الطرف"
            />
          </div>
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">تاريخ المرجع</span>
          <DateField value={form.referenceDate}
            onChange={e => setForm({ ...form, referenceDate: e.target.value })}
            data-testid="input-reference-date" />
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">مركز التكلفة</span>
          <div data-testid="select-cost-center">
            <SearchCombobox
              items={costCenterItems}
              value={form.costCenter || undefined}
              onValueChange={(v) => setForm({ ...form, costCenter: v })}
              placeholder="— الرجاء الاختيار —"
              searchPlaceholder="ابحث…"
            />
          </div>
        </label>

        <label className="flex flex-col gap-1"><span className="text-sm font-medium">المشروع</span>
          <div data-testid="select-project">
            <SearchCombobox
              items={projectItems}
              value={form.projectId || undefined}
              onValueChange={(v) => setForm({ ...form, projectId: v })}
              placeholder="— الرجاء الاختيار —"
              searchPlaceholder="ابحث…"
            />
          </div>
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
        <div><div className="text-xs text-muted-foreground">المبلغ</div><div className="text-lg font-semibold">{fmt2(amount)}</div></div>
        <div><div className="text-xs text-muted-foreground">الضريبة</div><div className="text-lg font-semibold">{fmt2(vatAmount)}</div></div>
        <div><div className="text-xs text-muted-foreground">الإجمالي</div><div className="text-lg font-bold text-primary" data-testid="total-amount">{fmt2(total)}</div></div>
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
