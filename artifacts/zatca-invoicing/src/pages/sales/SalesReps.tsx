import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { FormPanel } from "@/components/FormPanel";
import { AccountCombobox } from "@/components/AccountCombobox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Plus, Search, Pencil, Trash2, UserCheck, UserX,
  Phone, Mail, MapPin, Percent, Target, Users, Sparkles, Loader2,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Rep = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  branchId: number | null;
  region: string | null;
  isActive: boolean;
  commissionPct: string;
  commissionType: "invoice" | "collection";
  monthlyTarget: string;
  accountId: number | null;
  notes: string | null;
};

const EMPTY_FORM = {
  code: "",
  nameAr: "",
  nameEn: "",
  phone: "",
  email: "",
  address: "",
  branchId: "" as string,
  region: "",
  isActive: true,
  commissionPct: "0",
  commissionType: "invoice" as "invoice" | "collection",
  monthlyTarget: "0",
  accountId: "" as string,
  notes: "",
};

export default function SalesReps() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}` };
  const cid = user?.companyId;

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Rep | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [deleteRep, setDeleteRep] = useState<Rep | null>(null);
  const [aiRep, setAiRep] = useState<Rep | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<string>("");
  const [aiLoading, setAiLoading] = useState(false);

  async function runAiAnalysis(rep: Rep) {
    setAiRep(rep);
    setAiAnalysis("");
    setAiLoading(true);
    try {
      const r = await fetch(`${API}/api/sales-reps/${rep.id}/ai-analysis?companyId=${cid}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "فشل التحليل");
      setAiAnalysis(j.analysis ?? "");
    } catch (e: any) {
      toast({ title: "تعذّر التحليل", description: String(e?.message ?? e), variant: "destructive" });
      setAiRep(null);
    } finally {
      setAiLoading(false);
    }
  }

  const { data: reps = [], isLoading } = useQuery<Rep[]>({
    queryKey: ["sales-reps", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/sales-reps?companyId=${cid}` : `${API}/api/sales-reps`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error("فشل تحميل المناديب");
      return r.json();
    },
    enabled: !!user,
  });

  const { data: branches = [] } = useQuery<any[]>({
    queryKey: ["branches", cid],
    queryFn: async () => {
      const r = await fetch(`${API}/api/org/branches?companyId=${cid}`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!cid,
    staleTime: 60_000,
  });

  const filtered = reps.filter((r) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      r.nameAr?.includes(search) ||
      r.nameEn?.toLowerCase().includes(q) ||
      r.code?.toLowerCase().includes(q) ||
      r.phone?.includes(search) ||
      r.email?.toLowerCase().includes(q) ||
      r.region?.includes(search)
    );
  });

  function openNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEdit(r: Rep) {
    setEditing(r);
    setForm({
      code: r.code ?? "",
      nameAr: r.nameAr ?? "",
      nameEn: r.nameEn ?? "",
      phone: r.phone ?? "",
      email: r.email ?? "",
      address: r.address ?? "",
      branchId: r.branchId ? String(r.branchId) : "",
      region: r.region ?? "",
      isActive: r.isActive,
      commissionPct: String(r.commissionPct ?? "0"),
      commissionType: r.commissionType ?? "invoice",
      monthlyTarget: String(r.monthlyTarget ?? "0"),
      accountId: r.accountId ? String(r.accountId) : "",
      notes: r.notes ?? "",
    });
    setShowForm(true);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.nameAr.trim()) throw new Error("اسم المندوب مطلوب");
      const body: any = {
        companyId: cid,
        code: form.code.trim() || undefined,
        nameAr: form.nameAr.trim(),
        nameEn: form.nameEn.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim() || null,
        branchId: form.branchId ? Number(form.branchId) : null,
        region: form.region.trim() || null,
        isActive: form.isActive,
        commissionPct: Number(form.commissionPct) || 0,
        commissionType: form.commissionType,
        monthlyTarget: Number(form.monthlyTarget) || 0,
        accountId: form.accountId ? Number(form.accountId) : null,
        notes: form.notes.trim() || null,
      };
      const url = editing
        ? `${API}/api/sales-reps/${editing.id}`
        : `${API}/api/sales-reps`;
      const r = await fetch(url, {
        method: editing ? "PUT" : "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "تعذّر الحفظ");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-reps", cid] });
      toast({ title: editing ? "تم التحديث" : "تم الإضافة" });
      setShowForm(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    },
    onError: (e: any) => {
      toast({ title: "خطأ", description: e?.message || "فشل الحفظ", variant: "destructive" });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      if (!deleteRep) return;
      const r = await fetch(`${API}/api/sales-reps/${deleteRep.id}?companyId=${cid}`, {
        method: "DELETE",
        headers,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "تعذّر الحذف");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-reps", cid] });
      toast({ title: "تم الحذف" });
      setDeleteRep(null);
    },
    onError: (e: any) => {
      toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" });
      setDeleteRep(null);
    },
  });

  return (
    <div className="space-y-4 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            مناديب المبيعات
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة مناديب المبيعات وعمولاتهم — {reps.length} مندوب
          </p>
        </div>
        <Button onClick={openNew} data-testid="btn-new-rep">
          <Plus className="h-4 w-4 ms-2" />
          مندوب جديد
        </Button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="بحث بالاسم، الكود، الهاتف، المنطقة…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pe-9"
          data-testid="input-search-rep"
        />
      </div>

      {showForm && (
        <FormPanel
          icon={editing ? Pencil : Plus}
          title={editing ? `تعديل المندوب: ${editing.nameAr}` : "إضافة مندوب جديد"}
          subtitle={editing ? `الكود: ${editing.code}` : "املأ بيانات المندوب — الكود يُولَّد تلقائياً إن تركته فارغاً"}
          width="3xl"
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSave={() => saveMut.mutate()}
          saving={saveMut.isPending}
          saveLabel="حفظ"
          cancelLabel="إلغاء"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>الكود</Label>
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="تلقائي مثل SR0001"
                data-testid="input-code"
              />
            </div>
            <div>
              <Label>الاسم بالعربية *</Label>
              <Input
                value={form.nameAr}
                onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
                placeholder="اسم المندوب"
                data-testid="input-name-ar"
              />
            </div>
            <div>
              <Label>الاسم بالإنجليزية</Label>
              <Input
                value={form.nameEn}
                onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
                placeholder="Sales Rep Name"
                data-testid="input-name-en"
              />
            </div>
            <div>
              <Label>الهاتف</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="05xxxxxxxx"
                data-testid="input-phone"
              />
            </div>
            <div>
              <Label>البريد الإلكتروني</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="rep@example.com"
                data-testid="input-email"
              />
            </div>
            <div>
              <Label>الفرع</Label>
              <select
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.branchId}
                onChange={(e) => setForm({ ...form, branchId: e.target.value })}
                data-testid="select-branch"
              >
                <option value="">— اختر الفرع —</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.nameAr || b.nameEn}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>المنطقة</Label>
              <Input
                value={form.region}
                onChange={(e) => setForm({ ...form, region: e.target.value })}
                placeholder="الرياض / جدة / الشرقية…"
                data-testid="input-region"
              />
            </div>
            <div>
              <Label>العنوان</Label>
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="عنوان المندوب"
                data-testid="input-address"
              />
            </div>
            <div>
              <Label>نسبة العمولة %</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={form.commissionPct}
                onChange={(e) => setForm({ ...form, commissionPct: e.target.value })}
                data-testid="input-commission-pct"
              />
            </div>
            <div>
              <Label>نوع العمولة</Label>
              <select
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                value={form.commissionType}
                onChange={(e) => setForm({ ...form, commissionType: e.target.value as any })}
                data-testid="select-commission-type"
              >
                <option value="invoice">على الفاتورة (تُحسب عند البيع)</option>
                <option value="collection">على التحصيل (تُحسب عند القبض)</option>
              </select>
            </div>
            <div>
              <Label>الهدف الشهري (ر.س)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={form.monthlyTarget}
                onChange={(e) => setForm({ ...form, monthlyTarget: e.target.value })}
                data-testid="input-monthly-target"
              />
            </div>
            <div>
              <Label>الحساب المحاسبي (اختياري)</Label>
              <AccountCombobox
                value={form.accountId}
                onValueChange={(v) => setForm({ ...form, accountId: v })}
                placeholder="— اختر حساب العمولات —"
                allowEmpty
              />
            </div>
            <div className="md:col-span-2">
              <Label>ملاحظات</Label>
              <Input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="ملاحظات إدارية"
                data-testid="input-notes"
              />
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="rep-active"
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="h-4 w-4"
                data-testid="checkbox-active"
              />
              <Label htmlFor="rep-active" className="cursor-pointer">
                المندوب نشط
              </Label>
            </div>
          </div>
        </FormPanel>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="border rounded-lg p-8 text-center text-muted-foreground">
          {reps.length === 0
            ? "لا يوجد مناديب بعد. اضغط على «مندوب جديد» للإضافة."
            : "لا توجد نتائج مطابقة لبحثك."}
        </div>
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="px-3 py-2 font-medium">الكود</th>
                <th className="px-3 py-2 font-medium">الاسم</th>
                <th className="px-3 py-2 font-medium">الهاتف</th>
                <th className="px-3 py-2 font-medium">المنطقة</th>
                <th className="px-3 py-2 font-medium">العمولة</th>
                <th className="px-3 py-2 font-medium">الهدف الشهري</th>
                <th className="px-3 py-2 font-medium">الحالة</th>
                <th className="px-3 py-2 font-medium text-center w-28">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-t hover:bg-muted/30" data-testid={`row-rep-${r.id}`}>
                  <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
                  <td className="px-3 py-2 font-medium">
                    {r.nameAr}
                    {r.nameEn && <div className="text-xs text-muted-foreground">{r.nameEn}</div>}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.phone ? (<span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{r.phone}</span>) : "—"}
                    {r.email && (<div className="text-xs flex items-center gap-1"><Mail className="h-3 w-3" />{r.email}</div>)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.region ? (<span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{r.region}</span>) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Percent className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium">{Number(r.commissionPct).toFixed(2)}%</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {r.commissionType === "collection" ? "على التحصيل" : "على الفاتورة"}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="inline-flex items-center gap-1">
                      <Target className="h-3 w-3 text-muted-foreground" />
                      {Number(r.monthlyTarget).toLocaleString("ar-SA", { maximumFractionDigits: 2 })} ر.س
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {r.isActive ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-50 text-green-700 border border-green-200">
                        <UserCheck className="h-3 w-3" />نشط
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600 border border-gray-200">
                        <UserX className="h-3 w-3" />متوقف
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-violet-600 hover:text-violet-700"
                        onClick={() => runAiAnalysis(r)}
                        title="تحليل الأداء بالذكاء الاصطناعي"
                        data-testid={`btn-ai-${r.id}`}
                      >
                        <Sparkles className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEdit(r)}
                        data-testid={`btn-edit-${r.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-600 hover:text-red-700"
                        onClick={() => setDeleteRep(r)}
                        data-testid={`btn-delete-${r.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog open={!!deleteRep} onOpenChange={(o) => !o && setDeleteRep(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف المندوب</AlertDialogTitle>
            <AlertDialogDescription>
              هل أنت متأكد من حذف المندوب «{deleteRep?.nameAr}»؟ لا يمكن التراجع عن هذه العملية.
              <br />
              <span className="text-xs text-muted-foreground mt-2 block">
                ملاحظة: لا يمكن حذف مندوب مرتبط بفواتير أو عملاء — يمكنك تعطيله بدلاً من ذلك.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMut.mutate()}
              className="bg-red-600 hover:bg-red-700"
            >
              حذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!aiRep} onOpenChange={(o) => { if (!o) { setAiRep(null); setAiAnalysis(""); } }}>
        <DialogContent dir="rtl" className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-600" />
              تحليل أداء المندوب: {aiRep?.nameAr}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            {aiLoading ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin mb-3 text-violet-600" />
                <p className="text-sm">جارٍ تحليل بيانات آخر 90 يوماً…</p>
                <p className="text-xs mt-1">قد يستغرق الأمر بضع ثوان.</p>
              </div>
            ) : aiAnalysis ? (
              <div
                className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed text-foreground"
                data-testid="ai-analysis-content"
              >
                {aiAnalysis}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-6 text-center">
                لا يوجد محتوى للعرض.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
