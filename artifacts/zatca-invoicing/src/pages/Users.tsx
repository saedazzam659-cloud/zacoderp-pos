import { useState, useMemo, useEffect, useRef } from "react";
import { useSearch, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Users as UsersIcon, Plus, Pencil, Trash2, Shield, Search, KeyRound,
  CheckCircle2, XCircle, Loader2, X, Save, Check, ShieldCheck, PowerOff, Power,
} from "lucide-react";
import {
  PERMISSION_MODULES, PERMISSION_GROUPS, ACTION_LABELS,
  emptyPermissions, fullPermissions, viewOnlyPermissions,
  type PermissionMap, type Action,
} from "@/lib/permissions";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type UserRow = {
  id: number;
  username: string;
  email: string | null;
  role: string;
  code: string | null;
  nameAr: string | null;
  nameEn: string | null;
  permissions: PermissionMap | null;
  viewAllBranches: boolean;
  scopeOwnCustomersOnly?: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  branchIds: number[];
  // Approval workflow — server returns numeric strings for the cap because
  // it's a NUMERIC column; we coerce on form-load.
  canApprove?: boolean;
  approvalLevel?: number;
  maxApprovalAmount?: string | number | null;
  requireSecondApproval?: boolean;
};

type Branch = { id: number; code: string; nameAr: string; nameEn?: string | null };

const emptyForm = () => ({
  id: 0 as number,
  code: "",
  nameAr: "",
  nameEn: "",
  username: "",
  password: "",
  email: "",
  role: "user" as "user" | "admin",
  isActive: true,
  viewAllBranches: true,
  scopeOwnCustomersOnly: false,
  branchIds: [] as number[],
  permissions: viewOnlyPermissions(),
  // Approval defaults: off, level 0, no cap, single-signature is fine.
  canApprove: false,
  approvalLevel: 0,
  maxApprovalAmount: "0",
  requireSecondApproval: false,
});

