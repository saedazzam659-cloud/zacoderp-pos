import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Code2, Loader2, AlertCircle, LogOut, FileText, Sparkles, Send, Trash2,
  Lock, Save, FolderTree, Gauge,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const TOKEN_KEY = "zatca_devstudio_token";

// ─────────────────────────────────────────────────────────────────────────
// DevStudio — in-browser developer studio ("التطوير من خلال زاكود").
//
// Developers authenticate with their OWN bearer token (kept in localStorage,
// NOT the tenant session) against /api/dev-studio/*. They get READ-ONLY scoped
// access to a frozen snapshot and can only PROPOSE diffs (AI-assisted). No
// download/clone/terminal; every file read is quota-checked + audited +
// watermarked server-side. A SuperAdmin can suspend live (next call → lockout).
// ─────────────────────────────────────────────────────────────────────────

interface Me {
  developer: { id: number; name: string; phone: string; country: string; status: string };
  entitlements: { offices: number; units: number; readLineQuota: number; writeLineQuota: number; billingCycle: string };
  usage: { readLinesUsed: number; writeLinesUsed: number; period: string };
  snapshot: { id: number; version: string; label: string | null } | null;
  allowedPrefixes: string[];
}
interface Proposal {
  id: number; title: string; description: string | null; targetPath: string | null;
  diff: string | null; status: string; writeLines: number; createdAt: string;
}

export default function DevStudio() {
  const [, navigate] = useLocation();
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const authed = !!token;
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }), [token]);

  function logout(msg?: string) {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    if (msg) setGlobalMsg(msg);
  }
  const [globalMsg, setGlobalMsg] = useState<string | null>(null);

  // Centralised fetch that handles the live kill-switch (401/403 → logout).
  const apiGet = useCallback(async (path: string) => {
    const r = await fetch(`${API}/api/dev-studio${path}`, { headers });
    if (r.status === 401 || r.status === 403) {
      const d = await r.json().catch(() => ({}));
      logout(d?.error ?? "انتهت الجلسة");
      throw new Error("auth");
    }
    return r;
  }, [headers]);

  if (!authed) return <DevStudioLogin onLogin={(t) => { localStorage.setItem(TOKEN_KEY, t); setToken(t); setGlobalMsg(null); }} initialMsg={globalMsg} navigate={navigate} />;

  return <StudioShell apiGet={apiGet} headers={headers} logout={logout} />;
}

// ── Login ───────────────────────────────────────────────────────────────────
function DevStudioLogin({ onLogin, initialMsg, navigate }: { onLogin: (t: string) => void; initialMsg: string | null; navigate: (p: string) => void }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialMsg);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/dev-studio/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data?.error ?? "تعذّر تسجيل الدخول"); return; }
      onLogin(data.token);
    } catch {
      setError("تعذّر الاتصال بالخادم");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4" dir="rtl">
      <Card className="w-full max-w-md">
        <CardContent className="pt-8 pb-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="h-11 w-11 rounded-xl bg-indigo-600 flex items-center justify-center">
              <Code2 className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold leading-tight">استوديو التطوير</h1>
              <p className="text-xs text-muted-foreground">التطوير من خلال زاكود</p>
            </div>
          </div>
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-md bg-destructive/10 text-destructive p-3 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /><span>{error}</span>
            </div>
          )}
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label>رقم الجوال</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} required dir="ltr" placeholder="05xxxxxxxx" />
            </div>
            <div className="space-y-1.5">
              <Label>كلمة المرور</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required dir="ltr" />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <><Loader2 className="h-4 w-4 animate-spin ml-2" /> جارٍ الدخول…</> : "تسجيل الدخول"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              مطوّر جديد؟{" "}
              <button type="button" className="text-indigo-600 hover:underline" onClick={() => navigate("/dev-studio/register")}>
                إنشاء حساب
              </button>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Studio shell ─────────────────────────────────────────────────────────────
