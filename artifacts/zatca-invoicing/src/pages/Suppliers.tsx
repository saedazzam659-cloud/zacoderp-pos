import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Search, Truck, Phone, Mail, MapPin, BadgeCheck, Building2, Package } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

const TYPE_TABS = [
  { key: "all",     label: "الكل" },
  { key: "withVat", label: "مسجّلو الضريبة" },
  { key: "noVat",   label: "غير مسجّلين" },
];

export default function Suppliers() {
  const { user, token } = useAuth();
  const [search, setSearch]       = useState("");
  const [activeTab, setActiveTab] = useState("all");

  const { data: suppliers = [], isLoading } = useQuery({
    queryKey: ["suppliers", user?.companyId],
    queryFn: async () => {
      const url = user?.companyId
        ? `${API}/api/suppliers?companyId=${user.companyId}`
        : `${API}/api/suppliers`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    },
    enabled: !!user,
  });

  const filtered = suppliers.filter((s: any) => {
    const matchSearch =
      s.nameAr?.includes(search) ||
      s.nameEn?.toLowerCase().includes(search.toLowerCase()) ||
      s.vatNumber?.includes(search) ||
      s.city?.includes(search) ||
      s.email?.includes(search);
    const matchTab =
      activeTab === "all" ||
      (activeTab === "withVat" && s.vatNumber) ||
      (activeTab === "noVat"   && !s.vatNumber);
    return matchSearch && matchTab;
  });

  const withVat = suppliers.filter((s: any) => s.vatNumber).length;

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Truck className="h-6 w-6 text-primary" />الموردون
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">إدارة بيانات الموردين والموزعين</p>
        </div>
        <Button asChild className="gap-2">
          <Link href="/suppliers/new"><Plus className="h-4 w-4" />إضافة مورد</Link>
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Truck className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? "—" : suppliers.length}</p>
            <p className="text-xs text-muted-foreground">إجمالي الموردين</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-green-100 flex items-center justify-center shrink-0">
            <BadgeCheck className="h-5 w-5 text-green-600" />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? "—" : withVat}</p>
            <p className="text-xs text-muted-foreground">مسجّلو ضريبة</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
            <Package className="h-5 w-5 text-amber-600" />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? "—" : suppliers.length - withVat}</p>
            <p className="text-xs text-muted-foreground">غير مسجّلين</p>
          </div>
        </div>
      </div>

      {/* Table card */}
      <div className="rounded-xl border bg-card overflow-hidden">
        {/* Tabs + Search */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b">
          <div className="flex overflow-x-auto">
            {TYPE_TABS.map(tab => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={`px-5 py-3.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
                  activeTab === tab.key
                    ? "border-primary text-primary bg-primary/5"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40"
                }`}>
                {tab.label}
                {!isLoading && (
                  <span className="mr-1.5 text-xs bg-muted px-1.5 py-0.5 rounded-full">
                    {tab.key === "all" ? suppliers.length : tab.key === "withVat" ? withVat : suppliers.length - withVat}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="relative px-4 py-3">
            <Search className="absolute right-7 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="بحث بالاسم أو الرقم الضريبي..."
              className="pl-4 pr-10 w-full sm:w-64 h-9"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">المورد</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden sm:table-cell">الرقم الضريبي</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden md:table-cell">المدينة</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden lg:table-cell">الهاتف / البريد</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide hidden md:table-cell">الفئة</th>
                <th className="h-10 px-5 text-right font-medium text-muted-foreground text-xs tracking-wide">حالة الضريبة</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b">
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j} className="px-5 py-4"><Skeleton className="h-4 w-full max-w-32" /></td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-16 text-center text-muted-foreground">
                    <Truck className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">{search ? "لا توجد نتائج مطابقة" : "لا يوجد موردون بعد"}</p>
                    {!search && (
                      <Button asChild variant="outline" size="sm" className="mt-4 gap-2">
                        <Link href="/suppliers/new"><Plus className="h-3.5 w-3.5" />إضافة مورد</Link>
                      </Button>
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((supplier: any) => (
                  <tr key={supplier.id} className="border-b transition-colors hover:bg-muted/30 cursor-pointer group">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0">
                          {supplier.nameAr?.[0] ?? "م"}
                        </div>
                        <div>
                          <p className="font-medium text-foreground">{supplier.nameAr}</p>
                          {supplier.nameEn && <p className="text-xs text-muted-foreground">{supplier.nameEn}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 hidden sm:table-cell">
                      {supplier.vatNumber
                        ? <span className="font-mono text-xs text-foreground flex items-center gap-1"><BadgeCheck className="h-3.5 w-3.5 text-green-600" />{supplier.vatNumber}</span>
                        : <span className="text-muted-foreground/50 text-xs">—</span>}
                    </td>
                    <td className="px-5 py-3.5 hidden md:table-cell text-sm text-muted-foreground">
                      {supplier.city
                        ? <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5 shrink-0" />{supplier.city}</span>
                        : "—"}
                    </td>
                    <td className="px-5 py-3.5 hidden lg:table-cell">
                      <div className="space-y-0.5">
                        {supplier.phone && <p className="text-xs text-muted-foreground flex items-center gap-1" dir="ltr"><Phone className="h-3 w-3" />{supplier.phone}</p>}
                        {supplier.email && <p className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="h-3 w-3" />{supplier.email}</p>}
                        {!supplier.phone && !supplier.email && <span className="text-muted-foreground/50 text-xs">—</span>}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 hidden md:table-cell text-xs text-muted-foreground">
                      {supplier.category || "—"}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
                        supplier.vatNumber
                          ? "bg-green-50 text-green-700 border-green-200"
                          : "bg-amber-50 text-amber-700 border-amber-200"
                      }`}>
                        {supplier.vatNumber
                          ? <><BadgeCheck className="h-3 w-3" />مسجّل</>
                          : <><Building2 className="h-3 w-3" />غير مسجّل</>}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        {!isLoading && filtered.length > 0 && (
          <div className="border-t bg-muted/20 px-5 py-2.5 text-xs text-muted-foreground">
            عدد النتائج: <strong>{filtered.length}</strong>
          </div>
        )}
      </div>
    </div>
  );
}
