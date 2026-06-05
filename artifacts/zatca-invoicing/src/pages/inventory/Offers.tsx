// Offers — list page (under /inventory/offers).
//
// What the user sees:
//   • A header card with "+ عرض جديد" call-to-action.
//   • A status filter (الكل / مسوّدة / مفعّل / منتهي).
//   • A table with offer number, name, scopes, priority, expiry, status,
//     and per-row actions: تفعيل / إيقاف / تعديل / حذف.
//
// Why these choices:
//   • Single screen for everything an admin does day-to-day; the form sits
//     on a dedicated route to keep the markup readable.
//   • Activate/expire are POST endpoints (not toggles) so the audit trail
//     captures intent — exactly matching the backend's lifecycle rules.
//   • Delete is blocked server-side for `active` offers; we surface that as
//     a plain toast instead of pre-disabling the button so the user always
//     sees the same UI shape.

import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Pencil, Trash2, Tag, Play, Square, BadgeCheck, Calendar, Ticket, Percent } from "lucide-react";
import { offersApi, type OfferRow } from "@/lib/offersApi";
import { parseError } from "@/lib/parseError";

type StatusFilter = "all" | "draft" | "active" | "expired";

export default function Offers() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const cid = user?.companyId ?? undefined;
  const { toast } = useToast();
  const qc = useQueryClient();

  const [filter, setFilter] = useState<StatusFilter>("all");

  // Always fetch the *unfiltered* list. We filter client-side so the status
  // chips show accurate global counts regardless of which chip is active —
  // otherwise switching to "active" would zero-out the draft/expired counts.
  const offersQ = useQuery({
    queryKey: ["offers", cid],
    queryFn:  () => offersApi.list(cid),
    enabled:  !!cid,
  });

  function invalidate() { qc.invalidateQueries({ queryKey: ["offers", cid] }); }

  const activate = useMutation({
    mutationFn: (id: number) => offersApi.activate(id, cid),
    onSuccess: () => { toast({ title: t("inventoryMaster.offers.activated") }); invalidate(); },
    onError:   (e) => toast({ title: t("inventoryMaster.offers.activateError"), description: parseError(e), variant: "destructive" }),
  });
  const expire = useMutation({
    mutationFn: (id: number) => offersApi.expire(id, cid),
    onSuccess: () => { toast({ title: t("inventoryMaster.offers.expired") }); invalidate(); },
    onError:   (e) => toast({ title: t("inventoryMaster.offers.expireError"), description: parseError(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => offersApi.remove(id, cid),
    onSuccess: () => { toast({ title: t("inventoryMaster.offers.deleted") }); invalidate(); },
    onError:   (e) => toast({ title: t("inventoryMaster.offers.deleteError"), description: parseError(e), variant: "destructive" }),
  });

  const allRows = offersQ.data ?? [];
  const counts = useMemo(() => ({
    all:     allRows.length,
    active:  allRows.filter(r => r.status === "active").length,
    draft:   allRows.filter(r => r.status === "draft").length,
    expired: allRows.filter(r => r.status === "expired").length,
  }), [allRows]);
  // Apply the chip filter on the client so the count badges (computed above
  // from the unfiltered set) and the visible rows always agree.
  const rows = filter === "all" ? allRows : allRows.filter(r => r.status === filter);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-card border border-border rounded-2xl p-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/10 grid place-items-center text-primary">
            <Tag className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t("inventoryMaster.offers.title")}</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("inventoryMaster.offers.subtitle")}
            </p>
          </div>
        </div>
        <Button onClick={() => navigate("/inventory/offers/new")} className="gap-1">
          <Plus className="h-4 w-4" /> {t("inventoryMaster.offers.new")}
        </Button>
      </div>

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2">
        {(["all", "draft", "active", "expired"] as StatusFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`text-xs px-3 py-1.5 rounded-full border transition ${
              filter === s
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-foreground border-border hover:border-primary/40"
            }`}
          >
            {t(`inventoryMaster.offers.filter.${s}`)} <span className="opacity-70">({counts[s]})</span>
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-2xl overflow-hidden">
        {offersQ.isLoading ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-muted-foreground text-sm">
            {t("inventoryMaster.offers.empty")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="text-start px-3 py-2.5 font-medium">{t("inventoryMaster.offers.col.number")}</th>
                  <th className="text-start px-3 py-2.5 font-medium">{t("inventoryMaster.offers.col.name")}</th>
                  <th className="text-start px-3 py-2.5 font-medium">{t("inventoryMaster.offers.col.discountType")}</th>
                  <th className="text-start px-3 py-2.5 font-medium">{t("inventoryMaster.offers.col.coupon")}</th>
                  <th className="text-start px-3 py-2.5 font-medium">{t("inventoryMaster.offers.col.scopes")}</th>
                  <th className="text-start px-3 py-2.5 font-medium">{t("inventoryMaster.offers.col.priority")}</th>
                  <th className="text-start px-3 py-2.5 font-medium">{t("inventoryMaster.offers.col.validity")}</th>
                  <th className="text-start px-3 py-2.5 font-medium">{t("inventoryMaster.offers.col.usage")}</th>
                  <th className="text-start px-3 py-2.5 font-medium">{t("inventoryMaster.offers.col.status")}</th>
                  <th className="text-end px-3 py-2.5 font-medium">{t("inventoryMaster.offers.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => <Row key={o.id} o={o}
                  onActivate={() => activate.mutate(o.id)}
                  onExpire={() => expire.mutate(o.id)}
                  onEdit={() => navigate(`/inventory/offers/${o.id}/edit`)}
                  onDelete={() => {
                    if (window.confirm(t("inventoryMaster.offers.deleteConfirm"))) remove.mutate(o.id);
                  }}
                />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ o, onActivate, onExpire, onEdit, onDelete }: {
  o: OfferRow;
  onActivate: () => void; onExpire: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  // Format dates with the system locale rather than hard-coding ar-SA so the
  // English UI gets a Latin date and the Arabic UI gets Arabic-Indic digits.
  const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString() : "—";
  const isActive = o.status === "active";
  const isExpired = o.status === "expired";

  const scopeBadge = (label: string, scope: "all" | "specific") => (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${
      scope === "all"
        ? "bg-blue-50 text-blue-700 border-blue-200"
        : "bg-amber-50 text-amber-700 border-amber-200"
    }`}>
      {label}: {t(`inventoryMaster.offers.scope.${scope}`)}
    </span>
  );

  const statusBadge =
    isActive   ? <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200"><BadgeCheck className="h-3 w-3" /> {t("inventoryMaster.offers.statusVal.active")}</span> :
    isExpired  ? <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">{t("inventoryMaster.offers.statusVal.expired")}</span> :
                 <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">{t("inventoryMaster.offers.statusVal.draft")}</span>;

  // Compact, descriptive label for the discount column — pairs the type's
  // short name with the headline value so admins can scan the table without
  // opening every offer.
  let discountLabel = t(`inventoryMaster.offers.discountTypeVal.${o.discountType}.short`, o.discountType);
  if (o.discountType === "percentage_total" && o.discountValue) discountLabel = `${o.discountValue}% ${t("inventoryMaster.offers.discountInline.off")}`;
  if (o.discountType === "fixed_total"      && o.discountValue) discountLabel = `${o.discountValue} ${t("inventoryMaster.offers.discountInline.fixed")}`;
  if (o.discountType === "buy_x_get_y"      && o.buyQty && o.getQty) discountLabel = `Buy ${o.buyQty} Get ${o.getQty}`;

  return (
    <tr className="border-t border-border hover:bg-muted/20">
      <td className="px-3 py-2 font-mono text-xs">{o.offerNumber}</td>
      <td className="px-3 py-2">{o.nameAr ?? "—"}</td>
      <td className="px-3 py-2 text-xs">
        <span className="inline-flex items-center gap-1"><Percent className="h-3 w-3 text-muted-foreground" /> {discountLabel}</span>
      </td>
      <td className="px-3 py-2 text-xs">
        {o.couponCode
          ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/10 text-primary font-mono"><Ticket className="h-3 w-3" /> {o.couponCode}</span>
          : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {scopeBadge(t("inventoryMaster.offers.scopeShort.customers"),  o.customerScope)}
          {scopeBadge(t("inventoryMaster.offers.scopeShort.items"),      o.itemsScope)}
          {scopeBadge(t("inventoryMaster.offers.scopeShort.salesReps"), o.salesRepScope)}
        </div>
      </td>
      <td className="px-3 py-2">{o.priority}</td>
      <td className="px-3 py-2 text-xs whitespace-nowrap">
        <span className="inline-flex items-center gap-1"><Calendar className="h-3 w-3 text-muted-foreground" /> {fmt(o.startDate)} → {fmt(o.expiryDate)}</span>
      </td>
      <td className="px-3 py-2 text-xs">
        <span className="font-mono">
          {o.timesUsed}{o.maxUses ? <span className="text-muted-foreground"> / {o.maxUses}</span> : <span className="text-muted-foreground"> / ∞</span>}
        </span>
      </td>
      <td className="px-3 py-2">{statusBadge}</td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-1">
          {!isActive && !isExpired && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-green-700" onClick={onActivate}>
              <Play className="h-3.5 w-3.5" />
            </Button>
          )}
          {isActive && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-amber-700" onClick={onExpire}>
              <Square className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onEdit} disabled={isActive}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={onDelete} disabled={isActive}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}
