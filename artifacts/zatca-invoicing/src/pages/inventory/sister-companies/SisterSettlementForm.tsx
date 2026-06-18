import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { Wallet, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { sisterCompaniesApi } from "@/lib/sisterCompaniesApi";
import { branchesApi } from "@/lib/branchesApi";
import { DateField } from "@/components/ui/date-field";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders(): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  return t ? { Authorization: `Bearer ${t}` } : {};
}
async function fetchJson(path: string) {
  const r = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (!r.ok) return [];
  return r.json();
}

export default function SisterSettlementForm() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Edit mode: /inventory/sister-settlements/:id (draft-only).
  const [matchEdit, editParams] = useRoute("/inventory/sister-settlements/:id");
  const editId = matchEdit ? Number(editParams?.id) : null;

  const url = new URL(window.location.href);
  const presetSisterId = url.searchParams.get("sisterId") ?? "";

  const [form, setForm] = useState<any>({
    sisterCompanyId: presetSisterId,
    branchId: "",
    date: new Date().toISOString().slice(0, 10),
    direction: "receive",
    paymentType: "cash",
    cashBoxId: "",
    bankAccountId: "",
    amount: "",
    description: "",
  });

  const { data: sisters = [] } = useQuery({ queryKey: ["sister-companies"], queryFn: () => sisterCompaniesApi.list() });
  const { data: branches = [] } = useQuery({ queryKey: ["branches"], queryFn: () => branchesApi.getBranches() });
  const { data: cashBoxes = [] } = useQuery({ queryKey: ["cash-boxes"], queryFn: () => fetchJson("/api/cash-boxes") });
  const { data: banks     = [] } = useQuery({ queryKey: ["bank-accounts"], queryFn: () => fetchJson("/api/bank-accounts") });

  // Edit mode: load the existing (draft) settlement.
  const { data: existing } = useQuery({
    queryKey: ["sister-settlement-detail", editId],
    queryFn: () => sisterCompaniesApi.getSettlement(editId!),
    enabled: !!editId,
  });
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!existing || loadedRef.current) return;
    const e: any = existing;
    setForm({
      sisterCompanyId: String(e.sisterCompanyId),
      branchId: e.branchId != null ? String(e.branchId) : "",
      date: e.date,
      direction: e.direction,
      paymentType: e.paymentType,
      cashBoxId: e.cashBoxId != null ? String(e.cashBoxId) : "",
      bankAccountId: e.bankAccountId != null ? String(e.bankAccountId) : "",
      amount: String(e.amount),
      description: e.description ?? "",
    });
    loadedRef.current = true;
  }, [existing]);

  // Auto-pick the main branch ONCE for a new doc; user may clear it (NULL = shared).
  // Skipped in edit mode (the loaded record already carries its branch).
  const branchDefaultedRef = useRef(false);
  useEffect(() => {
    if (editId || branchDefaultedRef.current || form.branchId) return;
    const def = (branches as any[]).find((b: any) => b.isMain) ?? (branches as any[])[0];
    if (!def) return;
    setForm((p: any) => ({ ...p, branchId: String(def.id) }));
    branchDefaultedRef.current = true;
  }, [branches, form.branchId, editId]);

  const createMut = useMutation({
    mutationFn: async (body: any) => {
      const id = editId
        ? (await sisterCompaniesApi.updateSettlement(editId, body), editId)
        : (await sisterCompaniesApi.createSettlement(body)).id;
      await sisterCompaniesApi.postSettlement(id);
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sister-settlements"] });
      toast({ title: "تم الحفظ والترحيل" });
      setLocation("/inventory/sister-settlements");
    },
    onError: (e: any) => toast({ title: "خطأ", description: String(e?.message || e), variant: "destructive" }),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.sisterCompanyId || !form.amount || Number(form.amount) <= 0) {
      toast({ title: "أكمل البيانات والمبلغ", variant: "destructive" }); return;
    }
    if (form.paymentType === "cash" && !form.cashBoxId) {
      toast({ title: "اختر الخزينة", variant: "destructive" }); return;
    }
    if (form.paymentType === "bank" && !form.bankAccountId) {
      toast({ title: "اختر الحساب البنكي", variant: "destructive" }); return;
    }
    createMut.mutate({
      sisterCompanyId: Number(form.sisterCompanyId),
      branchId: form.branchId ? Number(form.branchId) : null,
      date: form.date,
      direction: form.direction,
      paymentType: form.paymentType,
      cashBoxId:     form.paymentType === "cash" ? Number(form.cashBoxId)     : null,
      bankAccountId: form.paymentType === "bank" ? Number(form.bankAccountId) : null,
      amount: form.amount,
      description: form.description || null,
    });
  }

  return (
    <form onSubmit={submit} className="p-6 space-y-4">
      <h1 className="text-xl font-bold flex items-center gap-2"><Wallet className="h-5 w-5" /> {editId ? "تعديل سند تسوية شركة شقيقة" : "سند تسوية شركة شقيقة"}</h1>
      <Card><CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-6">
        <label><span className="text-sm">الشركة الشقيقة *</span>
          <select className="w-full border rounded h-9 px-2" value={form.sisterCompanyId}
            onChange={e => setForm({ ...form, sisterCompanyId: e.target.value })}>
            <option value="">اختر…</option>
            {(sisters as any[]).filter((s: any) => s.isActive).map((s: any) =>
              <option key={s.id} value={s.id}>{s.nameAr}</option>)}
          </select></label>
        <label><span className="text-sm">الفرع</span>
          <select className="w-full border rounded h-9 px-2" value={form.branchId}
            onChange={e => setForm({ ...form, branchId: e.target.value })} data-testid="select-branch">
            <option value="">— بدون فرع —</option>
            {(branches as any[]).map((b: any) => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
          </select></label>
        <label><span className="text-sm">التاريخ</span>
          <DateField value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></label>

        <label><span className="text-sm">الاتجاه *</span>
          <select className="w-full border rounded h-9 px-2" value={form.direction}
            onChange={e => setForm({ ...form, direction: e.target.value })}>
            <option value="receive">تحصيل (الشركة الشقيقة تدفع لنا)</option>
            <option value="pay">سداد (نحن ندفع لها)</option>
          </select></label>
        <label><span className="text-sm">طريقة الدفع *</span>
          <select className="w-full border rounded h-9 px-2" value={form.paymentType}
            onChange={e => setForm({ ...form, paymentType: e.target.value })}>
            <option value="cash">نقدي (خزينة)</option>
            <option value="bank">بنك</option>
          </select></label>

        {form.paymentType === "cash" ? (
          <label><span className="text-sm">الخزينة *</span>
            <select className="w-full border rounded h-9 px-2" value={form.cashBoxId}
              onChange={e => setForm({ ...form, cashBoxId: e.target.value })}>
              <option value="">اختر…</option>
              {(cashBoxes as any[]).map((c: any) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
            </select></label>
        ) : (
          <label><span className="text-sm">الحساب البنكي *</span>
            <select className="w-full border rounded h-9 px-2" value={form.bankAccountId}
              onChange={e => setForm({ ...form, bankAccountId: e.target.value })}>
              <option value="">اختر…</option>
              {(banks as any[]).map((b: any) => <option key={b.id} value={b.id}>{b.nameAr}</option>)}
            </select></label>
        )}

        <label><span className="text-sm">المبلغ *</span>
          <Input type="number" min="0" step="0.01" value={form.amount}
            onChange={e => setForm({ ...form, amount: e.target.value })} data-testid="input-amount" /></label>

        <label className="md:col-span-2"><span className="text-sm">البيان</span>
          <Input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
      </CardContent></Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={createMut.isPending}><Save className="h-4 w-4 ml-1" /> حفظ وترحيل</Button>
        <Button type="button" variant="outline" onClick={() => setLocation("/inventory/sister-settlements")}>إلغاء</Button>
      </div>
    </form>
  );
}