function StudioShell({ apiGet, headers, logout }: { apiGet: (p: string) => Promise<Response>; headers: any; logout: (m?: string) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [snapshotMsg, setSnapshotMsg] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [watermark, setWatermark] = useState<string>("");
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  const [aiRequest, setAiRequest] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<{ explanation: string; diff: string } | null>(null);
  const [aiErr, setAiErr] = useState<string | null>(null);

  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [savingProposal, setSavingProposal] = useState(false);

  const refreshMe = useCallback(async () => {
    try { const r = await apiGet("/me"); setMe(await r.json()); } catch { /* handled */ }
  }, [apiGet]);
  const refreshFiles = useCallback(async () => {
    try {
      const r = await apiGet("/files"); const d = await r.json();
      setPaths(d.paths ?? []); setSnapshotMsg(d.message ?? null);
    } catch { /* handled */ }
  }, [apiGet]);
  const refreshProposals = useCallback(async () => {
    try { const r = await apiGet("/proposals"); const d = await r.json(); setProposals(d.proposals ?? []); } catch { /* handled */ }
  }, [apiGet]);

  useEffect(() => { void refreshMe(); void refreshFiles(); void refreshProposals(); }, [refreshMe, refreshFiles, refreshProposals]);

  async function openFile(p: string) {
    setActivePath(p); setFileErr(null); setLoadingFile(true); setFileContent("");
    try {
      const r = await apiGet(`/file?path=${encodeURIComponent(p)}`);
      const d = await r.json();
      if (!r.ok) { setFileErr(d?.error ?? "تعذّر فتح الملف"); void refreshMe(); return; }
      setFileContent(d.content ?? ""); setWatermark(d.watermark ?? "");
      void refreshMe();
    } catch { /* handled */ } finally { setLoadingFile(false); }
  }

  async function runAI() {
    setAiBusy(true); setAiErr(null); setAiResult(null);
    try {
      const res = await fetch(`${API}/api/dev-studio/ai/propose`, {
        method: "POST", headers,
        body: JSON.stringify({ request: aiRequest, paths: activePath ? [activePath] : [] }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setAiErr(d?.error ?? "تعذّر توليد المقترح"); return; }
      if (!d.ok) { setAiErr(d.explanation ?? "تعذّر توليد المقترح"); return; }
      setAiResult({ explanation: d.explanation ?? "", diff: d.diff ?? "" });
    } catch {
      setAiErr("تعذّر الاتصال بالخادم");
    } finally { setAiBusy(false); }
  }

  async function saveProposal() {
    if (!aiResult) return;
    setSavingProposal(true);
    try {
      const res = await fetch(`${API}/api/dev-studio/proposals`, {
        method: "POST", headers,
        body: JSON.stringify({
          title: aiRequest.slice(0, 80) || "مقترح تعديل",
          description: aiResult.explanation,
          targetPath: activePath,
          diff: aiResult.diff,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setAiErr(d?.error ?? "تعذّر حفظ المقترح"); return; }
      setAiResult(null); setAiRequest("");
      void refreshProposals(); void refreshMe();
    } finally { setSavingProposal(false); }
  }

  async function submitProposal(id: number) {
    const res = await fetch(`${API}/api/dev-studio/proposals/${id}/submit`, { method: "POST", headers });
    if (res.ok) void refreshProposals();
  }
  async function deleteProposal(id: number) {
    const res = await fetch(`${API}/api/dev-studio/proposals/${id}`, { method: "DELETE", headers });
    if (res.ok) void refreshProposals();
  }

  const readPct = me ? Math.min(100, Math.round((me.usage.readLinesUsed / Math.max(1, me.entitlements.readLineQuota)) * 100)) : 0;
  const writePct = me ? Math.min(100, Math.round((me.usage.writeLinesUsed / Math.max(1, me.entitlements.writeLineQuota)) * 100)) : 0;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950" dir="rtl">
      {/* Top bar */}
      <header className="h-14 border-b bg-white dark:bg-slate-900 flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center">
            <Code2 className="h-5 w-5 text-white" />
          </div>
          <div className="leading-tight">
            <div className="font-bold text-sm">استوديو التطوير</div>
            <div className="text-[11px] text-muted-foreground">
              {me?.snapshot ? `النسخة ${me.snapshot.version}` : "لا توجد نسخة معيّنة"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {me && (
            <div className="hidden md:flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1"><Gauge className="h-3.5 w-3.5" /> قراءة: {me.usage.readLinesUsed}/{me.entitlements.readLineQuota}</span>
              <span className="flex items-center gap-1"><Save className="h-3.5 w-3.5" /> كتابة: {me.usage.writeLinesUsed}/{me.entitlements.writeLineQuota}</span>
            </div>
          )}
          <span className="text-xs text-muted-foreground hidden sm:inline">{me?.developer.name}</span>
          <Button variant="outline" size="sm" onClick={() => logout()}><LogOut className="h-4 w-4 ml-1" /> خروج</Button>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-0 h-[calc(100vh-3.5rem)]">
        {/* File tree */}
        <aside className="col-span-3 border-l bg-white dark:bg-slate-900 overflow-y-auto">
          <div className="p-3 border-b flex items-center gap-2 text-sm font-medium"><FolderTree className="h-4 w-4" /> الملفات المتاحة</div>
          {/* quota bars */}
          {me && (
            <div className="p-3 border-b space-y-2">
              <QuotaBar label="حد القراءة" pct={readPct} />
              <QuotaBar label="حد الكتابة" pct={writePct} />
            </div>
          )}
          {snapshotMsg && <div className="p-3 text-xs text-muted-foreground">{snapshotMsg}</div>}
          {!snapshotMsg && paths.length === 0 && <div className="p-3 text-xs text-muted-foreground">لا توجد ملفات ضمن صلاحياتك بعد.</div>}
          <ul className="py-1">
            {paths.map((p) => (
              <li key={p}>
                <button
                  onClick={() => openFile(p)}
                  className={`w-full text-right px-3 py-1.5 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5 ${activePath === p ? "bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300" : ""}`}
                  dir="ltr"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{p}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* Viewer + AI */}
        <main className="col-span-9 overflow-y-auto p-4 space-y-4">
          {/* Read-only viewer */}
          <Card>
            <CardContent className="p-0">
              <div className="flex items-center justify-between px-3 py-2 border-b text-xs">
                <span className="font-mono" dir="ltr">{activePath ?? "اختر ملفاً للعرض"}</span>
                <Badge variant="secondary" className="gap-1"><Lock className="h-3 w-3" /> قراءة فقط</Badge>
              </div>
              {fileErr && <div className="p-3 text-sm text-destructive flex items-center gap-2"><AlertCircle className="h-4 w-4" /> {fileErr}</div>}
              {loadingFile ? (
                <div className="p-8 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>
              ) : (
                <div className="relative">
                  {watermark && fileContent && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-[0.06] text-2xl font-bold -rotate-12 select-none">
                      {watermark}
                    </div>
                  )}
                  <pre className="p-3 text-xs overflow-x-auto max-h-[40vh] leading-relaxed" dir="ltr">
                    <code>{fileContent || (activePath ? "" : "")}</code>
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>

          {/* AI proposer */}
          <Card>
            <CardContent className="p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium"><Sparkles className="h-4 w-4 text-indigo-600" /> اقترح تعديلاً بالذكاء الاصطناعي</div>
              <p className="text-xs text-muted-foreground">
                اكتب وصف التعديل المطلوب. سيقترح المساعد تعديلاً (diff) على الملف المفتوح فقط. لا يتم تنفيذ أي شيفرة —
                المخرجات مقترح فقط يمكنك حفظه وإرساله لمدير المنصة.
              </p>
              <Textarea value={aiRequest} onChange={(e) => setAiRequest(e.target.value)} rows={3}
                placeholder="مثال: أضف تحققاً من أن المبلغ أكبر من صفر قبل الحفظ…" />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={runAI} disabled={aiBusy || !aiRequest.trim()}>
                  {aiBusy ? <><Loader2 className="h-4 w-4 animate-spin ml-1" /> جارٍ التوليد…</> : <><Sparkles className="h-4 w-4 ml-1" /> توليد المقترح</>}
                </Button>
                {activePath && <span className="text-xs text-muted-foreground" dir="ltr">{activePath}</span>}
              </div>
              {aiErr && <div className="text-sm text-destructive flex items-center gap-2"><AlertCircle className="h-4 w-4" /> {aiErr}</div>}
              {aiResult && (
                <div className="space-y-2 border-t pt-3">
                  <div className="text-sm">{aiResult.explanation}</div>
                  {aiResult.diff && (
                    <pre className="p-3 text-xs bg-slate-900 text-slate-100 rounded-md overflow-x-auto max-h-[30vh]" dir="ltr"><code>{aiResult.diff}</code></pre>
                  )}
                  <Button size="sm" variant="default" onClick={saveProposal} disabled={savingProposal}>
                    {savingProposal ? <Loader2 className="h-4 w-4 animate-spin ml-1" /> : <Save className="h-4 w-4 ml-1" />} حفظ كمقترح
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Proposals */}
          <Card>
            <CardContent className="p-3 space-y-2">
              <div className="text-sm font-medium">مقترحاتي</div>
              {proposals.length === 0 && <div className="text-xs text-muted-foreground">لا توجد مقترحات بعد.</div>}
              {proposals.map((p) => (
                <div key={p.id} className="flex items-center justify-between border rounded-md p-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{p.title}</div>
                    <div className="text-xs text-muted-foreground" dir="ltr">{p.targetPath ?? "—"} · {p.writeLines} سطر</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={p.status === "draft" ? "secondary" : p.status === "submitted" ? "default" : p.status === "published" ? "default" : "destructive"}>{statusAr(p.status)}</Badge>
                    {p.status === "draft" && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => submitProposal(p.id)}><Send className="h-3.5 w-3.5 ml-1" /> إرسال</Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteProposal(p.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  );
}

function QuotaBar({ label, pct }: { label: string; pct: number }) {
  return (
    <div>
      <div className="flex justify-between text-[11px] text-muted-foreground mb-0.5"><span>{label}</span><span>{pct}%</span></div>
      <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
        <div className={`h-full ${pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-indigo-600"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function statusAr(s: string): string {
  return s === "draft" ? "مسودة" : s === "submitted" ? "مُرسَل" : s === "published" ? "معتمد" : s === "rejected" ? "مرفوض" : s;
}
