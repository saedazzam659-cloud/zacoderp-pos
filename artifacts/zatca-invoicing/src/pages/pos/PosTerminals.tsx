import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  MonitorSmartphone, Plus, Pencil, Trash2, Loader2, Building2,
  Cpu, Wifi, WifiOff, Unlink, Power, PowerOff, Search, Users, Check,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// Service icons that can be shown/hidden in the cashier top bar. Keep keys in
// lockstep with the backend SERVICE_KEYS (pos-terminals.ts) and the POS
// frontend gating (artifacts/pos Cashier.tsx).
const SERVICE_OPTIONS: { key: string; ar: string; en: string }[] = [
  { key: "kitchen",     ar: "المطبخ",            en: "Kitchen" },
  { key: "waiter",      ar: "الجرسون / الصالة",   en: "Waiter / Hall" },
  { key: "settings",    ar: "إعدادات المطعم",     en: "Restaurant settings" },
  { key: "analytics",   ar: "تحليلات الذكاء",     en: "AI analytics" },
  { key: "supermarket", ar: "سوبر ماركت",         en: "Supermarket" },
];
const ALL_SERVICE_KEYS = SERVICE_OPTIONS.map((s) => s.key);

type Branch  = { id: number; nameAr: string; nameEn?: string | null; code?: string };
type CashBox = { id: number; nameAr: string; nameEn?: string | null; code?: string };
type Company = { id: number; nameAr: string; nameEn?: string | null };
type CoUser  = { id: number; username: string; nameAr?: string | null; nameEn?: string | null; role: string; isActive?: boolean; branchIds?: number[] };

type Terminal = {
  id:          number;
  code:        string;
  nameAr:      string;
  nameEn:      string | null;
  branchId:    number;
  branchName:  string | null;
  branchNameEn?: string | null;
  machineCode: string | null;
  cashBoxId:   number | null;
  cashBoxName: string | null;
  cashBoxNameEn?: string | null;
  isActive:    boolean;
  notes:       string | null;
  busyUserId:  number | null;
  allowedUserCount?: number;
  enabledServices: string[] | null;
};

type Draft = {
  id?:         number;
  code?:       string;
  nameAr:      string;
  nameEn:      string;
  branchId:    string;
  machineCode: string;
  cashBoxId:   string;
  isActive:    boolean;
  notes:       string;
  // null = all services visible (backwards compatible default).
  enabledServices: string[] | null;
};

const blankDraft: Draft = {
  code: "", nameAr: "", nameEn: "", branchId: "",
  machineCode: "", cashBoxId: "", isActive: true, notes: "",
  enabledServices: null,
};

