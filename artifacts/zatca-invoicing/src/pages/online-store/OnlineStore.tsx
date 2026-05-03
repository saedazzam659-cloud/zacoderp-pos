import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Store, Plus, Pencil, Trash2, Loader2, Globe, Package, ShoppingCart,
  CreditCard, Sparkles, Check, X, RefreshCw, TrendingUp, AlertTriangle,
  Eye, EyeOff, Search, ExternalLink, ShieldCheck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type StoreT = {
  id: number; name: string; slug: string; currency: string; language: string;
  theme: string; logoUrl: string | null; description: string | null;
  contactEmail: string | null; contactPhone: string | null;
  isActive: boolean; createdAt: string;
  products?: number; orders?: number; openOrders?: number;
};
type DomainT = { id: number; domain: string; type: string; status: string; isPrimary: boolean; verifiedAt: string | null };
type StoreProduct = {
  id: number; productId: number; price: string; comparePrice: string | null;
  isVisible: boolean; imageUrl: string | null;
  descriptionAr: string | null; descriptionEn: string | null; sortOrder: number;
  itemNameAr: string | null; itemNameEn: string | null; itemCode: string | null;
  itemBarcode: string | null; itemSalePrice: string | null; itemImageUrl: string | null;
};
type Item = { id: number; code: string; nameAr: string; nameEn: string | null; salePrice: string; imageUrl: string | null };
type Order = {
  id: number; code: string; customerName: string; customerPhone: string | null;
  total: string; status: string; paymentMethod: string; paymentStatus: string;
  trackingNumber: string | null; createdAt: string;
};
type PaymentSetting = {
  gateway: string; isEnabled: boolean; environment: string; displayName: string | null; hasConfig: boolean;
};

const GATEWAYS: Array<{ key: string; label: string; type: "local" | "intl" | "other" }> = [
  { key: "mada",          label: "مدى",                   type: "local" },
  { key: "stcpay",        label: "STC Pay",                type: "local" },
  { key: "applepay",      label: "Apple Pay",              type: "local" },
  { key: "sadad",         label: "سداد",                   type: "local" },
  { key: "tamara",        label: "تمارا (تقسيط)",          type: "local" },
  { key: "tabby",         label: "تابي (تقسيط)",           type: "local" },
  { key: "stripe",        label: "Stripe",                 type: "intl"  },
  { key: "paypal",        label: "PayPal",                 type: "intl"  },
  { key: "bank_transfer", label: "تحويل بنكي",             type: "other" },
  { key: "cod",           label: "الدفع عند الاستلام (COD)", type: "other" },
];

const ORDER_STATUSES = [
  { key: "new",       label: "جديد",      color: "bg-blue-500" },
  { key: "confirmed", label: "مؤكد",      color: "bg-amber-500" },
  { key: "shipped",   label: "تم الشحن",  color: "bg-indigo-500" },
  { key: "delivered", label: "تم التسليم", color: "bg-emerald-600" },
  { key: "cancelled", label: "ملغي",      color: "bg-red-500" },
];

