import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Store, Plus, Pencil, Trash2, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  useAdminListings,
  useAdminSales,
  useSaveListing,
  useDeleteListing,
  type AdminListing,
  type PricingModel,
  type ListingStatus,
} from "@/extensions/marketplaceApi";

// ─────────────────────────────────────────────────────────────────────────
// MarketplaceAdmin — Phase 4 SuperAdmin Control Center (إدارة المتجر).
//
// SA lists developers' extensions on the store (pricing, commission, status),
// and reviews the sales & commission breakdown that feeds the developer
// commission ledger (partner_commissions). 100% additive, SA-only.
// ─────────────────────────────────────────────────────────────────────────
const EMPTY_FORM = {
  id: undefined as number | undefined,
  extensionId: "",
  partnerId: "" as string,
  category: "other",
  summaryAr: "",
  summaryEn: "",
  descriptionAr: "",
  iconUrl: "",
  pricingModel: "free" as PricingModel,
  price: "0",
  currency: "SAR",
  commissionRate: "",
  status: "draft" as ListingStatus,
  featured: false,
};
type FormState = typeof EMPTY_FORM;

export default function MarketplaceAdmin() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { data, isLoading } = useAdminListings();
  const { data: sales } = useAdminSales();
  const save = useSaveListing();
  const del = useDeleteListing();

  const [form, setForm] = useState<FormState | null>(null);

  const listings = data?.listings ?? [];
  const extensions = data?.extensions ?? [];
  const partners = data?.partners ?? [];

  // Extensions not yet listed (for the create picker).
  const unlisted = useMemo(() => {
    const listed = new Set(listings.map((l) => l.extensionId));
    return extensions.filter((e) => !listed.has(e.extensionId));
  }, [listings, extensions]);

  function openCreate() {
    setForm({ ...EMPTY_FORM });
  }
  function openEdit(l: AdminListing) {
    setForm({
      id: l.id,
      extensionId: l.extensionId,
      partnerId: l.partnerId ? String(l.partnerId) : "",
      category: l.category || "other",
      summaryAr: l.summaryAr || "",
      summaryEn: l.summaryEn || "",
      descriptionAr: l.descriptionAr || "",
      iconUrl: l.iconUrl || "",
      pricingModel: l.pricingModel,
      price: String(l.price ?? "0"),
      currency: l.currency || "SAR",
      commissionRate: l.commissionRate == null ? "" : String(l.commissionRate),
      status: l.status,
      featured: l.featured,
    });
  }

  async function submit() {
    if (!form) return;
    if (!form.extensionId) {
      toast({ variant: "destructive", title: t("marketplaceAdmin.pickExtension", "اختر الإضافة أولاً") });
      return;
    }
    try {
      await save.mutateAsync({
        id: form.id,
        extensionId: form.extensionId,
        partnerId: form.partnerId ? Number(form.partnerId) : null,
        category: form.category,
        summaryAr: form.summaryAr,
        summaryEn: form.summaryEn,
        descriptionAr: form.descriptionAr,
        iconUrl: form.iconUrl,
        pricingModel: form.pricingModel,
        price: form.price,
        currency: form.currency,
        commissionRate: form.commissionRate,
        status: form.status,
        featured: form.featured,
      });
      toast({ title: t("common.saved", "تم الحفظ") });
      setForm(null);
    } catch (e) {
      toast({ variant: "destructive", title: t("common.error", "حدث خطأ"), description: (e as Error)?.message });
    }
  }

  async function remove(l: AdminListing) {
    if (!window.confirm(t("marketplaceAdmin.confirmDelete", "حذف هذه القائمة من المتجر؟"))) return;
    try {
      await del.mutateAsync(l.id);
      toast({ title: t("common.deleted", "تم الحذف") });
    } catch (e) {
      toast({ variant: "destructive", title: t("common.error", "حدث خطأ"), description: (e as Error)?.message });
    }
  }

  const statusBadge = (s: ListingStatus) => {
    const map: Record<ListingStatus, string> = {
      draft: t("marketplaceAdmin.draft", "مسودة"),
      published: t("marketplaceAdmin.published", "منشور"),
      unpublished: t("marketplaceAdmin.unpublished", "غير منشور"),
    };
    return <Badge variant={s === "published" ? "default" : "secondary"}>{map[s]}</Badge>;
  };

  return (
    <div className="p-4 md:p-6 space-y-5" data-testid="marketplace-admin">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Store className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-bold">{t("marketplaceAdmin.title", "إدارة المتجر")}</h1>
        </div>
        <Button onClick={openCreate} data-testid="market-admin-new">
          <Plus className="h-4 w-4 me-1" /> {t("marketplaceAdmin.newListing", "إدراج تطبيق")}
        </Button>
      </div>

      {/* Sales & commission summary */}
      {sales && (
        <div className="grid gap-3 sm:grid-cols-4">
          <SummaryCard label={t("marketplaceAdmin.totalSales", "عدد المبيعات")} value={String(sales.totals.sales)} />
          <SummaryCard label={t("marketplaceAdmin.gross", "الإجمالي")} value={sales.totals.gross} />
          <SummaryCard label={t("marketplaceAdmin.commission", "عمولة زاكود")} value={sales.totals.commission} />
          <SummaryCard label={t("marketplaceAdmin.developerNet", "صافي المطوّر")} value={sales.totals.developerNet} />
        </div>
      )}

      {/* Listings table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("marketplaceAdmin.listings", "قوائم المتجر")}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-muted-foreground py-6">{t("common.loading", "جارٍ التحميل…")}</div>
          ) : listings.length === 0 ? (
            <div className="text-muted-foreground py-6 text-center" data-testid="market-admin-empty">
              {t("marketplaceAdmin.empty", "لا توجد قوائم بعد.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("marketplaceAdmin.extension", "الإضافة")}</TableHead>
                  <TableHead>{t("marketplaceAdmin.developer", "المطوّر")}</TableHead>
                  <TableHead>{t("marketplaceAdmin.pricing", "التسعير")}</TableHead>
                  <TableHead>{t("marketplaceAdmin.commissionRate", "العمولة %")}</TableHead>
                  <TableHead>{t("marketplaceAdmin.status", "الحالة")}</TableHead>
                  <TableHead>{t("marketplaceAdmin.installs", "تثبيتات")}</TableHead>
                  <TableHead className="text-end">{t("common.actions", "إجراءات")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listings.map((l) => (
                  <TableRow key={l.id} data-testid={`market-listing-${l.extensionId}`}>
                    <TableCell className="font-medium">{l.extensionId}</TableCell>
                    <TableCell>{l.partnerName || "—"}</TableCell>
                    <TableCell>
                      {l.pricingModel === "free"
                        ? t("marketplace.free", "مجاني")
                        : `${Number(l.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${l.currency}${l.pricingModel === "monthly" ? " /شهر" : ""}`}
                    </TableCell>
                    <TableCell>{l.commissionRate == null ? "—" : `${l.commissionRate}%`}</TableCell>
                    <TableCell>{statusBadge(l.status)}</TableCell>
                    <TableCell>{l.activeInstalls}</TableCell>
                    <TableCell className="text-end space-x-1 space-x-reverse">
                      <Button size="icon" variant="ghost" onClick={() => openEdit(l)} data-testid={`market-edit-${l.extensionId}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => remove(l)} data-testid={`market-delete-${l.extensionId}`}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Per-extension breakdown */}
      {sales && sales.byExtension.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> {t("marketplaceAdmin.breakdown", "تفصيل المبيعات حسب التطبيق")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("marketplaceAdmin.extension", "الإضافة")}</TableHead>
                  <TableHead>{t("marketplaceAdmin.totalSales", "عدد المبيعات")}</TableHead>
                  <TableHead>{t("marketplaceAdmin.gross", "الإجمالي")}</TableHead>
                  <TableHead>{t("marketplaceAdmin.commission", "عمولة زاكود")}</TableHead>
                  <TableHead>{t("marketplaceAdmin.developerNet", "صافي المطوّر")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sales.byExtension.map((r) => (
                  <TableRow key={r.extensionId}>
                    <TableCell className="font-medium">{r.extensionId}</TableCell>
                    <TableCell>{r.sales}</TableCell>
                    <TableCell>{r.gross}</TableCell>
                    <TableCell>{r.commission}</TableCell>
                    <TableCell>{r.developerNet}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Create / edit form */}
      {form && (
        <Card data-testid="market-listing-form">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {form.id ? t("marketplaceAdmin.editListing", "تعديل القائمة") : t("marketplaceAdmin.newListing", "إدراج تطبيق")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>{t("marketplaceAdmin.extension", "الإضافة")}</Label>
              {form.id ? (
                <Input value={form.extensionId} disabled />
              ) : (
                <Select value={form.extensionId} onValueChange={(v) => setForm({ ...form, extensionId: v })}>
                  <SelectTrigger data-testid="market-form-extension"><SelectValue placeholder={t("marketplaceAdmin.pickExtension", "اختر الإضافة")} /></SelectTrigger>
                  <SelectContent>
                    {unlisted.map((e) => (
                      <SelectItem key={e.extensionId} value={e.extensionId}>{e.nameAr} ({e.extensionId})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-1">
              <Label>{t("marketplaceAdmin.developer", "المطوّر")}</Label>
              <Select value={form.partnerId || "none"} onValueChange={(v) => setForm({ ...form, partnerId: v === "none" ? "" : v })}>
                <SelectTrigger data-testid="market-form-partner"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("marketplaceAdmin.noDeveloper", "بدون")}</SelectItem>
                  {partners.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.nameAr} ({p.commissionRate}%)</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>{t("marketplaceAdmin.pricingModel", "نموذج التسعير")}</Label>
              <Select value={form.pricingModel} onValueChange={(v) => setForm({ ...form, pricingModel: v as PricingModel })}>
                <SelectTrigger data-testid="market-form-pricing"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">{t("marketplace.free", "مجاني")}</SelectItem>
                  <SelectItem value="one_time">{t("marketplaceAdmin.oneTime", "دفعة واحدة")}</SelectItem>
                  <SelectItem value="monthly">{t("marketplaceAdmin.monthly", "اشتراك شهري")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>{t("marketplaceAdmin.price", "السعر")}</Label>
                <Input
                  type="number" min="0" step="0.01"
                  value={form.price}
                  disabled={form.pricingModel === "free"}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  data-testid="market-form-price"
                />
              </div>
              <div className="space-y-1">
                <Label>{t("marketplaceAdmin.currency", "العملة")}</Label>
                <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
              </div>
            </div>

            <div className="space-y-1">
              <Label>{t("marketplaceAdmin.commissionOverride", "عمولة زاكود % (اختياري)")}</Label>
              <Input
                type="number" min="0" step="0.001"
                placeholder={t("marketplaceAdmin.commissionFallback", "افتراضي المطوّر")}
                value={form.commissionRate}
                onChange={(e) => setForm({ ...form, commissionRate: e.target.value })}
                data-testid="market-form-commission"
              />
            </div>

            <div className="space-y-1">
              <Label>{t("marketplaceAdmin.status", "الحالة")}</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as ListingStatus })}>
                <SelectTrigger data-testid="market-form-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">{t("marketplaceAdmin.draft", "مسودة")}</SelectItem>
                  <SelectItem value="published">{t("marketplaceAdmin.published", "منشور")}</SelectItem>
                  <SelectItem value="unpublished">{t("marketplaceAdmin.unpublished", "غير منشور")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>{t("marketplaceAdmin.category", "التصنيف")}</Label>
              <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>{t("marketplaceAdmin.iconUrl", "رابط الأيقونة")}</Label>
              <Input value={form.iconUrl} onChange={(e) => setForm({ ...form, iconUrl: e.target.value })} />
            </div>

            <div className="space-y-1">
              <Label>{t("marketplaceAdmin.summaryAr", "وصف مختصر (عربي)")}</Label>
              <Input value={form.summaryAr} onChange={(e) => setForm({ ...form, summaryAr: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>{t("marketplaceAdmin.summaryEn", "وصف مختصر (إنجليزي)")}</Label>
              <Input value={form.summaryEn} onChange={(e) => setForm({ ...form, summaryEn: e.target.value })} />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label>{t("marketplaceAdmin.descriptionAr", "الوصف")}</Label>
              <Textarea value={form.descriptionAr} onChange={(e) => setForm({ ...form, descriptionAr: e.target.value })} />
            </div>

            <label className="flex items-center gap-2 sm:col-span-2">
              <Switch checked={form.featured} onCheckedChange={(v) => setForm({ ...form, featured: v })} data-testid="market-form-featured" />
              <span className="text-sm">{t("marketplaceAdmin.featured", "تطبيق مميّز")}</span>
            </label>

            <div className="sm:col-span-2 flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setForm(null)}>{t("common.cancel", "إلغاء")}</Button>
              <Button onClick={submit} disabled={save.isPending} data-testid="market-form-save">
                {t("common.save", "حفظ")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-lg font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}