export default function PosTerminals() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`posPages.terminals.${k}`, opts) as string;
  const pickName = (r: { nameAr?: string | null; nameEn?: string | null } | undefined | null) =>
    !r ? "" : (isRtl ? (r.nameAr ?? r.nameEn ?? "") : (r.nameEn ?? r.nameAr ?? ""));
  const qc = useQueryClient();
  const isSuperAdmin = user?.role === "superadmin";

  const [companyId, setCompanyId] = useState<number | null>(user?.companyId ?? null);
  useEffect(() => { if (user?.companyId) setCompanyId(user.companyId); }, [user?.companyId]);

  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Terminal | null>(null);
  const [usersForTerminal, setUsersForTerminal] = useState<Terminal | null>(null);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const cidQS = companyId ? `?companyId=${companyId}` : "";

  const companiesQ = useQuery<Company[]>({
    queryKey: ["pt-companies"],
    enabled: isSuperAdmin,
    queryFn: async () => {
      const r = await fetch(`${API}/api/companies`, { headers });
      if (!r.ok) throw new Error(tr("errLoadCompanies"));
      return r.json();
    },
  });

  const branchesQ = useQuery<Branch[]>({
    queryKey: ["pt-branches", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/org/branches${cidQS}`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const usersQ = useQuery<CoUser[]>({
    queryKey: ["pt-users", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/users${cidQS}`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const cashBoxesQ = useQuery<CashBox[]>({
    queryKey: ["pt-cashboxes", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/cash-boxes${cidQS}`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const terminalsQ = useQuery<Terminal[]>({
    queryKey: ["pt-terminals", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const r = await fetch(`${API}/api/pos-terminals`, { headers });
      if (!r.ok) throw new Error(tr("errLoadTerminals"));
      return r.json();
    },
  });

  const saveMut = useMutation({
    mutationFn: async (d: Draft) => {
      const body = {
        code:        d.code?.trim() || undefined,
        nameAr:      d.nameAr.trim(),
        nameEn:      d.nameEn.trim() || null,
        branchId:    d.branchId ? Number(d.branchId) : null,
        machineCode: d.machineCode.trim() || null,
        cashBoxId:   d.cashBoxId ? Number(d.cashBoxId) : null,
        isActive:    d.isActive,
        notes:       d.notes.trim() || null,
        enabledServices: d.enabledServices,
      };
      const url = d.id ? `${API}/api/pos-terminals/${d.id}` : `${API}/api/pos-terminals`;
      const r = await fetch(url, {
        method: d.id ? "PATCH" : "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || tr("errSave"));
      }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: tr("toastSaved") });
      qc.invalidateQueries({ queryKey: ["pt-terminals", companyId] });
      setEditing(null);
    },
    onError: (e: any) => toast({ title: tr("toastError"), description: e?.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/pos-terminals/${id}`, { method: "DELETE", headers });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || tr("errDelete"));
      }
    },
    onSuccess: () => {
      toast({ title: tr("toastDeleted") });
      qc.invalidateQueries({ queryKey: ["pt-terminals", companyId] });
      setConfirmDelete(null);
    },
    onError: (e: any) => toast({ title: tr("toastDeleteFailed"), description: e?.message, variant: "destructive" }),
  });

  const unpairMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/pos-terminals/${id}/unpair`, { method: "POST", headers });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || tr("errUnpair"));
      }
    },
    onSuccess: () => {
      toast({ title: tr("toastUnpaired"), description: tr("toastUnpairedDesc") });
      qc.invalidateQueries({ queryKey: ["pt-terminals", companyId] });
    },
    onError: (e: any) => toast({ title: tr("toastError"), description: e?.message, variant: "destructive" }),
  });

  const filtered = useMemo(() => {
    const items = terminalsQ.data ?? [];
    const q = search.trim().toLowerCase();
    return items.filter(tt => {
      if (branchFilter !== "all" && String(tt.branchId) !== branchFilter) return false;
      if (!q) return true;
      return [tt.code, tt.nameAr, tt.nameEn, tt.branchName, tt.branchNameEn, tt.machineCode]
        .some(v => v && String(v).toLowerCase().includes(q));
    });
  }, [terminalsQ.data, branchFilter, search]);

  const totals = useMemo(() => {
    const items = terminalsQ.data ?? [];
    return {
      total:  items.length,
      active: items.filter(tt => tt.isActive).length,
      paired: items.filter(tt => !!tt.machineCode).length,
      busy:   items.filter(tt => !!tt.busyUserId).length,
    };
  }, [terminalsQ.data]);

  const openNew  = () => setEditing({ ...blankDraft });
  const openEdit = (tt: Terminal) => setEditing({
    id: tt.id, code: tt.code, nameAr: tt.nameAr, nameEn: tt.nameEn ?? "",
    branchId: String(tt.branchId), machineCode: tt.machineCode ?? "",
    cashBoxId: tt.cashBoxId ? String(tt.cashBoxId) : "",
    isActive: tt.isActive, notes: tt.notes ?? "",
    enabledServices: tt.enabledServices ?? null,
  });

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MonitorSmartphone className="w-6 h-6 text-primary" />
            {tr("title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {tr("subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSuperAdmin && (
            <div className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-muted-foreground" />
              <Select value={companyId ? String(companyId) : ""} onValueChange={(v) => setCompanyId(Number(v))}>
                <SelectTrigger className="w-56" data-testid="select-company"><SelectValue placeholder={tr("selectCompany")} /></SelectTrigger>
                <SelectContent>
                  {(companiesQ.data ?? []).map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{pickName(c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button onClick={openNew} disabled={!companyId} data-testid="btn-new-terminal">
            <Plus className="w-4 h-4 me-1" /> {tr("newTerminal")}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<MonitorSmartphone className="w-5 h-5" />} label={tr("statTotal")} value={totals.total} color="bg-primary/10 text-primary" />
        <StatCard icon={<Power className="w-5 h-5" />}             label={tr("statActive")} value={totals.active} color="bg-emerald-100 text-emerald-700" />
        <StatCard icon={<Cpu className="w-5 h-5" />}                label={tr("statPaired")} value={totals.paired} color="bg-blue-100 text-blue-700" />
        <StatCard icon={<Wifi className="w-5 h-5" />}               label={tr("statBusy")}   value={totals.busy}   color="bg-amber-100 text-amber-700" />
      </div>

      {/* Filter row */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-2.5 text-muted-foreground pointer-events-none" />
            <Input
              data-testid="input-search"
              className="ps-8"
              placeholder={tr("searchPh")}
              value={search} onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={branchFilter} onValueChange={setBranchFilter}>
            <SelectTrigger className="w-56" data-testid="select-branch-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr("allBranches")}</SelectItem>
              {(branchesQ.data ?? []).map(b => (
                <SelectItem key={b.id} value={String(b.id)}>{pickName(b)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Inline editor */}
      {editing && (
        <TerminalEditor
          draft={editing}
          branches={branchesQ.data ?? []}
          cashBoxes={cashBoxesQ.data ?? []}
          onClose={() => setEditing(null)}
          onChange={setEditing}
          onSave={() => editing && saveMut.mutate(editing)}
          saving={saveMut.isPending}
        />
      )}

      {/* Cards grid */}
      {!companyId ? (
        <Card><CardContent className="p-10 text-center text-muted-foreground">{tr("selectCompanyToContinue")}</CardContent></Card>
      ) : terminalsQ.isLoading ? (
        <Card><CardContent className="p-10 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-primary" /></CardContent></Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground space-y-2">
            <MonitorSmartphone className="w-10 h-10 mx-auto opacity-40" />
            <div>{tr("noTerminals")}</div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(tt => (
            <TerminalCard
              key={tt.id}
              t={tt}
              onEdit={() => openEdit(tt)}
              onDelete={() => setConfirmDelete(tt)}
              onUnpair={() => unpairMut.mutate(tt.id)}
              onManageUsers={() => setUsersForTerminal(tt)}
              unpairing={unpairMut.isPending}
            />
          ))}
        </div>
      )}

      {/* Users assignment dialog */}
      {usersForTerminal && (
        <TerminalUsersDialog
          terminal={usersForTerminal}
          users={(usersQ.data ?? []).filter(u => u.isActive !== false)}
          headers={headers}
          apiBase={API}
          onClose={() => setUsersForTerminal(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["pt-terminals", companyId] });
            setUsersForTerminal(null);
          }}
        />
      )}

      {/* Delete confirm */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr("deleteDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr("deleteDialogDesc", { name: confirmDelete ? pickName(confirmDelete) : "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="btn-confirm-delete"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => confirmDelete && deleteMut.mutate(confirmDelete.id)}
            >
              {tr("deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl grid place-items-center ${color}`}>{icon}</div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-bold tabular-nums">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function TerminalCard({
  t: tt, onEdit, onDelete, onUnpair, onManageUsers, unpairing,
}: {
  t: Terminal;
  onEdit: () => void;
  onDelete: () => void;
  onUnpair: () => void;
  onManageUsers: () => void;
  unpairing: boolean;
}) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`posPages.terminals.${k}`, opts) as string;
  const pickName = (r: { nameAr?: string | null; nameEn?: string | null } | undefined | null) =>
    !r ? "" : (isRtl ? (r.nameAr ?? r.nameEn ?? "") : (r.nameEn ?? r.nameAr ?? ""));
  const branchDisplay = isRtl ? (tt.branchName ?? tt.branchNameEn) : (tt.branchNameEn ?? tt.branchName);
  const cashBoxDisplay = isRtl ? (tt.cashBoxName ?? tt.cashBoxNameEn) : (tt.cashBoxNameEn ?? tt.cashBoxName);
  const primaryName = pickName(tt);
  const altName = isRtl ? tt.nameEn : tt.nameAr;
  return (
    <Card data-testid={`card-terminal-${tt.id}`} className={!tt.isActive ? "opacity-70" : ""}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <Badge variant="outline" className="text-[11px] font-mono">{tt.code}</Badge>
              {tt.isActive ? (
                <Badge variant="outline" className="text-[11px] gap-1 border-emerald-200 bg-emerald-50 text-emerald-700">
                  <Power className="w-3 h-3" /> {tr("active")}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[11px] gap-1 border-slate-200 bg-slate-50 text-slate-600">
                  <PowerOff className="w-3 h-3" /> {tr("inactive")}
                </Badge>
              )}
              {tt.busyUserId && (
                <Badge variant="outline" className="text-[11px] gap-1 border-amber-200 bg-amber-50 text-amber-700">
                  <Wifi className="w-3 h-3" /> {tr("busyLabel")}
                </Badge>
              )}
            </div>
            <div className="font-bold truncate">{primaryName}</div>
            {altName && altName !== primaryName && <div className="text-xs text-muted-foreground truncate">{altName}</div>}
          </div>
        </div>

        <div className="text-sm space-y-1.5 border-t pt-2">
          <div className="flex items-center gap-2">
            <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">{tr("branchLabel")}</span>
            <span className="font-medium">{branchDisplay ?? "—"}</span>
          </div>
          <div className="flex items-center gap-2">
            <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">{tr("machineLabel")}</span>
            {tt.machineCode ? (
              <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded truncate" title={tt.machineCode}>
                {tt.machineCode.length > 16 ? `${tt.machineCode.slice(0, 8)}…${tt.machineCode.slice(-6)}` : tt.machineCode}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <WifiOff className="w-3 h-3" /> {tr("unlinkedHint")}
              </span>
            )}
          </div>
          {cashBoxDisplay && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">{tr("defaultCashBoxLabel")}</span>
              <span className="text-xs">{cashBoxDisplay}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Users className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground text-xs">{tr("usersLabel")}</span>
            {tt.allowedUserCount && tt.allowedUserCount > 0 ? (
              <Badge variant="outline" className="text-[11px] gap-1 border-blue-200 bg-blue-50 text-blue-700">
                {tr("usersBoundCount", { count: tt.allowedUserCount })}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">{tr("usersOpenToAll")}</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 border-t pt-2">
          <Button size="sm" variant="outline" className="h-8" onClick={onEdit} data-testid={`btn-edit-${tt.id}`}>
            <Pencil className="w-3.5 h-3.5 me-1" /> {tr("edit")}
          </Button>
          <Button
            size="sm" variant="outline" className="h-8"
            onClick={onManageUsers}
            data-testid={`btn-users-${tt.id}`}
          >
            <Users className="w-3.5 h-3.5 me-1" /> {tr("manageUsers")}
          </Button>
          {tt.machineCode && (
            <Button
              size="sm" variant="outline" className="h-8"
              onClick={onUnpair} disabled={unpairing}
              data-testid={`btn-unpair-${tt.id}`}
            >
              <Unlink className="w-3.5 h-3.5 me-1" /> {tr("unpair")}
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-8 text-destructive hover:text-destructive" onClick={onDelete} data-testid={`btn-delete-${tt.id}`}>
            <Trash2 className="w-3.5 h-3.5 me-1" /> {tr("delete")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TerminalEditor({
  draft, branches, cashBoxes, onClose, onChange, onSave, saving,
}: {
  draft: Draft;
  branches: Branch[];
  cashBoxes: CashBox[];
  onClose: () => void;
  onChange: (d: Draft) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`posPages.terminals.${k}`, opts) as string;
  const pickName = (r: { nameAr?: string | null; nameEn?: string | null } | undefined | null) =>
    !r ? "" : (isRtl ? (r.nameAr ?? r.nameEn ?? "") : (r.nameEn ?? r.nameAr ?? ""));
  const isNew = !draft.id;
  const valid = draft.nameAr.trim().length > 0 && !!draft.branchId;

  return (
    <Card className="border-primary/40 shadow-sm" dir={isRtl ? "rtl" : "ltr"}>
      <CardContent className="p-4 md:p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 border-b pb-3">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <MonitorSmartphone className="w-5 h-5 text-primary" />
              {isNew ? tr("addNew") : tr("editTitle")}
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              {tr("editorDesc")}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-muted-foreground">
            {tr("close")}
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="col-span-1">
            <Label className="text-xs">{tr("code")}</Label>
            <Input
              data-testid="input-code"
              placeholder={tr("codeAuto")}
              value={draft.code ?? ""}
              onChange={(e) => onChange({ ...draft, code: e.target.value })}
            />
          </div>
          <div className="col-span-1 flex items-end justify-end gap-2">
            <Label className="text-xs">{tr("activeSwitch")}</Label>
            <Switch
              checked={draft.isActive}
              onCheckedChange={(v) => onChange({ ...draft, isActive: v })}
              data-testid="switch-active"
            />
          </div>

          <div className="col-span-2">
            <Label className="text-xs">{tr("nameArLabel")}</Label>
            <Input
              data-testid="input-name-ar"
              placeholder={tr("nameArPh")}
              value={draft.nameAr}
              onChange={(e) => onChange({ ...draft, nameAr: e.target.value })}
            />
          </div>

          <div className="col-span-2">
            <Label className="text-xs">{tr("nameEnLabel")}</Label>
            <Input
              data-testid="input-name-en"
              placeholder={tr("nameEnPh")}
              value={draft.nameEn}
              onChange={(e) => onChange({ ...draft, nameEn: e.target.value })}
            />
          </div>

          <div className="col-span-2">
            <Label className="text-xs">{tr("branchSelectLabel")}</Label>
            <Select value={draft.branchId} onValueChange={(v) => onChange({ ...draft, branchId: v })}>
              <SelectTrigger data-testid="select-branch"><SelectValue placeholder={tr("branchSelectPh")} /></SelectTrigger>
              <SelectContent>
                {branches.map(b => (
                  <SelectItem key={b.id} value={String(b.id)}>{pickName(b)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="col-span-2">
            <Label className="text-xs">{tr("cashBoxSelectLabel")}</Label>
            <Select
              value={draft.cashBoxId || "none"}
              onValueChange={(v) => onChange({ ...draft, cashBoxId: v === "none" ? "" : v })}
            >
              <SelectTrigger data-testid="select-cashbox"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{tr("noneOption")}</SelectItem>
                {cashBoxes.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{pickName(c)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="col-span-2">
            <Label className="text-xs">{tr("machineCodeLabel")}</Label>
            <Input
              data-testid="input-machine-code"
              placeholder={tr("machineCodePh")}
              value={draft.machineCode}
              onChange={(e) => onChange({ ...draft, machineCode: e.target.value })}
              className="font-mono text-xs"
            />
          </div>

          <div className="col-span-2">
            <Label className="text-xs">{tr("notes")}</Label>
            <Input
              data-testid="input-notes"
              value={draft.notes}
              onChange={(e) => onChange({ ...draft, notes: e.target.value })}
            />
          </div>

          <div className="col-span-2 space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-semibold">
                {isRtl ? "الخدمات الظاهرة للكاشير" : "Cashier services"}
              </Label>
              <button
                type="button"
                className="text-[11px] text-primary hover:underline"
                onClick={() =>
                  onChange({
                    ...draft,
                    enabledServices: draft.enabledServices === null ? [] : null,
                  })
                }
                data-testid="btn-toggle-services-all"
              >
                {draft.enabledServices === null
                  ? (isRtl ? "تخصيص" : "Customize")
                  : (isRtl ? "إظهار الكل" : "Show all")}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {draft.enabledServices === null
                ? (isRtl
                    ? "كل الخدمات ظاهرة (الوضع الافتراضي). اضغط «تخصيص» للتحكم."
                    : "All services visible (default). Click \"Customize\" to control.")
                : (isRtl
                    ? "حدّد الخدمات التي تظهر في الشريط العلوي للكاشير على هذه المحطة."
                    : "Pick which services show in the cashier top bar on this terminal.")}
            </p>
            {draft.enabledServices !== null && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {SERVICE_OPTIONS.map((s) => {
                  const checked = draft.enabledServices!.includes(s.key);
                  return (
                    <label
                      key={s.key}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 cursor-pointer"
                      data-testid={`svc-terminal-${s.key}`}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => {
                          const cur = draft.enabledServices ?? [];
                          const next = checked
                            ? cur.filter((k) => k !== s.key)
                            : ALL_SERVICE_KEYS.filter((k) => cur.includes(k) || k === s.key);
                          onChange({ ...draft, enabledServices: next });
                        }}
                      />
                      <span className="text-sm">{isRtl ? s.ar : s.en}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t">
          <Button variant="outline" onClick={onClose}>{tr("cancel")}</Button>
          <Button onClick={onSave} disabled={!valid || saving} data-testid="btn-save-terminal">
            {saving && <Loader2 className="w-4 h-4 me-1 animate-spin" />}
            {tr("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TerminalUsersDialog({
  terminal, users, headers, apiBase, onClose, onSaved,
}: {
  terminal: Terminal;
  users: CoUser[];
  headers: Record<string, string>;
  apiBase: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`posPages.terminals.${k}`, opts) as string;
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Per-cashier service override. Absent key (or null value) = inherit terminal.
  const [svcOverrides, setSvcOverrides] = useState<Map<number, string[] | null>>(new Map());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`${apiBase}/api/pos-terminals/${terminal.id}/users`, { headers });
        const j = await r.json();
        if (!cancelled) {
          const rows = (j?.users ?? []) as { userId: number; enabledServices: string[] | null }[];
          if (rows.length > 0) {
            setSelected(new Set<number>(rows.map(x => x.userId)));
            setSvcOverrides(new Map(rows.map(x => [x.userId, x.enabledServices ?? null])));
          } else {
            setSelected(new Set<number>((j?.userIds ?? []) as number[]));
            setSvcOverrides(new Map());
          }
        }
      } catch {
        if (!cancelled) { setSelected(new Set()); setSvcOverrides(new Map()); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [terminal.id, apiBase]);

  const toggle = (uid: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  };

  // null = inherit terminal default; array = custom per-cashier list.
  const setOverride = (uid: number, value: string[] | null) => {
    setSvcOverrides(prev => {
      const next = new Map(prev);
      next.set(uid, value);
      return next;
    });
  };
  const toggleUserSvc = (uid: number, key: string) => {
    const cur = svcOverrides.get(uid) ?? [];
    const has = cur.includes(key);
    const next = has
      ? cur.filter(k => k !== key)
      : ALL_SERVICE_KEYS.filter(k => cur.includes(k) || k === key);
    setOverride(uid, next);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(u =>
      [u.username, u.nameAr, u.nameEn].some(v => v && String(v).toLowerCase().includes(q)),
    );
  }, [users, search]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${apiBase}/api/pos-terminals/${terminal.id}/users`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          users: Array.from(selected).map(uid => ({
            userId: uid,
            enabledServices: svcOverrides.get(uid) ?? null,
          })),
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || tr("usersSaveErr"));
      }
      toast({ title: tr("usersSaveOk") });
      onSaved();
    } catch (e: any) {
      toast({ title: tr("toastError"), description: e?.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir={isRtl ? "rtl" : "ltr"} className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            {tr("usersDialogTitle", { name: isRtl ? terminal.nameAr : (terminal.nameEn ?? terminal.nameAr) })}
          </DialogTitle>
          <DialogDescription>{tr("usersDialogDesc")}</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-2.5 text-muted-foreground pointer-events-none" />
          <Input
            className="ps-8"
            placeholder={tr("usersSearchPh")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-user-search"
          />
        </div>

        <div className="rounded-lg border max-h-[320px] overflow-y-auto divide-y">
          {loading ? (
            <div className="p-6 text-center text-muted-foreground text-sm inline-flex items-center gap-2 justify-center w-full">
              <Loader2 className="w-4 h-4 animate-spin" /> {tr("loading")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-sm">{tr("usersEmpty")}</div>
          ) : (
            filtered.map(u => {
              const checked = selected.has(u.id);
              const display = isRtl ? (u.nameAr ?? u.username) : (u.nameEn ?? u.nameAr ?? u.username);
              const override = svcOverrides.get(u.id) ?? null;
              const custom = override !== null;
              return (
                <div
                  key={u.id}
                  className={`px-3 py-2 ${checked ? "bg-primary/5" : ""}`}
                  data-testid={`row-user-${u.id}`}
                >
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox checked={checked} onCheckedChange={() => toggle(u.id)} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{display}</div>
                      <div className="text-[11px] font-mono text-muted-foreground truncate">
                        {u.username} · {u.role}
                      </div>
                    </div>
                    {checked && <Check className="w-4 h-4 text-primary" />}
                  </label>

                  {checked && (
                    <div className="mt-2 ms-7 rounded-md border bg-background/60 p-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-muted-foreground">
                          {isRtl ? "الخدمات الظاهرة" : "Visible services"}
                        </span>
                        <button
                          type="button"
                          className="text-[11px] text-primary hover:underline"
                          onClick={() => setOverride(u.id, custom ? null : [])}
                          data-testid={`btn-user-override-${u.id}`}
                        >
                          {custom
                            ? (isRtl ? "متابعة إعداد المحطة" : "Inherit terminal")
                            : (isRtl ? "تخصيص لهذا الكاشير" : "Customize")}
                        </button>
                      </div>
                      {!custom ? (
                        <p className="text-[11px] text-muted-foreground">
                          {isRtl
                            ? "يتبع الخدمات الافتراضية للمحطة."
                            : "Follows the terminal's default services."}
                        </p>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                          {SERVICE_OPTIONS.map((s) => (
                            <label
                              key={s.key}
                              className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted/50 cursor-pointer"
                              data-testid={`svc-user-${u.id}-${s.key}`}
                            >
                              <Checkbox
                                checked={(override ?? []).includes(s.key)}
                                onCheckedChange={() => toggleUserSvc(u.id, s.key)}
                              />
                              <span className="text-xs">{isRtl ? s.ar : s.en}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="text-[11px] text-muted-foreground bg-muted/30 border rounded-md px-2 py-1.5">
          {selected.size === 0
            ? tr("usersHintEmpty")
            : tr("usersHintCount", { count: selected.size })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{tr("cancel")}</Button>
          <Button onClick={save} disabled={saving || loading} data-testid="btn-save-users">
            {saving && <Loader2 className="w-4 h-4 me-1 animate-spin" />}
            {tr("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
