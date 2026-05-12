import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useListCompanies } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Building2, Search, LogIn, LogOut, ShieldCheck, AlertCircle,
  CheckCircle2, MapPin, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export default function EnterCompany() {
  const { user, actingCompanyId, setActingCompany } = useAuth() as any;
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");

  const { data: companies = [], isLoading } = useListCompanies({
    query: { queryKey: ["companies"] },
  }) as any;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (companies as any[]).filter(
      (c) => (c.status ?? "active") !== "deleted",
    );
    if (!q) return list;
    return list.filter((c) => {
      return (
        String(c.id).includes(q) ||
        (c.nameAr ?? "").toLowerCase().includes(q) ||
        (c.nameEn ?? "").toLowerCase().includes(q) ||
        (c.taxNumber ?? "").toLowerCase().includes(q) ||
        (c.commercialReg ?? "").toLowerCase().includes(q)
      );
    });
  }, [companies, search]);

  if (user?.role !== "superadmin") {
    return (
      <div className="p-6 text-center text-muted-foreground">
        هذه الشاشة متاحة لمدير النظام فقط.
      </div>
    );
  }

  const enter = (id: number) => {
    setActingCompany(id);
    // "نفس الشاشة" — ننقل المستخدم مباشرة إلى لوحة بيانات الشركة فيُكمل العمل
    // داخل سياق هذه الشركة دون فتح نافذة جديدة.
    setLocation("/dashboard");
  };

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-6 w-6 text-primary" />
            الدخول إلى شركة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            اختر الشركة التي تريد العمل داخلها كمدير نظام. كل العمليات بعد ذلك
            ستُنسب لها تلقائياً، ويمكنك الخروج منها في أي وقت من الشريط الأصفر
            أعلى الصفحة.
          </p>
        </div>
        {actingCompanyId && (
          <Button
            variant="outline"
            className="gap-1.5 border-amber-400 text-amber-900 bg-amber-50 hover:bg-amber-100"
            onClick={() => setActingCompany(null)}
          >
            <LogOut className="h-4 w-4" />
            خروج من الشركة الحالية
          </Button>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute top-1/2 -translate-y-1/2 right-3 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="بحث بالاسم أو الرقم الضريبي أو السجل التجاري…"
          className="pr-10 h-10"
          data-testid="search-companies"
        />
      </div>

      {/* List */}
      <div className="border rounded-lg overflow-hidden bg-background">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            جاري تحميل الشركات…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-sm">
            لا توجد شركات مطابقة لبحثك.
          </div>
        ) : (
          <ul className="divide-y">
            {filtered.map((c: any) => {
              const isActive = actingCompanyId === c.id;
              const status = c.status ?? "active";
              const linked = !!c.zatcaPcsid;
              return (
                <li
                  key={c.id}
                  className={cn(
                    "flex items-center gap-3 p-3 hover:bg-muted/40 transition",
                    isActive && "bg-amber-50",
                  )}
                  data-testid={`company-row-${c.id}`}
                >
                  <div className="h-10 w-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold truncate">
                        {c.nameAr || c.nameEn || `شركة #${c.id}`}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        #{c.id}
                      </span>
                      {status === "active" ? (
                        <span className="inline-flex items-center gap-1 text-[11px] bg-emerald-100 text-emerald-800 rounded px-1.5 py-0.5">
                          <CheckCircle2 className="h-3 w-3" />نشطة
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] bg-amber-100 text-amber-800 rounded px-1.5 py-0.5">
                          <AlertCircle className="h-3 w-3" />{status}
                        </span>
                      )}
                      {linked && (
                        <span className="inline-flex items-center gap-1 text-[11px] bg-sky-100 text-sky-800 rounded px-1.5 py-0.5">
                          <ShieldCheck className="h-3 w-3" />مرتبطة بزاتكا
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3 flex-wrap">
                      {c.taxNumber && <span>الرقم الضريبي: {c.taxNumber}</span>}
                      {c.commercialReg && <span>س.ت: {c.commercialReg}</span>}
                      {c.city && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" />{c.city}
                        </span>
                      )}
                    </div>
                  </div>

                  <Button
                    size="sm"
                    variant={isActive ? "secondary" : "default"}
                    className="gap-1.5 shrink-0"
                    onClick={() => enter(c.id)}
                    data-testid={`enter-company-${c.id}`}
                  >
                    <LogIn className="h-4 w-4" />
                    {isActive ? "داخل الشركة الآن" : "دخول"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
