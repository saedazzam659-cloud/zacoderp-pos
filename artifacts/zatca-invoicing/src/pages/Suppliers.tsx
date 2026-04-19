import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, Search, Truck, Phone, Mail, MapPin, BadgeCheck, Building2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

export default function Suppliers() {
  const { user, token } = useAuth();
  const [search, setSearch] = useState("");

  const { data: suppliers = [], isLoading } = useQuery({
    queryKey: ["suppliers", user?.companyId],
    queryFn: async () => {
      const url = user?.companyId
        ? `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/suppliers?companyId=${user.companyId}`
        : `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/suppliers`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    },
    enabled: !!user,
  });

  const filtered = suppliers.filter((s: any) =>
    s.nameAr?.includes(search) || s.vatNumber?.includes(search) || s.city?.includes(search)
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Truck className="h-6 w-6 text-primary" />الموردون
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">قائمة الموردين والموزعين المسجّلين</p>
        </div>
        <Button asChild className="gap-2">
          <Link href="/suppliers/new"><Plus className="h-4 w-4" />إضافة مورد</Link>
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="ابحث باسم المورد أو الرقم الضريبي أو المدينة..."
          className="pr-10"
        />
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <div key={i} className="h-40 rounded-xl bg-muted animate-pulse" />)}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-20">
          <Truck className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-muted-foreground">
            {search ? "لا توجد نتائج" : "لا يوجد موردون بعد"}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {search ? "جرب كلمة بحث مختلفة" : "ابدأ بإضافة أول مورد لشركتك"}
          </p>
          {!search && (
            <Button asChild className="mt-4 gap-2">
              <Link href="/suppliers/new"><Plus className="h-4 w-4" />إضافة مورد</Link>
            </Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((supplier: any) => (
          <Card key={supplier.id} className="group hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-lg">
                  {supplier.nameAr?.[0] ?? "م"}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-foreground truncate">{supplier.nameAr}</h3>
                  {supplier.nameEn && <p className="text-xs text-muted-foreground truncate">{supplier.nameEn}</p>}
                </div>
              </div>

              <div className="mt-4 space-y-1.5 text-sm">
                {supplier.vatNumber && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <BadgeCheck className="h-3.5 w-3.5 text-green-600 shrink-0" />
                    <span className="font-mono text-xs">{supplier.vatNumber}</span>
                  </div>
                )}
                {supplier.city && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-xs">{supplier.city}</span>
                  </div>
                )}
                {supplier.phone && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Phone className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-xs" dir="ltr">{supplier.phone}</span>
                  </div>
                )}
                {supplier.email && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Mail className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-xs truncate">{supplier.email}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
