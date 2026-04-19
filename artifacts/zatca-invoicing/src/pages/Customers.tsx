import { useListCustomers } from "@workspace/api-client-react";
import { Link } from "wouter";
import {
  Plus, Users, Search, Phone, Mail, MapPin,
  BadgeCheck, Building2, UserCheck, FileText, ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import ExportButtons from "@/components/ExportButtons";

const CUSTOMER_EXPORT_COLS = [
  { key: "nameAr",     header: "الاسم (عربي)",        width: 28 },
  { key: "nameEn",     header: "الاسم (إنجليزي)",     width: 28 },
  { key: "vatNumber",  header: "الرقم الضريبي",       width: 20 },
  { key: "crNumber",   header: "السجل التجاري",       width: 18 },
  { key: "phone",      header: "الهاتف",              width: 18 },
  { key: "email",      header: "البريد الإلكتروني",  width: 28 },
  { key: "city",       header: "المدينة",             width: 16 },
  { key: "district",   header: "الحي",               width: 16 },
  { key: "postalCode", header: "الرقم البريدي",      width: 14 },
];

const TABS = [
  { key: "all",        label: "جميع العملاء",    icon: Users },
  { key: "withVat",    label: "شركات (B2B)",      icon: Building2 },
  { key: "individual", label: "أفراد (B2C)",       icon: UserCheck },
];

export default function Customers() {
  const [search, setSearch]       = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const { user } = useAuth();

  const { data: customers = [], isLoading } = useListCustomers(undefined, {
    query: { queryKey: ["customers", user?.companyId] },
  }) as any;

  const withVat = (customers as any[]).filter(c => c.vatNumber).length;
  const individuals = (customers as any[]).length - withVat;

  const counts: Record<string, number> = {
    all:        (customers as any[]).length,
    withVat,
    individual: individuals,
  };

  const filtered = (customers as any[]).filter(c => {
    const q = search.toLowerCase();
    const matchSearch =
      !search ||
      c.nameAr?.includes(search) ||
      c.nameEn?.toLowerCase().includes(q) ||
      c.vatNumber?.includes(search) ||
      c.city?.includes(search) ||
      c.email?.toLowerCase().includes(q) ||
      c.phone?.includes(search);
    const matchTab =
      activeTab === "all" ||
      (activeTab === "withVat"    && c.vatNumber) ||
      (activeTab === "individual" && !c.vatNumber);
    return matchSearch && matchTab;
  });

  return (
    <div className="space-y-0" dir="rtl">

      {/* ── Header strip ── */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            العملاء
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة بيانات العملاء لإصدار الفواتير الإلكترونية
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons
            rows={filtered.map((c: any) => ({
              nameAr:     c.nameAr     ?? "",
              nameEn:     c.nameEn     ?? "",
              vatNumber:  c.vatNumber  ?? "",
              crNumber:   c.crNumber   ?? "",
              phone:      c.phone      ?? "",
              email:      c.email      ?? "",
              city:       c.city       ?? "",
              district:   c.district   ?? "",
              postalCode: c.postalCode ?? "",
            }))}
            columns={CUSTOMER_EXPORT_COLS}
            filename={`عملاء-${new Date().toISOString().slice(0, 10)}`}
            title="قائمة العملاء"
            subtitle={`نظام الفاتورة الإلكترونية — ${new Date().toLocaleDateString("ar-SA-u-nu-latn")}`}
          />
          <Button asChild className="gap-2 shrink-0">
            <Link href="/customers/new">
              <Plus className="h-4 w-4" />إضافة عميل
            </Link>
          </Button>
        </div>
      </div>

      {/* ── 3 TABS — أعلى اليسار ── */}
      <div className="flex items-center gap-1 mb-6 bg-muted/50 p-1 rounded-xl w-fit border">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const count = isLoading ? null : counts[tab.key];
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap ${
                active
                  ? "bg-background text-primary shadow-sm border border-border/60"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              }`}
            >
              <Icon className={`h-3.5 w-3.5 ${active ? "text-primary" : ""}`} />
              {tab.label}
              {count !== null && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                  active
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Stats cards (3 mini) ── */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          {
            label: "إجمالي العملاء",
            value: isLoading ? null : (customers as any[]).length,
            icon: Users,
            color: "text-primary",
            bg:    "bg-primary/10",
          },
          {
            label: "مسجّلو الضريبة",
            value: isLoading ? null : withVat,
            icon: BadgeCheck,
            color: "text-emerald-600",
            bg:    "bg-emerald-50",
            sub:   "B2B",
          },
          {
            label: "أفراد",
            value: isLoading ? null : individuals,
            icon: UserCheck,
            color: "text-blue-600",
            bg:    "bg-blue-50",
            sub:   "B2C",
          },
        ].map(stat => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="rounded-xl border bg-card p-4 flex items-center gap-3">
              <div className={`h-9 w-9 rounded-lg ${stat.bg} flex items-center justify-center shrink-0`}>
                <Icon className={`h-4.5 w-4.5 ${stat.color}`} style={{ width: 18, height: 18 }} />
              </div>
              <div>
                {stat.value === null
                  ? <Skeleton className="h-6 w-12 mb-1" />
                  : <p className="text-xl font-bold leading-none">{stat.value}</p>
                }
                <p className="text-xs text-muted-foreground mt-0.5">
                  {stat.label}
                  {stat.sub && <span className="text-[10px] mr-1 opacity-60">{stat.sub}</span>}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Main card ── */}
      <div className="rounded-xl border bg-card overflow-hidden">

        {/* Search bar */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-muted/10">
          <p className="text-xs text-muted-foreground">
            {isLoading ? "جاري التحميل..." : `${filtered.length} نتيجة`}
          </p>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="بحث بالاسم أو الرقم الضريبي أو المدينة..."
              className="pr-9 h-8 w-64 text-sm"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">العميل</th>
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden sm:table-cell">الرقم الضريبي</th>
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden md:table-cell">المدينة</th>
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden lg:table-cell">التواصل</th>
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">النوع</th>
                <th className="h-9 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b">
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j} className="px-5 py-3.5">
                        <Skeleton className="h-4 w-full max-w-32" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-20 text-center">
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <div className="h-14 w-14 rounded-full bg-muted/60 flex items-center justify-center">
                        <Users className="h-7 w-7 opacity-40" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">
                          {search ? "لا توجد نتائج مطابقة" : "لا يوجد عملاء في هذا التصنيف"}
                        </p>
                        <p className="text-xs mt-0.5 opacity-70">
                          {search ? "جرّب كلمة بحث مختلفة" : "ابدأ بإضافة عميلك الأول"}
                        </p>
                      </div>
                      {!search && (
                        <Button asChild variant="outline" size="sm" className="gap-2 mt-1">
                          <Link href="/customers/new">
                            <Plus className="h-3.5 w-3.5" />إضافة عميل
                          </Link>
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((customer: any) => (
                  <tr
                    key={customer.id}
                    className="border-b transition-colors hover:bg-muted/30 group"
                  >
                    {/* Customer name */}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0 border border-primary/10">
                          {customer.nameAr?.[0] ?? "ع"}
                        </div>
                        <div>
                          <p className="font-semibold text-foreground leading-tight">{customer.nameAr}</p>
                          {customer.nameEn && (
                            <p className="text-xs text-muted-foreground">{customer.nameEn}</p>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* VAT */}
                    <td className="px-5 py-3 hidden sm:table-cell">
                      {customer.vatNumber ? (
                        <span className="inline-flex items-center gap-1 font-mono text-xs bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full">
                          <BadgeCheck className="h-3 w-3" />{customer.vatNumber}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40 text-xs">—</span>
                      )}
                    </td>

                    {/* City */}
                    <td className="px-5 py-3 hidden md:table-cell text-sm text-muted-foreground">
                      {customer.city ? (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                          {customer.city}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>

                    {/* Contact */}
                    <td className="px-5 py-3 hidden lg:table-cell">
                      <div className="space-y-0.5">
                        {customer.phone && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1" dir="ltr">
                            <Phone className="h-3 w-3 shrink-0" />{customer.phone}
                          </p>
                        )}
                        {customer.email && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Mail className="h-3 w-3 shrink-0" />{customer.email}
                          </p>
                        )}
                        {!customer.phone && !customer.email && (
                          <span className="text-muted-foreground/40 text-xs">—</span>
                        )}
                      </div>
                    </td>

                    {/* Type badge */}
                    <td className="px-5 py-3">
                      {customer.vatNumber ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <Building2 className="h-3 w-3" />شركة B2B
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                          <UserCheck className="h-3 w-3" />فرد B2C
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="outline" size="sm" asChild className="h-7 px-2.5 text-xs gap-1">
                          <Link href={`/invoices/new?customerId=${customer.id}`}>
                            <FileText className="h-3 w-3" />فاتورة
                          </Link>
                        </Button>
                        <Button variant="ghost" size="sm" asChild className="h-7 px-2 text-xs text-muted-foreground">
                          <Link href={`/customers/${customer.id}`}>
                            <ChevronLeft className="h-3.5 w-3.5" />
                          </Link>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/10 px-5 py-2.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>عرض <strong>{filtered.length}</strong> من أصل <strong>{(customers as any[]).length}</strong> عميل</span>
          </div>
        )}
      </div>
    </div>
  );
}
