import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  KeyRound, Plus, Loader2, Building2, ShieldCheck, ShieldAlert, FileText,
  Copy, Check, Trash2, Edit3, Search, TrendingUp, AlertTriangle, Sparkles, Lock, Unlock,
  Wand2, Download, Upload, ExternalLink, Hash, ArrowRight, Eye,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Client {
  id: number;
  nameAr: string; nameEn: string | null;
  vatNumber: string; crNumber: string | null;
  contactEmail: string | null; contactPhone: string | null;
  city: string | null;
  zatcaEnv: "production" | "sandbox";
  status: "pending" | "active" | "suspended";
  monthlyQuota: number; invoicesThisMonth: number; totalInvoices: number;
  lastInvoiceAt: string | null; createdAt: string;
  hasCredentials: boolean;
  activeKeys: number;
}

interface ClientDetail extends Omit<Client, "hasCredentials" | "activeKeys"> {
  addressAr: string | null;
  notes: string | null;
  hasCsid: boolean; hasPcsid: boolean; hasPrivateKey: boolean;
  updatedAt: string;
  lastIcv?: number;
  egsSerial?: string | null;
}

interface ApiKey {
  id: number; label: string; keyPrefix: string; scope: string;
  createdAt: string; lastUsedAt: string | null; lastUsedIp: string | null;
  revokedAt: string | null; expiresAt: string | null;
}

interface Stats {
  totalClients: number; activeClients: number; pendingClients: number;
  suspendedClients: number; productionClients: number;
  totalInvoices: number; cleared: number; rejected: number; received: number;
}

const STATUS_BADGE: Record<Client["status"], { label: string; cls: string }> = {
  active:    { label: "مفعّل",    cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  pending:   { label: "بانتظار التفعيل", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  suspended: { label: "موقوف",   cls: "bg-rose-50 text-rose-700 border-rose-200" },
};

const ENV_BADGE: Record<Client["zatcaEnv"], { label: string; cls: string }> = {
  production: { label: "إنتاج",   cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  sandbox:    { label: "تجريبي",  cls: "bg-sky-50 text-sky-700 border-sky-200" },
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("zatca_token");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error ?? res.statusText);
  }
  return res.json();
}

export default function GatewayClients() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "pending" | "suspended">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [activeClient, setActiveClient] = useState<Client | null>(null);

  const { data, isLoading } = useQuery<{ clients: Client[] }>({
    queryKey: ["gateway-clients"],
    queryFn: () => api("/api/admin/gateway-clients"),
  });
  const { data: stats } = useQuery<Stats>({
    queryKey: ["gateway-clients", "stats"],
    queryFn: () => api("/api/admin/gateway-clients/stats/overview"),
  });

  const filtered = useMemo(() => {
    const all = data?.clients ?? [];
    return all.filter(c => {
      if (filter !== "all" && c.status !== filter) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return c.nameAr.toLowerCase().includes(q)
        || (c.nameEn?.toLowerCase().includes(q) ?? false)
        || c.vatNumber.includes(q)
        || (c.crNumber?.includes(q) ?? false);
    });
  }, [data, search, filter]);

  return (
    <div className="space-y-6 p-4 md:p-6 max-w-[1400px] mx-auto" dir="rtl">
      {/* ── Hero header ───────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-l from-indigo-600 via-purple-600 to-pink-600 text-white p-6 md:p-8 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-white/20 p-3 backdrop-blur">
                <KeyRound className="h-7 w-7" />
              </div>
              <div>
                <h1 className="text-2xl md:text-3xl font-bold">بوابة الفواتير الخارجية</h1>
                <p className="text-white/80 text-sm md:text-base">شركات مسجّلة بزاتكا ترسل فواتيرها عبر بوّابتك</p>
              </div>
            </div>
          </div>
          <CreateClientDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={() => qc.invalidateQueries({ queryKey: ["gateway-clients"] })} />
        </div>

        {/* Inline stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
            <StatPill icon={Building2} label="عملاء البوابة" value={stats.totalClients} sub={`${stats.activeClients} مفعّل`} />
            <StatPill icon={ShieldCheck} label="بيئة الإنتاج" value={stats.productionClients} sub={`من ${stats.totalClients} عميل`} />
            <StatPill icon={FileText} label="إجمالي الفواتير" value={stats.totalInvoices} sub={`${stats.cleared} مقبولة`} />
            <StatPill icon={AlertTriangle} label="فواتير مرفوضة" value={stats.rejected} sub={`${stats.received} قيد المعالجة`} />
          </div>
        )}
      </div>

      {/* ── Filters & search ──────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                placeholder="ابحث باسم الشركة، الرقم الضريبي، أو السجل التجاري..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pr-10"
              />
            </div>
            <Tabs value={filter} onValueChange={v => setFilter(v as typeof filter)}>
              <TabsList>
                <TabsTrigger value="all">الكل</TabsTrigger>
                <TabsTrigger value="active">مفعّل</TabsTrigger>
                <TabsTrigger value="pending">بانتظار التفعيل</TabsTrigger>
                <TabsTrigger value="suspended">موقوف</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardContent>
      </Card>

      {/* ── Clients grid ──────────────────────────────────────────── */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
        </div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="p-16 text-center text-slate-500">
          <Building2 className="h-16 w-16 mx-auto mb-4 text-slate-300" />
          <p className="text-lg font-medium">لا يوجد عملاء بعد</p>
          <p className="text-sm mt-1">ابدأ بإضافة شركة خارجية لتسليمها بوابة فوترة زاتكا.</p>
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map(c => (
            <ClientCard key={c.id} client={c} onOpen={() => setActiveClient(c)} />
          ))}
        </div>
      )}

      {/* ── Client detail dialog ──────────────────────────────────── */}
      {activeClient && (
        <ClientDetailDialog
          clientId={activeClient.id}
          onClose={() => setActiveClient(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: ["gateway-clients"] })}
        />
      )}
    </div>
  );
}

