import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { demoAnalyticsApi } from "@/lib/demoAnalyticsApi";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Users, Activity, Clock, MonitorSmartphone, MousePointerClick, 
  BarChart, Target, Building2, ChevronLeft, CalendarRange, Filter, RefreshCcw, Star
} from "lucide-react";
import ExportButtons from "@/components/ExportButtons";
import {
  ResponsiveContainer, BarChart as RechartsBarChart, Bar, XAxis, YAxis, Tooltip,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import { demoActionLabel, demoModuleLabel, demoScreenLabel } from "@/lib/demoAnalyticsLabels";

const interestMapping: Record<string, { label: string; color: string }> = {
  new_visitor: { label: "زائر جديد", color: "#94a3b8" }, // slate-400
  casual: { label: "عابر", color: "#38bdf8" }, // blue-400
  interested: { label: "مهتم", color: "#fbbf24" }, // amber-400
  very_interested: { label: "مهتم جداً", color: "#f97316" }, // orange-500
  strong_candidate: { label: "مرشح قوي", color: "#10b981" } // emerald-500
};

const leadStatusLabels: Record<string, string> = {
  new: "جديد",
  contacted: "تم التواصل",
  qualified: "مؤهل",
  converted: "تحول لعميل",
  lost: "مستبعد"
};

const leadStatusColors: Record<string, string> = {
  new: "bg-blue-100 text-blue-700",
  contacted: "bg-amber-100 text-amber-700",
  qualified: "bg-indigo-100 text-indigo-700",
  converted: "bg-green-100 text-green-700",
  lost: "bg-slate-100 text-slate-700"
};

const formatDuration = (ms: number) => {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} دقيقة`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} س ${mins % 60} د`;
};

