import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { employeesApi } from "@/lib/employeesApi";
import { parseError } from "@/lib/parseError";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ArrowRight, ArrowLeft, FileSignature, Plus, Pencil, Trash2, RefreshCcw,
  Sparkles, Loader2, CalendarDays, UserCog,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const EMPTY_CONTRACT: any = {
  contractNumber: "", contractType: "fixed",
  startDate: new Date().toISOString().slice(0, 10),
  endDate: "",
  basicSalary: 0, housingAllow: 0, transportAllow: 0, otherAllow: 0,
  workingHours: 8, probationDays: 90, noticePeriod: 60, vacationDays: 21,
  terms: "", notes: "", status: "active",
};

const EMPTY_LEAVE: any = {
  leaveType: "annual",
  startDate: new Date().toISOString().slice(0, 10),
  endDate: new Date().toISOString().slice(0, 10),
  days: 1, paid: true, reason: "",
};

export default function EmployeeContracts() {
  const [, params] = useRoute("/hr/employees/:id/contracts");
  const empId = Number(params?.id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`hrPages.contracts.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const STATUS_CFG: Record<string, { label: string; cls: string }> = {
    active:  { label: tr("stActive"),  cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    expired: { label: tr("stExpired"), cls: "bg-rose-50 text-rose-700 border-rose-200" },
    renewed: { label: tr("stRenewed"), cls: "bg-sky-50 text-sky-700 border-sky-200" },
    draft:   { label: tr("stDraft"),   cls: "bg-amber-50 text-amber-700 border-amber-200" },
  };

  const LEAVE_LABEL: Record<string, string> = {
    annual:      tr("leaveAnnual"),
    sick:        tr("leaveSick"),
    marriage:    tr("leaveMarriage"),
    bereavement: tr("leaveBereavement"),
    paternity:   tr("leavePaternity"),
    maternity:   tr("leaveMaternity"),
    hajj:        tr("leaveHajj"),
    study:       tr("leaveStudy"),
    unpaid:      tr("leaveUnpaid"),
  };

  const empQ = useQuery({ queryKey: ["employee", empId], queryFn: () => employeesApi.get(empId), enabled: !!empId });
  const contractsQ = useQuery({ queryKey: ["employee", empId, "contracts"], queryFn: () => employeesApi.contracts(empId), enabled: !!empId });
  const leavesQ = useQuery({ queryKey: ["employee", empId, "leaves"], queryFn: () => employeesApi.leaves(empId), enabled: !!empId });

  const [tab, setTab] = useState("contracts");
  const [showCForm, setShowCForm] = useState(false);
  const [editingC, setEditingC] = useState<any | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiReason, setAiReason] = useState("");

  const [showLForm, setShowLForm] = useState(false);
  const [editingL, setEditingL] = useState<any | null>(null);
  const [leaveAiBusy, setLeaveAiBusy] = useState(false);
  const [leaveAdvice, setLeaveAdvice] = useState("");

  const setCF = (k: string, v: any) => setEditingC((p: any) => ({ ...p, [k]: v }));
  const setLF = (k: string, v: any) => setEditingL((p: any) => ({ ...p, [k]: v }));

  const upsertContract = useMutation({
    mutationFn: (d: any) => editingC?.id
      ? employeesApi.updateContract(empId, editingC.id, d)
      : employeesApi.addContract(empId, d),
    onSuccess: () => {
      toast({ title: editingC?.id ? tr("toastContractUpdated") : tr("toastContractAdded") });
      qc.invalidateQueries({ queryKey: ["employee", empId, "contracts"] });
      qc.invalidateQueries({ queryKey: ["employees", "alerts"] });
      setShowCForm(false); setEditingC(null); setAiReason("");
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastError"), description: parseError(e) }),
  });

  const renewContract = useMutation({
    mutationFn: ({ id, d }: { id: number; d: any }) => employeesApi.renewContract(empId, id, d),
    onSuccess: () => {
      toast({ title: tr("toastContractRenewed") });
      qc.invalidateQueries({ queryKey: ["employee", empId, "contracts"] });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastError"), description: parseError(e) }),
  });

  const deleteContract = useMutation({
    mutationFn: (id: number) => employeesApi.deleteContract(empId, id),
    onSuccess: () => {
      toast({ title: tr("toastContractDeleted") });
      qc.invalidateQueries({ queryKey: ["employee", empId, "contracts"] });
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastError"), description: parseError(e) }),
  });

  const upsertLeave = useMutation({
    mutationFn: (d: any) => editingL?.id ? employeesApi.updateLeave(empId, editingL.id, d) : employeesApi.addLeave(empId, d),
    onSuccess: () => { toast({ title: editingL?.id ? tr("toastLeaveUpdated") : tr("toastLeaveAdded") }); qc.invalidateQueries({ queryKey: ["employee", empId, "leaves"] }); setShowLForm(false); setEditingL(null); setLeaveAdvice(""); },
    onError: (e) => toast({ variant: "destructive", title: tr("toastError"), description: parseError(e) }),
  });

  const deleteLeave = useMutation({
    mutationFn: (id: number) => employeesApi.deleteLeave(empId, id),
    onSuccess: () => { toast({ title: tr("toastContractDeleted") }); qc.invalidateQueries({ queryKey: ["employee", empId, "leaves"] }); },
  });

  const updateLeaveStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => employeesApi.updateLeave(empId, id, { status }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employee", empId, "leaves"] }); },
  });

  function openNewContract() {
    setEditingC({
      ...EMPTY_CONTRACT,
      basicSalary: empQ.data?.basicSalary || 0,
      housingAllow: empQ.data?.housingAllow || 0,
      transportAllow: empQ.data?.transportAllow || 0,
      otherAllow: empQ.data?.otherAllow || 0,
    });
    setAiReason(""); setShowCForm(true);
  }

  function openRenew(c: any) {
    const start = new Date().toISOString().slice(0, 10);
    const endD = new Date(); endD.setFullYear(endD.getFullYear() + 1);
    if (confirm(tr("renewConfirm", { n: c.contractNumber }))) {
      renewContract.mutate({ id: c.id, d: { startDate: start, endDate: endD.toISOString().slice(0, 10) } });
    }
  }

  async function suggestContract() {
    setAiBusy(true);
    try {
      const r = await employeesApi.aiSuggestContract({
        jobTitle: empQ.data?.jobTitle,
        nationality: empQ.data?.nationality,
        basicSalary: editingC.basicSalary || empQ.data?.basicSalary,
        contractType: editingC.contractType,
      });
      setEditingC((p: any) => ({
        ...p,
        basicSalary: r.basicSalary,
        housingAllow: r.housingAllow,
        transportAllow: r.transportAllow,
        otherAllow: r.otherAllow,
        workingHours: r.workingHours,
        probationDays: r.probationDays,
        noticePeriod: r.noticePeriod,
        vacationDays: r.vacationDays,
        terms: r.terms,
      }));
      setAiReason(r.reasoning || "");
      toast({ title: r.source === "ai" ? tr("toastAiAi") : tr("toastAiRule") });
    } catch (e) {
      toast({ variant: "destructive", title: tr("toastAiFailed"), description: parseError(e) });
    } finally { setAiBusy(false); }
  }

  async function suggestLeave() {
    setLeaveAiBusy(true);
    try {
      const r = await employeesApi.aiSuggestLeavePolicy({
        reason: editingL.reason,
        leaveType: editingL.leaveType,
        days: editingL.days,
      });
      setLF("leaveType", r.leaveType);
      setLF("paid", r.paid);
      setLeaveAdvice(r.advice || "");
      toast({ title: r.source === "ai" ? tr("toastAiClassifyAi") : tr("toastAiClassifyRule") });
    } catch (e) {
      toast({ variant: "destructive", title: tr("toastAiFailed"), description: parseError(e) });
    } finally { setLeaveAiBusy(false); }
  }

  if (empQ.isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;
  if (!empQ.data) return <div className="p-6 text-center text-muted-foreground">{tr("employeeNotFound")}</div>;

  const emp = empQ.data;
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const align = "text-start";
  const endAlign = "text-end";

  return (
    <div className="space-y-5 p-4 md:p-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center gap-3">
        <Link href="/hr/employees">
          <Button variant="ghost" size="sm" className="gap-1"><BackIcon className="h-4 w-4" /> {tr("back")}</Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <UserCog className="h-6 w-6 text-primary" /> {pickName(emp.nameAr, emp.nameEn)}
          </h1>
          <p className="text-xs text-muted-foreground">{emp.jobTitle || "—"} · {emp.code}</p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="contracts" className="gap-1.5"><FileSignature className="h-4 w-4" /> {tr("tabContracts")}</TabsTrigger>
          <TabsTrigger value="leaves" className="gap-1.5"><CalendarDays className="h-4 w-4" /> {tr("tabLeaves")}</TabsTrigger>
        </TabsList>

        <TabsContent value="contracts" className="space-y-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={openNewContract} className="gap-1.5"><Plus className="h-4 w-4" /> {tr("newContract")}</Button>
          </div>

          {showCForm && editingC && (
            <FormPanel
              icon={FileSignature}
              title={editingC.id ? tr("formEdit") : tr("formNew")}
              subtitle={tr("formSubtitle")}
              width="5xl"
              onClose={() => { setShowCForm(false); setEditingC(null); }}
              onSave={() => upsertContract.mutate(editingC)}
              saving={upsertContract.isPending}
              saveDisabled={!editingC.startDate}
            >
              <div className="mb-4 flex items-center justify-between gap-2">
                <div className="text-sm text-muted-foreground">
                  {tr("jobLabel")} <span className="font-medium text-foreground">{emp.jobTitle || tr("jobUnknown")}</span>
                </div>
                <Button onClick={suggestContract} disabled={aiBusy} className="gap-2 bg-purple-600 hover:bg-purple-700">
                  {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {tr("aiBtn")}
                </Button>
              </div>

              {aiReason && (
                <div className="mb-4 rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm text-purple-900 flex gap-2">
                  <Sparkles className="h-4 w-4 text-purple-600 mt-0.5 shrink-0" />
                  <span>{aiReason}</span>
                </div>
              )}

              <FormGrid>
                <Field label={tr("fContractNo")}><Input value={editingC.contractNumber} onChange={e => setCF("contractNumber", e.target.value)} placeholder={tr("fContractNoPh")} /></Field>
                <Field label={tr("fContractType")}>
                  <SearchCombobox
                    items={[
                      { value: "fixed",     label: tr("ctFixed") },
                      { value: "unlimited", label: tr("ctUnlimited") },
                    ]}
                    value={editingC.contractType}
                    onValueChange={(v) => setCF("contractType", v)}
                    placeholder={tr("fContractTypePh")}
                    className="w-full"
                  />
                </Field>
                <Field label={tr("fStartDate")} required><Input type="date" value={editingC.startDate} onChange={e => setCF("startDate", e.target.value)} /></Field>
                <Field label={tr("fEndDate")}><Input type="date" value={editingC.endDate || ""} onChange={e => setCF("endDate", e.target.value)} /></Field>
                <Field label={tr("fBasicSalary")}><Input type="number" min="0" value={editingC.basicSalary} onChange={e => setCF("basicSalary", e.target.value)} /></Field>
                <Field label={tr("fHousingAllow")}><Input type="number" min="0" value={editingC.housingAllow} onChange={e => setCF("housingAllow", e.target.value)} /></Field>
                <Field label={tr("fTransportAllow")}><Input type="number" min="0" value={editingC.transportAllow} onChange={e => setCF("transportAllow", e.target.value)} /></Field>
                <Field label={tr("fOtherAllow")}><Input type="number" min="0" value={editingC.otherAllow} onChange={e => setCF("otherAllow", e.target.value)} /></Field>
                <Field label={tr("fWorkingHours")}><Input type="number" min="0" value={editingC.workingHours} onChange={e => setCF("workingHours", Number(e.target.value))} /></Field>
                <Field label={tr("fProbationDays")}><Input type="number" min="0" value={editingC.probationDays} onChange={e => setCF("probationDays", Number(e.target.value))} /></Field>
                <Field label={tr("fNoticePeriod")}><Input type="number" min="0" value={editingC.noticePeriod} onChange={e => setCF("noticePeriod", Number(e.target.value))} /></Field>
                <Field label={tr("fVacationDays")}><Input type="number" min="0" value={editingC.vacationDays} onChange={e => setCF("vacationDays", Number(e.target.value))} /></Field>
                <Field label={tr("fTerms")} className="md:col-span-2"><Textarea rows={6} value={editingC.terms} onChange={e => setCF("terms", e.target.value)} placeholder={tr("fTermsPh")} /></Field>
                <Field label={tr("fNotes")} className="md:col-span-2"><Textarea rows={2} value={editingC.notes} onChange={e => setCF("notes", e.target.value)} /></Field>
              </FormGrid>

              <div className="mt-4 rounded-lg border bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground mb-1">{tr("monthlyTotal")}</div>
                <div className="text-lg font-bold text-emerald-700">
                  {(Number(editingC.basicSalary || 0) + Number(editingC.housingAllow || 0) + Number(editingC.transportAllow || 0) + Number(editingC.otherAllow || 0)).toLocaleString()} {tr("currencySAR")}
                </div>
              </div>
            </FormPanel>
          )}

          <div className="rounded-xl border bg-card overflow-hidden">
            {contractsQ.isLoading ? (
              <div className="p-6"><Skeleton className="h-20 w-full" /></div>
            ) : (contractsQ.data ?? []).length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                <FileSignature className="h-12 w-12 mx-auto mb-2 opacity-30" />
                <p>{tr("noContracts")}</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase">
                  <tr>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("colNo")}</th>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("colType")}</th>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("colFrom")}</th>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("colTo")}</th>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("colMonthlyTotal")}</th>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("colStatus")}</th>
                    <th className={`px-3 py-2.5 ${endAlign}`}>{tr("colActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(contractsQ.data ?? []).map((c: any) => {
                    const total = Number(c.basicSalary || 0) + Number(c.housingAllow || 0) + Number(c.transportAllow || 0) + Number(c.otherAllow || 0);
                    const st = STATUS_CFG[c.status] || STATUS_CFG.draft;
                    return (
                      <tr key={c.id} className="hover:bg-muted/30">
                        <td className="px-3 py-2.5 font-mono text-xs">{c.contractNumber}</td>
                        <td className="px-3 py-2.5 text-xs">{c.contractType === "fixed" ? tr("ctFixedShort") : tr("ctUnlimitedShort")}</td>
                        <td className="px-3 py-2.5 text-xs">{c.startDate}</td>
                        <td className="px-3 py-2.5 text-xs">{c.endDate || "—"}</td>
                        <td className="px-3 py-2.5 text-xs font-semibold">{total.toLocaleString()} {tr("currencySAR")}</td>
                        <td className="px-3 py-2.5"><Badge className={cn("border", st.cls)}>{st.label}</Badge></td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            {c.status === "active" && (
                              <Button size="sm" variant="ghost" onClick={() => openRenew(c)} className="h-8 px-2 gap-1 text-xs"><RefreshCcw className="h-3.5 w-3.5" /> {tr("renewBtn")}</Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => { setEditingC({ ...c }); setShowCForm(true); }} className="h-8 w-8 p-0"><Pencil className="h-3.5 w-3.5" /></Button>
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" onClick={() => { if (confirm(tr("deleteConfirm"))) deleteContract.mutate(c.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </TabsContent>

        <TabsContent value="leaves" className="space-y-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => { setEditingL({ ...EMPTY_LEAVE }); setLeaveAdvice(""); setShowLForm(true); }} className="gap-1.5">
              <Plus className="h-4 w-4" /> {tr("newRequest")}
            </Button>
          </div>

          {showLForm && editingL && (
            <FormPanel
              icon={CalendarDays}
              title={tr("leaveFormTitle")}
              subtitle={tr("leaveFormSubtitle")}
              width="3xl"
              onClose={() => { setShowLForm(false); setEditingL(null); }}
              onSave={() => upsertLeave.mutate(editingL)}
              saving={upsertLeave.isPending}
            >
              <FormGrid>
                <Field label={tr("fLeaveType")}>
                  <SearchCombobox
                    items={Object.entries(LEAVE_LABEL).map(([v, l]) => ({ value: v, label: l as string }))}
                    value={editingL.leaveType}
                    onValueChange={(v) => setLF("leaveType", v)}
                    placeholder={tr("fLeaveTypePh")}
                    searchPlaceholder={tr("leaveSearch")}
                    className="w-full"
                  />
                </Field>
                <Field label={tr("fPaid")}>
                  <SearchCombobox
                    items={[
                      { value: "1", label: tr("paidYes") },
                      { value: "0", label: tr("paidNo") },
                    ]}
                    value={editingL.paid ? "1" : "0"}
                    onValueChange={(v) => setLF("paid", v === "1")}
                    placeholder="—"
                    className="w-full"
                  />
                </Field>
                <Field label={tr("fLeaveStart")} required><Input type="date" value={editingL.startDate} onChange={e => { const v = e.target.value; setLF("startDate", v); const days = Math.max(1, Math.ceil((new Date(editingL.endDate).getTime() - new Date(v).getTime()) / 86400000) + 1); if (!isNaN(days)) setLF("days", days); }} /></Field>
                <Field label={tr("fLeaveEnd")} required><Input type="date" value={editingL.endDate} onChange={e => { const v = e.target.value; setLF("endDate", v); const days = Math.max(1, Math.ceil((new Date(v).getTime() - new Date(editingL.startDate).getTime()) / 86400000) + 1); if (!isNaN(days)) setLF("days", days); }} /></Field>
                <Field label={tr("fDays")}><Input type="number" min="1" value={editingL.days} onChange={e => setLF("days", Number(e.target.value))} /></Field>
                <Field label={tr("fReason")} className="md:col-span-2"><Textarea rows={3} value={editingL.reason} onChange={e => setLF("reason", e.target.value)} placeholder={tr("fReasonPh")} /></Field>
              </FormGrid>
              <div className="mt-3 flex items-center gap-2">
                <Button onClick={suggestLeave} disabled={leaveAiBusy} className="gap-2 bg-purple-600 hover:bg-purple-700" size="sm">
                  {leaveAiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {tr("aiClassifyBtn")}
                </Button>
              </div>
              {leaveAdvice && (
                <div className="mt-3 rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm text-purple-900 flex gap-2">
                  <Sparkles className="h-4 w-4 text-purple-600 mt-0.5 shrink-0" />
                  <span>{leaveAdvice}</span>
                </div>
              )}
            </FormPanel>
          )}

          <div className="rounded-xl border bg-card overflow-hidden">
            {leavesQ.isLoading ? (
              <div className="p-6"><Skeleton className="h-20 w-full" /></div>
            ) : (leavesQ.data ?? []).length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                <CalendarDays className="h-12 w-12 mx-auto mb-2 opacity-30" />
                <p>{tr("noLeaves")}</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase">
                  <tr>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("lvType")}</th>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("lvFrom")}</th>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("lvTo")}</th>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("lvDays")}</th>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("lvPaid")}</th>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("lvReason")}</th>
                    <th className={`px-3 py-2.5 ${align}`}>{tr("lvStatus")}</th>
                    <th className={`px-3 py-2.5 ${endAlign}`}>{tr("lvActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(leavesQ.data ?? []).map((l: any) => (
                    <tr key={l.id} className="hover:bg-muted/30">
                      <td className="px-3 py-2.5 text-xs">{LEAVE_LABEL[l.leaveType] || l.leaveType}</td>
                      <td className="px-3 py-2.5 text-xs">{l.startDate}</td>
                      <td className="px-3 py-2.5 text-xs">{l.endDate}</td>
                      <td className="px-3 py-2.5 text-xs">{l.days}</td>
                      <td className="px-3 py-2.5 text-xs">{l.paid ? tr("yes") : tr("no")}</td>
                      <td className="px-3 py-2.5 text-xs max-w-xs truncate">{l.reason || "—"}</td>
                      <td className="px-3 py-2.5">
                        <Badge className={cn("border",
                          l.status === "approved" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                          l.status === "rejected" ? "bg-rose-50 text-rose-700 border-rose-200" :
                          "bg-amber-50 text-amber-700 border-amber-200")}>
                          {l.status === "approved" ? tr("lvApproved") : l.status === "rejected" ? tr("lvRejected") : tr("lvPending")}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          {l.status === "pending" && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => updateLeaveStatus.mutate({ id: l.id, status: "approved" })} className="h-8 px-2 text-xs text-emerald-700">{tr("approveBtn")}</Button>
                              <Button size="sm" variant="ghost" onClick={() => updateLeaveStatus.mutate({ id: l.id, status: "rejected" })} className="h-8 px-2 text-xs text-rose-700">{tr("rejectBtn")}</Button>
                            </>
                          )}
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" onClick={() => { if (confirm(tr("deleteLeaveConfirm"))) deleteLeave.mutate(l.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
