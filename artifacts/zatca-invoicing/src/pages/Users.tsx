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
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Users as UsersIcon, Plus, Pencil, Trash2, Shield, Search, KeyRound,
  CheckCircle2, XCircle, Loader2, X, Save, Check,
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
  isActive: boolean;
  lastLoginAt: string | null;
  branchIds: number[];
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
  branchIds: [] as number[],
  permissions: viewOnlyPermissions(),
});

export default function Users() {
  const { t } = useTranslation();
  const { isRtl } = useFormatters();
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const authH = { Authorization: `Bearer ${token}` };

  const [search, setSearch] = useState("");
  const [openForm, setOpenForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // Deep-link support: when arriving from Security Center via /users?selected=:id,
  // auto-open that user's edit panel as soon as the user list loads. Tracked with
  // a ref so it only fires once per query-string visit (avoids reopening if the
  // admin manually closes the editor).
  const search$ = useSearch();
  const [, setLocation] = useLocation();
  const handledSelectedRef = useRef<string | null>(null);

  const url   = cid ? `${API}/api/users?companyId=${cid}` : `${API}/api/users`;
  const burl  = cid ? `${API}/api/org/branches?companyId=${cid}` : `${API}/api/org/branches`;

  const { data: users = [], isLoading } = useQuery<UserRow[]>({
    queryKey: ["users", cid],
    queryFn: async () => {
      const r = await fetch(url, { headers: authH });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ["branches-for-users", cid],
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
  // the edit panel for that user. Strips the param from the URL afterwards so
  // the editor doesn't keep reopening on every re-render.
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
      branchIds: u.branchIds ?? [],
      permissions: { ...viewOnlyPermissions(), ...(u.permissions ?? {}) },
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
        branchIds: form.branchIds,
        permissions: form.permissions,
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
      closeForm();
    },
    onError: (e: any) => toast({ title: t("users.error"), description: e.message, variant: "destructive" }),
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
        {!openForm && (
          <Button onClick={openCreate} className={cn("gap-2 hover:from-cyan-700 hover:to-blue-700", isRtl ? "bg-gradient-to-l from-cyan-600 to-blue-600" : "bg-gradient-to-r from-cyan-600 to-blue-600")}>
            <Plus className="h-4 w-4" />
            {t("users.addUser")}
          </Button>
        )}
      </div>

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
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="info">{t("users.tabInfo")}</TabsTrigger>
                <TabsTrigger value="branches">{t("users.tabBranches", { count: form.branchIds.length })}</TabsTrigger>
                <TabsTrigger value="permissions">{t("users.tabPermissions")}</TabsTrigger>
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
