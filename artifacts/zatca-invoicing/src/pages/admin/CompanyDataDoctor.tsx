// SuperAdmin "Company Data Doctor" — per-company data quality scanner,
// AI-narrated report, manual delete to recycle bin, and recycle-bin restore.
//
// Three tabs:
//   1) تشخيص    — pick a company, run the SQL scan, read the AI summary,
//                  inspect each problem category and check rows to delete.
//   2) حذف البيانات — orphan batch-delete + danger-zone full-company wipe
//                     (typed-name confirmation).
//   3) سلة المحذوفات — paginated list of deleted_records with restore /
//                       permanent purge.
//
// All requests go through the existing admin auth (Bearer token from
// useAuth) — `requireSuperAdmin` enforces access on the server side.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Stethoscope, ScanSearch, Trash2, RotateCcw, AlertTriangle, AlertCircle, Info,
  Sparkles, Loader2, RefreshCcw, Database, ShieldAlert, CheckCircle2,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Types ────────────────────────────────────────────────────────────────
type TableKey =
  | "invoices" | "purchase_invoices" | "journal_entries"
  | "customers" | "suppliers" | "items"
  | "cash_boxes" | "bank_accounts" | "warehouses" | "branches" | "accounts";

type ScanItem = {
  key: string;
  labelAr: string;
  severity: "high" | "medium" | "low";
  count: number;
  samples: any[];
  entityTable: TableKey;
};

type ScanCategory = { labelAr: string; items: ScanItem[] };

type ScanResult = {
  companyId: number;
  companyName: string;
  generatedAt: string;
  totalIssues: number;
  categories: {
    duplicates: ScanCategory;
    missingFields: ScanCategory;
    accountingErrors: ScanCategory;
  };
};

type Company = { id: number; nameAr: string; nameEn: string | null; vatNumber: string | null; status: string };

type RecycleRow = {
  id: number;
  tableName: string;
  tableLabel: string;
  companyId: number | null;
  recordId: number;
  payload: any;
  summary: string;
  deletedAt: string;
  deletedByUsername: string | null;
  reason: string | null;
  source: string;
  restoredAt: string | null;
};

