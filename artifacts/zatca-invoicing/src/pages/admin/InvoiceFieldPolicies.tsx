// /admin/invoice-field-policies  (SuperAdmin-only screen)
//
// Two-pane manager:
//   ① القوالب  — create/edit named policy profiles. Each profile is a full
//                bundle covering the 3 invoice scopes (Sales / Purchase / POS)
//                with a 4-mode select per field + today_only toggle for date
//                fields. AI button suggests a bundle for the chosen role.
//   ② تعيين المستخدمين — list every user in the company with a dropdown to
//                pick the profile that governs their invoice screens.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Loader2, Save, Sparkles, Eye, EyeOff, Lock, Asterisk,
  ShieldCheck, ArrowRight, Receipt, ShoppingCart, Store, Calendar,
  Plus, Trash2, Users, Star, StarOff, Pencil,
  Search, RefreshCw, Printer, FileText, FileSpreadsheet, Download,
  ArrowUpDown, Filter, X, Palette,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ────────────────────────────────────────────────────────────────
type FieldMode = "editable" | "readonly" | "hidden" | "required";
type DateConstraint = "none" | "today_only";
type PolicyScope = "sales" | "purchase" | "pos" | "customers";
interface FieldRule { mode: FieldMode; dateConstraint?: DateConstraint }
type PolicyMap = Record<string, FieldRule>;
type PolicyBundle = Record<PolicyScope, PolicyMap>;
interface FieldDef { key: string; labelAr: string; labelEn: string; isDate?: boolean }
type Catalogue = Record<PolicyScope, FieldDef[]>;
interface Profile {
  id: number; name: string; bundle: PolicyBundle;
  isDefault: boolean; color: string | null; assignedCount: number; updatedAt: string;
}
interface AssignmentUser {
  id: number; username: string; email: string | null; role: string;
  nameAr: string | null; nameEn: string | null; profileId: number | null;
}

// ── Visual helpers ───────────────────────────────────────────────────────
const MODE_META: Record<FieldMode, { labelAr: string; tone: string; icon: any }> = {
  editable: { labelAr: "قابل للتعديل", tone: "bg-emerald-100 text-emerald-700 border-emerald-200",  icon: Eye },
  readonly: { labelAr: "للقراءة فقط",   tone: "bg-amber-100 text-amber-700 border-amber-200",       icon: Lock },
  hidden:   { labelAr: "مخفي",          tone: "bg-slate-200 text-slate-700 border-slate-300",       icon: EyeOff },
  required: { labelAr: "إلزامي",        tone: "bg-rose-100 text-rose-700 border-rose-200",          icon: Asterisk },
};
const PALETTE = [
  "#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#ec4899", "#14b8a6", "#f97316", "#0ea5e9",
];
function pickColor(seed: string | number): string {
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function userDisplayName(u: AssignmentUser): string {
  return u.nameAr ?? u.nameEn ?? u.username;
}
function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? "").join("").toUpperCase();
}

