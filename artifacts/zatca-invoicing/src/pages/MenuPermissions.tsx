import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Loader2, LayoutDashboard, FileText, Users, Truck, Link2, Search, Building2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Menu definitions ─────────────────────────────────────────────────────────

interface MenuItem {
  key: string;
  label: string;
  icon: React.ElementType;
  section: string;
}

const MENU_ITEMS: MenuItem[] = [
  { key: "dashboard", label: "لوحة التحكم",  icon: LayoutDashboard, section: "رئيسي" },
  { key: "invoices",  label: "الفواتير",     icon: FileText,         section: "الأعمال" },
  { key: "customers", label: "العملاء",      icon: Users,            section: "الأعمال" },
  { key: "suppliers", label: "الموردون",     icon: Truck,            section: "الأعمال" },
  { key: "zatca",     label: "ربط ZATCA",    icon: Link2,            section: "النظام" },
];

const DEFAULT_PERMISSIONS: Record<string, boolean> = {
  dashboard: true,
  invoices: true,
  customers: true,
  suppliers: true,
  zatca: true,
};

function parsePerms(raw: string | null | undefined): Record<string, boolean> {
  try { return { ...DEFAULT_PERMISSIONS, ...JSON.parse(raw ?? "{}") }; }
  catch { return { ...DEFAULT_PERMISSIONS }; }
}

// ─── Section label ─────────────────────────────────────────────────────────────

function SectionBadge({ section }: { section: string }) {
  const color =
    section === "رئيسي"   ? "bg-blue-50 text-blue-700 border-blue-200" :
    section === "الأعمال" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
    "bg-purple-50 text-purple-700 border-purple-200";
  return (
    <span className={cn("text-[10px] border rounded-full px-1.5 py-px font-medium", color)}>
      {section}
    </span>
  );
}

// ─── Status dot ───────────────────────────────────────────────────────────────