export default function DemoAnalyticsDashboard({ scope = "admin" }: { scope?: "admin" | "company" }) {
  const isAdmin = scope === "admin";
  const basePath = isAdmin ? "/admin/demo-analytics" : "/demo-analytics";
  const [filterState, setFilterState] = useState({
    phone: "",
    device: "all",
    interest: "all",
    leadStatus: "all",
    source: "all",
    from: "",
    to: "",
    module: "",
    screen: "",
    loginCount: "",
    duration: ""
  });
  
  const [appliedFilters, setAppliedFilters] = useState(filterState);

  const { data: dashboard, isLoading: dashLoading } = useQuery({
    queryKey: ["demo-dashboard", scope],
    queryFn: isAdmin ? demoAnalyticsApi.getAdminDashboard : demoAnalyticsApi.getCompanyDashboard,
    refetchInterval: 60000
  });

  const { data: profilesData, isLoading: profilesLoading } = useQuery({
    queryKey: ["demo-profiles", scope, appliedFilters],
    queryFn: () => {
      const params: Record<string, string | number> = { limit: 100 };
      if (appliedFilters.phone) params.phone = appliedFilters.phone;
      if (appliedFilters.device !== "all") params.device = appliedFilters.device;
      if (appliedFilters.interest !== "all") params.interest = appliedFilters.interest;
      if (isAdmin && appliedFilters.leadStatus !== "all") params.leadStatus = appliedFilters.leadStatus;
      if (isAdmin && appliedFilters.source !== "all") params.source = appliedFilters.source;
      if (appliedFilters.from) params.from = appliedFilters.from;
      if (appliedFilters.to) params.to = appliedFilters.to;
      if (appliedFilters.module) params.module = appliedFilters.module;
      if (appliedFilters.screen) params.screen = appliedFilters.screen;
      if (appliedFilters.loginCount) params.loginCount = appliedFilters.loginCount;
      if (appliedFilters.duration) params.duration = Number(appliedFilters.duration) * 60_000;
      return isAdmin
        ? demoAnalyticsApi.getAdminProfiles(params)
        : demoAnalyticsApi.getCompanyProfiles(params);
    },
    refetchInterval: 60000
  });

  const profiles = Array.isArray(profilesData) ? profilesData : [];

  const handleApplyFilters = () => setAppliedFilters(filterState);
  const handleResetFilters = () => {
    const fresh = { phone: "", device: "all", interest: "all", leadStatus: "all", source: "all", from: "", to: "", module: "", screen: "", loginCount: "", duration: "" };
    setFilterState(fresh);
    setAppliedFilters(fresh);
  };

  const exportCols = [
    { key: "id", header: "المعرف" },
    { key: "phone", header: "الجوال" },
    { key: "sourceKind", header: "المصدر" },
    { key: "loginCount", header: "الدخول" },
    { key: "totalDuration", header: "وقت الاستخدام" },
    { key: "interestCategory", header: "الاهتمام" },
    { key: "interestScore", header: "نقاط الاهتمام" },
    { key: "leadStatus", header: "حالة العميل" }
  ].filter(col => isAdmin || (col.key !== "sourceKind" && col.key !== "leadStatus"));
  
  const exportRows = profiles.map((p: any) => ({
    id: p.id,
    phone: p.phone || "لم يدخل الرقم",
    sourceKind: p.sourceKind === "agent" ? "وكيل" : "مباشر",
    loginCount: p.loginCount,
    totalDuration: formatDuration(p.totalDurationMs || 0),
    interestCategory: p.interestCategory ? (interestMapping[p.interestCategory]?.label || p.interestCategory) : "-",
    interestScore: p.interestScore,
    leadStatus: leadStatusLabels[p.leadStatus] || p.leadStatus
  }));

  if (dashLoading) {
    return <div className="p-6 text-center text-muted-foreground">جاري تحميل لوحة المؤشرات...</div>;
  }

  const devChartData = (dashboard?.deviceDistribution || []).map((d: any) => ({
    name: d.key,
    value: d.count
  }));
  const COLORS = ['#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e'];

  const interestChartData = (dashboard?.interestDistribution || []).map((d: any) => ({
    name: interestMapping[d.key]?.label || d.key,
    value: d.count,
    fill: interestMapping[d.key]?.color || '#cbd5e1'
  }));

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto" dir="rtl">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Target className="h-6 w-6 text-primary" />
            {isAdmin ? "تحليلات الحسابات التجريبية (Demo)" : "متابعة مستخدمي الديمو"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isAdmin
              ? "متابعة سلوك العملاء المحتملين وتحديد الحسابات ذات الجدية العالية"
              : "عرض نشاط مستخدمي الديمو التابعين لشركتك فقط"}
          </p>
        </div>
      </div>

      {dashboard && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="bg-gradient-to-br from-white to-slate-50 border-primary/20 shadow-sm">
              <CardContent className="p-4 flex items-start justify-between">
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-1">إجمالي الحسابات</p>
                  <p className="text-2xl font-bold text-foreground" data-testid="kpi-total">{dashboard.totalProfiles}</p>
                </div>
                <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Users className="h-4 w-4 text-primary" />
                </div>
              </CardContent>
            </Card>
            <Card className="bg-gradient-to-br from-white to-slate-50 border-primary/20 shadow-sm">
              <CardContent className="p-4 flex items-start justify-between">
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-1">حسابات جديدة</p>
                  <p className="text-2xl font-bold text-blue-700" data-testid="kpi-new">{dashboard.newProfiles}</p>
                </div>
                <div className="h-8 w-8 rounded-lg bg-blue-100 flex items-center justify-center">
                  <Star className="h-4 w-4 text-blue-700" />
                </div>
              </CardContent>
            </Card>
            <Card className="bg-gradient-to-br from-white to-slate-50 border-primary/20 shadow-sm">
              <CardContent className="p-4 flex items-start justify-between">
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-1">حسابات نشطة</p>
                  <p className="text-2xl font-bold text-green-700" data-testid="kpi-active">{dashboard.activeProfiles}</p>
                </div>
                <div className="h-8 w-8 rounded-lg bg-green-100 flex items-center justify-center">
                  <Activity className="h-4 w-4 text-green-700" />
                </div>
              </CardContent>
            </Card>
            <Card className="bg-gradient-to-br from-white to-slate-50 border-primary/20 shadow-sm">
              <CardContent className="p-4 flex items-start justify-between">
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-1">وقت الاستخدام الإجمالي</p>
                  <p className="text-xl font-bold text-indigo-700" data-testid="kpi-total-time">{formatDuration(dashboard.totalUsageMs || 0)}</p>
                </div>
                <div className="h-8 w-8 rounded-lg bg-indigo-100 flex items-center justify-center">
                  <Clock className="h-4 w-4 text-indigo-700" />
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">دخول (اليوم)</p>
                <p className="text-xl font-bold" data-testid="kpi-login-today">{dashboard.loginCounts?.today || 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">دخول (الاسبوع)</p>
                <p className="text-xl font-bold" data-testid="kpi-login-week">{dashboard.loginCounts?.week || 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">دخول (الشهر)</p>
                <p className="text-xl font-bold" data-testid="kpi-login-month">{dashboard.loginCounts?.month || 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">متوسط الجلسة</p>
                <p className="text-xl font-bold text-amber-700" data-testid="kpi-avg-session">{formatDuration(dashboard.averageSessionMs || 0)}</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <MonitorSmartphone className="h-4 w-4 text-primary" />
                  الأجهزة المستخدمة
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="h-56">
                  {devChartData.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-xs text-muted-foreground">لا توجد بيانات</div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={devChartData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%" cy="50%"
                          innerRadius={50} outerRadius={80}
                        >
                          {devChartData.map((e: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Pie>
                        <Tooltip contentStyle={{ fontSize: '12px' }} />
                        <Legend wrapperStyle={{ fontSize: '12px' }} />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <BarChart className="h-4 w-4 text-primary" />
                  مستويات الاهتمام
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="h-56">
                  {interestChartData.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-xs text-muted-foreground">لا توجد بيانات</div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <RechartsBarChart data={interestChartData} layout="vertical" margin={{ left: 30, right: 10 }}>
                        <XAxis type="number" hide />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={70} />
                        <Tooltip contentStyle={{ fontSize: '12px' }} cursor={{ fill: 'rgba(0,0,0,0.05)' }} />
                        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                          {interestChartData.map((entry: any, index: number) => (
                            <Cell key={`cell-${index}`} fill={entry.fill} />
                          ))}
                        </Bar>
                      </RechartsBarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-primary" />
                  أكثر الأقسام استخداماً
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="space-y-3">
                  {(dashboard.topModules || []).map((m: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-sm" data-testid={`top-module-${m.key}`}>
                      <span className="font-medium truncate pl-2">{demoModuleLabel(m.key)}</span>
                      <span className="text-muted-foreground shrink-0">{m.count} مرة</span>
                    </div>
                  ))}
                  {(!dashboard.topModules || dashboard.topModules.length === 0) && (
                    <div className="text-xs text-muted-foreground text-center py-4">لا توجد بيانات</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Target className="h-4 w-4 text-primary" />
                  أكثر الشاشات زيارة
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="space-y-3">
                  {(dashboard.topScreens || []).map((m: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-sm" data-testid={`top-screen-${m.key}`}>
                      <span className="font-medium truncate pl-2">{demoScreenLabel(m.key)}</span>
                      <span className="text-muted-foreground shrink-0">{m.count} مرة</span>
                    </div>
                  ))}
                  {(!dashboard.topScreens || dashboard.topScreens.length === 0) && (
                    <div className="text-xs text-muted-foreground text-center py-4">لا توجد بيانات</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <MousePointerClick className="h-4 w-4 text-primary" />
                  أكثر الإجراءات
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="space-y-3">
                  {(dashboard.topActions || []).map((m: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-sm" data-testid={`top-action-${m.key}`}>
                      <span className="font-medium truncate pl-2">{demoActionLabel(m.key)}</span>
                      <span className="text-muted-foreground shrink-0">{m.count} مرة</span>
                    </div>
                  ))}
                  {(!dashboard.topActions || dashboard.topActions.length === 0) && (
                    <div className="text-xs text-muted-foreground text-center py-4">لا توجد بيانات</div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card data-testid="ranked-prospects">
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-base flex items-center gap-2">
                <Star className="h-4 w-4 text-amber-500" />
                أعلى الحسابات اهتمامًا
              </CardTitle>
              <CardDescription>ترتيب تلقائي حسب مؤشر الاستخدام والاهتمام، دون تحليل محتوى البيانات التجارية.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {(dashboard.rankedProspects || []).slice(0, 10).map((prospect: any, index: number) => {
                  const interest = interestMapping[prospect.interestCategory] ?? interestMapping.new_visitor;
                  return (
                    <div
                      key={prospect.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                      data-testid={`ranked-prospect-${index}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-xs font-bold">
                          {index + 1}
                        </span>
                        <div className="min-w-0">
                          <p className="font-mono text-sm truncate" dir="ltr">{prospect.phone || "بدون رقم"}</p>
                          <p className="text-xs text-muted-foreground">
                            {prospect.sourceKind === "agent" ? "وكيل" : "مباشر"} · {prospect.loginCount || 0} جلسة
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold" style={{ color: interest.color }}>{interest.label}</span>
                        <span className="min-w-9 text-center rounded-md bg-primary/10 px-2 py-1 text-sm font-bold text-primary">
                          {prospect.interestScore || 0}
                        </span>
                        <Button variant="ghost" size="sm" asChild>
                           <Link href={`${basePath}/${prospect.id}`}>التفاصيل</Link>
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {(!dashboard.rankedProspects || dashboard.rankedProspects.length === 0) && (
                  <div className="p-6 text-center text-xs text-muted-foreground">لا توجد بيانات ترتيب بعد</div>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader className="pb-4 border-b">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
            <CardTitle className="text-lg">{isAdmin ? "سجل العملاء المحتملين (Demo)" : "سجل مستخدمي الديمو"}</CardTitle>
            <div className="flex items-center gap-2">
              <ExportButtons 
                rows={exportRows}
                columns={exportCols}
                title="سجل الحسابات التجريبية"
                filename="demo-profiles"
                label="تصدير"
                disabled={profilesLoading || profiles.length === 0}
              />
            </div>
          </div>
          
          <div className="bg-muted/30 p-3 rounded-lg flex flex-col gap-3">
            <div className="flex items-center gap-1.5 mb-1">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">تصفية البحث</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <Input placeholder="رقم الجوال" className="h-9 text-sm" value={filterState.phone} onChange={(e) => setFilterState(f => ({ ...f, phone: e.target.value }))} data-testid="filter-phone" />
              
              <Select value={filterState.device} onValueChange={(val) => setFilterState(f => ({ ...f, device: val }))}>
                <SelectTrigger className="h-9 text-sm" data-testid="filter-device"><SelectValue placeholder="الجهاز" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الأجهزة</SelectItem>
                  <SelectItem value="desktop">مكتبي</SelectItem>
                  <SelectItem value="laptop">محمول</SelectItem>
                  <SelectItem value="tablet">جهاز لوحي</SelectItem>
                  <SelectItem value="mobile">جوال</SelectItem>
                </SelectContent>
              </Select>

              <Select value={filterState.interest} onValueChange={(val) => setFilterState(f => ({ ...f, interest: val }))}>
                <SelectTrigger className="h-9 text-sm" data-testid="filter-interest"><SelectValue placeholder="الاهتمام" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الاهتمامات</SelectItem>
                  {Object.entries(interestMapping).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

               {isAdmin && <Select value={filterState.leadStatus} onValueChange={(val) => setFilterState(f => ({ ...f, leadStatus: val }))}>
                <SelectTrigger className="h-9 text-sm" data-testid="filter-lead"><SelectValue placeholder="الحالة المبيعية" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الحالات</SelectItem>
                  {Object.entries(leadStatusLabels).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
               </Select>}

               {isAdmin && <Select value={filterState.source} onValueChange={(val) => setFilterState(f => ({ ...f, source: val }))}>
                <SelectTrigger className="h-9 text-sm" data-testid="filter-source"><SelectValue placeholder="المصدر" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل المصادر</SelectItem>
                   <SelectItem value="central">مباشر</SelectItem>
                  <SelectItem value="agent">وكيل</SelectItem>
                </SelectContent>
               </Select>}

              <Input placeholder="اسم القسم" className="h-9 text-sm" value={filterState.module} onChange={(e) => setFilterState(f => ({ ...f, module: e.target.value }))} data-testid="filter-module" />
              <Input placeholder="اسم الشاشة" className="h-9 text-sm" value={filterState.screen} onChange={(e) => setFilterState(f => ({ ...f, screen: e.target.value }))} data-testid="filter-screen" />
              <Input type="number" placeholder="حد أدنى للدخول" className="h-9 text-sm" value={filterState.loginCount} onChange={(e) => setFilterState(f => ({ ...f, loginCount: e.target.value }))} data-testid="filter-logincount" />
              <Input type="number" placeholder="حد أدنى للمدة (دقيقة)" className="h-9 text-sm" value={filterState.duration} onChange={(e) => setFilterState(f => ({ ...f, duration: e.target.value }))} data-testid="filter-duration" />
              <Input type="date" className="h-9 text-sm" value={filterState.from} onChange={(e) => setFilterState(f => ({ ...f, from: e.target.value }))} data-testid="filter-from" />
              <Input type="date" className="h-9 text-sm" value={filterState.to} onChange={(e) => setFilterState(f => ({ ...f, to: e.target.value }))} data-testid="filter-to" />

              <div className="flex items-center gap-2 lg:col-span-1">
                <Button className="flex-1 h-9" size="sm" onClick={handleApplyFilters} data-testid="filter-apply">تطبيق</Button>
                <Button className="flex-1 h-9" size="sm" variant="secondary" onClick={handleResetFilters} data-testid="filter-reset"><RefreshCcw className="h-4 w-4" /></Button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto min-h-[300px]">
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground text-xs">
                <tr>
                  <th className="p-3 text-right">رقم الجوال</th>
                  <th className="p-3 text-right">نقاط الاهتمام</th>
                  <th className="p-3 text-right">الاهتمام الرئيسي</th>
                  <th className="p-3 text-right">تسجيلات الدخول</th>
                  <th className="p-3 text-right">وقت الاستخدام</th>
                   {isAdmin && <th className="p-3 text-right">الحالة المبيعية</th>}
                  <th className="p-3 text-center">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {profilesLoading ? (
                   <tr><td colSpan={isAdmin ? 7 : 6} className="p-6 text-center text-muted-foreground">جاري التحميل...</td></tr>
                ) : profiles.length === 0 ? (
                   <tr><td colSpan={isAdmin ? 7 : 6} className="p-6 text-center text-muted-foreground">لا توجد حسابات مطابقة للبحث</td></tr>
                ) : (
                  profiles.map((p: any, idx: number) => (
                    <tr key={p.id} className="hover:bg-muted/50 transition-colors" data-testid={`profile-row-${idx}`}>
                      <td className="p-3 font-mono text-left" dir="ltr">{p.phone || <span className="text-muted-foreground text-xs">لم يُدخل</span>}</td>
                       {isAdmin && <td className="p-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-2 bg-slate-100 rounded-full overflow-hidden">
                             <div className="h-full bg-primary" style={{ width: `${Math.min(100, p.interestScore || 0)}%` }} />
                          </div>
                          <span className="font-bold text-xs">{p.interestScore || 0}</span>
                        </div>
                       </td>}
                      <td className="p-3">
                        {p.interestCategory ? (
                          <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: `${interestMapping[p.interestCategory]?.color}20`, color: interestMapping[p.interestCategory]?.color }}>
                            {interestMapping[p.interestCategory]?.label || p.interestCategory}
                          </span>
                        ) : "-"}
                      </td>
                      <td className="p-3">{p.loginCount}</td>
                      <td className="p-3 text-xs text-muted-foreground">{formatDuration(p.totalDurationMs || 0)}</td>
                      <td className="p-3">
                        <span className={`text-xs px-2 py-0.5 rounded font-medium ${leadStatusColors[p.leadStatus] || leadStatusColors.new}`}>
                          {leadStatusLabels[p.leadStatus] || p.leadStatus}
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <Button variant="ghost" size="sm" asChild data-testid={`view-profile-${p.id}`}>
                           <Link href={`${basePath}/${p.id}`} className="text-primary hover:text-primary">
                            التفاصيل <ChevronLeft className="h-4 w-4 mr-1" />
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
