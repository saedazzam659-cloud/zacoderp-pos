import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MonitorSmartphone, Plus, Pencil, Trash2, Loader2, Building2,
  Cpu, Wifi, WifiOff, Unlink, Power, PowerOff, Search,
} from "lucide-react";
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

type Branch  = { id: number; nameAr: string; code?: string };
type CashBox = { id: number; nameAr: string; code?: string };
type Company = { id: number; nameAr: string };

type Terminal = {
  id:          number;
  code:        string;
  nameAr:      string;
  nameEn:      string | null;
  branchId:    number;
  branchName:  string | null;
  machineCode: string | null;
  cashBoxId:   number | null;
  cashBoxName: string | null;
  isActive:    boolean;
  notes:       string | null;
  busyUserId:  number | null;
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
};

const blankDraft: Draft = {
  code: "", nameAr: "", nameEn: "", branchId: "",
  machineCode: "", cashBoxId: "", isActive: true, notes: "",
};

export default function PosTerminals() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isSuperAdmin = user?.role === "superadmin";

  const [companyId, setCompanyId] = useState<number | null>(user?.companyId ?? null);
  useEffect(() => { if (user?.companyId) setCompanyId(user.companyId); }, [user?.companyId]);

  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Terminal | null>(null);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const cidQS = companyId ? `?companyId=${companyId}` : "";

  const companiesQ = useQuery<Company[]>({
    queryKey: ["pt-companies"],
    enabled: isSuperAdmin,
    queryFn: async () => {
      const r = await fetch(`${API}/api/companies`, { headers });
      if (!r.ok) throw new Error("فشل تحميل الشركات");
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
      if (!r.ok) throw new Error("فشل تحميل محطات البيع");
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
      };
      const url = d.id ? `${API}/api/pos-terminals/${d.id}` : `${API}/api/pos-terminals`;
      const r = await fetch(url, {
        method: d.id ? "PATCH" : "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || "فشل الحفظ");
      }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "تم حفظ محطة البيع" });
      qc.invalidateQueries({ queryKey: ["pt-terminals", companyId] });
      setEditing(null);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/pos-terminals/${id}`, { method: "DELETE", headers });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || "فشل الحذف");
      }
    },
    onSuccess: () => {
      toast({ title: "تم حذف محطة البيع" });
      qc.invalidateQueries({ queryKey: ["pt-terminals", companyId] });
      setConfirmDelete(null);
    },
    onError: (e: any) => toast({ title: "تعذّر الحذف", description: e?.message, variant: "destructive" }),
  });

  const unpairMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/pos-terminals/${id}/unpair`, { method: "POST", headers });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error || "فشل إلغاء الربط");
      }
    },
    onSuccess: () => {
      toast({ title: "تم إلغاء ربط الجهاز", description: "يمكن لأي جهاز جديد أن يربط نفسه بهذه المحطة عند الدخول التالي." });
      qc.invalidateQueries({ queryKey: ["pt-terminals", companyId] });
    },
    onError: (e: any) => toast({ title: "خطأ", description: e?.message, variant: "destructive" }),
  });

  const filtered = useMemo(() => {
    const items = terminalsQ.data ?? [];
    const q = search.trim().toLowerCase();
    return items.filter(t => {
      if (branchFilter !== "all" && String(t.branchId) !== branchFilter) return false;
      if (!q) return true;
      return [t.code, t.nameAr, t.nameEn, t.branchName, t.machineCode]
        .some(v => v && String(v).toLowerCase().includes(q));
    });
  }, [terminalsQ.data, branchFilter, search]);

  const totals = useMemo(() => {
    const items = terminalsQ.data ?? [];
    return {
      total:  items.length,
      active: items.filter(t => t.isActive).length,
      paired: items.filter(t => !!t.machineCode).length,
      busy:   items.filter(t => !!t.busyUserId).length,
    };
  }, [terminalsQ.data]);

  const openNew  = () => setEditing({ ...blankDraft });
  const openEdit = (t: Terminal) => setEditing({
    id: t.id, code: t.code, nameAr: t.nameAr, nameEn: t.nameEn ?? "",
    branchId: String(t.branchId), machineCode: t.machineCode ?? "",
    cashBoxId: t.cashBoxId ? String(t.cashBoxId) : "",
    isActive: t.isActive, notes: t.notes ?? "",
  });

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MonitorSmartphone className="w-6 h-6 text-primary" />
            محطات البيع (طرق البيع)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            عرّف لكل فرع محطات البيع المتاحة (كاشير، نافذة دليفري، آيباد…)، اربطها بمكينة فعلية وصندوق نقدي افتراضي. الكاشير يختارها عند تسجيل الدخول لنقاط البيع.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSuperAdmin && (
            <div className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-muted-foreground" />
              <Select value={companyId ? String(companyId) : ""} onValueChange={(v) => setCompanyId(Number(v))}>
                <SelectTrigger className="w-56" data-testid="select-company"><SelectValue placeholder="اختر شركة" /></SelectTrigger>
                <SelectContent>
                  {(companiesQ.data ?? []).map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.nameAr}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button onClick={openNew} disabled={!companyId} data-testid="btn-new-terminal">
            <Plus className="w-4 h-4 me-1" /> محطة بيع جديدة
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<MonitorSmartphone className="w-5 h-5" />} label="إجمالي المحطات" value={totals.total} color="bg-primary/10 text-primary" />
        <StatCard icon={<Power className="w-5 h-5" />}             label="مفعّلة"        value={totals.active} color="bg-emerald-100 text-emerald-700" />
        <StatCard icon={<Cpu className="w-5 h-5" />}                label="مرتبطة بمكينة" value={totals.paired} color="bg-blue-100 text-blue-700" />
        <StatCard icon={<Wifi className="w-5 h-5" />}               label="قيد الاستخدام" value={totals.busy}   color="bg-amber-100 text-amber-700" />
      </div>

      {/* Filter row */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-2.5 text-muted-foreground pointer-events-none" />
            <Input
              data-testid="input-search"
              className="ps-8"
              placeholder="بحث بالكود أو الاسم أو المكينة..."
              value={search} onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={branchFilter} onValueChange={setBranchFilter}>
            <SelectTrigger className="w-56" data-testid="select-branch-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الفروع</SelectItem>
              {(branchesQ.data ?? []).map(b => (
                <SelectItem key={b.id} value={String(b.id)}>{b.nameAr}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Inline editor — appears between the filter row and the grid */}
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
        <Card><CardContent className="p-10 text-center text-muted-foreground">اختر شركة للمتابعة</CardContent></Card>
      ) : terminalsQ.isLoading ? (
        <Card><CardContent className="p-10 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-primary" /></CardContent></Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground space-y-2">
            <MonitorSmartphone className="w-10 h-10 mx-auto opacity-40" />
            <div>لا توجد محطات بيع. أنشئ أول محطة الآن.</div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(t => (
            <TerminalCard
              key={t.id}
              t={t}
              onEdit={() => openEdit(t)}
              onDelete={() => setConfirmDelete(t)}
              onUnpair={() => unpairMut.mutate(t.id)}
              unpairing={unpairMut.isPending}
            />
          ))}
        </div>
      )}

      {/* Editor */}
      <TerminalEditor
        open={!!editing}
        draft={editing}
        branches={branchesQ.data ?? []}
        cashBoxes={cashBoxesQ.data ?? []}
        onClose={() => setEditing(null)}
        onChange={setEditing}
        onSave={() => editing && saveMut.mutate(editing)}
        saving={saveMut.isPending}
      />

      {/* Delete confirm */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>حذف محطة البيع</AlertDialogTitle>
            <AlertDialogDescription>
              سيتم حذف "{confirmDelete?.nameAr}" نهائيًا. هذا الإجراء لا يمكن التراجع عنه.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              data-testid="btn-confirm-delete"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => confirmDelete && deleteMut.mutate(confirmDelete.id)}
            >
              حذف
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
  t, onEdit, onDelete, onUnpair, unpairing,
}: {
  t: Terminal;
  onEdit: () => void;
  onDelete: () => void;
  onUnpair: () => void;
  unpairing: boolean;
}) {
  return (
    <Card data-testid={`card-terminal-${t.id}`} className={!t.isActive ? "opacity-70" : ""}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <Badge variant="outline" className="text-[11px] font-mono">{t.code}</Badge>
              {t.isActive ? (
                <Badge variant="outline" className="text-[11px] gap-1 border-emerald-200 bg-emerald-50 text-emerald-700">
                  <Power className="w-3 h-3" /> مفعّلة
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[11px] gap-1 border-slate-200 bg-slate-50 text-slate-600">
                  <PowerOff className="w-3 h-3" /> معطّلة
                </Badge>
              )}
              {t.busyUserId && (
                <Badge variant="outline" className="text-[11px] gap-1 border-amber-200 bg-amber-50 text-amber-700">
                  <Wifi className="w-3 h-3" /> قيد الاستخدام
                </Badge>
              )}
            </div>
            <div className="font-bold truncate">{t.nameAr}</div>
            {t.nameEn && <div className="text-xs text-muted-foreground truncate">{t.nameEn}</div>}
          </div>
        </div>

        <div className="text-sm space-y-1.5 border-t pt-2">
          <div className="flex items-center gap-2">
            <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">الفرع:</span>
            <span className="font-medium">{t.branchName ?? "—"}</span>
          </div>
          <div className="flex items-center gap-2">
            <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">المكينة:</span>
            {t.machineCode ? (
              <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded truncate" title={t.machineCode}>
                {t.machineCode.length > 16 ? `${t.machineCode.slice(0, 8)}…${t.machineCode.slice(-6)}` : t.machineCode}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <WifiOff className="w-3 h-3" /> غير مرتبطة (سيتم الربط عند أول دخول)
              </span>
            )}
          </div>
          {t.cashBoxName && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">الصندوق الافتراضي:</span>
              <span className="text-xs">{t.cashBoxName}</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 border-t pt-2">
          <Button size="sm" variant="outline" className="h-8" onClick={onEdit} data-testid={`btn-edit-${t.id}`}>
            <Pencil className="w-3.5 h-3.5 me-1" /> تعديل
          </Button>
          {t.machineCode && (
            <Button
              size="sm" variant="outline" className="h-8"
              onClick={onUnpair} disabled={unpairing}
              data-testid={`btn-unpair-${t.id}`}
            >
              <Unlink className="w-3.5 h-3.5 me-1" /> إلغاء الربط
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-8 text-destructive hover:text-destructive" onClick={onDelete} data-testid={`btn-delete-${t.id}`}>
            <Trash2 className="w-3.5 h-3.5 me-1" /> حذف
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
  const isNew = !draft.id;
  const valid = draft.nameAr.trim().length > 0 && !!draft.branchId;

  return (
    <Card className="border-primary/40 shadow-sm" dir="rtl">
      <CardContent className="p-4 md:p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 border-b pb-3">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <MonitorSmartphone className="w-5 h-5 text-primary" />
              {isNew ? "إضافة محطة بيع" : "تعديل محطة بيع"}
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              عرّف محطة بيع وحدّد فرعها. اترك حقل المكينة فارغًا ليتم ربطها تلقائيًا بأول جهاز يسجل الدخول عليها.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-muted-foreground">
            إغلاق
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="col-span-1">
            <Label className="text-xs">الكود</Label>
            <Input
              data-testid="input-code"
              placeholder="تلقائي"
              value={draft.code ?? ""}
              onChange={(e) => onChange({ ...draft, code: e.target.value })}
            />
          </div>
          <div className="col-span-1 flex items-end justify-end gap-2">
            <Label className="text-xs">مفعّلة</Label>
            <Switch
              checked={draft.isActive}
              onCheckedChange={(v) => onChange({ ...draft, isActive: v })}
              data-testid="switch-active"
            />
          </div>

          <div className="col-span-2">
            <Label className="text-xs">الاسم بالعربية *</Label>
            <Input
              data-testid="input-name-ar"
              placeholder="مثل: كاشير 1 / نافذة الدليفري"
              value={draft.nameAr}
              onChange={(e) => onChange({ ...draft, nameAr: e.target.value })}
            />
          </div>

          <div className="col-span-2">
            <Label className="text-xs">الاسم بالإنجليزية</Label>
            <Input
              data-testid="input-name-en"
              placeholder="Cashier 1"
              value={draft.nameEn}
              onChange={(e) => onChange({ ...draft, nameEn: e.target.value })}
            />
          </div>

          <div className="col-span-2">
            <Label className="text-xs">الفرع *</Label>
            <Select value={draft.branchId} onValueChange={(v) => onChange({ ...draft, branchId: v })}>
              <SelectTrigger data-testid="select-branch"><SelectValue placeholder="اختر فرعًا" /></SelectTrigger>
              <SelectContent>
                {branches.map(b => (
                  <SelectItem key={b.id} value={String(b.id)}>{b.nameAr}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="col-span-2">
            <Label className="text-xs">الصندوق النقدي الافتراضي</Label>
            <Select
              value={draft.cashBoxId || "none"}
              onValueChange={(v) => onChange({ ...draft, cashBoxId: v === "none" ? "" : v })}
            >
              <SelectTrigger data-testid="select-cashbox"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— بدون —</SelectItem>
                {cashBoxes.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.nameAr}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="col-span-2">
            <Label className="text-xs">كود المكينة (اختياري)</Label>
            <Input
              data-testid="input-machine-code"
              placeholder="اتركه فارغًا للربط التلقائي عند أول دخول"
              value={draft.machineCode}
              onChange={(e) => onChange({ ...draft, machineCode: e.target.value })}
              className="font-mono text-xs"
            />
          </div>

          <div className="col-span-2">
            <Label className="text-xs">ملاحظات</Label>
            <Input
              data-testid="input-notes"
              value={draft.notes}
              onChange={(e) => onChange({ ...draft, notes: e.target.value })}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t">
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={onSave} disabled={!valid || saving} data-testid="btn-save-terminal">
            {saving && <Loader2 className="w-4 h-4 me-1 animate-spin" />}
            حفظ
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