function StatusDot({ active }: { active: boolean }) {
  return (
    <span className={cn(
      "inline-flex h-2 w-2 rounded-full shrink-0",
      active ? "bg-green-500" : "bg-muted-foreground/30"
    )} />
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function MenuPermissions() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
  };

  // Load all companies
  const { data: companies = [], isLoading } = useQuery<any[]>({
    queryKey: ["companies-menu-perms"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/companies`, { headers });
      if (!res.ok) throw new Error("فشل تحميل الشركات");
      return res.json();
    },
  });

  // Save permissions mutation (per company)
  const saveMutation = useMutation({
    mutationFn: async ({ companyId, perms }: { companyId: number; perms: Record<string, boolean> }) => {
      const res = await fetch(`${API}/api/companies/${companyId}/menu-permissions`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ menuPermissions: JSON.stringify(perms) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "فشل الحفظ");
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies-menu-perms"] });
      setSavingId(null);
      toast({ title: "تم حفظ الصلاحيات بنجاح", variant: "default" });
    },
    onError: (e: any) => {
      toast({ title: "فشل الحفظ: " + e.message, variant: "destructive" });
      setSavingId(null);
    },
  });

  function togglePerm(company: any, key: string) {
    const perms = parsePerms(company.menuPermissions);
    perms[key] = !perms[key];
    setSavingId(company.id);
    saveMutation.mutate({ companyId: company.id, perms });
  }

  const filtered = companies.filter((c: any) =>
    !search || c.nameAr?.includes(search) || c.nameEn?.toLowerCase().includes(search.toLowerCase()) || c.vatNumber?.includes(search)
  );

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-bold">صلاحيات القوائم</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            تحكم في القوائم الظاهرة لمستخدمي كل شركة — التغييرات تُطبَّق فورياً
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="ابحث باسم الشركة أو رقم ضريبي..."
              className="h-8 pr-8 text-sm w-56"
            />
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">القوائم:</span>
        {MENU_ITEMS.map(m => (
          <span key={m.key} className="flex items-center gap-1.5">
            <m.icon className="h-3.5 w-3.5" />
            {m.label}
            <SectionBadge section={m.section} />
          </span>
        ))}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          لا توجد شركات مطابقة للبحث
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 border-b">
                <tr>
                  <th className="text-right font-semibold text-xs text-muted-foreground px-4 py-3 w-[200px]">
                    <span className="flex items-center gap-1.5">
                      <Building2 className="h-3.5 w-3.5" />الشركة
                    </span>
                  </th>
                  <th className="text-center font-semibold text-xs text-muted-foreground px-3 py-3 min-w-[90px]">
                    <span className="flex flex-col items-center gap-1">
                      <LayoutDashboard className="h-4 w-4" />
                      <span>لوحة التحكم</span>
                    </span>
                  </th>
                  <th className="text-center font-semibold text-xs text-muted-foreground px-3 py-3 min-w-[80px]">
                    <span className="flex flex-col items-center gap-1">
                      <FileText className="h-4 w-4" />
                      <span>الفواتير</span>
                    </span>
                  </th>
                  <th className="text-center font-semibold text-xs text-muted-foreground px-3 py-3 min-w-[80px]">
                    <span className="flex flex-col items-center gap-1">
                      <Users className="h-4 w-4" />
                      <span>العملاء</span>
                    </span>
                  </th>
                  <th className="text-center font-semibold text-xs text-muted-foreground px-3 py-3 min-w-[90px]">
                    <span className="flex flex-col items-center gap-1">
                      <Truck className="h-4 w-4" />
                      <span>الموردون</span>
                    </span>
                  </th>
                  <th className="text-center font-semibold text-xs text-muted-foreground px-3 py-3 min-w-[90px]">
                    <span className="flex flex-col items-center gap-1">
                      <Link2 className="h-4 w-4" />
                      <span>ربط ZATCA</span>
                    </span>
                  </th>
                  <th className="text-center font-semibold text-xs text-muted-foreground px-3 py-3 min-w-[70px]">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((company: any) => {
                  const perms = parsePerms(company.menuPermissions);
                  const isSaving = savingId === company.id && saveMutation.isPending;
                  const enabledCount = MENU_ITEMS.filter(m => perms[m.key]).length;

                  return (
                    <tr
                      key={company.id}
                      className={cn(
                        "transition-colors",
                        isSaving ? "bg-primary/5" : "hover:bg-muted/30"
                      )}
                    >
                      {/* Company info */}
                      <td className="px-4 py-3">
                        <div className="flex items-start gap-2">
                          {isSaving ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0 mt-0.5" />
                          ) : (
                            <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                          )}
                          <div className="min-w-0">
                            <p className="font-medium truncate text-sm leading-tight">{company.nameAr}</p>
                            <p className="text-[11px] font-mono text-muted-foreground mt-0.5" dir="ltr">{company.vatNumber}</p>
                          </div>
                        </div>
                      </td>

                      {/* Per-menu toggles */}
                      {MENU_ITEMS.map(menu => (
                        <td key={menu.key} className="px-3 py-3 text-center">
                          <div className="flex justify-center">
                            <Switch
                              checked={perms[menu.key] ?? true}
                              onCheckedChange={() => togglePerm(company, menu.key)}
                              disabled={isSaving}
                              className="scale-90"
                            />
                          </div>
                        </td>
                      ))}

                      {/* Summary */}
                      <td className="px-3 py-3 text-center">
                        <span className={cn(
                          "inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5 border",
                          enabledCount === MENU_ITEMS.length
                            ? "bg-green-50 text-green-700 border-green-200"
                            : enabledCount === 0
                            ? "bg-red-50 text-red-700 border-red-200"
                            : "bg-amber-50 text-amber-700 border-amber-200"
                        )}>
                          <StatusDot active={enabledCount > 0} />
                          {enabledCount}/{MENU_ITEMS.length}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Footer summary */}
          <div className="border-t bg-muted/20 px-4 py-2.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>إجمالي الشركات: <strong className="text-foreground">{filtered.length}</strong></span>
            <span>التغييرات تُطبَّق فورياً بدون حاجة لحفظ يدوي</span>
          </div>
        </div>
      )}
    </div>
  );
}