export default function OnlineStore() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const [activeStoreId, setActiveStoreId] = useState<number | null>(null);
  const [tab, setTab] = useState<"dashboard" | "products" | "orders" | "domains" | "payments" | "ai">("dashboard");
  const [showStoreDialog, setShowStoreDialog] = useState(false);
  const [editingStore, setEditingStore] = useState<StoreT | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StoreT | null>(null);

  const storesQ = useQuery<{ stores: StoreT[] }>({
    queryKey: ["os-stores"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/online-store/stores`, { headers });
      if (!r.ok) throw new Error("فشل تحميل المتاجر");
      return r.json();
    },
  });

  useEffect(() => {
    if (!activeStoreId && storesQ.data?.stores?.length) {
      setActiveStoreId(storesQ.data.stores[0].id);
    }
  }, [storesQ.data, activeStoreId]);

  const activeStore = storesQ.data?.stores.find(s => s.id === activeStoreId);

  const deleteStoreM = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/online-store/stores/${id}`, { method: "DELETE", headers });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "فشل الحذف"); }
    },
    onSuccess: () => {
      toast({ title: "تم حذف المتجر" });
      setConfirmDelete(null);
      setActiveStoreId(null);
      qc.invalidateQueries({ queryKey: ["os-stores"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6 p-4 md:p-6" dir="rtl">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <Store className="w-7 h-7 text-primary" />
            المتجر الإلكتروني
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            أنشئ متاجر إلكترونية متعددة، اربط دومينك، ابع منتجاتك من المخزون مباشرة، وحلّل أدائك بالذكاء الاصطناعي.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => storesQ.refetch()} data-testid="btn-refresh">
            <RefreshCw className="w-4 h-4 me-1" /> تحديث
          </Button>
          <Button onClick={() => { setEditingStore(null); setShowStoreDialog(true); }} data-testid="btn-new-store">
            <Plus className="w-4 h-4 me-1" /> متجر جديد
          </Button>
        </div>
      </div>

      {storesQ.isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground p-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" /> جاري التحميل...
        </div>
      ) : !storesQ.data?.stores.length ? (
        <Card>
          <CardContent className="p-12 text-center space-y-4">
            <Store className="w-16 h-16 text-muted-foreground/40 mx-auto" />
            <div>
              <h3 className="text-lg font-semibold">لا يوجد متاجر بعد</h3>
              <p className="text-sm text-muted-foreground mt-1">ابدأ بإنشاء متجرك الإلكتروني الأول لتفعيل المبيعات أونلاين.</p>
            </div>
            <Button onClick={() => { setEditingStore(null); setShowStoreDialog(true); }}>
              <Plus className="w-4 h-4 me-1" /> أنشئ متجر الآن
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Stores grid */}
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {storesQ.data!.stores.map(s => (
              <Card
                key={s.id}
                className={`cursor-pointer transition-all hover:shadow-md ${activeStoreId === s.id ? "ring-2 ring-primary" : ""}`}
                onClick={() => setActiveStoreId(s.id)}
                data-testid={`card-store-${s.id}`}
              >
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-bold truncate">{s.name}</h3>
                      <div className="text-[11px] text-muted-foreground font-mono mt-0.5">{s.slug}.zacoderp.com</div>
                    </div>
                    <Badge variant={s.isActive ? "default" : "secondary"}>
                      {s.isActive ? "نشط" : "موقوف"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs pt-2 border-t">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Package className="w-3.5 h-3.5" /> {s.products ?? 0} منتج
                    </span>
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <ShoppingCart className="w-3.5 h-3.5" /> {s.orders ?? 0} طلب
                    </span>
                    {!!s.openOrders && (
                      <Badge variant="outline" className="text-[10px]">{s.openOrders} مفتوح</Badge>
                    )}
                  </div>
                  <div className="flex gap-1 pt-2 justify-end">
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setEditingStore(s); setShowStoreDialog(true); }}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setConfirmDelete(s); }}>
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {activeStore && (
            <div className="border-t pt-4">
              <div className="mb-3 flex items-center gap-2">
                <Store className="w-4 h-4 text-primary" />
                <span className="font-semibold">{activeStore.name}</span>
                <a
                  href={`https://${activeStore.slug}.zacoderp.com`}
                  target="_blank" rel="noreferrer"
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" /> فتح المتجر (قيد التطوير)
                </a>
              </div>
              <Tabs value={tab} onValueChange={(v: any) => setTab(v)}>
                <TabsList className="w-full justify-start overflow-x-auto">
                  <TabsTrigger value="dashboard"><TrendingUp className="w-4 h-4 me-1" />لوحة التحكم</TabsTrigger>
                  <TabsTrigger value="products"><Package className="w-4 h-4 me-1" />المنتجات</TabsTrigger>
                  <TabsTrigger value="orders"><ShoppingCart className="w-4 h-4 me-1" />الطلبات</TabsTrigger>
                  <TabsTrigger value="domains"><Globe className="w-4 h-4 me-1" />الدومينات</TabsTrigger>
                  <TabsTrigger value="payments"><CreditCard className="w-4 h-4 me-1" />الدفع</TabsTrigger>
                  <TabsTrigger value="ai"><Sparkles className="w-4 h-4 me-1" />الذكاء الاصطناعي</TabsTrigger>
                </TabsList>
                <TabsContent value="dashboard"><DashboardTab storeId={activeStore.id} headers={headers} /></TabsContent>
                <TabsContent value="products"><ProductsTab storeId={activeStore.id} headers={headers} /></TabsContent>
                <TabsContent value="orders"><OrdersTab storeId={activeStore.id} headers={headers} /></TabsContent>
                <TabsContent value="domains"><DomainsTab storeId={activeStore.id} headers={headers} storeSlug={activeStore.slug} /></TabsContent>
                <TabsContent value="payments"><PaymentsTab storeId={activeStore.id} headers={headers} /></TabsContent>
                <TabsContent value="ai"><AiTab storeId={activeStore.id} headers={headers} /></TabsContent>
              </Tabs>
            </div>
          )}
        </>
      )}

      {showStoreDialog && (
        <StoreDialog
          store={editingStore}
          headers={headers}
          onClose={() => setShowStoreDialog(false)}
          onSaved={(saved) => {
            setShowStoreDialog(false);
            qc.invalidateQueries({ queryKey: ["os-stores"] });
            if (saved?.id) setActiveStoreId(saved.id);
          }}
        />
      )}

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف المتجر "{confirmDelete?.name}"؟</AlertDialogTitle>
            <AlertDialogDescription>
              سيتم حذف جميع المنتجات والطلبات والدومينات وإعدادات الدفع المرتبطة به. لا يمكن التراجع عن هذه العملية.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmDelete && deleteStoreM.mutate(confirmDelete.id)}>
              نعم، احذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Store Create/Edit Dialog ────────────────────────────────────────────
