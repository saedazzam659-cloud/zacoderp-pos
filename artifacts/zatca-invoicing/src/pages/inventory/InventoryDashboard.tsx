import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { inventoryApi } from "@/lib/inventoryApi";
import { Link } from "wouter";
import {
  Package, Warehouse, AlertTriangle, TrendingUp,
  ArrowRightLeft, SlidersHorizontal, ClipboardList, BookOpen,
  ChevronLeft, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useFmt } from "@/hooks/use-fmt";

const TX_TYPE_LABEL: Record<string, { label: string; color: string }> = {
  transfer_out: { label: "تحويل خارج",  color: "text-orange-600 bg-orange-50" },
  transfer_in:  { label: "تحويل داخل",  color: "text-blue-600 bg-blue-50" },
  adjustment:   { label: "تسوية",        color: "text-purple-600 bg-purple-50" },
  count_adj:    { label: "تعديل جرد",   color: "text-indigo-600 bg-indigo-50" },
  sale:         { label: "مبيعات",       color: "text-red-600 bg-red-50" },
  purchase:     { label: "مشتريات",      color: "text-green-600 bg-green-50" },
  opening:      { label: "رصيد افتتاحي", color: "text-slate-600 bg-slate-50" },
};

export default function InventoryDashboard() {
  const { fmtQty, fmtVal } = useFmt();
  const { user } = useAuth();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const { data, isLoading } = useQuery({
    queryKey: ["inventory-dashboard", cid],
    queryFn: () => inventoryApi.getDashboard(cid),
  });

  const stats = [
    {
      label: "إجمالي الأصناف",
      value: isLoading ? "—" : (data?.totalItems ?? 0),
      icon: Package,
      color: "text-blue-600",
      bg: "bg-blue-50 border-blue-100",
      href: "/inventory/items",
    },
    {
      label: "عدد المخازن",
      value: isLoading ? "—" : (data?.totalWarehouses ?? 0),
      icon: Warehouse,
      color: "text-green-600",
      bg: "bg-green-50 border-green-100",
      href: "/inventory/warehouses",
    },
    {
      label: "قيمة المخزون (ر.س)",
      value: isLoading ? "—" : fmtVal(data?.totalStockValue ?? 0),
      icon: TrendingUp,
      color: "text-primary",
      bg: "bg-primary/5 border-primary/10",
      href: "/inventory/balance",
    },
    {
      label: "أصناف تحت حد الطلب",
      value: isLoading ? "—" : (data?.itemsBelowReorder ?? 0),
      icon: AlertTriangle,
      color: "text-amber-600",
      bg: "bg-amber-50 border-amber-100",
      href: "/inventory/items",
    },
  ];

  const quickActions = [
    { label: "تحويل جديد",     href: "/inventory/transfers/new",    icon: ArrowRightLeft, color: "text-blue-600" },
    { label: "تسوية مخزنية",   href: "/inventory/adjustments/new",  icon: SlidersHorizontal, color: "text-purple-600" },
    { label: "جرد مخزن",       href: "/inventory/counts/new",        icon: ClipboardList, color: "text-indigo-600" },
    { label: "صنف جديد",       href: "/inventory/items/new",         icon: Plus,          color: "text-green-600" },
  ];

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">إدارة المخازن</h1>
          <p className="text-muted-foreground text-sm mt-1">لوحة تحكم المخزون — الجرد المستمر بالمتوسط المرجح</p>
        </div>
        <Button asChild size="sm" className="gap-2">
          <Link href="/inventory/items/new"><Plus className="h-4 w-4" />صنف جديد</Link>
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(s => (
          <Link key={s.label} href={s.href}>
            <div className={cn("rounded-xl border p-4 cursor-pointer hover:shadow-md transition-shadow", s.bg)}>
              {isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <s.icon className={cn("h-5 w-5", s.color)} />
                    <ChevronLeft className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <p className="text-2xl font-bold tabular-nums">{s.value}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{s.label}</p>
                </>
              )}
            </div>
          </Link>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">إجراءات سريعة</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {quickActions.map(a => (
            <Link key={a.label} href={a.href}>
              <div className="flex flex-col items-center gap-2 rounded-lg border bg-muted/30 p-4 hover:bg-muted/60 transition-colors cursor-pointer text-center">
                <a.icon className={cn("h-6 w-6", a.color)} />
                <span className="text-xs font-medium">{a.label}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Recent Movements */}
      <div className="rounded-xl border bg-card">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            <h2 className="font-semibold text-sm">آخر حركات المخزون</h2>
          </div>
          <Button variant="ghost" size="sm" asChild className="text-xs gap-1">
            <Link href="/inventory/ledger">عرض الكل <ChevronLeft className="h-3 w-3" /></Link>
          </Button>
        </div>
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : !data?.recentMovements?.length ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            <Package className="h-8 w-8 mx-auto mb-2 opacity-40" />
            لا توجد حركات مخزون حتى الآن
          </div>
        ) : (
          <div className="divide-y">
            {data.recentMovements.map((mov: any) => {
              const tx = TX_TYPE_LABEL[mov.txType] ?? { label: mov.txType, color: "text-slate-600 bg-slate-50" };
              return (
                <div key={mov.id} className="flex items-center gap-3 px-4 py-3">
                  <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5 shrink-0", tx.color)}>
                    {tx.label}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{mov.item?.nameAr ?? "—"}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{mov.warehouse?.nameAr}</p>
                  </div>
                  <div className="text-left shrink-0">
                    <p className={cn("text-sm font-bold tabular-nums", Number(mov.qty) >= 0 ? "text-green-600" : "text-red-600")}>
                      {Number(mov.qty) >= 0 ? "+" : ""}{fmtQty(mov.qty)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{mov.txDate}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
