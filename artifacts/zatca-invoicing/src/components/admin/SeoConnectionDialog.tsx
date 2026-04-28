import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Plug, Loader2, ExternalLink, Copy, Check, Sparkles, Wand2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ConnectionState {
  analytics: boolean;
  searchConsole: boolean;
  analyticsPropertyId: string | null;
  searchConsoleSiteUrl: string | null;
  serviceAccountSet: boolean;
  serviceAccountEmail: string | null;
}

interface TestResult {
  analytics: { tested: boolean; ok: boolean; error?: string };
  searchConsole: { tested: boolean; ok: boolean; error?: string };
  serviceAccountEmail: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function SeoConnectionDialog({ open, onOpenChange }: Props) {
  const { token } = useAuth();
  const qc = useQueryClient();

  const headers = (): HeadersInit => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  });

  // Pull current state
  const { data: state, isLoading } = useQuery<ConnectionState>({
    queryKey: ["seo-connection"],
    enabled: open,
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/seo/connection`, { headers: headers() });
      if (!r.ok) throw new Error("تعذّر تحميل حالة الربط");
      return r.json();
    },
  });

  // ─── Local form state ─────────────────────────────────────────────────
  const [propertyId, setPropertyId] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [saJson, setSaJson] = useState("");        // empty = "keep current"
  const [analyticsOn, setAnalyticsOn] = useState(false);
  const [searchConsoleOn, setSearchConsoleOn] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ── AI helper state ──────────────────────────────────────────────────
  const [aiOpen, setAiOpen] = useState(false);
  const [aiHint, setAiHint] = useState("");
  const [aiResult, setAiResult] = useState<{
    analyticsPropertyId: string | null;
    searchConsoleSiteUrl: string | null;
    analyticsMeasurementId?: string | null;
    gtmContainerId?: string | null;
    legacyUaId?: string | null;
    fetchedFrom?: string | null;
    notes: string;
    source: "ai" | "regex";
  } | null>(null);
  // Track which fields were last filled by AI so we can show a small badge.
  const [aiFilled, setAiFilled] = useState<{ propertyId: boolean; siteUrl: boolean }>({
    propertyId: false,
    siteUrl: false,
  });

  // Reset form whenever the dialog opens or remote state arrives.
  useEffect(() => {
    if (open && state) {
      setPropertyId(state.analyticsPropertyId ?? "");
      setSiteUrl(state.searchConsoleSiteUrl ?? "");
      setSaJson(""); // never prefill — server doesn't return it
      setAnalyticsOn(state.analytics);
      setSearchConsoleOn(state.searchConsole);
      setTestResult(null);
      setSavedNotice(null);
      setAiOpen(false);
      setAiHint("");
      setAiResult(null);
      setAiFilled({ propertyId: false, siteUrl: false });
    }
  }, [open, state]);

  const testMut = useMutation({
    mutationFn: async (): Promise<TestResult> => {
      setSavedNotice(null);
      const body: Record<string, unknown> = {
        analyticsPropertyId: propertyId || null,
        searchConsoleSiteUrl: siteUrl || null,
      };
      // Only send saJson if the user pasted something new — otherwise use saved.
      if (saJson.trim()) body.serviceAccountJson = saJson;
      const r = await fetch(`${API}/api/admin/seo/connection/test`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json?.error || "فشل الاختبار");
      return json;
    },
    onSuccess: (r) => setTestResult(r),
  });

  const saveMut = useMutation({
    mutationFn: async (): Promise<ConnectionState> => {
      const body: Record<string, unknown> = {
        analyticsPropertyId: propertyId || null,
        searchConsoleSiteUrl: siteUrl || null,
        analytics: analyticsOn,
        searchConsole: searchConsoleOn,
      };
      if (saJson.trim()) body.serviceAccountJson = saJson;
      const r = await fetch(`${API}/api/admin/seo/connection`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json?.error || "فشل الحفظ");
      return json;
    },
    onSuccess: () => {
      setSavedNotice("تم حفظ إعدادات الربط بنجاح");
      setSaJson(""); // clear textarea after save
      qc.invalidateQueries({ queryKey: ["seo-connection"] });
      qc.invalidateQueries({ queryKey: ["seo-dashboard"] });
    },
  });

  const aiMut = useMutation({
    mutationFn: async (): Promise<{
      analyticsPropertyId: string | null;
      searchConsoleSiteUrl: string | null;
      analyticsMeasurementId?: string | null;
      gtmContainerId?: string | null;
      legacyUaId?: string | null;
      fetchedFrom?: string | null;
      notes: string;
      source: "ai" | "regex";
    }> => {
      setSavedNotice(null);
      const r = await fetch(`${API}/api/admin/seo/connection/suggest`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ hint: aiHint }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json?.error || "تعذّر توليد الاقتراحات");
      return json;
    },
    onSuccess: (r) => {
      setAiResult(r);
      const filled = { propertyId: false, siteUrl: false };
      // Only overwrite an empty field by default; otherwise show the
      // suggestion in the result card and let the user click "تطبيق".
      if (r.analyticsPropertyId && !propertyId.trim()) {
        setPropertyId(r.analyticsPropertyId);
        filled.propertyId = true;
      }
      if (r.searchConsoleSiteUrl && !siteUrl.trim()) {
        setSiteUrl(r.searchConsoleSiteUrl);
        filled.siteUrl = true;
      }
      setAiFilled(filled);
    },
  });

  const applyAi = (field: "propertyId" | "siteUrl") => {
    if (!aiResult) return;
    if (field === "propertyId" && aiResult.analyticsPropertyId) {
      setPropertyId(aiResult.analyticsPropertyId);
      setAiFilled((s) => ({ ...s, propertyId: true }));
    }
    if (field === "siteUrl" && aiResult.searchConsoleSiteUrl) {
      setSiteUrl(aiResult.searchConsoleSiteUrl);
      setAiFilled((s) => ({ ...s, siteUrl: true }));
    }
  };

  const copyEmail = async () => {
    const email = state?.serviceAccountEmail;
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const isBusy = testMut.isPending || saveMut.isPending;
  const hasSavedSa = !!state?.serviceAccountSet;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="seo-connection-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="h-5 w-5 text-primary" />
            ربط Google Analytics و Search Console
          </DialogTitle>
          <DialogDescription>
            استخدم حساب خدمة (Service Account) من Google Cloud لجلب البيانات الحقيقية تلقائياً.
            بعد لصق ملف الحساب، أضف بريد الحساب كمستخدم في GA4 و Search Console.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin inline-block ml-2" />
            جاري التحميل...
          </div>
        ) : (
          <div className="space-y-5">
            {/* Status summary */}
            <div className="grid grid-cols-2 gap-3">
              <StatusCard label="Google Analytics" connected={!!state?.analytics} />
              <StatusCard label="Search Console" connected={!!state?.searchConsole} />
            </div>

            {/* ─── AI helper ─── */}
            <div className="border rounded-lg bg-gradient-to-l from-indigo-50/40 to-violet-50/40 dark:from-indigo-950/20 dark:to-violet-950/20">
              <button
                type="button"
                onClick={() => setAiOpen((v) => !v)}
                className="w-full p-3 flex items-center justify-between text-right"
                data-testid="seo-ai-helper-toggle"
              >
                <span className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-violet-600" />
                  <span className="font-semibold text-sm">توليد الإعدادات بالذكاء الاصطناعي</span>
                  <Badge variant="secondary" className="text-[10px] font-normal">جديد</Badge>
                </span>
                <span className="text-xs text-muted-foreground">{aiOpen ? "إخفاء" : "اقتراح تلقائي"}</span>
              </button>

              {aiOpen && (
                <div className="px-3 pb-3 space-y-2">
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    الصق رابط لوحة Google Analytics أو رابط Search Console أو رابط موقعك،
                    وسيستخرج الذكاء الاصطناعي معرّف GA4 ورابط Search Console بالصيغة الصحيحة.
                  </p>
                  <Textarea
                    placeholder={`أمثلة:\nhttps://analytics.google.com/analytics/web/#/p123456789/reports/dashboard\nأو: example.com\nأو: sc-domain:example.com`}
                    rows={3}
                    value={aiHint}
                    onChange={(e) => setAiHint(e.target.value)}
                    className="text-xs"
                    dir="auto"
                    data-testid="seo-ai-hint"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => aiMut.mutate()}
                      disabled={aiMut.isPending || !aiHint.trim()}
                      data-testid="seo-ai-generate"
                      className="bg-violet-600 hover:bg-violet-700 text-white"
                    >
                      {aiMut.isPending
                        ? <Loader2 className="h-4 w-4 animate-spin ml-2" />
                        : <Wand2 className="h-4 w-4 ml-2" />}
                      اقتراح بالذكاء الاصطناعي
                    </Button>
                    {aiMut.isError && (
                      <span className="text-xs text-rose-700">{(aiMut.error as Error).message}</span>
                    )}
                  </div>

                  {aiResult && (
                    <div className="mt-2 rounded border bg-background/60 p-2 space-y-1.5 text-xs">
                      <div className="flex items-center gap-2 text-[11px]">
                        <Sparkles className="h-3 w-3 text-violet-600" />
                        <span className="font-semibold">النتيجة</span>
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {aiResult.source === "ai" ? "ذكاء اصطناعي" : "استخراج تلقائي"}
                        </Badge>
                      </div>
                      <SuggestionRow
                        label="معرّف GA4"
                        value={aiResult.analyticsPropertyId}
                        onApply={() => applyAi("propertyId")}
                        applied={aiFilled.propertyId}
                      />
                      <SuggestionRow
                        label="رابط Search Console"
                        value={aiResult.searchConsoleSiteUrl}
                        onApply={() => applyAi("siteUrl")}
                        applied={aiFilled.siteUrl}
                      />

                      {/* Site-fetch signals — read-only because the
                          Measurement ID is NOT the Property ID, and the
                          GTM/UA values are purely informational. */}
                      {(aiResult.fetchedFrom || aiResult.analyticsMeasurementId
                        || aiResult.gtmContainerId || aiResult.legacyUaId) && (
                        <div className="border-t pt-1.5 mt-1.5 space-y-1">
                          <div className="text-[10px] text-muted-foreground">
                            ما وجدناه عند فحص صفحة موقعك:
                          </div>
                          {aiResult.analyticsMeasurementId && (
                            <InfoRow
                              label="معرّف قياس GA4"
                              value={aiResult.analyticsMeasurementId}
                              tone="info"
                            />
                          )}
                          {aiResult.gtmContainerId && (
                            <InfoRow
                              label="حاوية Tag Manager"
                              value={aiResult.gtmContainerId}
                              tone="info"
                            />
                          )}
                          {aiResult.legacyUaId && (
                            <InfoRow
                              label="معرّف Universal Analytics قديم"
                              value={aiResult.legacyUaId}
                              tone="warn"
                            />
                          )}
                          {aiResult.fetchedFrom
                            && !aiResult.analyticsMeasurementId
                            && !aiResult.gtmContainerId
                            && !aiResult.legacyUaId && (
                            <p className="text-[11px] text-amber-700">
                              لم نجد شيفرة Google Analytics في صفحة موقعك.
                            </p>
                          )}
                        </div>
                      )}

                      {aiResult.notes && (
                        <p className="text-[11px] text-muted-foreground border-t pt-1.5 mt-1.5 leading-relaxed">
                          {aiResult.notes}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Service account JSON */}
            <div className="space-y-1.5">
              <Label htmlFor="sa-json" className="flex items-center justify-between">
                <span>ملف حساب الخدمة (Service Account JSON)</span>
                {hasSavedSa && (
                  <Badge variant="secondary" className="font-normal">
                    <CheckCircle2 className="h-3 w-3 ml-1 text-green-600" />
                    محفوظ
                  </Badge>
                )}
              </Label>
              <Textarea
                id="sa-json"
                placeholder={hasSavedSa
                  ? "اترك فارغاً للإبقاء على الملف المحفوظ، أو الصق ملف جديد لاستبداله"
                  : "الصق محتوى ملف JSON الكامل من Google Cloud Console (Service Account Key)"
                }
                rows={6}
                value={saJson}
                onChange={(e) => setSaJson(e.target.value)}
                className="font-mono text-xs"
                data-testid="seo-sa-json"
              />
              {state?.serviceAccountEmail && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">بريد حساب الخدمة:</span>
                  <code className="bg-muted px-2 py-0.5 rounded">{state.serviceAccountEmail}</code>
                  <button
                    type="button"
                    onClick={copyEmail}
                    className="text-primary hover:underline inline-flex items-center gap-1"
                    data-testid="seo-copy-sa-email"
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? "نُسخ" : "نسخ"}
                  </button>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                أضف هذا البريد كمستخدم بصلاحية «Viewer» في GA4 و Search Console قبل الربط.
              </p>
            </div>

            {/* GA4 */}
            <div className="space-y-2 border rounded-lg p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="ga-prop" className="font-semibold">Google Analytics 4 (GA4)</Label>
                <div className="flex items-center gap-2 text-xs">
                  <span className={analyticsOn ? "text-green-700" : "text-muted-foreground"}>
                    {analyticsOn ? "مفعّل" : "متوقف"}
                  </span>
                  <Switch
                    checked={analyticsOn}
                    onCheckedChange={setAnalyticsOn}
                    data-testid="seo-toggle-ga"
                  />
                </div>
              </div>
              <Input
                id="ga-prop"
                placeholder="معرّف الموقع — مثال: 123456789"
                value={propertyId}
                onChange={(e) => setPropertyId(e.target.value)}
                data-testid="seo-ga-property"
              />
              <p className="text-[11px] text-muted-foreground">
                موقعه: GA4 Admin → Property Settings → Property ID (أرقام فقط).
              </p>
              {testResult?.analytics?.tested && (
                <TestRow ok={testResult.analytics.ok} error={testResult.analytics.error} />
              )}
            </div>

            {/* GSC */}
            <div className="space-y-2 border rounded-lg p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="gsc-url" className="font-semibold">Search Console</Label>
                <div className="flex items-center gap-2 text-xs">
                  <span className={searchConsoleOn ? "text-green-700" : "text-muted-foreground"}>
                    {searchConsoleOn ? "مفعّل" : "متوقف"}
                  </span>
                  <Switch
                    checked={searchConsoleOn}
                    onCheckedChange={setSearchConsoleOn}
                    data-testid="seo-toggle-gsc"
                  />
                </div>
              </div>
              <Input
                id="gsc-url"
                placeholder="رابط الموقع — مثال: https://example.com/  أو  sc-domain:example.com"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                dir="ltr"
                data-testid="seo-gsc-site"
              />
              <p className="text-[11px] text-muted-foreground">
                استخدم نفس الصيغة المعرّفة في حسابك على Search Console (الرابط الكامل أو sc-domain:).
              </p>
              {testResult?.searchConsole?.tested && (
                <TestRow ok={testResult.searchConsole.ok} error={testResult.searchConsole.error} />
              )}
            </div>

            {/* Errors / notices */}
            {testMut.isError && (
              <Alert variant="destructive">
                <AlertDescription>{(testMut.error as Error).message}</AlertDescription>
              </Alert>
            )}
            {saveMut.isError && (
              <Alert variant="destructive">
                <AlertDescription>{(saveMut.error as Error).message}</AlertDescription>
              </Alert>
            )}
            {savedNotice && (
              <Alert className="border-green-300 bg-green-50/50">
                <AlertDescription className="text-green-800">{savedNotice}</AlertDescription>
              </Alert>
            )}

            {/* Help link */}
            <Alert>
              <AlertDescription className="text-xs leading-relaxed">
                <strong>كيفية إنشاء حساب خدمة:</strong> افتح Google Cloud Console → IAM & Admin → Service Accounts →
                إنشاء حساب جديد → Keys → Add Key (JSON) → الصق المحتوى هنا.
                <a
                  href="https://cloud.google.com/iam/docs/service-accounts-create"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1 mr-1"
                >
                  دليل Google
                  <ExternalLink className="h-3 w-3" />
                </a>
              </AlertDescription>
            </Alert>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => testMut.mutate()}
            disabled={isBusy || (!propertyId && !siteUrl) || (!saJson.trim() && !hasSavedSa)}
            data-testid="seo-test-connection"
          >
            {testMut.isPending && <Loader2 className="h-4 w-4 animate-spin ml-2" />}
            اختبار الاتصال
          </Button>
          <Button
            onClick={() => saveMut.mutate()}
            disabled={isBusy}
            data-testid="seo-save-connection"
          >
            {saveMut.isPending && <Loader2 className="h-4 w-4 animate-spin ml-2" />}
            حفظ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusCard({ label, connected }: { label: string; connected: boolean }) {
  return (
    <div className={`rounded-lg border p-3 flex items-center gap-2 ${connected ? "bg-green-50 border-green-300" : "bg-amber-50/40 border-amber-200"}`}>
      {connected ? (
        <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
      ) : (
        <XCircle className="h-5 w-5 text-amber-600 shrink-0" />
      )}
      <div>
        <p className="text-sm font-semibold">{label}</p>
        <p className={`text-[11px] ${connected ? "text-green-700" : "text-amber-700"}`}>
          {connected ? "متصل" : "غير متصل"}
        </p>
      </div>
    </div>
  );
}

function SuggestionRow({
  label, value, onApply, applied,
}: { label: string; value: string | null; onApply: () => void; applied: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <span className="text-muted-foreground">{label}: </span>
        {value ? (
          <code className="bg-muted px-1.5 py-0.5 rounded text-[11px] break-all" dir="ltr">{value}</code>
        ) : (
          <span className="text-amber-700">لم يُستخرج — أدخله يدوياً</span>
        )}
      </div>
      {value && (
        applied ? (
          <Badge variant="secondary" className="text-[10px] font-normal shrink-0">
            <Check className="h-3 w-3 ml-1 text-green-600" />
            مُطبَّق
          </Badge>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 text-[11px] px-2 shrink-0"
            onClick={onApply}
          >
            تطبيق
          </Button>
        )
      )}
    </div>
  );
}

function InfoRow({
  label, value, tone,
}: { label: string; value: string; tone: "info" | "warn" }) {
  // Read-only counterpart to SuggestionRow. Used for site-fetch hits
  // that the admin should SEE but cannot directly apply to a form
  // field (e.g. GA4 Measurement ID, GTM container ID).
  const codeColor = tone === "warn"
    ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
    : "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200";
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <span className="text-muted-foreground">{label}: </span>
        <code className={`px-1.5 py-0.5 rounded text-[11px] break-all ${codeColor}`} dir="ltr">
          {value}
        </code>
      </div>
    </div>
  );
}

function TestRow({ ok, error }: { ok: boolean; error?: string }) {
  return (
    <div className={`text-xs p-2 rounded flex items-start gap-2 ${ok ? "bg-green-50 text-green-800" : "bg-rose-50 text-rose-800"}`}>
      {ok ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" /> : <XCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      <span>{ok ? "نجح الاتصال — البيانات متاحة" : (error || "فشل الاتصال")}</span>
    </div>
  );
}