function StoreDialog({ store, headers, onClose, onSaved }: {
  store: StoreT | null; headers: Record<string, string>;
  onClose: () => void; onSaved: (saved?: StoreT) => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(store?.name ?? "");
  const [slug, setSlug] = useState(store?.slug ?? "");
  const [currency, setCurrency] = useState(store?.currency ?? "SAR");
  const [language, setLanguage] = useState(store?.language ?? "ar");
  const [theme, setTheme] = useState(store?.theme ?? "modern");
  const [description, setDescription] = useState(store?.description ?? "");
  const [contactEmail, setContactEmail] = useState(store?.contactEmail ?? "");
  const [contactPhone, setContactPhone] = useState(store?.contactPhone ?? "");
  const [isActive, setIsActive] = useState(store?.isActive ?? true);
  const [saving, setSaving] = useState(false);

  const autoSlug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42);

  const save = async () => {
    setSaving(true);
    try {
      const url = store ? `${API}/api/online-store/stores/${store.id}` : `${API}/api/online-store/stores`;
      const method = store ? "PATCH" : "POST";
      const body = { name, slug: slug || autoSlug(name), currency, language, theme, description, contactEmail, contactPhone, isActive };
      const r = await fetch(url, { method, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "فشل الحفظ"); }
      const j = await r.json();
      toast({ title: store ? "تم تحديث المتجر" : "تم إنشاء المتجر بنجاح" });
      onSaved(j.store);
    } catch (e: any) { toast({ title: "خطأ", description: e.message, variant: "destructive" }); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{store ? "تعديل المتجر" : "متجر إلكتروني جديد"}</DialogTitle>
          <DialogDescription>
            عرّف اسم المتجر، الرابط (سيكون subdomain تلقائياً)، اللغة والعملة والقالب.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label>اسم المتجر *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="متجر الأناقة" data-testid="input-store-name" />
          </div>
          <div>
            <Label>الرابط (slug) *</Label>
            <Input
              value={slug}
              onChange={(e) => setSlug(autoSlug(e.target.value))}
              placeholder="elegance"
              data-testid="input-store-slug"
              dir="ltr"
            />
            <div className="text-[11px] text-muted-foreground mt-1">
              يُستخدم كنطاق فرعي للمتجر، لذا يقبل الحروف الإنجليزية الصغيرة والأرقام والشرطة (-) فقط. الحروف العربية والمسافات تُحذف تلقائياً.
            </div>
            {(slug || name) && (
              <div className="text-[11px] text-muted-foreground mt-1 font-mono" dir="ltr">
                {(slug || autoSlug(name))}.zacoderp.com
              </div>
            )}
          </div>
          <div>
            <Label>العملة</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="SAR">ريال سعودي (SAR)</SelectItem>
                <SelectItem value="AED">درهم إماراتي (AED)</SelectItem>
                <SelectItem value="USD">دولار (USD)</SelectItem>
                <SelectItem value="EUR">يورو (EUR)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>اللغة</Label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ar">العربية</SelectItem>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="ar+en">عربي + إنجليزي</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>القالب</Label>
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="modern">عصري (Modern)</SelectItem>
                <SelectItem value="classic">كلاسيكي (Classic)</SelectItem>
                <SelectItem value="minimal">بسيط (Minimal)</SelectItem>
                <SelectItem value="luxury">فاخر (Luxury)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 pt-6">
            <Switch checked={isActive} onCheckedChange={setIsActive} />
            <Label>متجر نشط</Label>
          </div>
          <div>
            <Label>بريد التواصل</Label>
            <Input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} type="email" dir="ltr" />
          </div>
          <div>
            <Label>هاتف التواصل</Label>
            <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} dir="ltr" />
          </div>
          <div className="md:col-span-2">
            <Label>وصف المتجر</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>إلغاء</Button>
          <Button onClick={save} disabled={saving || !name} data-testid="btn-save-store">
            {saving && <Loader2 className="w-4 h-4 me-1 animate-spin" />} حفظ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Dashboard tab ──────────────────────────────────────────────────────
function DashboardTab({ storeId, headers }: { storeId: number; headers: Record<string, string> }) {
  const { data, isLoading } = useQuery<{ kpis: any; recentOrders: Order[] }>({
    queryKey: ["os-dash", storeId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/online-store/stores/${storeId}/dashboard`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });
  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground p-8"><Loader2 className="w-4 h-4 animate-spin" /> جاري التحميل...</div>;
  const k = data?.kpis ?? {};
  const cards = [
    { label: "إجمالي الطلبات",   value: k.orders ?? 0,        icon: ShoppingCart, color: "text-blue-600 bg-blue-50" },
    { label: "طلبات مفتوحة",      value: k.openOrders ?? 0,    icon: AlertTriangle, color: "text-amber-600 bg-amber-50" },
    { label: "الإيرادات (مؤكدة)", value: `${Number(k.revenue ?? 0).toFixed(2)} ر.س`, icon: TrendingUp, color: "text-emerald-600 bg-emerald-50" },
    { label: "منتجات منشورة",     value: `${k.visibleProducts ?? 0} / ${k.products ?? 0}`, icon: Package, color: "text-indigo-600 bg-indigo-50" },
  ];
  return (
    <div className="space-y-4 mt-4">
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        {cards.map(c => (
          <Card key={c.label}>
            <CardContent className="p-4 flex items-center justify-between">
              <div>
                <div className="text-xs text-muted-foreground">{c.label}</div>
                <div className="text-2xl font-bold mt-1">{c.value}</div>
              </div>
              <div className={`p-3 rounded-lg ${c.color}`}>
                <c.icon className="w-6 h-6" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">آخر الطلبات</CardTitle></CardHeader>
        <CardContent>
          {!data?.recentOrders.length ? (
            <div className="text-center py-8 text-muted-foreground text-sm">لا توجد طلبات بعد</div>
          ) : (
            <div className="space-y-1.5">
              {data.recentOrders.map(o => <OrderRow key={o.id} order={o} />)}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function statusBadge(status: string) {
  const def = ORDER_STATUSES.find(s => s.key === status);
  return <Badge className={`${def?.color || "bg-gray-500"} text-white text-[10px]`}>{def?.label || status}</Badge>;
}
function OrderRow({ order, onClick }: { order: Order; onClick?: () => void }) {
  return (
    <div
      className={`flex items-center justify-between p-2 rounded border bg-card hover:bg-muted/40 ${onClick ? "cursor-pointer" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-mono text-xs text-muted-foreground w-20 truncate">{order.code}</span>
        <span className="text-sm font-medium truncate">{order.customerName}</span>
        {statusBadge(order.status)}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span className="font-bold text-primary">{Number(order.total).toFixed(2)}</span>
        <span className="text-xs text-muted-foreground">ر.س</span>
      </div>
    </div>
  );
}

// ─── Products tab ───────────────────────────────────────────────────────
function ProductsTab({ storeId, headers }: { storeId: number; headers: Record<string, string> }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const productsQ = useQuery<{ products: StoreProduct[] }>({
    queryKey: ["os-products", storeId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/online-store/stores/${storeId}/products`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const updateM = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: any }) => {
      const r = await fetch(`${API}/api/online-store/products/${id}`, {
        method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["os-products", storeId] }),
  });

  const removeM = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/online-store/products/${id}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error();
    },
    onSuccess: () => { toast({ title: "تم إزالة المنتج" }); qc.invalidateQueries({ queryKey: ["os-products", storeId] }); },
  });

  return (
    <div className="space-y-3 mt-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{productsQ.data?.products.length ?? 0} منتج منشور</div>
        <Button onClick={() => setPickerOpen(true)} data-testid="btn-add-products">
          <Plus className="w-4 h-4 me-1" /> أضف منتجات من المخزون
        </Button>
      </div>
      {productsQ.isLoading ? (
        <div className="p-8 text-center"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
      ) : !productsQ.data?.products.length ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">
          لا منتجات منشورة بعد. اضغط "أضف منتجات من المخزون" للبدء.
        </CardContent></Card>
      ) : (
        <div className="grid gap-2">
          {productsQ.data.products.map(p => (
            <Card key={p.id}>
              <CardContent className="p-3 flex items-center gap-3">
                <div className="w-12 h-12 rounded bg-muted flex items-center justify-center overflow-hidden flex-shrink-0">
                  {p.imageUrl || p.itemImageUrl ? (
                    <img src={p.imageUrl ?? p.itemImageUrl ?? ""} alt="" className="w-full h-full object-cover" />
                  ) : <Package className="w-5 h-5 text-muted-foreground" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{p.itemNameAr}</div>
                  <div className="text-[11px] font-mono text-muted-foreground">{p.itemCode}</div>
                </div>
                <Input
                  type="number" step="0.01" defaultValue={p.price}
                  onBlur={(e) => { const v = e.target.value; if (v !== p.price) updateM.mutate({ id: p.id, patch: { price: v } }); }}
                  className="w-28 text-sm"
                  data-testid={`input-price-${p.id}`}
                />
                <Button
                  size="sm" variant="ghost"
                  onClick={() => updateM.mutate({ id: p.id, patch: { isVisible: !p.isVisible } })}
                  title={p.isVisible ? "إخفاء" : "إظهار"}
                >
                  {p.isVisible ? <Eye className="w-4 h-4 text-emerald-600" /> : <EyeOff className="w-4 h-4 text-muted-foreground" />}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => removeM.mutate(p.id)}>
                  <Trash2 className="w-4 h-4 text-red-500" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {pickerOpen && (
        <ProductPicker
          storeId={storeId}
          headers={headers}
          existingIds={new Set((productsQ.data?.products ?? []).map(p => p.productId))}
          onClose={() => setPickerOpen(false)}
          onSaved={() => { setPickerOpen(false); qc.invalidateQueries({ queryKey: ["os-products", storeId] }); }}
        />
      )}
    </div>
  );
}

function ProductPicker({ storeId, headers, existingIds, onClose, onSaved }: {
  storeId: number; headers: Record<string, string>; existingIds: Set<number>;
  onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const itemsQ = useQuery<Item[]>({
    queryKey: ["os-items"],
    queryFn: async () => {
      const r = await fetch(`${API}/api/inventory/items`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });
  const filtered = useMemo(() => {
    const list = (itemsQ.data ?? []).filter(i => !existingIds.has(i.id));
    const q = search.trim().toLowerCase();
    return q ? list.filter(i => [i.code, i.nameAr, i.nameEn].some(v => v && String(v).toLowerCase().includes(q))) : list;
  }, [itemsQ.data, search, existingIds]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/api/online-store/stores/${storeId}/products`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: Array.from(picked) }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "فشل الحفظ"); }
      toast({ title: `تم نشر ${picked.size} منتج` });
      onSaved();
    } catch (e: any) { toast({ title: "خطأ", description: e.message, variant: "destructive" }); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-xl">
        <DialogHeader>
          <DialogTitle>نشر منتجات على المتجر</DialogTitle>
          <DialogDescription>اختر المنتجات من المخزون لإضافتها إلى الكتالوج.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-2.5 text-muted-foreground" />
          <Input className="ps-8" placeholder="ابحث بالاسم أو الكود..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="max-h-[360px] overflow-y-auto border rounded divide-y">
          {itemsQ.isLoading ? (
            <div className="p-6 text-center"><Loader2 className="w-4 h-4 animate-spin inline" /></div>
          ) : !filtered.length ? (
            <div className="p-6 text-center text-muted-foreground text-sm">لا منتجات مطابقة</div>
          ) : filtered.map(i => {
            const checked = picked.has(i.id);
            return (
              <label key={i.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40 ${checked ? "bg-primary/5" : ""}`}>
                <Checkbox checked={checked} onCheckedChange={() => {
                  setPicked(prev => { const n = new Set(prev); n.has(i.id) ? n.delete(i.id) : n.add(i.id); return n; });
                }} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{i.nameAr}</div>
                  <div className="text-[11px] font-mono text-muted-foreground">{i.code} · {i.salePrice} ر.س</div>
                </div>
                {checked && <Check className="w-4 h-4 text-primary" />}
              </label>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>إلغاء</Button>
          <Button onClick={save} disabled={saving || !picked.size}>
            {saving && <Loader2 className="w-4 h-4 me-1 animate-spin" />} نشر ({picked.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Orders tab ──────────────────────────────────────────────────────────
function OrdersTab({ storeId, headers }: { storeId: number; headers: Record<string, string> }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [openOrder, setOpenOrder] = useState<number | null>(null);

  const ordersQ = useQuery<{ orders: Order[] }>({
    queryKey: ["os-orders", storeId, statusFilter],
    queryFn: async () => {
      const qs = statusFilter !== "all" ? `?status=${statusFilter}` : "";
      const r = await fetch(`${API}/api/online-store/stores/${storeId}/orders${qs}`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const confirmM = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/online-store/orders/${id}/confirm`, { method: "POST", headers });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "فشل التأكيد"); }
      return r.json();
    },
    onSuccess: (j) => {
      toast({ title: "تم تأكيد الطلب وإصدار فاتورة", description: `الفاتورة: ${j.invoice?.invoiceNumber}` });
      qc.invalidateQueries({ queryKey: ["os-orders", storeId] });
      qc.invalidateQueries({ queryKey: ["os-dash", storeId] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const updateM = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: any }) => {
      const r = await fetch(`${API}/api/online-store/orders/${id}`, {
        method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["os-orders", storeId] }),
  });

  return (
    <div className="space-y-3 mt-4">
      <div className="flex items-center gap-2 overflow-x-auto">
        <Button size="sm" variant={statusFilter === "all" ? "default" : "outline"} onClick={() => setStatusFilter("all")}>الكل</Button>
        {ORDER_STATUSES.map(s => (
          <Button key={s.key} size="sm" variant={statusFilter === s.key ? "default" : "outline"} onClick={() => setStatusFilter(s.key)}>
            {s.label}
          </Button>
        ))}
      </div>
      {ordersQ.isLoading ? (
        <div className="p-8 text-center"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
      ) : !ordersQ.data?.orders.length ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">لا طلبات في هذه الحالة</CardContent></Card>
      ) : (
        <div className="space-y-1.5">
          {ordersQ.data.orders.map(o => (
            <Card key={o.id}>
              <CardContent className="p-3 flex flex-wrap items-center gap-3">
                <span className="font-mono text-xs text-muted-foreground w-24">{o.code}</span>
                <div className="flex-1 min-w-[140px]">
                  <div className="font-medium text-sm">{o.customerName}</div>
                  <div className="text-[11px] text-muted-foreground">{o.customerPhone || ""}</div>
                </div>
                {statusBadge(o.status)}
                <div className="text-sm font-bold text-primary">{Number(o.total).toFixed(2)} ر.س</div>
                <div className="flex gap-1">
                  {o.status === "new" && (
                    <Button size="sm" onClick={() => confirmM.mutate(o.id)} disabled={confirmM.isPending}>
                      <ShieldCheck className="w-4 h-4 me-1" /> تأكيد
                    </Button>
                  )}
                  {o.status === "confirmed" && (
                    <Button size="sm" variant="outline" onClick={() => updateM.mutate({ id: o.id, patch: { status: "shipped" } })}>
                      شحن
                    </Button>
                  )}
                  {o.status === "shipped" && (
                    <Button size="sm" variant="outline" onClick={() => updateM.mutate({ id: o.id, patch: { status: "delivered" } })}>
                      تسليم
                    </Button>
                  )}
                  {(o.status === "new" || o.status === "confirmed") && (
                    <Button size="sm" variant="ghost" onClick={() => updateM.mutate({ id: o.id, patch: { status: "cancelled" } })}>
                      <X className="w-4 h-4 text-red-500" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Domains tab ─────────────────────────────────────────────────────────
function DomainsTab({ storeId, headers, storeSlug }: { storeId: number; headers: Record<string, string>; storeSlug: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [newDomain, setNewDomain] = useState("");
  const [type, setType] = useState<"custom" | "subdomain">("custom");

  const q = useQuery<{ domains: DomainT[] }>({
    queryKey: ["os-domains", storeId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/online-store/stores/${storeId}/domains`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const addM = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/online-store/stores/${storeId}/domains`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ domain: newDomain.trim(), type }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "فشل الإضافة"); }
    },
    onSuccess: () => { toast({ title: "تم إضافة الدومين" }); setNewDomain(""); qc.invalidateQueries({ queryKey: ["os-domains", storeId] }); },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const verifyM = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/online-store/domains/${id}/verify`, { method: "POST", headers });
      if (!r.ok) throw new Error();
    },
    onSuccess: () => { toast({ title: "تم التحقق" }); qc.invalidateQueries({ queryKey: ["os-domains", storeId] }); },
  });

  const removeM = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/online-store/domains/${id}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["os-domains", storeId] }),
  });

  return (
    <div className="space-y-3 mt-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="text-sm">
            <span className="text-muted-foreground">الدومين الافتراضي:</span>{" "}
            <span className="font-mono" dir="ltr">{storeSlug}.zacoderp.com</span>
          </div>
          <div className="flex gap-2 flex-col md:flex-row">
            <Select value={type} onValueChange={(v: any) => setType(v)}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">دومين مخصص</SelectItem>
                <SelectItem value="subdomain">Subdomain إضافي</SelectItem>
              </SelectContent>
            </Select>
            <Input
              dir="ltr" placeholder="shop.example.com"
              value={newDomain} onChange={(e) => setNewDomain(e.target.value)}
              data-testid="input-domain"
            />
            <Button onClick={() => addM.mutate()} disabled={!newDomain || addM.isPending}>
              <Plus className="w-4 h-4 me-1" /> إضافة
            </Button>
          </div>
          {type === "custom" && (
            <div className="text-[11px] bg-amber-50 border border-amber-200 text-amber-900 rounded p-2">
              تعليمات الربط: أنشئ سجل CNAME في DNS الخاص بدومينك يشير إلى{" "}
              <span className="font-mono" dir="ltr">stores.zacoderp.com</span> ثم اضغط "تحقق".
            </div>
          )}
        </CardContent>
      </Card>
      <div className="space-y-1.5">
        {q.data?.domains.map(d => (
          <Card key={d.id}>
            <CardContent className="p-3 flex items-center gap-3">
              <Globe className="w-4 h-4 text-primary" />
              <span className="font-mono text-sm flex-1" dir="ltr">{d.domain}</span>
              <Badge variant="outline">{d.type === "subdomain" ? "Subdomain" : "Custom"}</Badge>
              <Badge className={d.status === "active" ? "bg-emerald-600" : "bg-amber-500"}>
                {d.status === "active" ? "مفعّل" : "بانتظار التحقق"}
              </Badge>
              {d.status !== "active" && (
                <Button size="sm" variant="outline" onClick={() => verifyM.mutate(d.id)}>تحقق</Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => removeM.mutate(d.id)}>
                <Trash2 className="w-4 h-4 text-red-500" />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── Payments tab ────────────────────────────────────────────────────────
function PaymentsTab({ storeId, headers }: { storeId: number; headers: Record<string, string> }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery<{ settings: PaymentSetting[] }>({
    queryKey: ["os-payments", storeId],
    queryFn: async () => {
      const r = await fetch(`${API}/api/online-store/stores/${storeId}/payments`, { headers });
      if (!r.ok) throw new Error();
      return r.json();
    },
  });

  const saveM = useMutation({
    mutationFn: async ({ gateway, body }: { gateway: string; body: any }) => {
      const r = await fetch(`${API}/api/online-store/stores/${storeId}/payments/${gateway}`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error();
    },
    onSuccess: () => { toast({ title: "تم الحفظ" }); qc.invalidateQueries({ queryKey: ["os-payments", storeId] }); },
  });

  const groups: Array<{ title: string; type: "local" | "intl" | "other" }> = [
    { title: "بوابات محلية (سعودية)", type: "local" },
    { title: "بوابات عالمية",          type: "intl" },
    { title: "أخرى",                    type: "other" },
  ];

  return (
    <div className="space-y-4 mt-4">
      <div className="text-xs bg-blue-50 border border-blue-200 text-blue-900 rounded p-3">
        فعّل البوابات التي تريد قبولها على متجرك. التكامل الفعلي مع كل بوابة (تمرير المفاتيح، توقيع المعاملات) سيُنشّط على مراحل — للبدء يمكنك تشغيل "الدفع عند الاستلام (COD)" والتحويل البنكي بدون أي تهيئة إضافية.
      </div>
      {groups.map(g => (
        <Card key={g.type}>
          <CardHeader><CardTitle className="text-base">{g.title}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {GATEWAYS.filter(x => x.type === g.type).map(gw => {
              const cur = q.data?.settings.find(s => s.gateway === gw.key);
              return (
                <div key={gw.key} className="flex items-center justify-between p-2 rounded border">
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={!!cur?.isEnabled}
                      onCheckedChange={(v) => saveM.mutate({ gateway: gw.key, body: { isEnabled: v, environment: cur?.environment || "test" } })}
                      data-testid={`toggle-${gw.key}`}
                    />
                    <div>
                      <div className="text-sm font-medium">{gw.label}</div>
                      <div className="text-[11px] text-muted-foreground">{gw.key}</div>
                    </div>
                  </div>
                  <Select
                    value={cur?.environment || "test"}
                    onValueChange={(v) => saveM.mutate({ gateway: gw.key, body: { isEnabled: !!cur?.isEnabled, environment: v } })}
                  >
                    <SelectTrigger className="w-28 h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="test">تجريبي</SelectItem>
                      <SelectItem value="live">حقيقي</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── AI tab ──────────────────────────────────────────────────────────────
function AiTab({ storeId, headers }: { storeId: number; headers: Record<string, string> }) {
  const analysisQ = useQuery<any>({
    queryKey: ["os-ai-analysis", storeId],
    queryFn: async () => (await fetch(`${API}/api/online-store-ai/stores/${storeId}/sales-analysis`, { headers })).json(),
  });
  const recoQ = useQuery<any>({
    queryKey: ["os-ai-reco", storeId],
    queryFn: async () => (await fetch(`${API}/api/online-store-ai/stores/${storeId}/recommend-products`, { headers })).json(),
  });
  const stockQ = useQuery<any>({
    queryKey: ["os-ai-stock", storeId],
    queryFn: async () => (await fetch(`${API}/api/online-store-ai/stores/${storeId}/low-stock`, { headers })).json(),
  });

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" /> رؤى المبيعات الذكية
          </CardTitle>
        </CardHeader>
        <CardContent>
          {analysisQ.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : (
            <div className="space-y-3">
              <ul className="space-y-1.5 text-sm">
                {(analysisQ.data?.insights ?? []).map((s: string, i: number) => (
                  <li key={i} className="flex gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
              {!!analysisQ.data?.topProducts?.length && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5">أعلى المنتجات مبيعاً:</div>
                  <div className="space-y-1">
                    {analysisQ.data.topProducts.slice(0, 5).map((p: any, i: number) => (
                      <div key={i} className="flex items-center justify-between text-sm border rounded p-2">
                        <span>{p.name}</span>
                        <span className="font-mono text-primary">{Number(p.revenue).toFixed(2)} ر.س</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="w-4 h-4 text-primary" /> منتجات يُقترح نشرها
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recoQ.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : !recoQ.data?.recommendations?.length ? (
            <div className="text-sm text-muted-foreground">جميع منتجاتك منشورة.</div>
          ) : (
            <div className="space-y-1.5">
              {recoQ.data.recommendations.map((r: any) => (
                <div key={r.id} className="flex items-start gap-3 p-2 border rounded">
                  <Badge variant="outline">{r.score}</Badge>
                  <div className="flex-1">
                    <div className="text-sm font-medium">{r.nameAr}</div>
                    <div className="text-[11px] text-muted-foreground">{r.reason}</div>
                  </div>
                  <span className="text-sm font-mono text-primary">{Number(r.salePrice).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" /> تنبيهات نقص المخزون
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stockQ.isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : !stockQ.data?.alerts?.length ? (
            <div className="text-sm text-muted-foreground">لا تنبيهات حالياً.</div>
          ) : (
            <div className="space-y-1.5">
              {stockQ.data.alerts.map((a: any) => (
                <div key={a.productId} className="flex items-center justify-between p-2 border rounded">
                  <div>
                    <div className="text-sm font-medium">{a.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      مبيعات 30 يوم: {a.sold30} · معدل يومي: {a.dailyRate} · حد إعادة الطلب: {a.reorderLevel}
                    </div>
                  </div>
                  <Badge className={a.severity === "critical" ? "bg-red-500" : "bg-amber-500"}>
                    {a.severity === "critical" ? "حرج" : "تحذير"} · {a.projectedDaysLeft} يوم
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