// ── API helpers ──────────────────────────────────────────────────────────
function authHeaders(): Record<string, string> {
  const tok = localStorage.getItem("zatca_token") ?? "";
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (tok) h.Authorization = `Bearer ${tok}`;
  // SuperAdmin "enter-company" context: this raw fetch helper bypasses the
  // generated API client, so we must forward the acting-company header
  // ourselves — otherwise resolveCompanyId returns undefined and every
  // POST/PUT here fails with 401 "غير مصرح".
  const acting = localStorage.getItem("zatca_acting_company_id");
  if (acting) h["x-acting-company-id"] = acting;
  return h;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c] as string);
}
async function jget<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api/invoice-field-policies${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
  return r.json();
}
async function jsend<T>(method: string, path: string, body?: any): Promise<T> {
  const r = await fetch(`${API}/api/invoice-field-policies${path}`, {
    method, headers: authHeaders(), body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
  return r.json();
}

// ────────────────────────────────────────────────────────────────────────
//                              Page
// ────────────────────────────────────────────────────────────────────────
export default function InvoiceFieldPoliciesPage() {
  const { user } = useAuth() as any;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Hard guard: this page is SuperAdmin-only. Routing already gates this,
  // but a defensive client check keeps the screen clean if the route ever
  // shifts.
  useEffect(() => {
    if (user && user.role !== "superadmin") navigate("/");
  }, [user, navigate]);

  const [tab, setTab] = useState<"profiles" | "assignments">("profiles");
  const [editing, setEditing] = useState<Profile | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Profile | null>(null);

  // ── Toolbar state (search / sort / status filter) ──────────────────────
  // Mirrors the polished operational toolbars used across the sales/inventory
  // grids so the SuperAdmin gets the same affordances here: instant search,
  // sort, status pills with live counts, and bulk export/print actions.
  type SortKey = "updated" | "name" | "users" | "default";
  type StatusFilter = "all" | "default" | "in_use" | "unused";
  const [query, setQuery]           = useState("");
  const [sortKey, setSortKey]       = useState<SortKey>("updated");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const { data: catData } = useQuery<{ catalogue: Catalogue }>({
    queryKey: ["ifp", "catalogue"],
    queryFn: () => jget<{ catalogue: Catalogue }>("/catalogue"),
    staleTime: Infinity,
  });
  const catalogue = catData?.catalogue;

  const { data: profData, isLoading: profLoading } = useQuery<{ profiles: Profile[] }>({
    queryKey: ["ifp", "profiles"],
    queryFn: () => jget<{ profiles: Profile[] }>("/profiles"),
  });
  const profiles = profData?.profiles ?? [];

  const { data: asgnData, isLoading: asgnLoading } = useQuery<{ users: AssignmentUser[] }>({
    queryKey: ["ifp", "assignments"],
    queryFn: () => jget<{ users: AssignmentUser[] }>("/assignments"),
    enabled: tab === "assignments",
  });
  const users = asgnData?.users ?? [];

  // ── Profile mutations ──
  const setDefault = useMutation({
    mutationFn: (p: Profile) => jsend<{ profile: Profile }>("PUT", `/profiles/${p.id}`, { isDefault: !p.isDefault }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ifp", "profiles"] }),
  });
  const deleteProfile = useMutation({
    mutationFn: (p: Profile) => jsend<{ ok: true }>("DELETE", `/profiles/${p.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ifp", "profiles"] });
      qc.invalidateQueries({ queryKey: ["ifp", "assignments"] });
      toast({ title: "تم الحذف" });
      setConfirmDelete(null);
    },
    onError: (e: any) => toast({ title: "تعذر الحذف", description: e?.message ?? "", variant: "destructive" }),
  });

  // ── Assignment mutation ──
  const assign = useMutation({
    mutationFn: ({ userId, profileId }: { userId: number; profileId: number | null }) =>
      jsend<{ ok: true }>("PUT", `/assignments/${userId}`, { profileId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ifp", "assignments"] }),
    onError: (e: any) => toast({ title: "تعذر الحفظ", description: e?.message ?? "", variant: "destructive" }),
  });

  // ── Status counts (live, for filter pills) ─────────────────────────────
  const counts = useMemo(() => {
    const c = { all: profiles.length, default: 0, in_use: 0, unused: 0 };
    for (const p of profiles) {
      if (p.isDefault) c.default++;
      if (p.assignedCount > 0) c.in_use++;
      else c.unused++;
    }
    return c;
  }, [profiles]);

  // ── Derived list (search → status filter → sort) ───────────────────────
  const visibleProfiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = profiles;
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q));
    if (statusFilter === "default") list = list.filter((p) => p.isDefault);
    else if (statusFilter === "in_use") list = list.filter((p) => p.assignedCount > 0);
    else if (statusFilter === "unused") list = list.filter((p) => p.assignedCount === 0);
    list = [...list].sort((a, b) => {
      switch (sortKey) {
        case "name":    return a.name.localeCompare(b.name, "ar");
        case "users":   return b.assignedCount - a.assignedCount;
        case "default": return Number(b.isDefault) - Number(a.isDefault);
        case "updated":
        default:        return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      }
    });
    return list;
  }, [profiles, query, statusFilter, sortKey]);

  // Same search box also filters the assignments tab for symmetry.
  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      (u.nameAr ?? "").toLowerCase().includes(q) ||
      (u.nameEn ?? "").toLowerCase().includes(q) ||
      u.username.toLowerCase().includes(q) ||
      (u.email ?? "").toLowerCase().includes(q),
    );
  }, [users, query]);

  // ── Export helpers ─────────────────────────────────────────────────────
  // Plain client-side CSV/Excel/print. Excel reads CSV with a UTF-8 BOM
  // happily, so we re-use the same generator for both. PDF is produced via
  // the browser's print dialog (window.print on the dedicated print sheet)
  // — no extra deps, perfect Arabic rendering, RTL preserved.
  const downloadBlob = (filename: string, mime: string, body: string) => {
    const bom = "\uFEFF"; // Excel needs this to detect UTF-8 / show Arabic
    const blob = new Blob([bom + body], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };
  const csvEscape = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const buildProfilesCsv = () => {
    const header = ["#", "الاسم", "افتراضي", "عدد المستخدمين", "اللون", "آخر تحديث"];
    const rows   = visibleProfiles.map((p) => [
      p.id, p.name, p.isDefault ? "نعم" : "لا",
      p.assignedCount, p.color ?? pickColor(p.id),
      new Date(p.updatedAt).toLocaleString("ar-SA"),
    ]);
    return [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
  };
  const buildAssignmentsCsv = () => {
    const header = ["#", "المستخدم", "البريد", "الدور", "القالب"];
    const rows   = visibleUsers.map((u) => {
      const prof = profiles.find((p) => p.id === u.profileId);
      return [
        u.id, userDisplayName(u), u.email ?? "", u.role,
        prof?.name ?? (u.role === "admin" || u.role === "superadmin"
          ? "(يتجاوز الحوكمة)" : "(الافتراضي)"),
      ];
    });
    return [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
  };
  const exportCsv = (kind: "csv" | "excel") => {
    const body = tab === "profiles" ? buildProfilesCsv() : buildAssignmentsCsv();
    const ext  = kind === "excel" ? "xls" : "csv";
    const mime = kind === "excel"
      ? "application/vnd.ms-excel;charset=utf-8"
      : "text/csv;charset=utf-8";
    downloadBlob(`governance-${tab}-${new Date().toISOString().slice(0,10)}.${ext}`, mime, body);
    toast({ title: kind === "excel" ? "تم تصدير Excel" : "تم تصدير CSV" });
  };
  const printOrPdf = () => {
    // Builds an Arabic-friendly printable sheet in a hidden iframe and
    // launches the OS print dialog (the user can pick "Save as PDF").
    const rows = tab === "profiles"
      ? visibleProfiles.map((p) => `
          <tr>
            <td>${p.id}</td>
            <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p.color ?? pickColor(p.id)};margin-inline-end:6px;"></span>${escapeHtml(p.name)}</td>
            <td>${p.isDefault ? "نعم" : "لا"}</td>
            <td>${p.assignedCount}</td>
            <td>${new Date(p.updatedAt).toLocaleString("ar-SA")}</td>
          </tr>`).join("")
      : visibleUsers.map((u) => {
          const prof = profiles.find((p) => p.id === u.profileId);
          return `
          <tr>
            <td>${u.id}</td>
            <td>${escapeHtml(userDisplayName(u))}</td>
            <td>${escapeHtml(u.email ?? "")}</td>
            <td>${escapeHtml(u.role)}</td>
            <td>${escapeHtml(prof?.name ?? (u.role === "admin" || u.role === "superadmin" ? "(يتجاوز الحوكمة)" : "(الافتراضي)"))}</td>
          </tr>`;
        }).join("");
    const headers = tab === "profiles"
      ? ["#", "الاسم", "افتراضي", "عدد المستخدمين", "آخر تحديث"]
      : ["#", "المستخدم", "البريد", "الدور", "القالب"];
    const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
      <title>حوكمة حقول الفواتير</title>
      <style>
        @page { size: A4; margin: 14mm; }
        body { font-family: "Segoe UI","Tahoma","Arial",sans-serif; color:#0f172a; }
        h1 { font-size:20px;margin:0 0 4px; }
        .sub { color:#64748b;font-size:12px;margin-bottom:14px; }
        table { width:100%;border-collapse:collapse;font-size:12px; }
        th,td { border:1px solid #e2e8f0;padding:6px 8px;text-align:right; }
        th { background:#f1f5f9;font-weight:600; }
        tr:nth-child(even) td { background:#fafafa; }
      </style></head><body>
      <h1>${tab === "profiles" ? "قوالب الحوكمة" : "تعيين القوالب للمستخدمين"}</h1>
      <div class="sub">طُبع في ${new Date().toLocaleString("ar-SA")}</div>
      <table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${headers.length}" style="text-align:center;color:#94a3b8;padding:18px;">لا توجد سجلات</td></tr>`}</tbody>
      </table>
      </body></html>`;
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed"; iframe.style.right = "-9999px";
    iframe.style.bottom = "0"; iframe.style.width = "0"; iframe.style.height = "0";
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.open(); doc.write(html); doc.close();
    iframe.onload = () => {
      try {
        iframe.contentWindow!.focus();
        iframe.contentWindow!.print();
      } finally {
        setTimeout(() => document.body.removeChild(iframe), 1500);
      }
    };
  };

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["ifp"] });
    toast({ title: "تم التحديث" });
  };

  return (
    <div className="space-y-6 p-6 bg-gradient-to-br from-slate-50 via-white to-indigo-50/30 min-h-screen">
      {/* ── Header ── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">حوكمة حقول الفواتير</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              قوالب صلاحيات يحددها السوبر أدمن — تعيّن لكل مستخدم القالب المناسب لدوره
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={() => navigate("/")} className="gap-2">
          <ArrowRight className="w-4 h-4" /> رجوع
        </Button>
      </div>

      {/* ── Polished Toolbar ─────────────────────────────────────────────
          Mirrors the operational sales/inventory audit grids: search,
          sort, refresh, AI suggest, exports, print/PDF, and a primary
          "قالب جديد" CTA — all in one glassy card. */}
      <Card className="border-slate-200/70 shadow-sm overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />
        <CardContent className="p-3 space-y-3">
          {/* Row 1 — action buttons */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Primary CTA */}
            <Button
              onClick={() => setCreating(true)}
              className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
            >
              <Plus className="w-4 h-4" /> قالب جديد
            </Button>

            {/* AI gradient button */}
            <Button
              onClick={() => setCreating(true)}
              className="gap-2 bg-gradient-to-l from-purple-600 to-fuchsia-600 hover:from-purple-700 hover:to-fuchsia-700 text-white shadow-sm"
              title="ابدأ قالب جديد بمقترح ذكاء اصطناعي"
            >
              <Sparkles className="w-4 h-4" /> تدقيق بالذكاء الاصطناعي
            </Button>

            <Separator orientation="vertical" className="hidden sm:block h-8 mx-1" />

            {/* Export cluster */}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={printOrPdf}>
              <Printer className="w-4 h-4 text-slate-600" /> طباعة
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={printOrPdf}>
              <FileText className="w-4 h-4 text-rose-600" /> تصدير PDF
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => exportCsv("excel")}>
              <FileSpreadsheet className="w-4 h-4 text-emerald-600" /> تصدير Excel
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => exportCsv("csv")}>
              <Download className="w-4 h-4 text-sky-600" /> تصدير CSV
            </Button>

            <Separator orientation="vertical" className="hidden sm:block h-8 mx-1" />

            <Button variant="outline" size="sm" className="gap-1.5" onClick={refreshAll}>
              <RefreshCw className="w-4 h-4 text-indigo-600" /> تحديث
            </Button>

            {/* Sort */}
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as any)}>
              <SelectTrigger className="h-9 w-[170px]">
                <span className="flex items-center gap-1.5 text-sm">
                  <ArrowUpDown className="w-3.5 h-3.5 text-amber-600" />
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated">ترتيب: الأحدث</SelectItem>
                <SelectItem value="name">ترتيب: الاسم</SelectItem>
                <SelectItem value="users">ترتيب: الأكثر استخداماً</SelectItem>
                <SelectItem value="default">ترتيب: الافتراضي أولاً</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Row 2 — search + status pills */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Status pills */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <FilterPill active={statusFilter === "all"}      onClick={() => setStatusFilter("all")}
                tone="slate"   label="الكل"        count={counts.all}     />
              <FilterPill active={statusFilter === "default"}  onClick={() => setStatusFilter("default")}
                tone="amber"   label="افتراضي"     count={counts.default} />
              <FilterPill active={statusFilter === "in_use"}   onClick={() => setStatusFilter("in_use")}
                tone="emerald" label="قيد الاستخدام" count={counts.in_use}  />
              <FilterPill active={statusFilter === "unused"}   onClick={() => setStatusFilter("unused")}
                tone="rose"    label="غير مستخدم"  count={counts.unused}  />
            </div>

            <div className="flex-1" />

            {/* Search */}
            <div className="relative w-full sm:w-80">
              <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 right-3 text-slate-400 pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === "profiles" ? "ابحث باسم القالب…" : "ابحث باسم/بريد المستخدم…"}
                className="pr-9 pl-8 h-9"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute top-1/2 -translate-y-1/2 left-2 p-0.5 rounded hover:bg-slate-100"
                  aria-label="مسح"
                >
                  <X className="w-3.5 h-3.5 text-slate-500" />
                </button>
              )}
            </div>
          </div>

          {/* Row 3 — Mode color legend */}
          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-dashed border-slate-200">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
              <Palette className="w-3.5 h-3.5" /> دلالة الأوضاع:
            </span>
            {(Object.keys(MODE_META) as FieldMode[]).map((m) => {
              const meta = MODE_META[m];
              const Icon = meta.icon;
              return (
                <span key={m} className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] ${meta.tone}`}>
                  <Icon className="w-3 h-3" /> {meta.labelAr}
                </span>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── Tabs ── */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="profiles" className="gap-2">
            <ShieldCheck className="w-4 h-4" /> القوالب ({visibleProfiles.length}
            {visibleProfiles.length !== profiles.length ? `/${profiles.length}` : ""})
          </TabsTrigger>
          <TabsTrigger value="assignments" className="gap-2">
            <Users className="w-4 h-4" /> تعيين المستخدمين
            {users.length > 0 && (
              <span className="text-xs opacity-70">
                ({visibleUsers.length}{visibleUsers.length !== users.length ? `/${users.length}` : ""})
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Profiles tab ── */}
        <TabsContent value="profiles" className="mt-5 space-y-4">
          <p className="text-sm text-muted-foreground">
            أنشئ قوالب باسامي مفهومة (مثال: <span className="font-medium">"كاشير"</span>،
            <span className="font-medium"> "محاسب مبتدئ"</span>،
            <span className="font-medium"> "مدير فرع"</span>) ثم عيّنها للمستخدمين من التبويب التالي.
            {query || statusFilter !== "all" ? (
              <span className="ms-2 text-indigo-600 font-medium">
                · معروض {visibleProfiles.length} من {profiles.length}
              </span>
            ) : null}
          </p>

          {profLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : profiles.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
                <ShieldCheck className="w-10 h-10 text-muted-foreground" />
                <div>
                  <p className="font-medium">لا توجد قوالب بعد</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    ابدأ بإنشاء قالب — مثلاً "كاشير" — لتحديد ما يظهر للمستخدم على شاشات الفواتير.
                  </p>
                </div>
                <Button onClick={() => setCreating(true)} className="gap-2 mt-2">
                  <Plus className="w-4 h-4" /> أنشئ أول قالب
                </Button>
              </CardContent>
            </Card>
          ) : visibleProfiles.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-10 flex flex-col items-center gap-2 text-center text-muted-foreground">
                <Filter className="w-8 h-8" />
                <p className="text-sm">لا توجد قوالب مطابقة للبحث/الفلتر الحالي.</p>
                <Button size="sm" variant="outline" onClick={() => { setQuery(""); setStatusFilter("all"); }}>
                  مسح الفلاتر
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleProfiles.map((p) => {
                const color = p.color ?? pickColor(p.id);
                return (
                  <Card key={p.id} className="overflow-hidden hover:shadow-md transition-shadow">
                    <div className="h-2" style={{ background: color }} />
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <CardTitle className="text-lg flex items-center gap-2">
                            {p.name}
                            {p.isDefault && (
                              <Badge className="bg-amber-100 text-amber-700 border-amber-200 gap-1">
                                <Star className="w-3 h-3" /> افتراضي
                              </Badge>
                            )}
                          </CardTitle>
                          <CardDescription className="mt-1 flex items-center gap-1.5">
                            <Users className="w-3.5 h-3.5" />
                            {p.assignedCount} مستخدم
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap gap-1.5 text-[11px]">
                        {(["sales", "purchase", "pos", "customers"] as PolicyScope[]).map((sc) => {
                          const counts = countModes(p.bundle[sc] ?? {});
                          return (
                            <Badge key={sc} variant="outline" className="gap-1">
                              {sc === "sales" ? "مبيعات" : sc === "purchase" ? "مشتريات" : sc === "pos" ? "POS" : "العملاء"}
                              {counts.hidden ? <span className="text-slate-500">·{counts.hidden}🚫</span> : null}
                              {counts.readonly ? <span className="text-amber-600">·{counts.readonly}🔒</span> : null}
                              {counts.required ? <span className="text-rose-600">·{counts.required}⚠</span> : null}
                            </Badge>
                          );
                        })}
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <Button size="sm" variant="default" className="gap-1.5 flex-1" onClick={() => setEditing(p)}>
                          <Pencil className="w-3.5 h-3.5" /> تعديل
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1.5"
                          onClick={() => setDefault.mutate(p)} disabled={setDefault.isPending}>
                          {p.isDefault
                            ? <><StarOff className="w-3.5 h-3.5" /> إلغاء افتراضي</>
                            : <><Star className="w-3.5 h-3.5" /> اجعله افتراضي</>}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50"
                          onClick={() => setConfirmDelete(p)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── Assignments tab ── */}
        <TabsContent value="assignments" className="mt-5 space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="w-4 h-4" /> مستخدمو الشركة
              </CardTitle>
              <CardDescription>
                اختر القالب المناسب لكل مستخدم. المستخدمون بدون قالب يحصلون على القالب الافتراضي تلقائياً.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {asgnLoading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" />
                </div>
              ) : users.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">لا يوجد مستخدمون.</p>
              ) : visibleUsers.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                  <Filter className="w-8 h-8" />
                  <p className="text-sm">لا يوجد مستخدمون مطابقون للبحث.</p>
                  <Button size="sm" variant="outline" onClick={() => setQuery("")}>مسح البحث</Button>
                </div>
              ) : (
                <div className="divide-y">
                  {visibleUsers.map((u) => {
                    const isAdminUser = u.role === "admin" || u.role === "superadmin";
                    const assignedProfile = profiles.find((p) => p.id === u.profileId);
                    return (
                      <div key={u.id} className="flex items-center gap-3 py-3">
                        <Avatar className="w-9 h-9">
                          <AvatarFallback
                            style={{ background: pickColor(u.id), color: "white" }}
                            className="text-xs font-semibold"
                          >
                            {initials(userDisplayName(u))}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm flex items-center gap-2 truncate">
                            {userDisplayName(u)}
                            {isAdminUser && (
                              <Badge variant="outline" className="text-[10px] gap-1">
                                <ShieldCheck className="w-3 h-3" />
                                {u.role === "superadmin" ? "سوبر أدمن" : "مدير"}
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {u.email ?? u.username}
                          </div>
                        </div>
                        <div className="w-56">
                          {isAdminUser ? (
                            <span className="text-xs text-muted-foreground italic">
                              المديرون يتجاوزون الحوكمة
                            </span>
                          ) : (
                            <Select
                              value={u.profileId == null ? "_default" : String(u.profileId)}
                              onValueChange={(v) => assign.mutate({
                                userId: u.id,
                                profileId: v === "_default" ? null : Number(v),
                              })}
                            >
                              <SelectTrigger className="h-9">
                                {assignedProfile ? (
                                  <span className="flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full"
                                      style={{ background: assignedProfile.color ?? pickColor(assignedProfile.id) }} />
                                    {assignedProfile.name}
                                  </span>
                                ) : (
                                  <SelectValue placeholder="القالب الافتراضي" />
                                )}
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="_default">
                                  <span className="text-muted-foreground">القالب الافتراضي</span>
                                </SelectItem>
                                {profiles.map((p) => (
                                  <SelectItem key={p.id} value={String(p.id)}>
                                    <span className="flex items-center gap-2">
                                      <span className="w-2 h-2 rounded-full"
                                        style={{ background: p.color ?? pickColor(p.id) }} />
                                      {p.name}
                                      {p.isDefault && <Star className="w-3 h-3 text-amber-500" />}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Editor Dialog ── */}
      {(editing || creating) && catalogue && (
        <ProfileEditorDialog
          mode={creating ? "create" : "edit"}
          initial={editing}
          catalogue={catalogue}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["ifp", "profiles"] });
            qc.invalidateQueries({ queryKey: ["ifp", "assignments"] });
            setEditing(null); setCreating(false);
          }}
        />
      )}

      {/* ── Delete confirm ── */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>حذف القالب "{confirmDelete?.name}"؟</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.assignedCount
                ? `سيتم إلغاء تعيين ${confirmDelete.assignedCount} مستخدم وسيرجعون للقالب الافتراضي.`
                : "لن يتأثر أي مستخدم."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => confirmDelete && deleteProfile.mutate(confirmDelete)}
            >
              حذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Reusable filter-pill (mirrors the colored status pills in the sales
//    audit grid). Active state fills the pill, inactive shows a subtle
//    bordered chip with the count.
function FilterPill({
  active, onClick, tone, label, count,
}: {
  active: boolean; onClick: () => void;
  tone: "slate" | "amber" | "emerald" | "rose";
  label: string; count: number;
}) {
  const toneMap: Record<string, { dot: string; activeBg: string; activeText: string; border: string }> = {
    slate:   { dot: "bg-slate-500",   activeBg: "bg-slate-900",   activeText: "text-white", border: "border-slate-200"   },
    amber:   { dot: "bg-amber-500",   activeBg: "bg-amber-500",   activeText: "text-white", border: "border-amber-200"   },
    emerald: { dot: "bg-emerald-500", activeBg: "bg-emerald-600", activeText: "text-white", border: "border-emerald-200" },
    rose:    { dot: "bg-rose-500",    activeBg: "bg-rose-600",    activeText: "text-white", border: "border-rose-200"    },
  };
  const t = toneMap[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-xs transition-colors ${
        active
          ? `${t.activeBg} ${t.activeText} ${t.border} shadow-sm`
          : `bg-white hover:bg-slate-50 ${t.border} text-slate-700`
      }`}
    >
      <span className={`w-2 h-2 rounded-full ${active ? "bg-white/80" : t.dot}`} />
      <span className="font-medium">{label}</span>
      <span className={`min-w-[1.25rem] text-center rounded-full px-1.5 py-px text-[10px] ${
        active ? "bg-white/20" : "bg-slate-100 text-slate-600 group-hover:bg-slate-200"
      }`}>
        {count}
      </span>
    </button>
  );
}

function countModes(map: PolicyMap): Record<FieldMode, number> {
  const c: Record<FieldMode, number> = { editable: 0, readonly: 0, hidden: 0, required: 0 };
  for (const r of Object.values(map)) c[r.mode] = (c[r.mode] ?? 0) + 1;
  return c;
}

// ── Editor Dialog ────────────────────────────────────────────────────────
function ProfileEditorDialog({
  mode, initial, catalogue, onClose, onSaved,
}: {
  mode: "create" | "edit";
  initial: Profile | null;
  catalogue: Catalogue;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState<string>(initial?.color ?? PALETTE[0]);
  const [bundle, setBundle] = useState<PolicyBundle>(
    initial?.bundle ?? emptyBundle(catalogue),
  );
  const [tab, setTab] = useState<PolicyScope>("sales");
  const [aiBusy, setAiBusy] = useState(false);

  const setRule = (sc: PolicyScope, key: string, patch: Partial<FieldRule>) => {
    setBundle((b) => ({
      ...b,
      [sc]: { ...b[sc], [key]: { ...(b[sc][key] ?? { mode: "editable" }), ...patch } },
    }));
  };

  async function aiSuggest() {
    if (!name.trim()) {
      toast({ title: "اكتب اسم القالب أولاً", variant: "destructive" });
      return;
    }
    setAiBusy(true);
    try {
      const r = await jsend<{ source: string; bundle: PolicyBundle }>("POST", "/suggest", { role: name });
      setBundle(r.bundle);
      toast({
        title: r.source === "ai" ? "اقتراح ذكي جاهز" : "تم تطبيق اقتراح افتراضي",
        description: r.source === "ai" ? "تمت قراءة نشاط الشركة." : "الذكاء الاصطناعي غير مفعل — استخدمنا قالب جاهز.",
      });
    } catch (e: any) {
      toast({ title: "تعذر الاقتراح", description: e?.message ?? "", variant: "destructive" });
    } finally {
      setAiBusy(false);
    }
  }

  const save = useMutation({
    mutationFn: () => {
      if (mode === "create") {
        return jsend<{ profile: Profile }>("POST", "/profiles", { name, color, bundle });
      }
      return jsend<{ profile: Profile }>("PUT", `/profiles/${initial!.id}`, { name, color, bundle });
    },
    onSuccess: () => { toast({ title: "تم الحفظ" }); onSaved(); },
    onError: (e: any) => toast({ title: "تعذر الحفظ", description: e?.message ?? "", variant: "destructive" }),
  });

  const SCOPE_META = {
    sales:     { icon: Receipt,      label: "المبيعات" },
    purchase:  { icon: ShoppingCart, label: "المشتريات" },
    pos:       { icon: Store,        label: "نقاط البيع" },
    customers: { icon: Users,        label: "العملاء" },
  } as const;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-indigo-600" />
            {mode === "create" ? "قالب جديد" : `تعديل: ${initial?.name}`}
          </DialogTitle>
          <DialogDescription>
            عرّف لكل حقل: قابل للتعديل، للقراءة فقط، مخفي، أو إلزامي. لحقل التاريخ يمكنك قفله على اليوم الحالي.
          </DialogDescription>
        </DialogHeader>

        {/* Name + color + AI */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-5 space-y-1.5">
            <Label className="text-xs">اسم القالب</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: كاشير، محاسب مبتدئ، مدير فرع" />
          </div>
          <div className="md:col-span-4 space-y-1.5">
            <Label className="text-xs">اللون</Label>
            <div className="flex flex-wrap gap-1.5">
              {PALETTE.map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full border-2 transition ${color === c ? "border-slate-900 scale-110" : "border-transparent"}`}
                  style={{ background: c }} aria-label={c} />
              ))}
            </div>
          </div>
          <div className="md:col-span-3">
            <Button variant="outline" className="w-full gap-2" onClick={aiSuggest} disabled={aiBusy}>
              {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              اقتراح ذكي
            </Button>
          </div>
        </div>

        {/* Scope tabs */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as PolicyScope)} className="mt-2">
          <TabsList className="grid w-full grid-cols-4">
            {(["sales", "purchase", "pos", "customers"] as PolicyScope[]).map((sc) => {
              const M = SCOPE_META[sc]; const Ic = M.icon;
              return (
                <TabsTrigger key={sc} value={sc} className="gap-2">
                  <Ic className="w-4 h-4" /> {M.label}
                </TabsTrigger>
              );
            })}
          </TabsList>

          {(["sales", "purchase", "pos", "customers"] as PolicyScope[]).map((sc) => (
            <TabsContent key={sc} value={sc} className="mt-3 space-y-2">
              {catalogue[sc].map((f) => {
                const r = bundle[sc]?.[f.key] ?? { mode: "editable" as FieldMode };
                const meta = MODE_META[r.mode];
                const Ic = meta.icon;
                return (
                  <div key={f.key} className="flex items-center gap-3 p-2.5 rounded-lg border bg-white">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{f.labelAr}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{f.labelEn} · <code>{f.key}</code></div>
                    </div>
                    <Badge className={`gap-1 ${meta.tone}`}>
                      <Ic className="w-3 h-3" /> {meta.labelAr}
                    </Badge>
                    <Select value={r.mode} onValueChange={(v) => setRule(sc, f.key, { mode: v as FieldMode })}>
                      <SelectTrigger className="w-40 h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(["editable", "readonly", "hidden", "required"] as FieldMode[]).map((m) => (
                          <SelectItem key={m} value={m}>{MODE_META[m].labelAr}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {f.isDate && (
                      <div className="flex items-center gap-1.5 text-xs">
                        <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                        اليوم فقط
                        <Switch
                          checked={r.dateConstraint === "today_only"}
                          onCheckedChange={(c) => setRule(sc, f.key, { dateConstraint: c ? "today_only" : "none" })}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </TabsContent>
          ))}
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()} className="gap-2">
            {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            حفظ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function emptyBundle(cat: Catalogue): PolicyBundle {
  const out: PolicyBundle = { sales: {}, purchase: {}, pos: {}, customers: {} };
  for (const sc of ["sales", "purchase", "pos", "customers"] as PolicyScope[]) {
    for (const f of cat[sc]) {
      out[sc][f.key] = { mode: "editable", ...(f.isDate ? { dateConstraint: "none" as const } : {}) };
    }
  }
  return out;
}
