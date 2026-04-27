import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Pencil, Archive, Users as UsersIcon, X, Loader2, RefreshCw,
} from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface SessionRow {
  id: number;
  name: string;
  status: "active" | "archived" | string;
  notes: string | null;
  userCount: number;
  createdAt: string;
  archivedAt: string | null;
  createdByUserId: number | null;
}
interface CompanyUser {
  id: number;
  username: string;
  nameAr: string | null;
  nameEn: string | null;
  role: string;
  isActive: boolean;
}
interface SessionUser {
  id: number;
  username: string;
  nameAr: string | null;
  nameEn: string | null;
  role: string;
  addedAt: string;
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const t = localStorage.getItem("zatca_token");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (t) headers["Authorization"] = `Bearer ${t}`;
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...opts,
    headers: { ...headers, ...(opts.headers as any) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : ({} as any);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export default function SessionsAdmin() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { refreshManualSessions } = useAuth();

  const [rows, setRows] = useState<SessionRow[]>([]);
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");

  // Edit/create dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<SessionRow | null>(null);
  const [form, setForm] = useState({ name: "", notes: "" });
  const [saving, setSaving] = useState(false);

  // Assignment dialog
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState<SessionRow | null>(null);
  const [assigned, setAssigned] = useState<SessionUser[]>([]);
  const [assignLoading, setAssignLoading] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [assignBusy, setAssignBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const qs = statusFilter === "all" ? "" : `?status=${statusFilter}`;
      const [s, u] = await Promise.all([
        api<{ sessions: SessionRow[] }>(`/sessions${qs}`),
        api<CompanyUser[]>(`/users`),
      ]);
      setRows(s.sessions ?? []);
      setUsers(u ?? []);
    } catch (e) {
      toast({ title: t("sessions.loadError"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusFilter]);

  const openCreate = () => { setEditing(null); setForm({ name: "", notes: "" }); setEditOpen(true); };
  const openEdit = (row: SessionRow) => { setEditing(row); setForm({ name: row.name, notes: row.notes ?? "" }); setEditOpen(true); };

  const submitForm = async () => {
    const name = form.name.trim();
    if (!name) return;
    setSaving(true);
    try {
      if (editing) {
        await api<{ session: SessionRow }>(`/sessions/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, notes: form.notes }),
        });
        toast({ title: t("sessions.savedTitle"), description: t("sessions.savedDesc") });
      } else {
        await api<{ session: SessionRow }>(`/sessions`, {
          method: "POST",
          body: JSON.stringify({ name, notes: form.notes || null }),
        });
        toast({ title: t("sessions.createdTitle"), description: t("sessions.createdDesc") });
      }
      setEditOpen(false);
      await load();
      await refreshManualSessions();
    } catch (e) {
      toast({ title: t("common.errorTitle"), description: (e as Error).message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const archive = async (row: SessionRow) => {
    if (!confirm(t("sessions.confirmArchive", { name: row.name }))) return;
    try {
      await api(`/sessions/${row.id}`, { method: "DELETE" });
      toast({ title: t("sessions.archivedTitle") });
      await load();
      await refreshManualSessions();
    } catch (e) {
      toast({ title: t("common.errorTitle"), description: (e as Error).message, variant: "destructive" });
    }
  };

  const restore = async (row: SessionRow) => {
    try {
      await api(`/sessions/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
      });
      await load();
      await refreshManualSessions();
    } catch (e) {
      toast({ title: t("common.errorTitle"), description: (e as Error).message, variant: "destructive" });
    }
  };

  const openAssign = async (row: SessionRow) => {
    setAssignTarget(row);
    setAssignOpen(true);
    setPicked(new Set());
    setAssignLoading(true);
    try {
      const data = await api<{ users: SessionUser[] }>(`/sessions/${row.id}/users`);
      setAssigned(data.users ?? []);
    } catch (e) {
      toast({ title: t("common.errorTitle"), description: (e as Error).message, variant: "destructive" });
    } finally { setAssignLoading(false); }
  };

  const assignedIds = useMemo(() => new Set(assigned.map(a => a.id)), [assigned]);
  const availableUsers = useMemo(
    () => users.filter(u => u.isActive && !assignedIds.has(u.id)),
    [users, assignedIds],
  );

  const toggle = (id: number) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  const submitAssign = async () => {
    if (!assignTarget || picked.size === 0) return;
    setAssignBusy(true);
    try {
      const userIds = Array.from(picked);
      await api(`/sessions/${assignTarget.id}/users`, {
        method: "POST",
        body: JSON.stringify({ userIds }),
      });
      // Reload assignment list + main rows for updated user counts
      const data = await api<{ users: SessionUser[] }>(`/sessions/${assignTarget.id}/users`);
      setAssigned(data.users ?? []);
      setPicked(new Set());
      await load();
      // If the admin assigned themselves to this session, the picker/topbar
      // need to learn about the new membership. Cheap call → always do it.
      await refreshManualSessions();
    } catch (e) {
      toast({ title: t("common.errorTitle"), description: (e as Error).message, variant: "destructive" });
    } finally { setAssignBusy(false); }
  };

  const removeAssignment = async (userId: number) => {
    if (!assignTarget) return;
    setAssignBusy(true);
    try {
      await api(`/sessions/${assignTarget.id}/users/${userId}`, { method: "DELETE" });
      setAssigned((cur) => cur.filter(a => a.id !== userId));
      await load();
      await refreshManualSessions();
    } catch (e) {
      toast({ title: t("common.errorTitle"), description: (e as Error).message, variant: "destructive" });
    } finally { setAssignBusy(false); }
  };

  return (
    <div dir="rtl" className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">{t("sessions.adminTitle")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("sessions.adminSubtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
            <SelectTrigger className="w-40 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">{t("sessions.statusActive")}</SelectItem>
              <SelectItem value="archived">{t("sessions.statusArchived")}</SelectItem>
              <SelectItem value="all">{t("sessions.statusAll")}</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="icon" className="h-9 w-9" onClick={load} title={t("common.refresh")}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" />{t("sessions.newSession")}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("sessions.allSessions")}</CardTitle>
          <CardDescription>{t("sessions.allSessionsDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin me-2" />{t("common.loading")}
            </div>
          ) : rows.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-12">{t("sessions.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("sessions.colName")}</TableHead>
                  <TableHead>{t("sessions.colStatus")}</TableHead>
                  <TableHead>{t("sessions.colUsers")}</TableHead>
                  <TableHead>{t("sessions.colCreated")}</TableHead>
                  <TableHead className="text-end">{t("sessions.colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === "active" ? "secondary" : "outline"}>
                        {r.status === "active" ? t("sessions.statusActive") : t("sessions.statusArchived")}
                      </Badge>
                    </TableCell>
                    <TableCell>{r.userCount}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openAssign(r)} className="gap-1">
                          <UsersIcon className="h-3.5 w-3.5" />{t("sessions.manageUsers")}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(r)} title={t("common.edit")}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {r.status === "active" ? (
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => archive(r)} title={t("sessions.archive")}>
                            <Archive className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => restore(r)}>
                            {t("sessions.restore")}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ─── Create/Edit dialog ─────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("sessions.editTitle") : t("sessions.newSession")}</DialogTitle>
            <DialogDescription>
              {editing ? t("sessions.editDesc") : t("sessions.newDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="sname">{t("sessions.nameLabel")}</Label>
              <Input id="sname" value={form.name} maxLength={120}
                onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder={t("sessions.namePlaceholder")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="snotes">{t("sessions.notesLabel")}</Label>
              <Textarea id="snotes" value={form.notes} rows={3}
                onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder={t("sessions.notesPlaceholder")} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditOpen(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitForm} disabled={!form.name.trim() || saving}>
              {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {editing ? t("common.save") : t("sessions.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Assign users dialog ─────────────────────────── */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {t("sessions.manageUsersFor", { name: assignTarget?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("sessions.manageUsersDesc")}</DialogDescription>
          </DialogHeader>
          {assignLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin me-2" />{t("common.loading")}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Available users */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{t("sessions.availableUsers")}</h3>
                <ScrollArea className="h-72 border rounded-md p-2">
                  {availableUsers.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-8">
                      {t("sessions.noAvailableUsers")}
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {availableUsers.map(u => (
                        <li key={u.id}
                            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent">
                          <Checkbox
                            checked={picked.has(u.id)}
                            onCheckedChange={() => toggle(u.id)}
                            id={`pick-${u.id}`}
                          />
                          <label htmlFor={`pick-${u.id}`} className="flex-1 cursor-pointer text-sm">
                            <div className="font-medium">{u.nameAr || u.username}</div>
                            <div className="text-[11px] text-muted-foreground">@{u.username} · {u.role}</div>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
                <Button onClick={submitAssign} disabled={picked.size === 0 || assignBusy} className="w-full">
                  {assignBusy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                  {t("sessions.assignSelected", { count: picked.size })}
                </Button>
              </div>
              {/* Currently assigned */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{t("sessions.assignedUsers")} ({assigned.length})</h3>
                <ScrollArea className="h-72 border rounded-md p-2">
                  {assigned.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-8">
                      {t("sessions.noAssignedUsers")}
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {assigned.map(a => (
                        <li key={a.id}
                            className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-accent">
                          <div className="text-sm flex-1 min-w-0">
                            <div className="font-medium truncate">{a.nameAr || a.username}</div>
                            <div className="text-[11px] text-muted-foreground truncate">@{a.username} · {a.role}</div>
                          </div>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                            onClick={() => removeAssignment(a.id)} disabled={assignBusy}
                            title={t("sessions.unassign")}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAssignOpen(false)} disabled={assignBusy}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
