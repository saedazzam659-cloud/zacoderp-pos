/**
 * Developed Attendance & Time Management tabs (وثيقة تطوير شاشة الحضور والانصراف):
 *  - DailyBoard  : الحضور اليومي — engine-derived grid + stats cards + recalc
 *  - MovementsTab: السجل اليومي للحركات (dedupe-aware add/delete)
 *  - PermissionsTab: استئذان الخروج — request + approve/reject + balance
 *  - ViolationsTab: المخالفات فقط
 *  - ApprovalTab : اعتماد/قفل اليوم + الترحيل للرواتب (مرة واحدة لكل فترة)
 *
 * All derived numbers come from the backend engine which guarantees the
 * no-double-count rule (قاعدة 16) — the UI never re-computes buckets.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { attendancePlusApi } from "@/lib/attendancePlusApi";
import { employeesApi } from "@/lib/employeesApi";
import { fmtNum } from "@/lib/format";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  RefreshCw, Plus, Trash2, Loader2, CheckCircle2, XCircle, Lock, LockOpen,
  ShieldCheck, Send, AlertTriangle, Info,
} from "lucide-react";

const mm = (v: any) => (Number(v) > 0 ? String(v) : "—");
const hrs = (v: any) => (v != null && v !== "" && Number(v) !== 0 ? fmtNum(Number(v), 2) : "—");

function useTr() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`hrPages.attendancePlus.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => (isRtl ? (ar ?? en ?? "") : (en ?? ar ?? ""));
  return { tr, isRtl, pickName };
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const trA = (k: string) => t(`hrPages.attendance.${k}`) as string;
  const trP = (k: string) => t(`hrPages.attendancePlus.${k}`) as string;
  const map: Record<string, { label: string; cls: string }> = {
    present: { label: trA("statusPresent"), cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    absent: { label: trA("statusAbsent"), cls: "bg-rose-50 text-rose-700 border-rose-200" },
    leave: { label: trA("statusLeave"), cls: "bg-sky-50 text-sky-700 border-sky-200" },
    late: { label: trA("statusLate"), cls: "bg-amber-50 text-amber-700 border-amber-200" },
    weekend: { label: trA("statusWeekend"), cls: "bg-slate-50 text-slate-600 border-slate-200" },
    partial: { label: trP("statusPartial"), cls: "bg-orange-50 text-orange-700 border-orange-200" },
    exit_permission: { label: trP("statusPermission"), cls: "bg-violet-50 text-violet-700 border-violet-200" },
    official_holiday: { label: trP("statusHoliday"), cls: "bg-purple-50 text-purple-700 border-purple-200" },
  };
  const m = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
  return <Badge variant="outline" className={m.cls}>{m.label}</Badge>;
}

function LockedBanner() {
  const { tr } = useTr();
  return (
    <div className="rounded border border-amber-300 bg-amber-50 text-amber-800 text-xs p-2 flex items-center gap-2">
      <Lock className="size-3.5 shrink-0" /> {tr("lockedBanner")}
    </div>
  );
}

// ═══════════════════════ 1) الحضور اليومي ═══════════════════════

export function DailyBoard({ date }: { date: string }) {
  const { tr, pickName } = useTr();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<any>({
    queryKey: ["att-plus-day", date],
    queryFn: () => attendancePlusApi.day(date),
  });
  const recalc = useMutation({
    mutationFn: () => attendancePlusApi.recalc(date),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["att-plus-day"] });
      qc.invalidateQueries({ queryKey: ["attendance"] });
      toast({ title: tr("recalcDone", { count: r.updated }) });
    },
    onError: (e) => toast({ variant: "destructive", title: parseError(e) }),
  });

  const rows: any[] = data?.rows ?? [];
  const locked = data?.dayLock?.status === "locked";
  const stats = useMemo(() => {
    const s = { total: rows.length, present: 0, absent: 0, late: 0, leave: 0, permission: 0, work: 0, ot: 0, lateMin: 0 };
    for (const r of rows) {
      const a = r.attendance;
      if (!a) continue;
      if (["present", "late", "partial", "exit_permission"].includes(a.status)) s.present++;
      if (a.status === "absent") s.absent++;
      if (a.status === "leave") s.leave++;
      if (Number(a.lateMinutes) > 0) s.late++;
      if (Number(a.permissionPaidMinutes) + Number(a.permissionUnpaidMinutes) > 0) s.permission++;
      s.work += Number(a.netHours ?? a.workedHours ?? 0);
      s.ot += Number(a.overtimeHours ?? 0);
      s.lateMin += Number(a.lateMinutes ?? 0);
    }
    return s;
  }, [rows]);

  const cards: [string, any, string][] = [
    [tr("statTotal"), stats.total, "text-foreground"],
    [tr("statPresent"), stats.present, "text-emerald-700"],
    [tr("statAbsent"), stats.absent, "text-rose-700"],
    [tr("statLate"), stats.late, "text-amber-700"],
    [tr("statPermission"), stats.permission, "text-violet-700"],
    [tr("statWorkHours"), fmtNum(stats.work, 1), "text-foreground"],
    [tr("statOvertime"), fmtNum(stats.ot, 1), "text-emerald-700"],
    [tr("statLateHours"), fmtNum(stats.lateMin / 60, 1), "text-amber-700"],
  ];

  return (
    <div className="space-y-3">
      {locked && <LockedBanner />}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {cards.map(([label, val, cls]) => (
          <div key={label} className="rounded-lg border bg-card p-2 text-center">
            <div className={`text-lg font-bold tabular-nums ${cls}`}>{val}</div>
            <div className="text-[11px] text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => recalc.mutate()} disabled={recalc.isPending || locked} data-testid="btn-recalc">
          {recalc.isPending ? <Loader2 className="size-3.5 me-1 animate-spin" /> : <RefreshCw className="size-3.5 me-1" />}
          {tr("recalc")}
        </Button>
        <span className="text-[11px] text-muted-foreground flex items-center gap-1"><Info className="size-3" />{tr("engineTip")}</span>
      </div>
      <div className="rounded-lg border overflow-x-auto bg-card">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 uppercase">
            <tr>
              <th className="p-2 text-start">{tr("employee")}</th>
              <th className="p-2 text-start">{tr("colDept")}</th>
              <th className="p-2">{tr("colShift")}</th>
              <th className="p-2">{tr("colWorkStart")}</th>
              <th className="p-2">{tr("colWorkEnd")}</th>
              <th className="p-2">{tr("colFirstIn")}</th>
              <th className="p-2">{tr("colLastOut")}</th>
              <th className="p-2">{tr("colNet")}</th>
              <th className="p-2">{tr("colLate")}</th>
              <th className="p-2">{tr("colEarly")}</th>
              <th className="p-2">{tr("colPermission")}</th>
              <th className="p-2">{tr("colMissing")}</th>
              <th className="p-2">{tr("statOvertime")}</th>
              <th className="p-2">{tr("status")}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={14} className="p-4"><Skeleton className="h-12" /></td></tr>
            ) : rows.map((r) => {
              const a = r.attendance;
              const permMin = a ? Number(a.permissionPaidMinutes || 0) + Number(a.permissionUnpaidMinutes || 0) : r.permissionMinutes;
              return (
                <tr key={r.employee.id} className="border-t" data-testid={`board-row-${r.employee.id}`}>
                  <td className="p-2">
                    <div className="font-medium">{pickName(r.employee.nameAr)}</div>
                    <div className="text-[10px] text-muted-foreground">{r.employee.code}</div>
                  </td>
                  <td className="p-2 text-muted-foreground">{r.employee.department || "—"}</td>
                  <td className="p-2 text-center">{r.shiftName || "—"}</td>
                  <td className="p-2 text-center tabular-nums">{r.workStart || "—"}</td>
                  <td className="p-2 text-center tabular-nums">{r.workEnd || "—"}</td>
                  <td className="p-2 text-center tabular-nums">{a?.checkIn || "—"}</td>
                  <td className="p-2 text-center tabular-nums">{a?.checkOut || "—"}</td>
                  <td className="p-2 text-center tabular-nums font-medium">{hrs(a?.netHours ?? a?.workedHours)}</td>
                  <td className="p-2 text-center tabular-nums text-amber-700">{mm(a?.lateMinutes)}</td>
                  <td className="p-2 text-center tabular-nums text-orange-700">{mm(a?.earlyLeaveMinutes)}</td>
                  <td className="p-2 text-center tabular-nums text-violet-700">{mm(permMin)}</td>
                  <td className="p-2 text-center tabular-nums text-rose-700">{mm(a?.missingMinutes)}</td>
                  <td className="p-2 text-center tabular-nums text-emerald-700">{hrs(a?.overtimeHours)}</td>
                  <td className="p-2 text-center">{a ? <StatusBadge status={a.status} /> : <span className="text-muted-foreground">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════ 2) الحركات ═══════════════════════

export function MovementsTab({ date }: { date: string }) {
  const { tr, pickName, isRtl } = useTr();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [empFilter, setEmpFilter] = useState<string>("");
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ employeeId: "", time: "", type: "in", source: "manual", editReason: "" });

  const { data: employees = [] } = useQuery<any[]>({ queryKey: ["employees"], queryFn: () => employeesApi.list() });
  const activeEmps = useMemo(() => employees.filter((e: any) => e.status === "active"), [employees]);
  const { data: movements = [], isLoading } = useQuery<any[]>({
    queryKey: ["att-plus-movements", date, empFilter],
    queryFn: () => attendancePlusApi.movements({ date, employeeId: empFilter ? Number(empFilter) : undefined }),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["att-plus-movements"] });
    qc.invalidateQueries({ queryKey: ["att-plus-day"] });
    qc.invalidateQueries({ queryKey: ["attendance"] });
  };

  const addMut = useMutation({
    mutationFn: () => attendancePlusApi.addMovements([{ ...form, employeeId: Number(form.employeeId), date }]),
    onSuccess: (r: any) => {
      invalidate();
      if (r.duplicates > 0) toast({ variant: "destructive", title: tr("movementDuplicate") });
      else toast({ title: tr("movementAdded") });
      setAddOpen(false);
      setForm({ employeeId: "", time: "", type: "in", source: "manual", editReason: "" });
    },
    onError: (e) => toast({ variant: "destructive", title: parseError(e) }),
  });
  const delMut = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => attendancePlusApi.deleteMovement(id, reason),
    onSuccess: () => { invalidate(); toast({ title: tr("movementDeleted") }); },
    onError: (e) => toast({ variant: "destructive", title: parseError(e) }),
  });

  const SRC: Record<string, string> = { device: tr("srcDevice"), mobile: tr("srcMobile"), manual: tr("srcManual"), api: tr("srcApi"), other: tr("srcOther") };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={empFilter} onChange={(e) => setEmpFilter(e.target.value)} className="h-9 rounded border bg-background px-2 text-sm" data-testid="mov-emp-filter">
          <option value="">{tr("allEmployees")}</option>
          {activeEmps.map((e: any) => <option key={e.id} value={e.id}>{pickName(e.nameAr, e.nameEn)}</option>)}
        </select>
        <div className="ms-auto">
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="btn-add-movement"><Plus className="size-3.5 me-1" />{tr("addMovement")}</Button>
        </div>
      </div>
      <div className="rounded-lg border overflow-x-auto bg-card">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 uppercase">
            <tr>
              <th className="p-2 text-start">{tr("employee")}</th>
              <th className="p-2">{tr("colTime")}</th>
              <th className="p-2">{tr("colType")}</th>
              <th className="p-2">{tr("colSource")}</th>
              <th className="p-2">{tr("colPermission")}</th>
              <th className="p-2 text-start">{tr("colReason")}</th>
              <th className="p-2">{tr("colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="p-4"><Skeleton className="h-10" /></td></tr>
            ) : movements.length === 0 ? (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">{tr("noMovements")}</td></tr>
            ) : movements.map((m: any) => (
              <tr key={m.id} className="border-t" data-testid={`mov-row-${m.id}`}>
                <td className="p-2">
                  <div className="font-medium">{pickName(m.empNameAr)}</div>
                  <div className="text-[10px] text-muted-foreground">{m.empCode}</div>
                </td>
                <td className="p-2 text-center tabular-nums font-medium">{m.time}</td>
                <td className="p-2 text-center">
                  {m.type === "in"
                    ? <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">{tr("typeIn")}</Badge>
                    : <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">{tr("typeOut")}</Badge>}
                </td>
                <td className="p-2 text-center text-muted-foreground">{SRC[m.source] ?? m.source}</td>
                <td className="p-2 text-center">{m.exitPermissionId ? <Badge variant="outline" className="bg-violet-50 text-violet-700 border-violet-200">#{m.exitPermissionId}</Badge> : "—"}</td>
                <td className="p-2 text-muted-foreground">{m.editReason || "—"}</td>
                <td className="p-2 text-center">
                  <button
                    onClick={() => {
                      const reason = window.prompt(tr("deleteReasonPrompt"));
                      if (reason?.trim()) delMut.mutate({ id: m.id, reason: reason.trim() });
                    }}
                    className="text-rose-500 hover:text-rose-700" data-testid={`mov-del-${m.id}`}>
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader><DialogTitle>{tr("addMovement")} — {date}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <select value={form.employeeId} onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
              className="h-9 w-full rounded border bg-background px-2 text-sm" data-testid="mov-form-emp">
              <option value="">{tr("employee")}…</option>
              {activeEmps.map((e: any) => <option key={e.id} value={e.id}>{pickName(e.nameAr, e.nameEn)}</option>)}
            </select>
            <div className="grid grid-cols-3 gap-2">
              <Input type="time" value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} data-testid="mov-form-time" />
              <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} className="h-9 rounded border bg-background px-2 text-sm">
                <option value="in">{tr("typeIn")}</option>
                <option value="out">{tr("typeOut")}</option>
              </select>
              <select value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} className="h-9 rounded border bg-background px-2 text-sm">
                <option value="manual">{tr("srcManual")}</option>
                <option value="device">{tr("srcDevice")}</option>
                <option value="mobile">{tr("srcMobile")}</option>
                <option value="api">{tr("srcApi")}</option>
                <option value="other">{tr("srcOther")}</option>
              </select>
            </div>
            <Input value={form.editReason} onChange={(e) => setForm((f) => ({ ...f, editReason: e.target.value }))} placeholder={tr("colReason")} />
          </div>
          <DialogFooter>
            <Button onClick={() => addMut.mutate()} disabled={!form.employeeId || !form.time || addMut.isPending} data-testid="mov-form-save">
              {addMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Plus className="size-4 me-1" />}
              {tr("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════ 3) الاستئذانات ═══════════════════════

export function PermissionsTab({ date }: { date: string }) {
  const { tr, pickName, isRtl } = useTr();
  const { toast } = useToast();
  const qc = useQueryClient();
  const month = date.slice(0, 7);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ employeeId: "", startTime: "", endTime: "", permissionType: "personal", paid: true, reason: "" });
  const [decideNote, setDecideNote] = useState("");

  const { data: employees = [] } = useQuery<any[]>({ queryKey: ["employees"], queryFn: () => employeesApi.list() });
  const activeEmps = useMemo(() => employees.filter((e: any) => e.status === "active"), [employees]);
  const { data: perms = [], isLoading } = useQuery<any[]>({
    queryKey: ["att-plus-perms", month],
    queryFn: () => attendancePlusApi.permissions({ from: `${month}-01`, to: `${month}-31` }),
  });
  const { data: balance } = useQuery<any>({
    queryKey: ["att-plus-perm-balance", form.employeeId, month],
    queryFn: () => attendancePlusApi.permissionBalance(Number(form.employeeId), month),
    enabled: addOpen && !!form.employeeId,
  });

  const minutes = useMemo(() => {
    if (!form.startTime || !form.endTime || form.endTime <= form.startTime) return 0;
    const [h1, m1] = form.startTime.split(":").map(Number);
    const [h2, m2] = form.endTime.split(":").map(Number);
    return h2 * 60 + m2 - (h1 * 60 + m1);
  }, [form.startTime, form.endTime]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["att-plus-perms"] });
    qc.invalidateQueries({ queryKey: ["att-plus-perm-balance"] });
    qc.invalidateQueries({ queryKey: ["att-plus-day"] });
    qc.invalidateQueries({ queryKey: ["attendance"] });
  };
  const addMut = useMutation({
    mutationFn: () => attendancePlusApi.addPermission({ ...form, employeeId: Number(form.employeeId), date }),
    onSuccess: () => {
      invalidate(); toast({ title: tr("permissionSaved") }); setAddOpen(false);
      setForm({ employeeId: "", startTime: "", endTime: "", permissionType: "personal", paid: true, reason: "" });
    },
    onError: (e) => toast({ variant: "destructive", title: parseError(e) }),
  });
  const decideMut = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "approve" | "reject" | "cancel" }) =>
      attendancePlusApi.decidePermission(id, decision, decideNote || undefined),
    onSuccess: () => { invalidate(); toast({ title: tr("permissionDecided") }); setDecideNote(""); },
    onError: (e) => toast({ variant: "destructive", title: parseError(e) }),
  });

  const PSTATUS: Record<string, { label: string; cls: string }> = {
    draft: { label: tr("permStatusDraft"), cls: "bg-slate-50 text-slate-600 border-slate-200" },
    pending: { label: tr("permStatusPending"), cls: "bg-amber-50 text-amber-700 border-amber-200" },
    approved: { label: tr("permStatusApproved"), cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    rejected: { label: tr("permStatusRejected"), cls: "bg-rose-50 text-rose-700 border-rose-200" },
    cancelled: { label: tr("permStatusCancelled"), cls: "bg-slate-50 text-slate-500 border-slate-200" },
    expired: { label: tr("permStatusExpired"), cls: "bg-slate-50 text-slate-500 border-slate-200" },
  };
  const PTYPE: Record<string, string> = {
    personal: tr("permTypePersonal"), official: tr("permTypeOfficial"), medical: tr("permTypeMedical"), other: tr("permTypeOther"),
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input value={decideNote} onChange={(e) => setDecideNote(e.target.value)} placeholder={tr("decisionNote")} className="h-9 max-w-xs text-xs" data-testid="perm-decide-note" />
        <div className="ms-auto">
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="btn-add-permission"><Plus className="size-3.5 me-1" />{tr("addPermission")}</Button>
        </div>
      </div>
      <div className="rounded-lg border overflow-x-auto bg-card">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 uppercase">
            <tr>
              <th className="p-2 text-start">{tr("employee")}</th>
              <th className="p-2">{tr("colDate")}</th>
              <th className="p-2">{tr("permStart")}</th>
              <th className="p-2">{tr("permEnd")}</th>
              <th className="p-2">{tr("colMinutes")}</th>
              <th className="p-2">{tr("colType")}</th>
              <th className="p-2">{tr("colPaid")}</th>
              <th className="p-2 text-start">{tr("colReason")}</th>
              <th className="p-2">{tr("status")}</th>
              <th className="p-2">{tr("colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={10} className="p-4"><Skeleton className="h-10" /></td></tr>
            ) : perms.length === 0 ? (
              <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">{tr("noPermissions")}</td></tr>
            ) : perms.map((p: any) => {
              const st = PSTATUS[p.status] ?? PSTATUS.pending;
              return (
                <tr key={p.id} className="border-t" data-testid={`perm-row-${p.id}`}>
                  <td className="p-2">
                    <div className="font-medium">{pickName(p.empNameAr)}</div>
                    <div className="text-[10px] text-muted-foreground">{p.empCode}</div>
                  </td>
                  <td className="p-2 text-center tabular-nums">{p.date}</td>
                  <td className="p-2 text-center tabular-nums">{p.startTime}</td>
                  <td className="p-2 text-center tabular-nums">{p.endTime}</td>
                  <td className="p-2 text-center tabular-nums font-medium">{p.minutes}</td>
                  <td className="p-2 text-center">{PTYPE[p.permissionType] ?? p.permissionType}</td>
                  <td className="p-2 text-center">{p.paid ? <CheckCircle2 className="size-3.5 text-emerald-600 inline" /> : <XCircle className="size-3.5 text-rose-500 inline" />}</td>
                  <td className="p-2 text-muted-foreground">{p.reason || "—"}</td>
                  <td className="p-2 text-center"><Badge variant="outline" className={st.cls}>{st.label}</Badge></td>
                  <td className="p-2">
                    {["draft", "pending"].includes(p.status) && (
                      <div className="flex items-center gap-1 justify-center">
                        <Button variant="outline" size="sm" className="h-6 px-2 text-[10px] text-emerald-700"
                          onClick={() => decideMut.mutate({ id: p.id, decision: "approve" })} disabled={decideMut.isPending} data-testid={`perm-approve-${p.id}`}>
                          {tr("approve")}
                        </Button>
                        <Button variant="outline" size="sm" className="h-6 px-2 text-[10px] text-rose-700"
                          onClick={() => decideMut.mutate({ id: p.id, decision: "reject" })} disabled={decideMut.isPending} data-testid={`perm-reject-${p.id}`}>
                          {tr("reject")}
                        </Button>
                      </div>
                    )}
                    {p.status === "approved" && (
                      <Button variant="outline" size="sm" className="h-6 px-2 text-[10px] text-slate-600 mx-auto block"
                        onClick={() => decideMut.mutate({ id: p.id, decision: "cancel" })} disabled={decideMut.isPending} data-testid={`perm-cancel-${p.id}`}>
                        {tr("cancelReq")}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader><DialogTitle>{tr("addPermission")} — {date}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <select value={form.employeeId} onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
              className="h-9 w-full rounded border bg-background px-2 text-sm" data-testid="perm-form-emp">
              <option value="">{tr("employee")}…</option>
              {activeEmps.map((e: any) => <option key={e.id} value={e.id}>{pickName(e.nameAr, e.nameEn)}</option>)}
            </select>
            {balance && (
              <div className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded p-2">
                {balance.monthlyMinutes == null
                  ? tr("permBalanceUnlimited", { used: balance.usedMinutes })
                  : tr("permBalance", { used: balance.usedMinutes, total: balance.monthlyMinutes })}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground">{tr("permStart")}</label>
                <Input type="time" value={form.startTime} onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))} data-testid="perm-form-start" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{tr("permEnd")}</label>
                <Input type="time" value={form.endTime} onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))} data-testid="perm-form-end" />
              </div>
            </div>
            {minutes > 0 && <div className="text-xs text-muted-foreground">{tr("permDuration", { m: minutes })}</div>}
            <div className="grid grid-cols-2 gap-2">
              <select value={form.permissionType} onChange={(e) => setForm((f) => ({ ...f, permissionType: e.target.value }))} className="h-9 rounded border bg-background px-2 text-sm">
                <option value="personal">{tr("permTypePersonal")}</option>
                <option value="official">{tr("permTypeOfficial")}</option>
                <option value="medical">{tr("permTypeMedical")}</option>
                <option value="other">{tr("permTypeOther")}</option>
              </select>
              <select value={form.paid ? "1" : "0"} onChange={(e) => setForm((f) => ({ ...f, paid: e.target.value === "1" }))} className="h-9 rounded border bg-background px-2 text-sm">
                <option value="1">{tr("permPaid")}</option>
                <option value="0">{tr("permUnpaid")}</option>
              </select>
            </div>
            <Textarea rows={2} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder={tr("colReason")} className="text-sm" />
          </div>
          <DialogFooter>
            <Button onClick={() => addMut.mutate()} disabled={!form.employeeId || minutes <= 0 || addMut.isPending} data-testid="perm-form-save">
              {addMut.isPending ? <Loader2 className="size-4 me-1 animate-spin" /> : <Send className="size-4 me-1" />}
              {tr("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════ 4) المخالفات ═══════════════════════

export function ViolationsTab({ date }: { date: string }) {
  const { tr, pickName } = useTr();
  const [from, setFrom] = useState(date.slice(0, 7) + "-01");
  const [to, setTo] = useState(date);
  const { data: rows = [], isLoading } = useQuery<any[]>({
    queryKey: ["att-plus-violations", from, to],
    queryFn: () => attendancePlusApi.violations(from, to),
  });
  const VIO: Record<string, { label: string; cls: string }> = {
    absent: { label: tr("vioAbsent"), cls: "bg-rose-50 text-rose-700 border-rose-200" },
    late: { label: tr("vioLate"), cls: "bg-amber-50 text-amber-700 border-amber-200" },
    early_leave: { label: tr("vioEarly"), cls: "bg-orange-50 text-orange-700 border-orange-200" },
    missing_hours: { label: tr("vioMissingHours"), cls: "bg-rose-50 text-rose-600 border-rose-200" },
    missing_in: { label: tr("vioMissingIn"), cls: "bg-slate-100 text-slate-700 border-slate-300" },
    missing_out: { label: tr("vioMissingOut"), cls: "bg-slate-100 text-slate-700 border-slate-300" },
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground text-xs">{tr("fromDate")}</span>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-36" data-testid="vio-from" />
        <span className="text-muted-foreground text-xs">{tr("toDate")}</span>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-36" data-testid="vio-to" />
      </div>
      <div className="rounded-lg border overflow-x-auto bg-card">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 uppercase">
            <tr>
              <th className="p-2 text-start">{tr("employee")}</th>
              <th className="p-2">{tr("colDate")}</th>
              <th className="p-2">{tr("colFirstIn")}</th>
              <th className="p-2">{tr("colLastOut")}</th>
              <th className="p-2">{tr("colLate")}</th>
              <th className="p-2">{tr("colEarly")}</th>
              <th className="p-2">{tr("colMissing")}</th>
              <th className="p-2 text-start">{tr("tabViolations")}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={8} className="p-4"><Skeleton className="h-10" /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">{tr("noViolations")}</td></tr>
            ) : rows.map((r: any) => (
              <tr key={r.id} className="border-t" data-testid={`vio-row-${r.id}`}>
                <td className="p-2">
                  <div className="font-medium">{pickName(r.empNameAr)}</div>
                  <div className="text-[10px] text-muted-foreground">{r.empCode} · {r.department || ""}</div>
                </td>
                <td className="p-2 text-center tabular-nums">{r.date}</td>
                <td className="p-2 text-center tabular-nums">{r.checkIn || "—"}</td>
                <td className="p-2 text-center tabular-nums">{r.checkOut || "—"}</td>
                <td className="p-2 text-center tabular-nums text-amber-700">{mm(r.lateMinutes)}</td>
                <td className="p-2 text-center tabular-nums text-orange-700">{mm(r.earlyLeaveMinutes)}</td>
                <td className="p-2 text-center tabular-nums text-rose-700">{mm(r.missingMinutes)}</td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1">
                    {r.violations.map((v: string) => {
                      const m = VIO[v]; if (!m) return null;
                      return <Badge key={v} variant="outline" className={m.cls}><AlertTriangle className="size-2.5 me-0.5" />{m.label}</Badge>;
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════ 5) الاعتماد والقفل والترحيل ═══════════════════════

export function ApprovalTab({ date }: { date: string }) {
  const { tr } = useTr();
  const { toast } = useToast();
  const qc = useQueryClient();
  const month = date.slice(0, 7);

  const { data: locks = [] } = useQuery<any[]>({
    queryKey: ["att-plus-locks", month],
    queryFn: () => attendancePlusApi.dayLocks(`${month}-01`, `${month}-31`),
  });
  const { data: transfers = [] } = useQuery<any[]>({
    queryKey: ["att-plus-transfers"],
    queryFn: () => attendancePlusApi.transfers(),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["att-plus-locks"] });
    qc.invalidateQueries({ queryKey: ["att-plus-transfers"] });
    qc.invalidateQueries({ queryKey: ["att-plus-day"] });
  };
  const lockMut = useMutation({
    mutationFn: (status: "approved" | "locked") => attendancePlusApi.setDayLock(date, status),
    onSuccess: () => { invalidate(); toast({ title: tr("dayLockDone") }); },
    onError: (e) => toast({ variant: "destructive", title: parseError(e) }),
  });
  const reopenMut = useMutation({
    mutationFn: () => attendancePlusApi.reopenDay(date),
    onSuccess: () => { invalidate(); toast({ title: tr("dayReopenDone") }); },
    onError: (e) => toast({ variant: "destructive", title: parseError(e) }),
  });
  const transferMut = useMutation({
    mutationFn: () => attendancePlusApi.transferPeriod(month),
    onSuccess: () => { invalidate(); toast({ title: tr("transferDone") }); },
    onError: (e) => toast({ variant: "destructive", title: parseError(e) }),
  });

  const todayLock = locks.find((l: any) => l.date === date);
  const lockState = todayLock?.status === "locked" ? tr("dayLocked") : todayLock ? tr("dayApproved") : tr("dayOpen");
  const transferred = transfers.some((t: any) => t.period === month);

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <span className="font-semibold text-sm">{date}</span>
          <Badge variant="outline" className={todayLock?.status === "locked" ? "bg-rose-50 text-rose-700 border-rose-200" : todayLock ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-50 text-slate-600 border-slate-200"}>
            {lockState}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => lockMut.mutate("approved")} disabled={lockMut.isPending} data-testid="btn-day-approve">
            <CheckCircle2 className="size-3.5 me-1 text-emerald-600" />{tr("dayApprove")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => lockMut.mutate("locked")} disabled={lockMut.isPending} data-testid="btn-day-lock">
            <Lock className="size-3.5 me-1 text-rose-600" />{tr("dayLock")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => reopenMut.mutate()} disabled={reopenMut.isPending || !todayLock} data-testid="btn-day-reopen">
            <LockOpen className="size-3.5 me-1" />{tr("dayReopen")}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="font-semibold text-sm">{tr("transferTitle")}</div>
        <div className="text-xs text-muted-foreground">{tr("transferOnce")}</div>
        <Button size="sm" onClick={() => transferMut.mutate()} disabled={transferMut.isPending || transferred} data-testid="btn-transfer">
          {transferMut.isPending ? <Loader2 className="size-3.5 me-1 animate-spin" /> : <Send className="size-3.5 me-1" />}
          {tr("transferBtn", { period: month })}
        </Button>
        {transfers.length > 0 && (
          <table className="w-full text-xs mt-2">
            <thead className="bg-muted/40 uppercase">
              <tr>
                <th className="p-1.5 text-start">{tr("transferredPeriods")}</th>
                <th className="p-1.5">{tr("employeesCount")}</th>
                <th className="p-1.5">{tr("transferredAt")}</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((t: any) => (
                <tr key={t.id} className="border-t">
                  <td className="p-1.5 font-medium tabular-nums">{t.period}</td>
                  <td className="p-1.5 text-center tabular-nums">{(() => { try { return JSON.parse(t.summary || "[]").length; } catch { return "—"; } })()}</td>
                  <td className="p-1.5 text-center tabular-nums">{String(t.createdAt).slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
