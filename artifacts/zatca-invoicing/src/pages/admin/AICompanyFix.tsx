import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sparkles, Search, AlertTriangle, AlertCircle, Info, CheckCircle2, Loader2 } from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type CheckResult = {
  key: string; label: string; severity: "high" | "medium" | "low";
  count: number; samples: any[];
};

const SEV_STYLE: Record<string, { bg: string; border: string; text: string; icon: any; label: string }> = {
  high:   { bg: "bg-red-50",    border: "border-red-200",    text: "text-red-800",    icon: AlertCircle,    label: "خطورة عالية" },
  medium: { bg: "bg-amber-50",  border: "border-amber-200",  text: "text-amber-900",  icon: AlertTriangle,  label: "خطورة متوسطة" },
  low:    { bg: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-900",   icon: Info,           label: "خطورة منخفضة" },
};

function renderMarkdown(md: string) {
  // Lightweight markdown: headings, bold, lists. No code blocks needed.
  const html = md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, '<h3 class="font-bold text-base mt-3 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2 class="font-bold text-lg mt-4 mb-2">$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1 class="font-bold text-xl mt-4 mb-2">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*\d+\.\s+(.+)$/gm, '<li class="ml-5 list-decimal">$1</li>')
    .replace(/^\s*[-*]\s+(.+)$/gm,  '<li class="ml-5 list-disc">$1</li>')
    .replace(/\n\n/g, '<br/><br/>');
  return { __html: html };
}

export default function AICompanyFix() {
  const { token } = useAuth();
  const { toast } = useToast();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [companyId, setCompanyId] = useState<string>("");
  const [aiSummary, setAiSummary] = useState<string>("");

  const { data: companies = [] } = useQuery({
    queryKey: ["admin-companies"],
    queryFn: async () => (await fetch(`${API}/api/admin/companies`, { headers })).json(),
  });

  const { data: diag, refetch, isFetching } = useQuery<{ checks: CheckResult[]; totalIssues: number }>({
    queryKey: ["ai-fix-diagnose", companyId],
    queryFn: async () => (await fetch(`${API}/api/admin/ai-fix/diagnose?companyId=${companyId}`, { headers })).json(),
    enabled: false,
  });

  const summarizeMut = useMutation({
    mutationFn: async () => {
      setAiSummary("");
      const r = await fetch(`${API}/api/admin/ai-fix/summarize`, {
        method: "POST", headers,
        body: JSON.stringify({ companyId: Number(companyId), checks: diag?.checks ?? [] }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل التلخيص");
      return r.json();
    },
    onSuccess: (data) => setAiSummary(data.summary || ""),
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  const handleScan = async () => {
    setAiSummary("");
    const res = await refetch();
    // After scan completes, trigger AI summary automatically
    if (res.data) summarizeMut.mutate();
  };

  const checks = diag?.checks ?? [];
  const totalIssues = diag?.totalIssues ?? 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-violet-600" />
          إصلاح مشاكل الشركات بالذكاء الاصطناعي
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          فحص تشخيصي شامل لبيانات الشركة (محاسبة، مخزون، فواتير، أصناف) ثم ملخص وتوصيات بالعربية يكتبها الذكاء الاصطناعي.
          هذه الصفحة <strong>للقراءة فقط</strong> ولا تنفذ أي تعديل تلقائي.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">اختر الشركة وافحص</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">الشركة</label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="— اختر الشركة —" /></SelectTrigger>
                <SelectContent>
                  {companies.map((c: any) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.nameAr || c.nameEn || `#${c.id}`}
                      {c.status !== "active" && <span className="text-muted-foreground"> ({c.status})</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={handleScan}
              disabled={!companyId || isFetching || summarizeMut.isPending}
              className="gap-1.5 bg-violet-600 hover:bg-violet-700"
            >
              {(isFetching || summarizeMut.isPending) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {isFetching ? "جارٍ الفحص..." : summarizeMut.isPending ? "الذكاء الاصطناعي يحلل..." : "فحص بالذكاء الاصطناعي"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {diag && (
        <>
          {totalIssues === 0 ? (
            <Card className="border-green-200 bg-green-50/30">
              <CardContent className="pt-5 pb-4 text-center">
                <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto mb-2" />
                <p className="text-green-800 font-medium">لا توجد مشاكل في بيانات هذه الشركة</p>
                <p className="text-sm text-green-700 mt-1">جميع الفحوصات الـ {checks.length} اجتازت بنجاح</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  <span>نتائج الفحص ({checks.length} فحص)</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    إجمالي المشاكل: <strong className="text-red-600">{totalIssues}</strong>
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {checks
                  .slice()
                  .sort((a, b) => {
                    const order = { high: 0, medium: 1, low: 2 } as any;
                    if (a.count === 0 && b.count > 0) return 1;
                    if (b.count === 0 && a.count > 0) return -1;
                    return order[a.severity] - order[b.severity];
                  })
                  .map((c) => {
                    const sev = SEV_STYLE[c.severity];
                    const Icon = sev.icon;
                    const isOk = c.count === 0;
                    return (
                      <div
                        key={c.key}
                        className={`flex items-center justify-between gap-3 p-3 rounded-md border ${
                          isOk ? "bg-green-50 border-green-200" : `${sev.bg} ${sev.border}`
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {isOk
                            ? <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                            : <Icon className={`h-4 w-4 shrink-0 ${sev.text}`} />
                          }
                          <div className="min-w-0">
                            <p className={`text-sm font-medium ${isOk ? "text-green-800" : sev.text}`}>{c.label}</p>
                            {!isOk && <p className="text-xs text-muted-foreground mt-0.5">{sev.label}</p>}
                          </div>
                        </div>
                        <span className={`text-sm font-bold tabular-nums shrink-0 ${
                          isOk ? "text-green-700" : sev.text
                        }`}>
                          {c.count}
                        </span>
                      </div>
                    );
                  })}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {(summarizeMut.isPending || aiSummary) && (
        <Card className="border-violet-200">
          <CardHeader className="pb-3 bg-violet-50/50">
            <CardTitle className="text-base flex items-center gap-2 text-violet-900">
              <Sparkles className="h-4 w-4" />
              ملخص الذكاء الاصطناعي
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {summarizeMut.isPending ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                جارٍ توليد الملخص والتوصيات...
              </div>
            ) : (
              <div className="prose prose-sm max-w-none text-sm leading-7 [&_li]:my-0.5"
                   dir="rtl"
                   dangerouslySetInnerHTML={renderMarkdown(aiSummary)} />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
