import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { FileSignature, ExternalLink, Search, AlertTriangle, Sparkles } from "lucide-react";

const STATUS: Record<string, { label: string; cls: string }> = {
  active:   { label: "نشط",     cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  expired:  { label: "منتهي",   cls: "bg-rose-50 text-rose-700 border-rose-200" },
  renewed:  { label: "مجدّد",   cls: "bg-sky-50 text-sky-700 border-sky-200" },
  cancelled:{ label: "ملغي",    cls: "bg-slate-50 text-slate-600 border-slate-200" },
};

const TYPE: Record<string, string> = { fixed: "محدد المدة", unlimited: "غير محدد المدة", parttime: "دوام جزئي" };

function daysUntil(date?: string): number | null {
  if (!date) return null;
  return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
}

function ExpiryBadge({ date }: { date?: string }) {
  const d = daysUntil(date);
  if (d == null) return <span className="text-muted-foreground text-xs">—</span>;
  if (d < 0)   return <Badge className="bg-rose-100 text-rose-700 border border-rose-200 hover:bg-rose-100">منتهي منذ {Math.abs(d)} يوم</Badge>;
  if (d <= 30) return <Badge className="bg-rose-100 text-rose-700 border border-rose-200 hover:bg-rose-100">باقي {d} يوم</Badge>;
  if (d <= 90) return <Badge className="bg-amber-100 text-amber-700 border border-amber-200 hover:bg-amber-100">باقي {d} يوم</Badge>;
  return <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-50">باقي {d} يوم</Badge>;
}

export default function AllContracts() {
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [expFilter, setExpFilter] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const { data: contracts = [], isLoading } = useQuery<any[]>({
    queryKey: ["all-contracts", statusFilter, expFilter],
    queryFn: () => employeesApi.allContracts({
      status: statusFilter === "all" ? undefined : statusFilter,
      expiringDays: expFilter ?? undefined,
    }),
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return contracts;
    const s = search.toLowerCase();
    return contracts.filter((c: any) =>
      String(c.empNameAr || "").toLowerCase().includes(s) ||
      String(c.empCode || "").toLowerCase().includes(s) ||
      String(c.contractNumber || "").toLowerCase().includes(s) ||
      String(c.jobTitle || "").toLowerCase().includes(s),
    );
  }, [contracts, search]);

  const stats = useMemo(() => {
    const total = contracts.length;
    let totalSalaries = 0;
    let expiring = 0;
    for (const c of contracts) {
      const monthly = Number(c.basicSalary || 0) + Number(c.housingAllow || 0) + Number(c.transportAllow || 0) + Number(c.otherAllow || 0);
      if (c.status === "active") totalSalaries += monthly;
      const d = daysUntil(c.endDate);
      if (d !== null && d >= 0 && d <= 90 && c.status === "active") expiring++;
    }
    return { total, totalSalaries, expiring };
  }, [contracts]);

  return (
    <div className="space-y-4 p-2 md:p-4" data-testid="page-all-contracts">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <FileSignature className="size-6 text-primary" />
          <h1 className="text-xl font-semibold">العقود — كل الموظفين</h1>
        </div>
        <Link href="/hr/employees">
          <Button variant="outline" size="sm">
            <ExternalLink className="size-4 me-1" /> الذهاب للموظفين
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="rounded-lg border p-3 bg-card">
          <div className="text-xs text-muted-foreground">إجمالي العقود</div>
          <div className="text-2xl font-semibold">{stats.total}</div>
        </div>
        <div className="rounded-lg border p-3 bg-card">
          <div className="text-xs text-muted-foreground">التزام شهري للأجور النشطة</div>
          <div className="text-2xl font-semibold tabular-nums">{stats.totalSalaries.toFixed(2)} <span className="text-sm text-muted-foreground">ر.س</span></div>
        </div>
        <div className="rounded-lg border p-3 bg-amber-50/50 border-amber-200">
          <div className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle className="size-3.5" /> عقود تنتهي خلال 90 يوم</div>
          <div className="text-2xl font-semibold text-amber-700">{stats.expiring}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute start-2 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="ابحث بالاسم، الكود، رقم العقد، المسمى…" className="ps-8" data-testid="contract-search" />
        </div>
        <span className="text-xs text-muted-foreground">الحالة:</span>
        {[["all","الكل"],["active","نشط"],["expired","منتهي"],["renewed","مجدّد"]].map(([v,l]) => (
          <Button key={v} variant={statusFilter === v ? "default" : "outline"} size="sm" onClick={() => setStatusFilter(v)} data-testid={`flt-${v}`}>{l}</Button>
        ))}
        <span className="text-xs text-muted-foreground ms-2">الانتهاء:</span>
        {[["all", null, "الكل"], ["soon", 90, "خلال 90 يوم"], ["urgent", 30, "خلال 30 يوم"]].map(([k, d, l]: any) => (
          <Button key={k} variant={expFilter === d ? "default" : "outline"} size="sm" onClick={() => setExpFilter(d)} data-testid={`expflt-${k}`}>{l}</Button>
        ))}
      </div>

      <div className="rounded-lg border overflow-x-auto bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase">
            <tr>
              <th className="p-2 text-start">رقم العقد</th>
              <th className="p-2 text-start">الموظف</th>
              <th className="p-2">المسمى</th>
              <th className="p-2">النوع</th>
              <th className="p-2">من</th>
              <th className="p-2">إلى</th>
              <th className="p-2">باقي</th>
              <th className="p-2">الراتب الشامل</th>
              <th className="p-2">إجازة سنوية</th>
              <th className="p-2">الحالة</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={11} className="p-4"><Skeleton className="h-12" /></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={11} className="p-6 text-center text-muted-foreground">لا توجد عقود مطابقة</td></tr>
            ) : filtered.map((c: any) => {
              const total = Number(c.basicSalary || 0) + Number(c.housingAllow || 0) + Number(c.transportAllow || 0) + Number(c.otherAllow || 0);
              const st = STATUS[c.status] || STATUS.active;
              return (
                <tr key={c.id} className="border-t" data-testid={`row-contract-${c.id}`}>
                  <td className="p-2 font-medium text-xs">{c.contractNumber}</td>
                  <td className="p-2">
                    <div className="font-medium">{c.empNameAr}</div>
                    <div className="text-xs text-muted-foreground">{c.empCode} {c.nationality && <span>· {c.nationality}</span>}</div>
                  </td>
                  <td className="p-2 text-xs">{c.jobTitle || "—"}</td>
                  <td className="p-2 text-xs">{TYPE[c.contractType] || c.contractType}</td>
                  <td className="p-2 text-xs">{c.startDate}</td>
                  <td className="p-2 text-xs">{c.endDate || <span className="text-muted-foreground">—</span>}</td>
                  <td className="p-2"><ExpiryBadge date={c.endDate} /></td>
                  <td className="p-2 text-xs tabular-nums font-medium">{total.toFixed(2)}</td>
                  <td className="p-2 text-center text-xs">{c.vacationDays || 21} يوم</td>
                  <td className="p-2"><Badge variant="outline" className={st.cls}>{st.label}</Badge></td>
                  <td className="p-2">
                    <Link href={`/hr/employees/${c.employeeId}/contracts`}>
                      <Button size="sm" variant="ghost" data-testid={`btn-open-${c.id}`}>
                        <ExternalLink className="size-3.5" />
                      </Button>
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-muted-foreground bg-blue-50/50 border border-blue-200 rounded p-2 flex items-start gap-2">
        <Sparkles className="size-3.5 text-blue-600 mt-0.5" />
        <div>
          <strong>تلميح:</strong> اضغط على أيقونة الفتح لإدارة عقد موظف معين (تجديد، تعديل بنود، اقتراح AI لرواتب السوق، إدارة الإجازات).
          العقود التي تنتهي خلال 30 يوم تُعرض بشارة حمراء، وخلال 90 يوم بشارة صفراء — يُنصح بالتجديد قبل الانتهاء بمدة كافية لتجنّب انقطاع التأمين.
        </div>
      </div>
    </div>
  );
}