// ─── Stat pill ──────────────────────────────────────────────────────
function StatPill({ icon: Icon, label, value, sub }: { icon: typeof Building2; label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-xl bg-white/15 backdrop-blur border border-white/20 p-3 hover:bg-white/20 transition">
      <div className="flex items-center gap-2 text-white/80 text-xs">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <div className="mt-1 text-2xl font-bold">{value.toLocaleString("ar-EG")}</div>
      {sub && <div className="text-xs text-white/70">{sub}</div>}
    </div>
  );
}

// ─── Client card ────────────────────────────────────────────────────
function ClientCard({ client, onOpen }: { client: Client; onOpen: () => void }) {
  const usagePct = client.monthlyQuota > 0 ? Math.min(100, (client.invoicesThisMonth / client.monthlyQuota) * 100) : 0;
  const usageColor = usagePct >= 90 ? "bg-rose-500" : usagePct >= 70 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <Card className="hover:shadow-lg transition cursor-pointer border-slate-200" onClick={onOpen}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="rounded-xl bg-gradient-to-br from-indigo-100 to-purple-100 p-2.5 shrink-0">
              <Building2 className="h-5 w-5 text-indigo-700" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900 truncate">{client.nameAr}</h3>
              {client.nameEn && <p className="text-xs text-slate-500 truncate">{client.nameEn}</p>}
              <p className="text-xs text-slate-400 mt-0.5 font-mono">VAT: {client.vatNumber}</p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5 items-end shrink-0">
            <Badge variant="outline" className={STATUS_BADGE[client.status].cls}>{STATUS_BADGE[client.status].label}</Badge>
            <Badge variant="outline" className={ENV_BADGE[client.zatcaEnv].cls}>{ENV_BADGE[client.zatcaEnv].label}</Badge>
          </div>
        </div>

        {/* Credentials & keys row */}
        <div className="flex items-center gap-3 mt-4 text-xs">
          <div className={`flex items-center gap-1 ${client.hasCredentials ? "text-emerald-700" : "text-amber-700"}`}>
            {client.hasCredentials ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
            <span>{client.hasCredentials ? "مفاتيح زاتكا مُسجّلة" : "بدون مفاتيح"}</span>
          </div>
          <div className="flex items-center gap-1 text-slate-600">
            <KeyRound className="h-3.5 w-3.5" />
            <span>{client.activeKeys} مفتاح API نشط</span>
          </div>
        </div>

        {/* Usage bar */}
        <div className="mt-4 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600">استخدام هذا الشهر</span>
            <span className="font-mono text-slate-700">{client.invoicesThisMonth.toLocaleString("ar-EG")} / {client.monthlyQuota.toLocaleString("ar-EG")}</span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div className={`h-full ${usageColor} transition-all`} style={{ width: `${usagePct}%` }} />
          </div>
          <div className="flex items-center justify-between text-xs text-slate-500 mt-1">
            <span>إجمالي: {client.totalInvoices.toLocaleString("ar-EG")} فاتورة</span>
            {client.lastInvoiceAt && <span>آخر فاتورة: {new Date(client.lastInvoiceAt).toLocaleDateString("ar-SA")}</span>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Create dialog ──────────────────────────────────────────────────
function CreateClientDialog({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    nameAr: "", nameEn: "", vatNumber: "", crNumber: "",
    contactEmail: "", contactPhone: "", city: "", addressAr: "",
    zatcaEnv: "sandbox" as "sandbox" | "production",
    monthlyQuota: 1000, notes: "",
  });

  const mut = useMutation({
    mutationFn: () => api("/api/admin/gateway-clients", { method: "POST", body: JSON.stringify(form) }),
    onSuccess: () => {
      toast({ title: "تمت إضافة العميل", description: "يمكنك الآن إدخال مفاتيح زاتكا وإصدار مفتاح API." });
      onCreated();
      onOpenChange(false);
      setForm({ nameAr: "", nameEn: "", vatNumber: "", crNumber: "", contactEmail: "", contactPhone: "", city: "", addressAr: "", zatcaEnv: "sandbox", monthlyQuota: 1000, notes: "" });
    },
    onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="lg" className="bg-white text-indigo-700 hover:bg-white/90 shadow-lg">
          <Plus className="h-5 w-5 ml-1" />
          إضافة شركة جديدة
        </Button>
      </DialogTrigger>
      <DialogContent dir="rtl" className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-indigo-600" />
            تسجيل شركة خارجية جديدة
          </DialogTitle>
          <DialogDescription>الشركة لازم تكون مسجّلة في زاتكا وعندها رقم ضريبي ساري.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 py-2">
          <Field label="اسم الشركة بالعربية *" required>
            <Input value={form.nameAr} onChange={e => setForm({ ...form, nameAr: e.target.value })} placeholder="شركة المثال للتجارة" />
          </Field>
          <Field label="Company Name (EN)">
            <Input value={form.nameEn} onChange={e => setForm({ ...form, nameEn: e.target.value })} placeholder="Example Trading Co." dir="ltr" />
          </Field>
          <Field label="الرقم الضريبي (15 رقماً) *" required>
            <Input value={form.vatNumber} onChange={e => setForm({ ...form, vatNumber: e.target.value.replace(/\D/g, "").slice(0, 15) })} placeholder="300000000000003" dir="ltr" className="font-mono" />
          </Field>
          <Field label="السجل التجاري">
            <Input value={form.crNumber} onChange={e => setForm({ ...form, crNumber: e.target.value })} placeholder="1010000000" dir="ltr" />
          </Field>
          <Field label="البريد الإلكتروني للتواصل">
            <Input type="email" value={form.contactEmail} onChange={e => setForm({ ...form, contactEmail: e.target.value })} placeholder="finance@example.sa" dir="ltr" />
          </Field>
          <Field label="رقم الجوال">
            <Input value={form.contactPhone} onChange={e => setForm({ ...form, contactPhone: e.target.value })} placeholder="+966 50 000 0000" dir="ltr" />
          </Field>
          <Field label="المدينة">
            <Input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} placeholder="الرياض" />
          </Field>
          <Field label="بيئة زاتكا">
            <Select value={form.zatcaEnv} onValueChange={v => setForm({ ...form, zatcaEnv: v as "sandbox" | "production" })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sandbox">تجريبي (Sandbox)</SelectItem>
                <SelectItem value="production">إنتاج (Production)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="الحصة الشهرية للفواتير">
            <Input type="number" min={0} value={form.monthlyQuota} onChange={e => setForm({ ...form, monthlyQuota: Number(e.target.value) || 0 })} dir="ltr" />
          </Field>
          <div className="md:col-span-2">
            <Field label="العنوان">
              <Textarea rows={2} value={form.addressAr} onChange={e => setForm({ ...form, addressAr: e.target.value })} placeholder="الحي، الشارع، المدينة، الرمز البريدي" />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="ملاحظات داخلية">
              <Textarea rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="أي تفاصيل خاصة بالعميل..." />
            </Field>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>إلغاء</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !form.nameAr || !/^\d{15}$/.test(form.vatNumber)} className="bg-indigo-600 hover:bg-indigo-700">
            {mut.isPending ? <Loader2 className="h-4 w-4 ml-1 animate-spin" /> : <Plus className="h-4 w-4 ml-1" />}
            إضافة
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}{required && <span className="text-rose-500 mr-0.5">*</span>}</Label>
      {children}
    </div>
  );
}

// ─── Detail dialog (credentials + API keys + invoices) ─────────────
function ClientDetailDialog({ clientId, onClose, onChanged }: { clientId: number; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<"info" | "credentials" | "keys" | "invoices">("info");

  const { data, isLoading } = useQuery<{ client: ClientDetail }>({
    queryKey: ["gateway-client", clientId],
    queryFn: () => api(`/api/admin/gateway-clients/${clientId}`),
  });

  const c = data?.client;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent dir="rtl" className="max-w-4xl max-h-[92vh] overflow-y-auto">
        {isLoading || !c ? (
          <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-indigo-600" /></div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <DialogTitle className="text-xl flex items-center gap-2">
                    <Building2 className="h-5 w-5 text-indigo-600" />
                    {c.nameAr}
                  </DialogTitle>
                  <DialogDescription className="font-mono mt-1">VAT: {c.vatNumber}</DialogDescription>
                </div>
                <div className="flex gap-2">
                  <Badge variant="outline" className={STATUS_BADGE[c.status].cls}>{STATUS_BADGE[c.status].label}</Badge>
                  <Badge variant="outline" className={ENV_BADGE[c.zatcaEnv].cls}>{ENV_BADGE[c.zatcaEnv].label}</Badge>
                </div>
              </div>
            </DialogHeader>

            <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)} className="mt-2">
              <TabsList className="grid grid-cols-4">
                <TabsTrigger value="info">المعلومات</TabsTrigger>
                <TabsTrigger value="credentials">مفاتيح زاتكا</TabsTrigger>
                <TabsTrigger value="keys">مفاتيح API</TabsTrigger>
                <TabsTrigger value="invoices">الفواتير</TabsTrigger>
              </TabsList>

              <TabsContent value="info" className="mt-4">
                <ClientInfoTab client={c} onSaved={() => { qc.invalidateQueries({ queryKey: ["gateway-client", clientId] }); onChanged(); }} onDeleted={() => { onChanged(); onClose(); }} />
              </TabsContent>
              <TabsContent value="credentials" className="mt-4">
                <CredentialsTab client={c} onSaved={() => qc.invalidateQueries({ queryKey: ["gateway-client", clientId] })} />
              </TabsContent>
              <TabsContent value="keys" className="mt-4">
                <ApiKeysTab clientId={clientId} />
              </TabsContent>
              <TabsContent value="invoices" className="mt-4">
                <div className="flex items-center justify-end mb-2 gap-2">
                  <Button variant="outline" size="sm" onClick={() => window.open(`/admin/gateway-clients/${clientId}/reports`, "_blank")} className="text-indigo-700 border-indigo-200">
                    <TrendingUp className="h-4 w-4 ml-1" />
                    لوحة التقارير + تصدير CSV
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => {
                    const token = localStorage.getItem("zatca_token");
                    const acting = localStorage.getItem("zatca_acting_company_id");
                    const headers: Record<string,string> = {};
                    if (token) headers.Authorization = `Bearer ${token}`;
                    if (acting) headers["x-acting-company-id"] = acting;
                    fetch(`${API}/api/admin/gateway-clients/${clientId}/template.csv`, { headers })
                      .then(r => r.blob()).then(blob => {
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(blob);
                        a.download = `gateway-template-${clientId}.csv`;
                        a.click(); URL.revokeObjectURL(a.href);
                      });
                  }}>
                    <Download className="h-4 w-4 ml-1" />
                    تنزيل قالب CSV
                  </Button>
                </div>
                <InvoicesTab clientId={clientId} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ClientInfoTab({ client, onSaved, onDeleted }: { client: ClientDetail; onSaved: () => void; onDeleted: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    nameAr: client.nameAr, nameEn: client.nameEn ?? "",
    crNumber: client.crNumber ?? "", contactEmail: client.contactEmail ?? "", contactPhone: client.contactPhone ?? "",
    city: client.city ?? "", addressAr: client.addressAr ?? "",
    zatcaEnv: client.zatcaEnv, status: client.status,
    monthlyQuota: client.monthlyQuota, notes: client.notes ?? "",
  });

  const save = useMutation({
    mutationFn: () => api(`/api/admin/gateway-clients/${client.id}`, { method: "PATCH", body: JSON.stringify(form) }),
    onSuccess: () => { toast({ title: "تم الحفظ" }); onSaved(); },
    onError: (e: Error) => toast({ title: "تعذّر الحفظ", description: e.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: () => api(`/api/admin/gateway-clients/${client.id}`, { method: "DELETE" }),
    onSuccess: () => { toast({ title: "تم حذف العميل" }); onDeleted(); },
    onError: (e: Error) => toast({ title: "تعذّر الحذف", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="اسم الشركة بالعربية"><Input value={form.nameAr} onChange={e => setForm({ ...form, nameAr: e.target.value })} /></Field>
        <Field label="Company Name (EN)"><Input value={form.nameEn} onChange={e => setForm({ ...form, nameEn: e.target.value })} dir="ltr" /></Field>
        <Field label="السجل التجاري"><Input value={form.crNumber} onChange={e => setForm({ ...form, crNumber: e.target.value })} dir="ltr" /></Field>
        <Field label="البريد الإلكتروني"><Input type="email" value={form.contactEmail} onChange={e => setForm({ ...form, contactEmail: e.target.value })} dir="ltr" /></Field>
        <Field label="الجوال"><Input value={form.contactPhone} onChange={e => setForm({ ...form, contactPhone: e.target.value })} dir="ltr" /></Field>
        <Field label="المدينة"><Input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} /></Field>
        <Field label="بيئة زاتكا">
          <Select value={form.zatcaEnv} onValueChange={v => setForm({ ...form, zatcaEnv: v as "sandbox" | "production" })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sandbox">تجريبي</SelectItem>
              <SelectItem value="production">إنتاج</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="الحالة">
          <Select value={form.status} onValueChange={v => setForm({ ...form, status: v as "active" | "pending" | "suspended" })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">بانتظار التفعيل</SelectItem>
              <SelectItem value="active">مفعّل</SelectItem>
              <SelectItem value="suspended">موقوف</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="الحصة الشهرية"><Input type="number" min={0} value={form.monthlyQuota} onChange={e => setForm({ ...form, monthlyQuota: Number(e.target.value) || 0 })} dir="ltr" /></Field>
        <div className="md:col-span-2"><Field label="العنوان"><Textarea rows={2} value={form.addressAr} onChange={e => setForm({ ...form, addressAr: e.target.value })} /></Field></div>
        <div className="md:col-span-2"><Field label="ملاحظات"><Textarea rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></Field></div>
      </div>

      <div className="flex items-center justify-between pt-4 border-t">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="text-rose-600 border-rose-200 hover:bg-rose-50"><Trash2 className="h-4 w-4 ml-1" /> حذف العميل</Button>
          </AlertDialogTrigger>
          <AlertDialogContent dir="rtl">
            <AlertDialogHeader>
              <AlertDialogTitle>تأكيد الحذف</AlertDialogTitle>
              <AlertDialogDescription>سيتم حذف العميل ومفاتيحه وفواتيره نهائياً. هذا الإجراء لا يمكن التراجع عنه.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>إلغاء</AlertDialogCancel>
              <AlertDialogAction onClick={() => del.mutate()} className="bg-rose-600 hover:bg-rose-700">حذف نهائي</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Button onClick={() => save.mutate()} disabled={save.isPending} className="bg-indigo-600 hover:bg-indigo-700">
          {save.isPending ? <Loader2 className="h-4 w-4 ml-1 animate-spin" /> : <Edit3 className="h-4 w-4 ml-1" />}
          حفظ التعديلات
        </Button>
      </div>
    </div>
  );
}

function CredentialsTab({ client, onSaved }: { client: ClientDetail; onSaved: () => void }) {
  const [mode, setMode] = useState<"manual" | "wizard">("manual");
  const allReady = client.hasCsid && client.hasPrivateKey;

  return (
    <div className="space-y-4">
      {/* Mode selector — two onboarding paths */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => setMode("manual")}
          className={`rounded-xl border-2 p-3 text-right transition-all ${mode === "manual" ? "border-indigo-500 bg-indigo-50 shadow-md" : "border-slate-200 bg-white hover:border-slate-300"}`}
        >
          <div className="flex items-center gap-2 mb-1">
            <Upload className={`h-4 w-4 ${mode === "manual" ? "text-indigo-600" : "text-slate-500"}`} />
            <span className="font-bold text-sm">عند الشركة CSID جاهز</span>
            {allReady && <Check className="h-3.5 w-3.5 text-emerald-600 mr-auto" />}
          </div>
          <p className="text-[11px] text-slate-600 leading-relaxed">الشركة تجيب CSID والمفتاح الخاص من بوابة فاتورة، وأنت تلصقهم هنا. الأسهل والأسرع.</p>
        </button>
        <button
          onClick={() => setMode("wizard")}
          className={`rounded-xl border-2 p-3 text-right transition-all ${mode === "wizard" ? "border-violet-500 bg-violet-50 shadow-md" : "border-slate-200 bg-white hover:border-slate-300"}`}
        >
          <div className="flex items-center gap-2 mb-1">
            <Wand2 className={`h-4 w-4 ${mode === "wizard" ? "text-violet-600" : "text-slate-500"}`} />
            <span className="font-bold text-sm">إصدار CSR من البوابة</span>
            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[9px] mr-auto">جديد</Badge>
          </div>
          <p className="text-[11px] text-slate-600 leading-relaxed">نولّد طلب الشهادة (CSR) ومفتاح خاص هنا، الشركة تحمّله لزاتكا، ثم ترجعلنا الـ CSID.</p>
        </button>
      </div>

      {mode === "manual" ? <ManualCredentialsForm client={client} onSaved={onSaved} /> : <CsrWizard client={client} onSaved={onSaved} />}
    </div>
  );
}

function ManualCredentialsForm({ client, onSaved }: { client: ClientDetail; onSaved: () => void }) {
  const { toast } = useToast();
  const [csid, setCsid] = useState("");
  const [pcsid, setPcsid] = useState("");
  const [privateKey, setPrivateKey] = useState("");

  const save = useMutation({
    mutationFn: () => api(`/api/admin/gateway-clients/${client.id}/credentials`, {
      method: "POST",
      body: JSON.stringify({ csid: csid || undefined, pcsid: pcsid || undefined, privateKey: privateKey || undefined }),
    }),
    onSuccess: () => { toast({ title: "تم تحديث المفاتيح", description: "المفاتيح مُشفّرة بـ AES-256-GCM في قاعدة البيانات." }); setCsid(""); setPcsid(""); setPrivateKey(""); onSaved(); },
    onError: (e: Error) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 flex gap-3">
        <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="text-sm text-amber-900">
          <p className="font-semibold">تنبيه أمني</p>
          <p className="mt-1">المفاتيح تُشفّر في قاعدة البيانات قبل الحفظ. لا يتم عرضها مرة أخرى. اترك الحقل فارغاً للإبقاء على المفتاح الحالي.</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <CredStatus label="CSID (Compliance)" present={client.hasCsid} />
        <CredStatus label="PCSID (Production)" present={client.hasPcsid} />
        <CredStatus label="Private Key" present={client.hasPrivateKey} />
      </div>

      <Field label="CSID (شهادة التجربة)">
        <Textarea rows={3} value={csid} onChange={e => setCsid(e.target.value)} placeholder={client.hasCsid ? "محفوظ — اتركه فارغاً للإبقاء" : "TUlJQ..."} dir="ltr" className="font-mono text-xs" />
      </Field>
      <Field label="PCSID (شهادة الإنتاج)">
        <Textarea rows={3} value={pcsid} onChange={e => setPcsid(e.target.value)} placeholder={client.hasPcsid ? "محفوظ — اتركه فارغاً للإبقاء" : "TUlJQ..."} dir="ltr" className="font-mono text-xs" />
      </Field>
      <Field label="Private Key (مفتاح التوقيع)">
        <Textarea rows={5} value={privateKey} onChange={e => setPrivateKey(e.target.value)} placeholder={client.hasPrivateKey ? "محفوظ — اتركه فارغاً للإبقاء" : "-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----"} dir="ltr" className="font-mono text-xs" />
      </Field>

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending || (!csid && !pcsid && !privateKey)} className="bg-indigo-600 hover:bg-indigo-700">
          {save.isPending ? <Loader2 className="h-4 w-4 ml-1 animate-spin" /> : <Lock className="h-4 w-4 ml-1" />}
          تشفير وحفظ
        </Button>
      </div>

      {/* Phase 1B.2: ZATCA Basic-Auth secret upload (separate from CSID PEM). */}
      <CsidSecretUpload client={client} onSaved={onSaved} />
    </div>
  );
}

// Uploads the ZATCA Basic-auth secret (returned alongside CSID/PCSID
// from fatoora.zatca.gov.sa). Required for the real /submit-zatca call —
// without it the API returns 412.
function CsidSecretUpload({ client, onSaved }: { client: ClientDetail; onSaved: () => void }) {
  const { toast } = useToast();
  const [target, setTarget] = useState<"sandbox" | "production">(client.zatcaEnv);
  const [certPem, setCertPem] = useState("");
  const [secret, setSecret] = useState("");

  const save = useMutation({
    mutationFn: () => api(`/api/admin/gateway-clients/${client.id}/csid`, {
      method: "PATCH",
      body: JSON.stringify({ certPem, basicAuthSecret: secret, env: target }),
    }),
    onSuccess: () => {
      toast({ title: "تم تشفير وحفظ بيانات اعتماد زاتكا", description: "الآن يمكن إرسال الفواتير فعلياً للبوابة." });
      setCertPem(""); setSecret(""); onSaved();
    },
    onError: (e: Error) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  return (
    <Card className="border-indigo-200 bg-indigo-50/30">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2 font-bold text-indigo-900">
          <ShieldCheck className="h-4 w-4" /> رفع بيانات الاعتماد الكاملة من زاتكا (Phase 1B.2)
        </div>
        <p className="text-xs text-slate-600 leading-relaxed">
          بعد توليد CSID من بوابة فاتورة، زاتكا ترجع لك زوجاً: <b>الشهادة (Certificate)</b> + <b>السر السري (Secret)</b>.
          الاثنان لازمان للإرسال الفعلي. كلاهما يُشفّر بـ AES-256-GCM في قاعدة البيانات.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="البيئة">
            <Select value={target} onValueChange={v => setTarget(v as "sandbox" | "production")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sandbox">تجريبي (Compliance)</SelectItem>
                <SelectItem value="production">إنتاج (Production)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="السر السري (Basic-Auth Secret)">
            <Input value={secret} onChange={e => setSecret(e.target.value)} dir="ltr" className="font-mono text-xs" placeholder="ZATCA Secret..." type="password" />
          </Field>
        </div>
        <Field label="الشهادة (Certificate PEM)">
          <Textarea rows={4} value={certPem} onChange={e => setCertPem(e.target.value)} dir="ltr" className="font-mono text-[10px]"
            placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----" />
        </Field>
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending || !certPem || !secret} className="bg-indigo-600 hover:bg-indigo-700">
            {save.isPending ? <Loader2 className="h-4 w-4 ml-1 animate-spin" /> : <Lock className="h-4 w-4 ml-1" />}
            تشفير وحفظ بيانات الاعتماد
          </Button>
        </div>
        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          ⚠️ ملاحظة: حالياً النظام يُرسل XML غير موقّع رقمياً (XAdES). البيئة التجريبية تقبله لاختبار التدفق، لكن إرسال الإنتاج سيُرفض حتى تكتمل المرحلة 1B.3 (التوقيع الرقمي).
        </p>
      </CardContent>
    </Card>
  );
}

// CSR onboarding wizard (Option B). 3 visible steps:
// 1) Generate CSR — server runs openssl with ZATCA-required OIDs.
// 2) Download + submit to ZATCA Fatoora portal (manual step out of band).
// 3) Paste returned CSID/PCSID — same form as manual flow.
function CsrWizard({ client, onSaved }: { client: ClientDetail; onSaved: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [csrPem, setCsrPem] = useState<string | null>(null);
  const [egsSerial, setEgsSerial] = useState<string | null>(client.egsSerial ?? null);
  const [businessCategory, setBusinessCategory] = useState("Retail");
  const [invoiceType, setInvoiceType] = useState("1100");

  const existingCsr = useQuery<{ csrPem: string; egsSerial: string | null }>({
    queryKey: ["gateway-client", client.id, "csr"],
    queryFn: () => api(`/api/admin/gateway-clients/${client.id}/csr`).catch(() => ({ csrPem: "", egsSerial: null })),
    refetchOnWindowFocus: false,
  });

  const generate = useMutation({
    mutationFn: () => api<{ csrPem: string; egsSerial: string }>(`/api/admin/gateway-clients/${client.id}/generate-csr`, {
      method: "POST",
      body: JSON.stringify({ businessCategory, invoiceType }),
    }),
    onSuccess: (d) => {
      setCsrPem(d.csrPem); setEgsSerial(d.egsSerial);
      toast({ title: "تم توليد طلب الشهادة (CSR)", description: "حمّله من الزر أدناه ثم ارفعه على بوابة فاتورة." });
      qc.invalidateQueries({ queryKey: ["gateway-client", client.id, "csr"] });
    },
    onError: (e: Error) => toast({ title: "تعذّر توليد CSR", description: e.message, variant: "destructive" }),
  });

  const csr = csrPem ?? existingCsr.data?.csrPem ?? "";
  const serial = egsSerial ?? existingCsr.data?.egsSerial ?? null;

  const downloadCsr = () => {
    const blob = new Blob([csr], { type: "application/x-pem-file" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${client.vatNumber}-csr.pem`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Stepper visualization */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Step n={1} label="توليد CSR" done={!!csr} active={!csr} />
        <ArrowRight className="h-4 w-4 text-slate-300 shrink-0 rtl:rotate-180" />
        <Step n={2} label="رفع لزاتكا" done={!!csr && client.hasCsid} active={!!csr && !client.hasCsid} />
        <ArrowRight className="h-4 w-4 text-slate-300 shrink-0 rtl:rotate-180" />
        <Step n={3} label="حفظ CSID" done={client.hasCsid} active={!!csr && !client.hasCsid} />
        <ArrowRight className="h-4 w-4 text-slate-300 shrink-0 rtl:rotate-180" />
        <Step n={4} label="ترقية للإنتاج" done={client.hasPcsid} active={client.hasCsid && !client.hasPcsid} />
      </div>

      {/* Step 1: parameters + generate */}
      <Card className="border-violet-200 bg-violet-50/30">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2 font-bold text-violet-900">
            <Wand2 className="h-4 w-4" /> الخطوة 1 — توليد طلب الشهادة (CSR)
          </div>
          <p className="text-xs text-slate-600">
            نُنشئ زوج مفاتيح RSA-2048 + CSR موقّع بحقول زاتكا الإلزامية (EGS Serial، VAT، invoice type).
            المفتاح الخاص يُحفظ مُشفَّراً في قاعدة بياناتنا — لا يخرج أبداً.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="نوع الفاتورة">
              <Select value={invoiceType} onValueChange={setInvoiceType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1100">قياسي + مبسّط (موصى به)</SelectItem>
                  <SelectItem value="1000">قياسي فقط (B2B)</SelectItem>
                  <SelectItem value="0100">مبسّط فقط (B2C)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="فئة النشاط التجاري">
              <Input value={businessCategory} onChange={e => setBusinessCategory(e.target.value)} placeholder="Retail / Wholesale / Services..." />
            </Field>
          </div>
          <Button onClick={() => generate.mutate()} disabled={generate.isPending} className="bg-violet-600 hover:bg-violet-700">
            {generate.isPending ? <Loader2 className="h-4 w-4 ml-1 animate-spin" /> : <Sparkles className="h-4 w-4 ml-1" />}
            {csr ? "إعادة توليد CSR (سيُلغي القديم)" : "توليد CSR الآن"}
          </Button>
          {serial && (
            <div className="text-xs font-mono bg-white border rounded-lg px-3 py-2 text-slate-700" dir="ltr">
              <Hash className="inline h-3 w-3 me-1 text-violet-500" />
              EGS: {serial}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Step 2: download + portal link */}
      {csr && (
        <Card className="border-sky-200 bg-sky-50/30">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2 font-bold text-sky-900">
              <Upload className="h-4 w-4" /> الخطوة 2 — رفع CSR على بوابة فاتورة
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              حمّل ملف CSR، ثم سجّل دخول لـ <a href="https://fatoora.zatca.gov.sa" target="_blank" rel="noopener noreferrer" className="text-sky-700 font-semibold underline">بوابة فاتورة</a> بحساب الشركة، وارفعه في صفحة "تسجيل جهاز جديد". سترجع الشركة بـ CSID + Secret.
            </p>
            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" onClick={downloadCsr} className="border-sky-300">
                <Download className="h-4 w-4 ml-1" />
                تنزيل ملف CSR
              </Button>
              <Button variant="outline" onClick={() => { navigator.clipboard.writeText(csr); toast({ title: "نُسخ CSR للحافظة" }); }}>
                <Copy className="h-4 w-4 ml-1" />
                نسخ نص CSR
              </Button>
              <Button variant="outline" asChild>
                <a href="https://fatoora.zatca.gov.sa" target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 ml-1" />
                  فتح بوابة فاتورة
                </a>
              </Button>
            </div>
            <details className="rounded-lg border bg-white">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">عرض نص CSR</summary>
              <Textarea readOnly value={csr} dir="ltr" className="font-mono text-[10px] leading-tight border-0 rounded-none rounded-b-lg" rows={10} />
            </details>
          </CardContent>
        </Card>
      )}

      {/* Step 3: paste CSID back — reuses manual form */}
      {csr && (
        <Card className="border-emerald-200 bg-emerald-50/30">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2 font-bold text-emerald-900">
              <ShieldCheck className="h-4 w-4" /> الخطوة 3 — لصق CSID المُسترجَع
            </div>
            <p className="text-xs text-slate-600">
              بعد ما تستلم الشركة الـ Compliance CSID من زاتكا، الصقه هنا. المفتاح الخاص محفوظ تلقائياً من الخطوة 1.
              {client.hasCsid && <span className="block mt-1 text-emerald-700 font-semibold">✓ CSID محفوظ بالفعل لهذا العميل.</span>}
            </p>
            <ManualCredentialsForm client={client} onSaved={onSaved} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Step({ n, label, done, active }: { n: number; label: string; done: boolean; active: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 shrink-0 ${done ? "bg-emerald-100 text-emerald-800" : active ? "bg-violet-100 text-violet-800 ring-2 ring-violet-300" : "bg-slate-100 text-slate-500"}`}>
      <span className={`h-5 w-5 rounded-full flex items-center justify-center text-[11px] font-bold ${done ? "bg-emerald-600 text-white" : active ? "bg-violet-600 text-white" : "bg-slate-300 text-white"}`}>
        {done ? <Check className="h-3 w-3" /> : n}
      </span>
      <span className="text-xs font-bold whitespace-nowrap">{label}</span>
    </div>
  );
}

function CredStatus({ label, present }: { label: string; present: boolean }) {
  return (
    <div className={`rounded-lg border p-3 flex items-center gap-2 ${present ? "bg-emerald-50 border-emerald-200" : "bg-slate-50 border-slate-200"}`}>
      {present ? <Check className="h-5 w-5 text-emerald-600" /> : <AlertTriangle className="h-5 w-5 text-slate-400" />}
      <div>
        <div className="text-xs text-slate-500">{label}</div>
        <div className={`text-sm font-medium ${present ? "text-emerald-700" : "text-slate-500"}`}>{present ? "محفوظ" : "غير محفوظ"}</div>
      </div>
    </div>
  );
}

function ApiKeysTab({ clientId }: { clientId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery<{ keys: ApiKey[] }>({
    queryKey: ["gateway-client", clientId, "keys"],
    queryFn: () => api(`/api/admin/gateway-clients/${clientId}/api-keys`),
  });

  const create = useMutation({
    mutationFn: () => api<{ token: string }>(`/api/admin/gateway-clients/${clientId}/api-keys`, { method: "POST", body: JSON.stringify({ label }) }),
    onSuccess: (d) => { setNewToken(d.token); setLabel(""); qc.invalidateQueries({ queryKey: ["gateway-client", clientId, "keys"] }); },
    onError: (e: Error) => toast({ title: "تعذّر الإصدار", description: e.message, variant: "destructive" }),
  });

  const revoke = useMutation({
    mutationFn: (keyId: number) => api(`/api/admin/gateway-clients/${clientId}/api-keys/${keyId}`, { method: "DELETE" }),
    onSuccess: () => { toast({ title: "تم إلغاء المفتاح" }); qc.invalidateQueries({ queryKey: ["gateway-client", clientId, "keys"] }); },
  });

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input placeholder="تسمية للمفتاح (مثل: ERP الإنتاجي)" value={label} onChange={e => setLabel(e.target.value)} />
        <Button onClick={() => create.mutate()} disabled={!label.trim() || create.isPending} className="bg-indigo-600 hover:bg-indigo-700 shrink-0">
          {create.isPending ? <Loader2 className="h-4 w-4 ml-1 animate-spin" /> : <Plus className="h-4 w-4 ml-1" />}
          إصدار مفتاح جديد
        </Button>
      </div>

      {newToken && (
        <div className="rounded-lg border-2 border-dashed border-indigo-300 bg-indigo-50 p-4 space-y-2">
          <div className="flex items-center gap-2 text-indigo-900 font-semibold">
            <KeyRound className="h-5 w-5" />
            <span>المفتاح الجديد — انسخه الآن!</span>
          </div>
          <p className="text-xs text-indigo-700">لن يظهر هذا المفتاح مرة ثانية. شارك هذا التوكن مع العميل بشكل آمن.</p>
          <div className="flex gap-2">
            <Input value={newToken} readOnly className="font-mono text-xs bg-white" dir="ltr" />
            <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(newToken); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setNewToken(null)}>إغلاق</Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>
      ) : (data?.keys ?? []).length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <KeyRound className="h-12 w-12 mx-auto mb-2 text-slate-300" />
          <p>لا توجد مفاتيح API بعد</p>
        </div>
      ) : (
        <div className="space-y-2">
          {data!.keys.map(k => (
            <div key={k.id} className={`rounded-lg border p-3 flex items-center justify-between gap-3 ${k.revokedAt ? "bg-slate-50 border-slate-200 opacity-60" : "bg-white border-slate-200"}`}>
              <div className="flex items-center gap-3 min-w-0">
                <KeyRound className={`h-5 w-5 shrink-0 ${k.revokedAt ? "text-slate-400" : "text-indigo-600"}`} />
                <div className="min-w-0">
                  <div className="font-medium text-sm flex items-center gap-2">
                    {k.label}
                    {k.revokedAt && <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">ملغى</Badge>}
                  </div>
                  <div className="text-xs text-slate-500 font-mono truncate" dir="ltr">{k.keyPrefix}••••••••••••</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    أُنشئ: {new Date(k.createdAt).toLocaleDateString("ar-SA")}
                    {k.lastUsedAt && ` • آخر استخدام: ${new Date(k.lastUsedAt).toLocaleDateString("ar-SA")}`}
                  </div>
                </div>
              </div>
              {!k.revokedAt && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" className="text-rose-600"><Trash2 className="h-4 w-4" /></Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent dir="rtl">
                    <AlertDialogHeader>
                      <AlertDialogTitle>إلغاء المفتاح؟</AlertDialogTitle>
                      <AlertDialogDescription>لن يتمكن العميل من استخدام هذا المفتاح بعد الإلغاء. لا يمكن استعادته.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>تراجع</AlertDialogCancel>
                      <AlertDialogAction onClick={() => revoke.mutate(k.id)} className="bg-rose-600 hover:bg-rose-700">إلغاء المفتاح</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InvoicesTab({ clientId }: { clientId: number }) {
  const { toast } = useToast();
  type Inv = {
    id: number; fileName: string | null; invoiceNumber: string | null;
    totalAmount: string | null; vatAmount: string | null;
    status: string; receivedAt: string; errorMessage: string | null;
    icv: number | null; invoiceFlow: string | null; invoiceType: string | null;
    zatcaUuid: string | null;
  };
  const { data, isLoading } = useQuery<{ invoices: Inv[] }>({
    queryKey: ["gateway-client", clientId, "invoices"],
    queryFn: () => api(`/api/admin/gateway-clients/${clientId}/invoices?limit=200`),
    refetchInterval: 10_000,
  });
  const [filter, setFilter] = useState<"all" | "ok" | "failed">("all");

  const STATUS_CLR: Record<string, string> = {
    received:           "bg-sky-50 text-sky-700 border-sky-200",
    sandbox_cleared:    "bg-violet-50 text-violet-700 border-violet-200",
    queued_for_zatca:   "bg-amber-50 text-amber-700 border-amber-200",
    manual_ack:         "bg-amber-50 text-amber-700 border-amber-200",
    cleared:            "bg-emerald-50 text-emerald-700 border-emerald-200",
    warning:            "bg-orange-50 text-orange-700 border-orange-200",
    sandbox_warning:    "bg-amber-50 text-amber-700 border-amber-200",
    rejected:           "bg-rose-50 text-rose-700 border-rose-200",
    failed:             "bg-rose-50 text-rose-700 border-rose-200",
    submission_failed:  "bg-rose-50 text-rose-700 border-rose-200",
  };
  const STATUS_AR: Record<string, string> = {
    received: "مستلمة", sandbox_cleared: "نجاح (تجربة)", queued_for_zatca: "في الانتظار",
    manual_ack: "إقرار يدوي (لم يُرسل لزاتكا)",
    cleared: "مقبولة من زاتكا", warning: "تحذيرات", sandbox_warning: "تحذيرات (تجربة)",
    rejected: "مرفوضة", failed: "فشل", submission_failed: "فشل الإرسال لزاتكا",
  };

  const downloadCanonical = async (inv: Inv) => {
    try {
      const data = await api<unknown>(`/api/admin/gateway-clients/${clientId}/invoices/${inv.id}/canonical`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `invoice-${inv.invoiceNumber || inv.id}.json`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast({ title: "تعذّر التنزيل", description: (e as Error).message, variant: "destructive" }); }
  };

  if (isLoading) return <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>;
  const all = data?.invoices ?? [];
  const list = all.filter(i => filter === "all" || (filter === "ok" ? i.status === "cleared" || i.status === "sandbox_cleared" : i.status === "rejected" || i.status === "failed"));
  const stats = {
    total: all.length,
    ok: all.filter(i => i.status === "cleared" || i.status === "sandbox_cleared").length,
    failed: all.filter(i => i.status === "rejected" || i.status === "failed").length,
    queued: all.filter(i => i.status === "queued_for_zatca" || i.status === "received").length,
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2">
        <MiniStat label="الإجمالي" value={stats.total} cls="text-slate-700 bg-slate-100" />
        <MiniStat label="ناجحة" value={stats.ok} cls="text-emerald-700 bg-emerald-100" />
        <MiniStat label="فاشلة" value={stats.failed} cls="text-rose-700 bg-rose-100" />
        <MiniStat label="بالانتظار" value={stats.queued} cls="text-amber-700 bg-amber-100" />
      </div>

      <Tabs value={filter} onValueChange={v => setFilter(v as typeof filter)}>
        <TabsList>
          <TabsTrigger value="all">الكل</TabsTrigger>
          <TabsTrigger value="ok">الناجحة</TabsTrigger>
          <TabsTrigger value="failed">الفاشلة</TabsTrigger>
        </TabsList>
      </Tabs>

      {list.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <FileText className="h-12 w-12 mx-auto mb-2 text-slate-300" />
          <p>لا توجد فواتير</p>
        </div>
      ) : (
        <div className="space-y-2 max-h-[500px] overflow-y-auto">
          {list.map(inv => (
            <div key={inv.id} className="rounded-lg border bg-white p-3 flex items-center justify-between gap-3 hover:shadow-sm transition-shadow">
              <div className="flex items-center gap-3 min-w-0">
                <FileText className="h-5 w-5 text-slate-400 shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate flex items-center gap-2">
                    {inv.invoiceNumber ?? inv.fileName ?? `#${inv.id}`}
                    {inv.icv != null && <span className="text-[10px] text-violet-600 font-mono bg-violet-50 px-1.5 py-0.5 rounded">ICV: {inv.icv}</span>}
                    {inv.invoiceFlow && <span className="text-[10px] text-slate-500 font-mono bg-slate-100 px-1.5 py-0.5 rounded">{inv.invoiceFlow === "standard" ? "B2B" : "B2C"}</span>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {new Date(inv.receivedAt).toLocaleString("ar-SA")}
                    {inv.zatcaUuid && <span className="ml-2 font-mono text-[10px]" dir="ltr">{inv.zatcaUuid.slice(0, 8)}...</span>}
                  </div>
                  {inv.errorMessage && <div className="text-xs text-rose-600 mt-0.5">{inv.errorMessage}</div>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {inv.totalAmount && <span className="font-mono text-sm text-slate-700 hidden sm:inline">{Number(inv.totalAmount).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
                <Badge variant="outline" className={STATUS_CLR[inv.status] ?? "bg-slate-50"}>{STATUS_AR[inv.status] ?? inv.status}</Badge>
                <Button
                  variant="ghost" size="icon"
                  onClick={() => window.open(`/admin/gateway-clients/${clientId}/invoices/${inv.id}`, "_blank")}
                  title="عرض الفاتورة الجميلة"
                  className="text-indigo-600 hover:bg-indigo-50"
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => downloadCanonical(inv)} title="تنزيل البيانات الكاملة">
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={`rounded-lg p-2 text-center ${cls}`}>
      <div className="font-mono text-lg font-bold leading-none">{value.toLocaleString("ar-EG")}</div>
      <div className="text-[10px] mt-1 opacity-80">{label}</div>
    </div>
  );
}