export default function Users() {
  const { t } = useTranslation();
  const { isRtl } = useFormatters();
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const authH = { Authorization: `Bearer ${token}` };

  const [search, setSearch] = useState("");
  const [openForm, setOpenForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // Deep-link support: when arriving from Security Center via
  //   /users?companyId=:cid&selected=:id
  // we honor the URL-supplied companyId (only meaningful for superadmin —
  // resolveCompanyId on the server pins normal admins to their own company).
  // This lets a superadmin open any tenant's user from the permissions matrix.
  const search$ = useSearch();
  const [, setLocation] = useLocation();
  const handledSelectedRef = useRef<string | null>(null);

  const urlCompanyId = useMemo(() => {
    const v = new URLSearchParams(search$).get("companyId");
    const n = v != null ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }, [search$]);

  // Effective companyId for fetching: superadmin uses the URL param when present
  // (otherwise fetches across all tenants — server returns 400 in that case so
  // the UI lands on an empty list and the create-user CTA is the only action).
  // Non-superadmin always uses their own company.
  const cid = user?.role === "superadmin" ? urlCompanyId : user?.company?.id;

  const url   = cid ? `${API}/api/users?companyId=${cid}` : `${API}/api/users`;
  const burl  = cid ? `${API}/api/org/branches?companyId=${cid}` : `${API}/api/org/branches`;

  // Skip the users/branches fetch entirely for superadmin until they pick a
  // tenant — avoids a noisy 400 from the server and lets the UI render a
  // friendly company picker instead of a confusing empty state.
  const fetchEnabled = user?.role !== "superadmin" || cid != null;

  const { data: users = [], isLoading } = useQuery<UserRow[]>({
    queryKey: ["users", cid],
    enabled: fetchEnabled,
    queryFn: async () => {
      const r = await fetch(url, { headers: authH });
      if (!r.ok) return [];
      return r.json();
    },
  });

  // Plan-based user quota — refetched on focus and on `subscription_changed`
  // SSE (handled globally by AuthContext via qc.invalidateQueries()) so any
  // SuperAdmin upgrade/downgrade reflects without a re-login.
  const { data: userQuota } = useQuery<{ limit: number; used: number; remaining: number; hasSubscription: boolean }>({
    queryKey: ["users-quota", cid],
    enabled: fetchEnabled && !!cid,
    queryFn: async () => {
      const r = await fetch(`${API}/api/users/quota?companyId=${cid}`, { headers: authH });
      if (!r.ok) return { limit: 0, used: 0, remaining: 0, hasSubscription: false };
      return r.json();
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  // Parse the JSON error body the API returns for plan-cap responses
  // (`{ error, code: "USER_LIMIT_REACHED", limit, used }`) so the toast
  // shows the actionable message instead of the raw stringified payload.
  const extractApiError = (raw: any): string => {
    const s = String(raw?.message ?? raw ?? "");
    try { const p = JSON.parse(s); return p.error || p.message || s; } catch { return s; }
  };

  // Companies dropdown for superadmin (small list — fine to keep cached).
  interface CompanyMin { id: number; nameAr: string; nameEn?: string | null }
  const { data: companiesList = [] } = useQuery<CompanyMin[]>({
    queryKey: ["admin-companies-min"],
    enabled: user?.role === "superadmin",
    queryFn: async () => {
      const r = await fetch(`${API}/api/admin/companies`, { headers: authH });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["branches-for-users", cid],
    enabled: fetchEnabled,
    queryFn: async () => {
      const r = await fetch(burl, { headers: authH });
      if (!r.ok) return [];
      const data = await r.json();
      if (Array.isArray(data)) return data;
      return Array.isArray(data?.branches) ? data.branches : [];
    },
  });

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return users;
    return users.filter(u =>
      (u.username ?? "").toLowerCase().includes(s) ||
      (u.nameAr ?? "").toLowerCase().includes(s) ||
      (u.nameEn ?? "").toLowerCase().includes(s) ||
      (u.code ?? "").toLowerCase().includes(s) ||
      (u.email ?? "").toLowerCase().includes(s),
    );
  }, [users, search]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setOpenForm(true);
    setConfirmDeleteId(null);
    setTimeout(() => {
      document.getElementById("user-form-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  // Consume ?selected=:id from the URL once users finish loading and auto-open
  // the edit panel for that user. Strips ONLY the `selected` param afterwards
  // so the editor doesn't keep reopening on re-renders, while preserving the
  // `companyId` param — that one is required for all subsequent save/delete
  // mutations to keep targeting the same tenant.
  useEffect(() => {
    if (isLoading) return;
    const params = new URLSearchParams(search$);
    const sel = params.get("selected");
    if (!sel) return;
    if (handledSelectedRef.current === sel) return;
    const targetId = Number(sel);
    if (!Number.isFinite(targetId)) return;
    const u = users.find(x => x.id === targetId);
    if (!u) return;
    handledSelectedRef.current = sel;
    openEdit(u);
    params.delete("selected");
    const qs = params.toString();
    setLocation(qs ? `/users?${qs}` : "/users", { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, isLoading, search$]);

  const openEdit = (u: UserRow) => {
    setEditingId(u.id);
    setForm({
      id: u.id,
      code: u.code ?? "",
      nameAr: u.nameAr ?? "",
      nameEn: u.nameEn ?? "",
      username: u.username,
      password: "",
      email: u.email ?? "",
      role: (u.role === "admin" ? "admin" : "user"),
      isActive: u.isActive,
      viewAllBranches: u.viewAllBranches ?? true,
      scopeOwnCustomersOnly: !!u.scopeOwnCustomersOnly,
      branchIds: u.branchIds ?? [],
      permissions: { ...viewOnlyPermissions(), ...(u.permissions ?? {}) },
      // Approval workflow fields — coerce numeric-string cap to a string the
      // <Input type="number"> can render without leading zeros.
      canApprove: !!u.canApprove,
      approvalLevel: Number.isFinite(Number(u.approvalLevel)) ? Number(u.approvalLevel) : 0,
      maxApprovalAmount: u.maxApprovalAmount != null ? String(u.maxApprovalAmount) : "0",
      requireSecondApproval: !!u.requireSecondApproval,
    });
    setOpenForm(true);
    setConfirmDeleteId(null);
    setTimeout(() => {
      document.getElementById("user-form-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  const closeForm = () => {
    setOpenForm(false);
    setEditingId(null);
    setForm(emptyForm());
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const body: any = {
        companyId: cid,
        code: form.code,
        nameAr: form.nameAr,
        nameEn: form.nameEn,
        email: form.email,
        role: form.role,
        isActive: form.isActive,
        viewAllBranches: form.viewAllBranches,
        scopeOwnCustomersOnly: form.scopeOwnCustomersOnly,
        branchIds: form.branchIds,
        permissions: form.permissions,
        // Approval workflow — server clamps these too as a safety net.
        canApprove: form.canApprove,
        approvalLevel: Number(form.approvalLevel) || 0,
        maxApprovalAmount: String(form.maxApprovalAmount ?? "0"),
        requireSecondApproval: form.requireSecondApproval,
      };
      if (editingId == null) {
        body.username = form.username;
        body.password = form.password;
        const r = await fetch(`${API}/api/users?companyId=${cid ?? ""}`, {
          method: "POST",
          headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || t("users.errSaveFailed"));
        return data;
      } else {
        if (form.password) body.password = form.password;
        const r = await fetch(`${API}/api/users/${editingId}?companyId=${cid ?? ""}`, {
          method: "PATCH",
          headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || t("users.errUpdateFailed"));
        return data;
      }
    },
    onSuccess: () => {
      toast({ title: t("users.savedTitle"), description: editingId == null ? t("users.savedAdd") : t("users.savedUpdate") });
      qc.invalidateQueries({ queryKey: ["users", cid] });
      qc.invalidateQueries({ queryKey: ["users-quota", cid] });
      closeForm();
    },
    onError: (e: any) => {
      toast({ title: t("users.error"), description: extractApiError(e), variant: "destructive" });
      qc.invalidateQueries({ queryKey: ["users-quota", cid] });
    },
  });

  // ─── Kill-switch: instant deactivation ───────────────────────────
  // Hits the same PATCH /users/:id endpoint with isActive=false. Server-side
  // also clears sessionToken+sessionId so the user's next request returns 401
  // and they're bounced to login *immediately* (no waiting for token expiry).
  // Used for fired-employee scenarios where every minute of access matters.
  const killSwitchMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/users/${id}?companyId=${cid ?? ""}`, {
        method: "PATCH",
        headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || "تعذّر إيقاف المستخدم");
    },
    onSuccess: () => {
      toast({ title: "🛑 تم إيقاف الوصول فوراً", description: "تم قطع الجلسة الحالية وأي محاولة دخول قادمة سيتم رفضها." });
      qc.invalidateQueries({ queryKey: ["users", cid] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  // Re-activate a deactivated user. They'll need to log in again — the cleared
  // sessionToken means no automatic restoration of their previous session.
  const reactivateMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/users/${id}?companyId=${cid ?? ""}`, {
        method: "PATCH",
        headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || "تعذّر إعادة التفعيل");
    },
    onSuccess: () => {
      toast({ title: "✅ تم إعادة التفعيل", description: "يمكن للمستخدم الآن تسجيل الدخول مجدداً." });
      qc.invalidateQueries({ queryKey: ["users", cid] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/users/${id}?companyId=${cid ?? ""}`, {
        method: "DELETE",
        headers: authH,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || t("users.errDeleteFailed"));
    },
    onSuccess: () => {
      toast({ title: t("users.deleted") });
      qc.invalidateQueries({ queryKey: ["users", cid] });
      setConfirmDeleteId(null);
    },
    onError: (e: any) => toast({ title: t("users.error"), description: e.message, variant: "destructive" }),
  });

  const togglePerm = (modKey: string, action: Action, val: boolean) => {
    setForm(f => ({
      ...f,
      permissions: {
        ...f.permissions,
        [modKey]: { ...(f.permissions[modKey] ?? {}), [action]: val },
      },
    }));
  };

  const setGroupAll = (group: string, val: boolean) => {
    setForm(f => {
      const next = { ...f.permissions };
      PERMISSION_MODULES.filter(m => m.group === group).forEach(m => {
        next[m.key] = {};
        m.actions.forEach(a => { next[m.key][a] = val; });
      });
      return { ...f, permissions: next };
    });
  };

  const applyPreset = (preset: "full" | "view" | "none") => {
    const p = preset === "full" ? fullPermissions() : preset === "view" ? viewOnlyPermissions() : emptyPermissions();
    setForm(f => ({ ...f, permissions: p }));
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 text-white">
            <UsersIcon className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t("users.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("users.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Superadmin company picker — lets the superadmin scope the page to a
              specific tenant. Pre-selected from ?companyId in the URL when the
              page is opened from the Security Center matrix click-through. */}
          {user?.role === "superadmin" && (
            <Select
              value={cid != null ? String(cid) : ""}
              onValueChange={(v) => {
                if (!v) return;
                handledSelectedRef.current = null;
                setLocation(`/users?companyId=${v}`, { replace: true });
              }}
            >
              <SelectTrigger className="min-w-[220px]" data-testid="superadmin-company-picker">
                <SelectValue placeholder={t("users.selectCompany", "اختر الشركة")} />
              </SelectTrigger>
              <SelectContent>
                {companiesList.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.nameAr}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {userQuota && fetchEnabled && (
            <div
              className={
                "rounded-lg border px-3 py-1.5 text-xs font-medium tabular-nums " +
                (userQuota.remaining === 0
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : userQuota.remaining <= Math.max(1, Math.floor(userQuota.limit * 0.2))
                    ? "border-amber-300 bg-amber-50 text-amber-800"
                    : "border-emerald-200 bg-emerald-50 text-emerald-800")
              }
              title={userQuota.remaining === 0 ? "وصلت إلى الحد الأقصى لخطتك" : `يمكنك إضافة ${userQuota.remaining} مستخدم إضافي`}
            >
              المستخدمون: <span className="font-bold">{userQuota.used}</span> / {userQuota.limit}
            </div>
          )}
          {!openForm && fetchEnabled && (
            <Button
              onClick={() => {
                if (userQuota && userQuota.remaining === 0) {
                  toast({
                    title: "وصلت للحد الأقصى",
                    description: `خطتك تسمح بـ ${userQuota.limit} مستخدم فقط. يرجى ترقية الخطة لإضافة المزيد.`,
                    variant: "destructive",
                  });
                  return;
                }
                openCreate();
              }}
              className={cn("gap-2 hover:from-cyan-700 hover:to-blue-700", isRtl ? "bg-gradient-to-l from-cyan-600 to-blue-600" : "bg-gradient-to-r from-cyan-600 to-blue-600")}
            >
              <Plus className="h-4 w-4" />
              {t("users.addUser")}
            </Button>
          )}
        </div>
      </div>

      {/* Friendly empty state when superadmin hasn't picked a tenant yet —
          replaces the previous 400-driven blank table. */}
      {user?.role === "superadmin" && cid == null && (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground space-y-2">
            <UsersIcon className="h-10 w-10 mx-auto opacity-30" />
            <div className="text-base">اختر شركة من القائمة أعلاه لإدارة مستخدميها.</div>
          </CardContent>
        </Card>
      )}

      {/* ─── Inline Form ─────────────────── */}
      {openForm && (
        <Card id="user-form-card" className="border-2 border-blue-200 dark:border-blue-900 shadow-lg">
          <CardHeader className={cn("border-b", isRtl ? "bg-gradient-to-l from-blue-50 to-cyan-50 dark:from-blue-950/40 dark:to-cyan-950/40" : "bg-gradient-to-r from-blue-50 to-cyan-50 dark:from-blue-950/40 dark:to-cyan-950/40")}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="flex items-center gap-2 text-lg">
                {editingId == null ? <Plus className="h-5 w-5 text-blue-600" /> : <Pencil className="h-5 w-5 text-blue-600" />}
                {editingId == null ? t("users.addUser") : t("users.editing", { name: form.nameAr || form.username })}
              </CardTitle>
              <div className="flex gap-2">
                <Button variant="outline" onClick={closeForm} className="gap-1">
                  <X className="h-4 w-4" /> {t("users.cancel")}
                </Button>
                <Button
                  onClick={() => saveMut.mutate()}
                  disabled={
                    saveMut.isPending ||
                    !form.username ||
                    (editingId == null && !form.password)
                  }
                  className="bg-blue-600 hover:bg-blue-700 gap-1"
                >
                  {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {editingId == null ? t("users.createUser") : t("users.saveChanges")}
                </Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-1">{t("users.formHint")}</p>
          </CardHeader>

          <CardContent className="pt-5">
            <Tabs defaultValue="info" className="w-full" dir={isRtl ? "rtl" : "ltr"}>
              <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4">
                <TabsTrigger value="info">{t("users.tabInfo")}</TabsTrigger>
                <TabsTrigger value="branches">{t("users.tabBranches", { count: form.branchIds.length })}</TabsTrigger>
                <TabsTrigger value="permissions">{t("users.tabPermissions")}</TabsTrigger>
                <TabsTrigger value="approval" data-testid="tab-approval" className="gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {t("users.tabApproval")}
                </TabsTrigger>
              </TabsList>

              {/* Info Tab */}
              <TabsContent value="info" className="space-y-4 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <Label>{t("users.code")}</Label>
                    <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="EMP-001" />
                  </div>
                  <div>
                    <Label>{t("users.nameAr")}</Label>
                    <Input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} placeholder="محمد أحمد" />
                  </div>
                  <div>
                    <Label>{t("users.nameEn")}</Label>
                    <Input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} placeholder="Mohamed Ahmed" />
                  </div>
                  <div>
                    <Label>{t("users.username")}</Label>
                    <Input
                      value={form.username}
                      onChange={(e) => setForm({ ...form, username: e.target.value })}
                      placeholder="username"
                      disabled={editingId != null}
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <Label>{t("users.email")}</Label>
                    <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="user@company.com" />
                  </div>
                  <div>
                    <Label className="flex items-center gap-1">
                      <KeyRound className="h-3 w-3" />
                      {editingId == null ? t("users.passwordNew") : t("users.passwordEdit")}
                    </Label>
                    <Input
                      type="password"
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      placeholder={editingId == null ? t("users.passwordPlaceholderNew") : t("users.passwordPlaceholderEdit")}
                      autoComplete="new-password"
                    />
                  </div>
                  <div>
                    <Label>{t("users.role")}</Label>
                    <select
                      value={form.role}
                      onChange={(e) => setForm({ ...form, role: e.target.value as any })}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                    >
                      <option value="user">{t("users.roleUser")}</option>
                      <option value="admin">{t("users.roleAdmin")}</option>
                    </select>
                  </div>
                  <div className="flex items-end gap-3 pb-2">
                    <Switch checked={form.isActive} onCheckedChange={(v) => setForm({ ...form, isActive: v })} />
                    <Label>{t("users.isActive")}</Label>
                  </div>
                </div>
              </TabsContent>

              {/* Branches Tab */}
              <TabsContent value="branches" className="space-y-3 pt-4">
                {/* عرض جميع الفروع — when on, the user can see data from every branch */}
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                    form.viewAllBranches
                      ? "bg-emerald-50 border-emerald-300 dark:bg-emerald-950/30"
                      : "hover:bg-muted/50"
                  }`}
                  data-testid="checkbox-view-all-branches"
                >
                  <Checkbox
                    checked={form.viewAllBranches}
                    onCheckedChange={(v) => setForm(f => ({ ...f, viewAllBranches: !!v }))}
                  />
                  <div>
                    <div className="font-medium">{t("users.viewAllBranches")}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {t("users.viewAllBranchesHint")}
                    </div>
                  </div>
                </label>

                {/* عزل العملاء — only see customers assigned to me as a sales rep */}
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                    form.scopeOwnCustomersOnly
                      ? "bg-amber-50 border-amber-300 dark:bg-amber-950/30"
                      : "hover:bg-muted/50"
                  }`}
                  data-testid="checkbox-scope-own-customers"
                >
                  <Checkbox
                    checked={form.scopeOwnCustomersOnly}
                    onCheckedChange={(v) => setForm(f => ({ ...f, scopeOwnCustomersOnly: !!v }))}
                  />
                  <div>
                    <div className="font-medium flex items-center gap-1">
                      <Shield className="h-3.5 w-3.5 text-amber-600" />
                      عزل العملاء — يرى عملاءه فقط
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      عند التفعيل: المستخدم لا يرى إلا العملاء المرتبطين بحسابه كمندوب مبيعات (يتطلب ربطه بمندوب من شاشة "مناديب المبيعات"). الأدمن والمدير العام لا يتأثرون بهذا الحد.
                    </div>
                  </div>
                </label>

                <div className={`flex items-center justify-between flex-wrap gap-2 ${form.viewAllBranches ? "opacity-50 pointer-events-none" : ""}`}>
                  <div className="text-sm text-muted-foreground">{t("users.branchesHint")}</div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setForm({ ...form, branchIds: branches.map(b => b.id) })}>
                      {t("users.selectAll")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setForm({ ...form, branchIds: [] })}>
                      {t("users.clearAll")}
                    </Button>
                  </div>
                </div>
                {branches.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground border rounded-lg">
                    {t("users.noBranchesYet")}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {branches.map(b => {
                      const checked = form.branchIds.includes(b.id);
                      return (
                        <label
                          key={b.id}
                          className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition ${
                            checked ? "bg-blue-50 border-blue-300 dark:bg-blue-950/30" : "hover:bg-muted/50"
                          }`}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => {
                              setForm(f => ({
                                ...f,
                                branchIds: v
                                  ? [...f.branchIds, b.id]
                                  : f.branchIds.filter(id => id !== b.id),
                              }));
                            }}
                          />
                          <div>
                            <div className="font-mono text-xs text-muted-foreground">{b.code}</div>
                            <div className="font-medium">{b.nameAr}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </TabsContent>

              {/* Permissions Tab */}
              <TabsContent value="permissions" className="space-y-4 pt-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    <Shield className="h-4 w-4 text-indigo-600" />
                    {t("users.permsHint")}
                    {form.role === "admin" && <span className="text-amber-600 font-semibold">{t("users.adminNote")}</span>}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => applyPreset("full")}>{t("users.presetFull")}</Button>
                    <Button size="sm" variant="outline" onClick={() => applyPreset("view")}>{t("users.presetView")}</Button>
                    <Button size="sm" variant="outline" onClick={() => applyPreset("none")}>{t("users.presetNone")}</Button>
                  </div>
                </div>

                <div className={`space-y-4 ${form.role === "admin" ? "opacity-50 pointer-events-none" : ""}`}>
                  {PERMISSION_GROUPS.map(group => {
                    const mods = PERMISSION_MODULES.filter(m => m.group === group);
                    return (
                      <div key={group} className="border rounded-lg overflow-hidden">
                        <div className="bg-muted/50 px-4 py-2 flex items-center justify-between">
                          <div className="font-semibold text-sm">{t(group)}</div>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setGroupAll(group, true)}>{t("users.groupEnable")}</Button>
                            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setGroupAll(group, false)}>{t("users.groupDisable")}</Button>
                          </div>
                        </div>
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b">
                              <th className="text-start p-2 font-medium">{t("users.colScreen")}</th>
                              {(["view", "create", "edit", "delete", "post", "export"] as Action[]).map(a => (
                                <th key={a} className="p-2 font-medium w-16 text-center">{t(ACTION_LABELS[a])}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {mods.map(m => (
                              <tr key={m.key} className="border-b last:border-b-0 hover:bg-muted/30">
                                <td className="p-2">{t(m.label)}</td>
                                {(["view", "create", "edit", "delete", "post", "export"] as Action[]).map(a => {
                                  const supported = m.actions.includes(a);
                                  const checked = !!form.permissions[m.key]?.[a];
                                  return (
                                    <td key={a} className="p-2 text-center">
                                      {supported ? (
                                        <Checkbox checked={checked} onCheckedChange={(v) => togglePerm(m.key, a, !!v)} />
                                      ) : (
                                        <span className="text-muted-foreground/40">—</span>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              </TabsContent>

              {/* Approval Permissions Tab — controls per-user document-approval workflow */}
              <TabsContent value="approval" className="space-y-4 pt-4" data-testid="approval-tab-content">
                <div className="text-sm text-muted-foreground flex items-start gap-2 p-3 rounded-lg border border-indigo-200 bg-indigo-50/40 dark:bg-indigo-950/20">
                  <ShieldCheck className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-semibold text-indigo-900 dark:text-indigo-100">{t("users.tabApproval")}</div>
                    <div className="text-xs mt-0.5">{t("users.approvalSectionHint")}</div>
                    {form.role === "admin" && (
                      <div className="text-xs mt-1.5 text-amber-700 font-medium">{t("users.approvalAdminNote")}</div>
                    )}
                  </div>
                </div>

                {/* 1) Master switch — gates everything below */}
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                    form.canApprove
                      ? "bg-emerald-50 border-emerald-300 dark:bg-emerald-950/30"
                      : "hover:bg-muted/50"
                  }`}
                  data-testid="checkbox-can-approve"
                >
                  <Checkbox
                    checked={form.canApprove}
                    onCheckedChange={(v) => setForm(f => ({ ...f, canApprove: !!v }))}
                  />
                  <div>
                    <div className="font-medium">{t("users.canApprove")}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t("users.canApproveHint")}</div>
                  </div>
                </label>

                {/* 2) Level + cap + 2nd-approval — disabled and dimmed when canApprove is off */}
                <div className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${!form.canApprove ? "opacity-50 pointer-events-none" : ""}`}>
                  <div>
                    <Label className="flex items-center gap-1">
                      <Shield className="h-3 w-3 text-indigo-600" />
                      {t("users.approvalLevel")}
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      max={9}
                      step={1}
                      value={form.approvalLevel}
                      onChange={(e) => setForm({ ...form, approvalLevel: Math.max(0, Math.min(9, Number(e.target.value) || 0)) })}
                      data-testid="input-approval-level"
                      className="font-mono"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">{t("users.approvalLevelHint")}</p>
                  </div>
                  <div>
                    <Label className="flex items-center gap-1">
                      <KeyRound className="h-3 w-3 text-emerald-600" />
                      {t("users.maxApprovalAmount")}
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={form.maxApprovalAmount}
                      onChange={(e) => setForm({ ...form, maxApprovalAmount: e.target.value })}
                      data-testid="input-max-approval-amount"
                      className="font-mono tabular-nums"
                      placeholder="0.00"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">{t("users.maxApprovalAmountHint")}</p>
                  </div>
                </div>

                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                    !form.canApprove ? "opacity-50 pointer-events-none" : ""
                  } ${
                    form.requireSecondApproval
                      ? "bg-amber-50 border-amber-300 dark:bg-amber-950/30"
                      : "hover:bg-muted/50"
                  }`}
                  data-testid="checkbox-require-second-approval"
                >
                  <Checkbox
                    checked={form.requireSecondApproval}
                    onCheckedChange={(v) => setForm(f => ({ ...f, requireSecondApproval: !!v }))}
                  />
                  <div>
                    <div className="font-medium">{t("users.requireSecondApproval")}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t("users.requireSecondApprovalHint")}</div>
                  </div>
                </label>

                {!form.canApprove && (
                  <div className="text-xs text-muted-foreground italic flex items-center gap-1.5 px-1">
                    <XCircle className="h-3 w-3 text-rose-500" />
                    {t("users.approvalDisabledHint")}
                  </div>
                )}
              </TabsContent>
            </Tabs>

            {/* Bottom action bar */}
            <div className="flex justify-end gap-2 pt-5 mt-4 border-t">
              <Button variant="outline" onClick={closeForm} className="gap-1">
                <X className="h-4 w-4" /> {t("users.cancel")}
              </Button>
              <Button
                onClick={() => saveMut.mutate()}
                disabled={
                  saveMut.isPending ||
                  !form.username ||
                  (editingId == null && !form.password)
                }
                className="bg-blue-600 hover:bg-blue-700 gap-1"
              >
                {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {editingId == null ? t("users.createUser") : t("users.saveChanges")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <Card>
        <CardContent className="pt-5">
          <div className="relative">
            <Search className={cn("h-4 w-4 absolute top-1/2 -translate-y-1/2 text-muted-foreground", isRtl ? "right-3" : "left-3")} />
            <Input
              placeholder={t("users.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={isRtl ? "pr-9" : "pl-9"}
            />
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("users.listTitle", { count: filtered.length })}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">
              <Loader2 className={cn("h-6 w-6 inline-block animate-spin", isRtl ? "ml-2" : "mr-2")} /> {t("users.loading")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <UsersIcon className="h-10 w-10 mx-auto mb-2 opacity-30" />
              {t("users.noUsers")}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-start">{t("users.colCode")}</TableHead>
                    <TableHead className="text-start">{t("users.colNameAr")}</TableHead>
                    <TableHead className="text-start">{t("users.colNameEn")}</TableHead>
                    <TableHead className="text-start">{t("users.colUsername")}</TableHead>
                    <TableHead className="text-start">{t("users.colEmail")}</TableHead>
                    <TableHead className="text-start">{t("users.colRole")}</TableHead>
                    <TableHead className="text-start">{t("users.colBranches")}</TableHead>
                    <TableHead className="text-start">{t("users.colStatus")}</TableHead>
                    <TableHead className="text-start">{t("users.colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(u => {
                    const branchNames = branches.filter(b => u.branchIds?.includes(b.id)).map(b => b.nameAr);
                    const isConfirming = confirmDeleteId === u.id;
                    return (
                      <TableRow key={u.id} className={isConfirming ? "bg-red-50/60 dark:bg-red-950/20" : ""}>
                        <TableCell className="font-mono">{u.code || "—"}</TableCell>
                        <TableCell>{u.nameAr || "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{u.nameEn || "—"}</TableCell>
                        <TableCell className="font-mono">{u.username}</TableCell>
                        <TableCell className="text-xs">{u.email || "—"}</TableCell>
                        <TableCell>
                          {u.role === "superadmin" && <Badge className="bg-purple-600">{t("users.roleSuperadmin")}</Badge>}
                          {u.role === "admin" && <Badge className="bg-blue-600">{t("users.roleAdminBadge")}</Badge>}
                          {u.role === "user" && <Badge variant="outline">{t("users.roleUserBadge")}</Badge>}
                        </TableCell>
                        <TableCell className="text-xs">
                          {branchNames.length === 0 ? (
                            <span className="text-muted-foreground">{t("users.allBranches")}</span>
                          ) : (
                            <span className="line-clamp-1">{branchNames.join(isRtl ? "، " : ", ")}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {u.isActive ? (
                            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300 gap-1">
                              <CheckCircle2 className="h-3 w-3" /> {t("users.active")}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-red-50 text-red-700 border-red-300 gap-1">
                              <XCircle className="h-3 w-3" /> {t("users.inactive")}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {isConfirming ? (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-red-700 font-semibold">{t("users.confirmDelete")}</span>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => deleteMut.mutate(u.id)}
                                disabled={deleteMut.isPending}
                                className="h-7 px-2"
                              >
                                {deleteMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setConfirmDeleteId(null)}
                                className="h-7 px-2"
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" onClick={() => openEdit(u)} title={t("users.edit")}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              {u.isActive ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-rose-700 hover:text-rose-800 hover:bg-rose-50"
                                  onClick={() => {
                                    if (confirm(`🛑 إيقاف الوصول فوراً للمستخدم "${u.nameAr || u.username}"؟\n\nسيتم:\n• قطع جلسته الحالية مباشرةً (401 على الفور)\n• منع تسجيل دخوله مجدداً\n• إبقاء كل بياناته وفواتيره كما هي\n\nيمكنك إعادة تفعيله لاحقاً.`)) {
                                      killSwitchMut.mutate(u.id);
                                    }
                                  }}
                                  title="إيقاف الوصول فوراً"
                                  disabled={u.role === "superadmin" || u.id === user?.id || killSwitchMut.isPending}
                                  data-testid={`btn-kill-switch-${u.id}`}
                                >
                                  <PowerOff className="h-4 w-4" />
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50"
                                  onClick={() => reactivateMut.mutate(u.id)}
                                  title="إعادة تفعيل الدخول"
                                  disabled={reactivateMut.isPending}
                                  data-testid={`btn-reactivate-${u.id}`}
                                >
                                  <Power className="h-4 w-4" />
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                onClick={() => setConfirmDeleteId(u.id)}
                                title={t("users.delete")}
                                disabled={u.role === "superadmin" || u.id === user?.id}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
