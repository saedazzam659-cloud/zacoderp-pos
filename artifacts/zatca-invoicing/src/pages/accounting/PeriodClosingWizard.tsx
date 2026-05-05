import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AccountCombobox } from "@/components/AccountCombobox";
import {
  AlertCircle, CheckCircle2, X, Loader2, ShieldCheck,
  Calculator, ArrowRightLeft, Lock, ShieldX, Sparkles, Brain,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type Period = {
  id: number; name: string; startDate: string; endDate: string;
  status: "open" | "closed" | "permanently_closed";
};

interface Props {
  period: Period;
  onClose: () => void;
  onPeriodUpdated: () => void;
}

type ValidateResp = {
  ok: boolean;
  issues: string[];
  drafts: { id: number; docNumber: string; entryDate: string }[];
  unbalanced: { entryId: number }[];
  missingAdjustments: { adjustmentId: number; name: string; missingMonths: string[] }[];
};

type AiResp = {
  metrics: { revenue: number; expense: number; netIncome: number; draftCount: number; missingAdjustmentsCount: number };
  findings: string[];
  suggestions: string[];
  readyToClose: boolean;
  riskLevel: string | null;
  source: "ai+rules" | "rules";
};

export function PeriodClosingWizard({ period, onClose, onPeriodUpdated }: Props) {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [plAccountId, setPlAccountId] = useState("");
  const [retainedId,  setRetainedId]  = useState("");
  const [forceSoftClose, setForceSoftClose] = useState(false);

  const safeJson = async (r: Response, fallback: string) => {
    const ct = r.headers.get("content-type") || "";
    const d = ct.includes("application/json") ? await r.json().catch(() => ({})) : {};
    if (!r.ok) throw new Error((d as any)?.error || fallback);
    return d;
  };

  // ─── Validate ─────────────────────────────────────────────────────
  const validateQ = useQuery<ValidateResp>({
    queryKey: ["period-validate", period.id],
    queryFn: async () => {
      const r = await fetch(`${API}/api/fiscal/periods/${period.id}/validate`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return safeJson(r, "تعذر التحقق من الفترة") as Promise<ValidateResp>;
    },
  });

  // ─── AI insights ───────────────────────────────────────────────────
  const aiMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/ai/period-insights`, {
        method: "POST", headers, body: JSON.stringify({ periodId: period.id }),
      });
      return safeJson(r, "تعذر تحليل الفترة") as Promise<AiResp>;
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const closePlMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/fiscal/periods/${period.id}/close-pl`, {
        method: "POST", headers, body: JSON.stringify({ plSummaryAccountId: Number(plAccountId) }),
      });
      return safeJson(r, "تعذر إقفال الأرباح والخسائر");
    },
    onSuccess: (d: any) => {
      toast({
        title: "تم إقفال الإيرادات والمصروفات",
        description: `صافي الفترة: ${(d?.netIncome ?? 0).toFixed(2)}`,
      });
      validateQ.refetch();
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const transferMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/fiscal/periods/${period.id}/transfer-profit`, {
        method: "POST", headers,
        body: JSON.stringify({
          plSummaryAccountId: Number(plAccountId),
          retainedEarningsAccountId: Number(retainedId),
        }),
      });
      return safeJson(r, "تعذر ترحيل الأرباح");
    },
    onSuccess: (d: any) => {
      toast({
        title: d?.isProfit ? "تم ترحيل الأرباح" : "تم ترحيل الخسائر",
        description: `المبلغ: ${(d?.amount ?? 0).toFixed(2)}`,
      });
      validateQ.refetch();
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const softCloseMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/fiscal/periods/${period.id}/soft-close`, {
        method: "POST", headers, body: JSON.stringify({ force: forceSoftClose }),
      });
      return safeJson(r, "تعذر الإقفال الناعم");
    },
    onSuccess: () => {
      toast({ title: "تم إقفال الفترة (ناعم) — يمكن إعادة فتحها لاحقاً" });
      qc.invalidateQueries({ queryKey: ["fiscal-periods"] });
      onPeriodUpdated();
    },
    onError: (e: any) => toast({ title: "تعذر الإقفال", description: e.message, variant: "destructive" }),
  });

  const hardCloseMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/fiscal/periods/${period.id}/hard-close`, {
        method: "POST", headers, body: "{}",
      });
      return safeJson(r, "تعذر الإقفال النهائي");
    },
    onSuccess: () => {
      toast({ title: "تم الإقفال النهائي للفترة — لا يمكن إعادة فتحها" });
      qc.invalidateQueries({ queryKey: ["fiscal-periods"] });
      onPeriodUpdated();
    },
    onError: (e: any) => toast({ title: "تعذر الإقفال النهائي", description: e.message, variant: "destructive" }),
  });

  const v = validateQ.data;
  const ai = aiMut.data;
  const isOpen = period.status === "open";
  const isSoftClosed = period.status === "closed";

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-background rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-gradient-to-l from-violet-600 to-purple-600 text-white p-4 flex items-center justify-between rounded-t-2xl z-10">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-white/15">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold">إقفال الفترة</h2>
              <p className="text-xs opacity-90">{period.name} — <span dir="ltr">{period.startDate}</span> → <span dir="ltr">{period.endDate}</span></p>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} className="text-white hover:bg-white/20 h-8 w-8 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-5 space-y-4">

          {/* 1. Validate */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-7 w-7 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center text-xs font-bold">1</div>
                <h3 className="font-semibold text-sm">التحقق من جاهزية الفترة</h3>
                <Button size="sm" variant="ghost" onClick={() => validateQ.refetch()} className="h-7 text-xs ml-auto">
                  إعادة التحقق
                </Button>
              </div>

              {validateQ.isLoading && <Skeleton className="h-16 w-full" />}
              {v && (
                <div className="space-y-2">
                  {v.ok ? (
                    <div className="rounded-md p-3 bg-green-50 border border-green-200 flex items-start gap-2 text-sm text-green-800">
                      <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <span>الفترة جاهزة للإقفال — لا توجد قيود معلقة أو تسويات ناقصة</span>
                    </div>
                  ) : (
                    <div className="rounded-md p-3 bg-amber-50 border border-amber-200 space-y-2 text-sm text-amber-900">
                      <div className="flex items-center gap-2 font-semibold">
                        <AlertCircle className="h-4 w-4" />
                        يجب معالجة المشاكل التالية:
                      </div>
                      <ul className="list-disc pr-5 space-y-0.5 text-xs">
                        {v.issues.map((i, idx) => <li key={idx}>{i}</li>)}
                      </ul>
                      {v.missingAdjustments.length > 0 && (
                        <div className="text-xs bg-white/50 rounded p-2 mt-1">
                          <strong>تسويات بحاجة توليد:</strong>
                          <ul className="list-disc pr-5 mt-0.5">
                            {v.missingAdjustments.map(m => (
                              <li key={m.adjustmentId}>
                                {m.name} — {m.missingMonths.length} شهر
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 2. AI insights */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-7 w-7 rounded-full bg-fuchsia-100 text-fuchsia-700 flex items-center justify-center text-xs font-bold">
                  <Brain className="h-3.5 w-3.5" />
                </div>
                <h3 className="font-semibold text-sm">تحليل الذكاء الاصطناعي</h3>
                <Button
                  size="sm" variant="outline"
                  onClick={() => aiMut.mutate()}
                  disabled={aiMut.isPending}
                  className="h-7 text-xs ml-auto gap-1 text-fuchsia-700 border-fuchsia-300 hover:bg-fuchsia-50"
                >
                  {aiMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  {ai ? "إعادة التحليل" : "حلّل الفترة"}
                </Button>
              </div>

              {ai && (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md bg-emerald-50 border border-emerald-200 p-2">
                      <div className="text-[10px] text-emerald-600">الإيرادات</div>
                      <div className="text-sm font-bold text-emerald-700">{ai.metrics.revenue.toFixed(2)}</div>
                    </div>
                    <div className="rounded-md bg-orange-50 border border-orange-200 p-2">
                      <div className="text-[10px] text-orange-600">المصروفات</div>
                      <div className="text-sm font-bold text-orange-700">{ai.metrics.expense.toFixed(2)}</div>
                    </div>
                    <div className={cn("rounded-md border p-2",
                      ai.metrics.netIncome >= 0 ? "bg-blue-50 border-blue-200" : "bg-red-50 border-red-200")}>
                      <div className="text-[10px] text-muted-foreground">الصافي</div>
                      <div className={cn("text-sm font-bold",
                        ai.metrics.netIncome >= 0 ? "text-blue-700" : "text-red-700")}>
                        {ai.metrics.netIncome.toFixed(2)}
                      </div>
                    </div>
                  </div>

                  {ai.findings.length > 0 && (
                    <div className="rounded-md p-2 bg-slate-50 border text-xs">
                      <div className="font-semibold mb-1">الملاحظات:</div>
                      <ul className="list-disc pr-5 space-y-0.5">
                        {ai.findings.map((f, i) => <li key={i}>{f}</li>)}
                      </ul>
                    </div>
                  )}
                  {ai.suggestions.length > 0 && (
                    <div className="rounded-md p-2 bg-violet-50 border border-violet-200 text-xs">
                      <div className="font-semibold mb-1 text-violet-800">توصيات:</div>
                      <ul className="list-disc pr-5 space-y-0.5 text-violet-900">
                        {ai.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{ai.source === "ai+rules" ? "تحليل الذكاء الاصطناعي + قواعد" : "تحليل بالقواعد"}</span>
                    <Badge variant="outline" className={cn(
                      ai.readyToClose ? "bg-green-50 text-green-700 border-green-200" : "bg-amber-50 text-amber-700 border-amber-200"
                    )}>
                      {ai.readyToClose ? "جاهز للإقفال" : "يحتاج مراجعة"}
                    </Badge>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 3. Closing entries (only if open) */}
          {isOpen && (
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <div className="h-7 w-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold">2</div>
                  <h3 className="font-semibold text-sm">قيود الإقفال (إيرادات + مصروفات)</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium mb-1 block">حساب ملخص الأرباح والخسائر *</label>
                    <AccountCombobox
                      value={plAccountId}
                      onValueChange={setPlAccountId}
                      filterTypes={["equity"]}
                      allowEmpty={false}
                      placeholder="— حساب حقوق ملكية —"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium mb-1 block">حساب الأرباح المحتجزة *</label>
                    <AccountCombobox
                      value={retainedId}
                      onValueChange={setRetainedId}
                      filterTypes={["equity"]}
                      allowEmpty={false}
                      placeholder="— حساب حقوق ملكية —"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm" variant="outline"
                    onClick={() => closePlMut.mutate()}
                    disabled={!plAccountId || closePlMut.isPending}
                    className="gap-2"
                  >
                    {closePlMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Calculator className="h-3.5 w-3.5" />}
                    أ) إقفال الإيرادات + المصروفات
                  </Button>
                  <Button
                    size="sm" variant="outline"
                    onClick={() => transferMut.mutate()}
                    disabled={!plAccountId || !retainedId || plAccountId === retainedId || transferMut.isPending}
                    className="gap-2"
                  >
                    {transferMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
                    ب) ترحيل الصافي للأرباح المحتجزة
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  ✦ الخطوات قابلة للإعادة (idempotent على المحاسب). أنشئ القيود ثم راجعها في «القيود المحاسبية».
                </p>
              </CardContent>
            </Card>
          )}

          {/* 4. Soft close */}
          {isOpen && (
            <Card className="border-amber-200">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <div className="h-7 w-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs font-bold">3</div>
                  <h3 className="font-semibold text-sm">إقفال ناعم (قابل للإعادة)</h3>
                </div>
                <p className="text-xs text-muted-foreground">
                  يمنع أي قيد جديد في الفترة، لكن يمكن إعادة فتحها بسهولة عند الحاجة.
                </p>
                {v && !v.ok && (
                  <label className="flex items-center gap-2 text-xs text-amber-800">
                    <input
                      type="checkbox"
                      checked={forceSoftClose}
                      onChange={(e) => setForceSoftClose(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    أؤكّد الإقفال رغم وجود تحذيرات
                  </label>
                )}
                <Button
                  size="sm"
                  onClick={() => softCloseMut.mutate()}
                  disabled={softCloseMut.isPending || (v && !v.ok && !forceSoftClose)}
                  className="gap-2 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {softCloseMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
                  إقفال ناعم
                </Button>
              </CardContent>
            </Card>
          )}

          {/* 5. Hard close */}
          {(isSoftClosed || isOpen) && (
            <Card className="border-red-200">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <div className="h-7 w-7 rounded-full bg-red-100 text-red-700 flex items-center justify-center text-xs font-bold">4</div>
                  <h3 className="font-semibold text-sm">إقفال نهائي (غير قابل للإعادة)</h3>
                </div>
                <p className="text-xs text-muted-foreground">
                  بعد التأكد من ختم الفترة، يمكن قفلها نهائياً — لن يستطيع أحد إعادة فتحها أبداً.
                </p>
                <Button
                  size="sm" variant="destructive"
                  onClick={() => hardCloseMut.mutate()}
                  disabled={!isSoftClosed || hardCloseMut.isPending}
                  className="gap-2"
                  title={!isSoftClosed ? "نفّذ الإقفال الناعم أولاً" : ""}
                >
                  {hardCloseMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldX className="h-3.5 w-3.5" />}
                  إقفال نهائي
                </Button>
                {!isSoftClosed && (
                  <p className="text-[10px] text-amber-700">⚠ يجب الإقفال الناعم أولاً</p>
                )}
              </CardContent>
            </Card>
          )}

          {period.status === "permanently_closed" && (
            <div className="rounded-md p-3 bg-red-50 border border-red-200 text-sm text-red-800 flex items-center gap-2">
              <ShieldX className="h-4 w-4" />
              هذه الفترة مُقفلة نهائياً ولا يمكن إعادة فتحها أو التعديل عليها.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