const SEV_STYLE = {
  high:   { bg: "bg-red-50",    border: "border-red-200",    text: "text-red-800",    icon: AlertCircle,    label: "خطورة عالية" },
  medium: { bg: "bg-amber-50",  border: "border-amber-200",  text: "text-amber-900",  icon: AlertTriangle,  label: "خطورة متوسطة" },
  low:    { bg: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-900",   icon: Info,           label: "خطورة منخفضة" },
} as const;

// Render the small Markdown the backend returns. Lightweight: paragraphs +
// bullets + bold/code. Avoids pulling a full Markdown lib for one screen.
//
// SECURITY: this content originates from an LLM and is therefore untrusted.
// We MUST NOT use dangerouslySetInnerHTML — instead we tokenize the inline
// formatting markers (`**bold**` and `` `code` ``) and emit real React nodes
// so any stray "<script>" or HTML in the source becomes plain text.
function renderInline(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Token regex: **bold** or `code`. Capture the marker so we can dispatch.
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(<strong key={`b${i++}`}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(<code key={`c${i++}`} className="bg-slate-100 px-1 rounded text-xs">{tok.slice(1, -1)}</code>);
    }
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
function MiniMarkdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-3 text-sm leading-7">
      {blocks.map((b, i) => {
        if (b.startsWith("## ")) return <h3 key={i} className="text-base font-bold mt-2">{b.slice(3)}</h3>;
        if (b.startsWith("# "))  return <h2 key={i} className="text-lg font-bold mt-2">{b.slice(2)}</h2>;
        const lines = b.split("\n");
        if (lines.every(l => l.startsWith("- ") || l.startsWith("* "))) {
          return (
            <ul key={i} className="list-disc pr-6 space-y-1">
              {lines.map((l, j) => <li key={j}>{renderInline(l.slice(2))}</li>)}
            </ul>
          );
        }
        if (lines.every(l => /^\d+\.\s/.test(l))) {
          return (
            <ol key={i} className="list-decimal pr-6 space-y-1">
              {lines.map((l, j) => <li key={j}>{renderInline(l.replace(/^\d+\.\s/, ""))}</li>)}
            </ol>
          );
        }
        return <p key={i}>{renderInline(b)}</p>;
      })}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────
export default function CompanyDataDoctor() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = useMemo(() => ({
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
  }), [token]);

  const [companyId, setCompanyId] = useState<number | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [aiSummary, setAiSummary] = useState<{ text: string; source: "ai" | "fallback" } | null>(null);
  // Map of "<table>:<id>" → boolean to track checked rows for batch delete.
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const companiesQ = useQuery<{ companies: Company[] }>({
    queryKey: ["dd", "companies"],
    queryFn: async () => (await fetch(`${API}/api/admin/data-doctor/companies`, { headers })).json(),
  });
  const companies = companiesQ.data?.companies ?? [];
  const selectedCompany = companies.find(c => c.id === companyId) ?? null;

  const scanMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/admin/data-doctor/scan`, {
        method: "POST", headers, body: JSON.stringify({ companyId }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل الفحص");
      return r.json() as Promise<ScanResult>;
    },
    onSuccess: (data) => {
      setScan(data); setPicked({}); setAiSummary(null);
      // Auto-trigger the AI explanation as a non-blocking follow-up.
      aiMut.mutate(data);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message ?? "فشل الفحص", variant: "destructive" }),
  });

  const aiMut = useMutation({
    mutationFn: async (s: ScanResult) => {
      const r = await fetch(`${API}/api/admin/data-doctor/ai-explain`, {
        method: "POST", headers, body: JSON.stringify({ scan: s }),
      });
      if (!r.ok) throw new Error("فشل التحليل الذكي");
      return r.json() as Promise<{ summary: string; source: "ai" | "fallback" }>;
    },
    onSuccess: (d) => setAiSummary({ text: d.summary, source: d.source }),
  });

  const deleteMut = useMutation({
    mutationFn: async (items: Array<{ table: TableKey; id: number }>) => {
      const r = await fetch(`${API}/api/admin/data-doctor/delete`, {
        method: "POST", headers,
        body: JSON.stringify({ companyId, items, reason: "حذف يدوي من شاشة طبيب البيانات" }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل الحذف");
      return r.json();
    },
    onSuccess: (d) => {
      toast({ title: "تم الحذف", description: `تم حذف ${d.summary.ok} عنصر إلى سلة المحذوفات` });
      setPicked({});
      qc.invalidateQueries({ queryKey: ["dd", "recycle-bin"] });
      // Re-scan so counts refresh.
      scanMut.mutate();
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message ?? "فشل الحذف", variant: "destructive" }),
  });

  const wipeMut = useMutation({
    mutationFn: async (confirmText: string) => {
      const r = await fetch(`${API}/api/admin/data-doctor/wipe-company`, {
        method: "POST", headers,
        body: JSON.stringify({ companyId, confirmText, reason: "حذف بيانات شركة كامل من الشاشة" }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "فشل الحذف الشامل");
      return r.json();
    },
    onSuccess: (d) => {
      toast({ title: "تم الحذف الشامل", description: `تم حذف ${d.totalDeleted} سجل إجمالي`, variant: "destructive" });
      qc.invalidateQueries({ queryKey: ["dd", "recycle-bin"] });
      setScan(null); setAiSummary(null);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message ?? "فشل الحذف", variant: "destructive" }),
  });

  // Pick-related helpers shared by Diagnose + Delete tabs.
  const pickKey = (t: TableKey, id: number) => `${t}:${id}`;
  const togglePick = (t: TableKey, id: number) =>
    setPicked(p => ({ ...p, [pickKey(t, id)]: !p[pickKey(t, id)] }));
  const pickedItems = useMemo(() => {
    const list: Array<{ table: TableKey; id: number }> = [];
    for (const [k, v] of Object.entries(picked)) {
      if (!v) continue;
      const [t, idStr] = k.split(":");
      list.push({ table: t as TableKey, id: Number(idStr) });
    }
    return list;
  }, [picked]);

  return (
    <div dir="rtl" className="p-6 space-y-6 max-w-screen-2xl mx-auto" data-testid="page-data-doctor">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Stethoscope className="w-8 h-8 text-emerald-600" />
          <div>
            <h1 className="text-2xl font-bold">طبيب بيانات الشركات</h1>
            <p className="text-sm text-slate-600">
              أداة المشرف العام لفحص وتنظيف بيانات أي شركة باستخدام الذكاء الاصطناعي
            </p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="diagnose" className="w-full">
        <TabsList className="grid grid-cols-3 w-full max-w-2xl">
          <TabsTrigger value="diagnose"  data-testid="tab-diagnose"><ScanSearch className="w-4 h-4 ml-2" />تشخيص</TabsTrigger>
          <TabsTrigger value="delete"    data-testid="tab-delete"><Trash2 className="w-4 h-4 ml-2" />حذف البيانات</TabsTrigger>
          <TabsTrigger value="recycle"   data-testid="tab-recycle"><RotateCcw className="w-4 h-4 ml-2" />سلة المحذوفات</TabsTrigger>
        </TabsList>

        {/* ─── TAB 1: DIAGNOSE ───────────────────────────────────────────── */}
        <TabsContent value="diagnose" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Database className="w-5 h-5" />اختر الشركة</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="min-w-[280px]">
                  <Label>الشركة</Label>
                  <Select value={companyId ? String(companyId) : ""} onValueChange={(v) => { setCompanyId(Number(v)); setScan(null); setAiSummary(null); setPicked({}); }}>
                    <SelectTrigger data-testid="select-company"><SelectValue placeholder="— اختر شركة —" /></SelectTrigger>
                    <SelectContent>
                      {companies.map(c => (
                        <SelectItem key={c.id} value={String(c.id)} data-testid={`option-company-${c.id}`}>
                          {c.nameAr}{c.vatNumber ? ` — ${c.vatNumber}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={() => scanMut.mutate()}
                  disabled={!companyId || scanMut.isPending}
                  data-testid="btn-scan"
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  {scanMut.isPending
                    ? <><Loader2 className="w-4 h-4 ml-2 animate-spin" />جاري الفحص…</>
                    : <><Sparkles className="w-4 h-4 ml-2" />ابدأ الفحص الذكي</>}
                </Button>
              </div>
              {scan && (
                <div className="text-sm text-slate-600 flex items-center gap-3 flex-wrap">
                  <span>آخر فحص: {new Date(scan.generatedAt).toLocaleString("ar-SA")}</span>
                  <Badge variant={scan.totalIssues > 0 ? "destructive" : "default"} data-testid="badge-total-issues">
                    إجمالي المشاكل: {scan.totalIssues}
                  </Badge>
                </div>
              )}
            </CardContent>
          </Card>

          {/* AI narrative card */}
          {scan && (
            <Card className="border-emerald-200 bg-emerald-50/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-emerald-600" />
                  تقرير الذكاء الاصطناعي
                  {aiSummary?.source === "fallback" && (
                    <Badge variant="outline" className="text-xs">نسخة احتياطية</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {aiMut.isPending && (
                  <div className="flex items-center gap-2 text-slate-600 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" />جاري التحليل بالذكاء الاصطناعي…
                  </div>
                )}
                {aiSummary && <div data-testid="ai-summary"><MiniMarkdown text={aiSummary.text} /></div>}
                {!aiMut.isPending && !aiSummary && (
                  <p className="text-sm text-slate-500">لم يبدأ التحليل بعد.</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Categorized issues */}
          {scan && Object.entries(scan.categories).map(([catKey, cat]) => (
            <CategoryCard
              key={catKey}
              category={cat}
              picked={picked}
              onToggle={togglePick}
              pickKey={pickKey}
            />
          ))}

          {/* Bottom action bar — visible whenever the user has picked rows */}
          {pickedItems.length > 0 && (
            <div className="sticky bottom-4 mx-auto max-w-3xl bg-white border-2 border-emerald-300 shadow-xl rounded-2xl p-4 flex items-center justify-between" data-testid="action-bar-delete">
              <div className="text-sm font-medium">
                تم تحديد {pickedItems.length} عنصر للحذف
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" data-testid="btn-delete-picked">
                    <Trash2 className="w-4 h-4 ml-2" />حذف المحدد إلى سلة المحذوفات
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent dir="rtl">
                  <AlertDialogHeader>
                    <AlertDialogTitle>تأكيد الحذف</AlertDialogTitle>
                    <AlertDialogDescription>
                      سيتم نقل {pickedItems.length} سجل إلى سلة المحذوفات. يمكنك استعادتها لاحقاً.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>إلغاء</AlertDialogCancel>
                    <AlertDialogAction onClick={() => deleteMut.mutate(pickedItems)} data-testid="confirm-delete">
                      حذف الآن
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </TabsContent>

        {/* ─── TAB 2: DELETE / DANGER ZONE ──────────────────────────────── */}
        <TabsContent value="delete" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Trash2 className="w-5 h-5" />حذف البيانات اليتيمة
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!scan ? (
                <p className="text-sm text-slate-500">قم أولاً بفحص شركة من تبويب التشخيص لرؤية البيانات اليتيمة.</p>
              ) : (
                <OrphansPanel scan={scan} onDelete={(items) => deleteMut.mutate(items)} pending={deleteMut.isPending} />
              )}
            </CardContent>
          </Card>

          <Card className="border-red-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-700">
                <ShieldAlert className="w-5 h-5" />منطقة الخطر — حذف بيانات شركة كاملة
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DangerZonePanel
                company={selectedCompany}
                pending={wipeMut.isPending}
                onWipe={(text) => wipeMut.mutate(text)}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── TAB 3: RECYCLE BIN ───────────────────────────────────────── */}
        <TabsContent value="recycle" className="mt-4">
          <RecycleBinTab headers={headers} companies={companies} defaultCompanyId={companyId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Sub-component: a single category's card with sample rows ─────────────
function CategoryCard({
  category, picked, onToggle, pickKey,
}: {
  category: ScanCategory;
  picked: Record<string, boolean>;
  onToggle: (t: TableKey, id: number) => void;
  pickKey: (t: TableKey, id: number) => string;
}) {
  const itemsWithFindings = category.items.filter(it => it.count > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>{category.labelAr}</span>
          <Badge variant={itemsWithFindings.length > 0 ? "destructive" : "default"}>
            {itemsWithFindings.length} نوع مشكلة
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {category.items.map(item => {
          const sty = SEV_STYLE[item.severity];
          const Icon = sty.icon;
          if (item.count === 0) {
            return (
              <div key={item.key} className="flex items-center gap-2 text-sm text-emerald-700">
                <CheckCircle2 className="w-4 h-4" /> {item.labelAr}: لا توجد مشاكل
              </div>
            );
          }
          return (
            <div key={item.key} className={`border-2 ${sty.border} ${sty.bg} rounded-lg p-3 space-y-2`} data-testid={`issue-${item.key}`}>
              <div className={`flex items-center justify-between gap-2 ${sty.text}`}>
                <div className="flex items-center gap-2 font-bold">
                  <Icon className="w-4 h-4" />
                  {item.labelAr}
                  <Badge variant="outline" className="text-xs">{sty.label}</Badge>
                </div>
                <span className="text-sm">العدد: {item.count}</span>
              </div>
              <div className="bg-white border rounded p-2 max-h-64 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="w-8"></th>
                      <th className="text-right">المعرّف</th>
                      <th className="text-right">العنصر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.samples.map((s: any, i: number) => {
                      // Duplicates samples have shape { ids: [..], names: [..] }
                      // — render each id in the group as its own actionable row.
                      const ids: number[] = Array.isArray(s.ids) ? s.ids : (s.id ? [s.id] : []);
                      const names: string[] = Array.isArray(s.names) ? s.names : [s.nameAr ?? s.code ?? s.invoiceNumber ?? s.docNumber ?? "—"];
                      return ids.map((id, j) => {
                        const k = pickKey(item.entityTable, id);
                        return (
                          <tr key={`${i}-${j}`} className="border-t">
                            <td className="text-center">
                              <Checkbox
                                checked={!!picked[k]}
                                onCheckedChange={() => onToggle(item.entityTable, id)}
                                data-testid={`pick-${item.entityTable}-${id}`}
                              />
                            </td>
                            <td>{id}</td>
                            <td>{names[j] ?? names[0] ?? "—"}</td>
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ─── Sub-component: orphans-only batch panel for tab 2 ────────────────────
function OrphansPanel({ scan, onDelete, pending }: {
  scan: ScanResult;
  onDelete: (items: Array<{ table: TableKey; id: number }>) => void;
  pending: boolean;
}) {
  // Orphans = items in accountingErrors that look like dangling references
  // OR items whose key starts with "orphan_". The user can batch-delete all
  // of them with one click.
  const orphanKeys = new Set(["orphan_invoices", "orphan_journal_lines", "orphan_accounts"]);
  const allOrphans = scan.categories.accountingErrors.items.filter(it => orphanKeys.has(it.key));
  const totalOrphans = allOrphans.reduce((s, it) => s + it.count, 0);

  if (totalOrphans === 0) {
    return (
      <p className="text-sm text-emerald-700 flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4" />لا توجد بيانات يتيمة في هذه الشركة.
      </p>
    );
  }

  const handleDeleteAll = () => {
    const items: Array<{ table: TableKey; id: number }> = [];
    for (const it of allOrphans) {
      for (const s of it.samples) {
        if (s.id) items.push({ table: it.entityTable, id: s.id });
      }
    }
    onDelete(items);
  };

  return (
    <div className="space-y-3">
      <ul className="list-disc pr-6 text-sm space-y-1">
        {allOrphans.map(it => (
          <li key={it.key}><strong>{it.labelAr}:</strong> {it.count}</li>
        ))}
      </ul>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" disabled={pending} data-testid="btn-delete-orphans">
            {pending ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <Trash2 className="w-4 h-4 ml-2" />}
            حذف كل البيانات اليتيمة ({totalOrphans})
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف كل البيانات اليتيمة</AlertDialogTitle>
            <AlertDialogDescription>
              سيتم نقل ما مجموعه {totalOrphans} سجل إلى سلة المحذوفات. يمكنك استعادتها لاحقاً.
              ملاحظة: قد يقتصر العمل على الأسطر الظاهرة في الفحص الأخير (حد ٢٠ لكل نوع).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteAll} data-testid="confirm-delete-orphans">حذف الآن</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Sub-component: typed-name confirmation for full company wipe ─────────
function DangerZonePanel({ company, pending, onWipe }: {
  company: Company | null;
  pending: boolean;
  onWipe: (confirmText: string) => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [understood, setUnderstood] = useState(false);

  if (!company) {
    return <p className="text-sm text-slate-500">اختر شركة أولاً من تبويب التشخيص.</p>;
  }

  const matches = confirmText.trim() === company.nameAr.trim();
  const ready = matches && understood;

  return (
    <div className="space-y-4">
      <div className="bg-red-50 border-2 border-red-200 rounded p-3 text-sm space-y-2">
        <p className="font-bold text-red-800">⚠️ هذا الإجراء يحذف كل البيانات الرئيسية للشركة:</p>
        <ul className="list-disc pr-6 text-red-700 text-xs space-y-1">
          <li>العملاء، الموردون، الأصناف، شجرة الحسابات</li>
          <li>الفروع، المخازن، الخزن النقدية، الحسابات البنكية</li>
          <li>كل الفواتير والمشتريات وقيود اليومية</li>
        </ul>
        <p className="text-red-700 text-xs">
          لن يتم حذف الشركة نفسها ولا حسابات المستخدمين. كل السجلات تذهب إلى سلة المحذوفات،
          لكن الأسطر التابعة (بنود الفواتير، حركات المخزون) لا يمكن استعادتها بشكل تلقائي.
        </p>
      </div>

      <div>
        <Label>اكتب اسم الشركة بالضبط للتأكيد: <span className="font-bold text-red-700">{company.nameAr}</span></Label>
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={company.nameAr}
          dir="rtl"
          data-testid="input-wipe-confirm"
        />
      </div>

      <div className="flex items-center gap-2">
        <Checkbox checked={understood} onCheckedChange={(v) => setUnderstood(!!v)} data-testid="checkbox-understood" />
        <Label className="cursor-pointer" onClick={() => setUnderstood(!understood)}>
          أتفهم خطورة هذا الإجراء وأن استعادة البيانات قد لا تكون كاملة.
        </Label>
      </div>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="destructive"
            disabled={!ready || pending}
            data-testid="btn-wipe-company"
          >
            {pending ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <ShieldAlert className="w-4 h-4 ml-2" />}
            حذف بيانات الشركة بالكامل
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد نهائي</AlertDialogTitle>
            <AlertDialogDescription>
              سيتم حذف كل البيانات الرئيسية لشركة "{company.nameAr}" إلى سلة المحذوفات.
              هل أنت متأكد؟
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={() => onWipe(confirmText)} data-testid="confirm-wipe">
              نعم، احذف الآن
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Sub-component: recycle bin tab ───────────────────────────────────────
function RecycleBinTab({
  headers, companies, defaultCompanyId,
}: { headers: any; companies: Company[]; defaultCompanyId: number | null }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [filterCompany, setFilterCompany] = useState<number | "all">(defaultCompanyId ?? "all");
  const [filterTable,   setFilterTable]   = useState<string>("all");
  const [includeRestored, setIncludeRestored] = useState(false);
  const [picked, setPicked] = useState<Record<number, boolean>>({});

  const q = useQuery<{ rows: RecycleRow[]; total: number }>({
    queryKey: ["dd", "recycle-bin", filterCompany, filterTable, includeRestored],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filterCompany !== "all") params.set("companyId", String(filterCompany));
      if (filterTable !== "all")   params.set("table", filterTable);
      params.set("includeRestored", String(includeRestored));
      params.set("limit", "100");
      const r = await fetch(`${API}/api/admin/data-doctor/recycle-bin?${params}`, { headers });
      return r.json();
    },
  });

  const restoreMut = useMutation({
    mutationFn: async (ids: number[]) => {
      const r = await fetch(`${API}/api/admin/data-doctor/restore`, {
        method: "POST", headers, body: JSON.stringify({ ids }),
      });
      if (!r.ok) throw new Error("فشل الاستعادة");
      return r.json();
    },
    onSuccess: (d) => {
      toast({ title: "تمت الاستعادة", description: `تم استعادة ${d.summary.ok} من ${d.summary.requested} سجل` });
      setPicked({});
      qc.invalidateQueries({ queryKey: ["dd", "recycle-bin"] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message ?? "فشل الاستعادة", variant: "destructive" }),
  });

  const purgeMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/admin/data-doctor/recycle-bin/${id}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error("فشل الحذف النهائي");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تم الحذف النهائي" });
      qc.invalidateQueries({ queryKey: ["dd", "recycle-bin"] });
    },
  });

  const rows = q.data?.rows ?? [];
  const pickedIds = Object.entries(picked).filter(([, v]) => v).map(([k]) => Number(k));

  const TABLE_OPTIONS = [
    { v: "all", l: "كل الجداول" },
    { v: "customers", l: "العملاء" },
    { v: "suppliers", l: "الموردون" },
    { v: "items", l: "الأصناف" },
    { v: "accounts", l: "الحسابات" },
    { v: "branches", l: "الفروع" },
    { v: "warehouses", l: "المخازن" },
    { v: "cash_boxes", l: "الخزن النقدية" },
    { v: "bank_accounts", l: "الحسابات البنكية" },
    { v: "invoices", l: "فواتير المبيعات" },
    { v: "purchase_invoices", l: "فواتير المشتريات" },
    { v: "journal_entries", l: "قيود اليومية" },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
          <span className="flex items-center gap-2"><RotateCcw className="w-5 h-5" />سلة المحذوفات</span>
          <Button variant="outline" size="sm" onClick={() => q.refetch()}>
            <RefreshCcw className="w-4 h-4 ml-2" />تحديث
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="min-w-[220px]">
            <Label>الشركة</Label>
            <Select value={String(filterCompany)} onValueChange={(v) => setFilterCompany(v === "all" ? "all" : Number(v))}>
              <SelectTrigger data-testid="filter-company"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الشركات</SelectItem>
                {companies.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.nameAr}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[200px]">
            <Label>الجدول</Label>
            <Select value={filterTable} onValueChange={setFilterTable}>
              <SelectTrigger data-testid="filter-table"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TABLE_OPTIONS.map(o => <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox checked={includeRestored} onCheckedChange={(v) => setIncludeRestored(!!v)} data-testid="checkbox-include-restored" />
            <Label className="cursor-pointer" onClick={() => setIncludeRestored(!includeRestored)}>
              عرض السجلات المستعادة
            </Label>
          </div>
          {pickedIds.length > 0 && (
            <Button onClick={() => restoreMut.mutate(pickedIds)} disabled={restoreMut.isPending} data-testid="btn-restore-bulk">
              <RotateCcw className="w-4 h-4 ml-2" />استعادة المحدد ({pickedIds.length})
            </Button>
          )}
        </div>

        <div className="border rounded overflow-auto max-h-[600px]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 sticky top-0">
              <tr>
                <th className="w-10 p-2"></th>
                <th className="text-right p-2">التاريخ</th>
                <th className="text-right p-2">المنفّذ</th>
                <th className="text-right p-2">الجدول</th>
                <th className="text-right p-2">العنصر</th>
                <th className="text-right p-2">السبب</th>
                <th className="text-right p-2">الحالة</th>
                <th className="text-right p-2 w-32">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !q.isFetching && (
                <tr><td colSpan={8} className="text-center text-slate-400 py-8">لا توجد سجلات</td></tr>
              )}
              {rows.map(r => (
                <tr key={r.id} className="border-t hover:bg-slate-50" data-testid={`recycle-row-${r.id}`}>
                  <td className="p-2 text-center">
                    {!r.restoredAt && (
                      <Checkbox
                        checked={!!picked[r.id]}
                        onCheckedChange={() => setPicked(p => ({ ...p, [r.id]: !p[r.id] }))}
                        data-testid={`pick-recycle-${r.id}`}
                      />
                    )}
                  </td>
                  <td className="p-2 whitespace-nowrap">{new Date(r.deletedAt).toLocaleString("ar-SA")}</td>
                  <td className="p-2">{r.deletedByUsername ?? "—"}</td>
                  <td className="p-2"><Badge variant="outline">{r.tableLabel}</Badge></td>
                  <td className="p-2">{r.summary}</td>
                  <td className="p-2 text-xs text-slate-600">{r.reason ?? "—"}</td>
                  <td className="p-2">
                    {r.restoredAt
                      ? <Badge className="bg-emerald-100 text-emerald-800">مستعاد</Badge>
                      : <Badge variant="destructive">محذوف</Badge>}
                  </td>
                  <td className="p-2 space-x-1 space-x-reverse">
                    {!r.restoredAt && (
                      <Button size="sm" variant="outline" onClick={() => restoreMut.mutate([r.id])} disabled={restoreMut.isPending} data-testid={`btn-restore-${r.id}`}>
                        <RotateCcw className="w-3 h-3 ml-1" />استعادة
                      </Button>
                    )}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="destructive" data-testid={`btn-purge-${r.id}`}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent dir="rtl">
                        <AlertDialogHeader>
                          <AlertDialogTitle>حذف نهائي</AlertDialogTitle>
                          <AlertDialogDescription>
                            بعد هذا الإجراء لن يكون من الممكن استعادة هذا السجل أبداً.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>إلغاء</AlertDialogCancel>
                          <AlertDialogAction onClick={() => purgeMut.mutate(r.id)}>حذف نهائي</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="text-xs text-slate-500 text-center">
          إجمالي السجلات: {q.data?.total ?? 0}
        </div>
      </CardContent>
    </Card>
  );
}
