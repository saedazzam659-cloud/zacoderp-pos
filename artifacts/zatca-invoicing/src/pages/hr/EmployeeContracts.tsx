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
  ArrowRight, FileSignature, Plus, Pencil, Trash2, RefreshCcw,
  Sparkles, Loader2, CalendarDays, CalendarClock, UserCog,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  active:  { label: "ساري",   cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  expired: { label: "منتهي",  cls: "bg-rose-50 text-rose-700 border-rose-200" },
  renewed: { label: "مجدد",   cls: "bg-sky-50 text-sky-700 border-sky-200" },
  draft:   { label: "مسودة",  cls: "bg-amber-50 text-amber-700 border-amber-200" },
};

const LEAVE_LABEL: Record<string, string> = {
  annual: "سنوية", sick: "مرضية", marriage: "زواج", bereavement: "وفاة",
  paternity: "ولادة (للأب)", maternity: "أمومة", hajj: "حج", study: "دراسية", unpaid: "بدون أجر",
};

export default function EmployeeContracts() {
  const [, params] = useRoute("/hr/employees/:id/contracts");
  const empId = Number(params?.id);
  const qc = useQueryClient();
  const { toast } = useToast();

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
      toast({ title: editingC?.id ? "تم تحديث العقد" : "تم إضافة العقد" });
      qc.invalidateQueries({ queryKey: ["employee", empId, "contracts"] });
      qc.invalidateQueries({ queryKey: ["employees", "alerts"] });
      setShowCForm(false); setEditingC(null); setAiReason("");
    },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  const renewContract = useMutation({
    mutationFn: ({ id, d }: { id: number; d: any }) => employeesApi.renewContract(empId, id, d),
    onSuccess: () => {
      toast({ title: "تم تجديد العقد" });
      qc.invalidateQueries({ queryKey: ["employee", empId, "contracts"] });
    },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  const deleteContract = useMutation({
    mutationFn: (id: number) => employeesApi.deleteContract(empId, id),
    onSuccess: () => {
      toast({ title: "تم الحذف" });
      qc.invalidateQueries({ queryKey: ["employee", empId, "contracts"] });
    },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  const upsertLeave = useMutation({
    mutationFn: (d: any) => editingL?.id ? employeesApi.updateLeave(empId, editingL.id, d) : employeesApi.addLeave(empId, d),
    onSuccess: () => { toast({ title: editingL?.id ? "تم التحديث" : "تم تسجيل الإجازة" }); qc.invalidateQueries({ queryKey: ["employee", empId, "leaves"] }); setShowLForm(false); setEditingL(null); setLeaveAdvice(""); },
    onError: (e) => toast({ variant: "destructive", title: "خطأ", description: parseError(e) }),
  });

  const deleteLeave = useMutation({
    mutationFn: (id: number) => employeesApi.deleteLeave(empId, id),
    onSuccess: () => { toast({ title: "تم الحذف" }); qc.invalidateQueries({ queryKey: ["employee", empId, "leaves"] }); },
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
    if (confirm(`تجديد العقد ${c.contractNumber}؟ سيتم أرشفة العقد الحالي وإنشاء عقد جديد لمدة سنة.`)) {
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
      toast({ title: r.source === "ai" ? "تم الاقتراح بالذكاء الاصطناعي" : "تم الاقتراح (نمطي)" });
    } catch (e) {
      toast({ variant: "destructive", title: "تعذّر الاقتراح", description: parseError(e) });
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
      toast({ title: r.source === "ai" ? "تم الاقتراح بالذكاء الاصطناعي" : "تم تصنيف الإجازة" });
    } catch (e) {
      toast({ variant: "destructive", title: "تعذّر الاقتراح", description: parseError(e) });
    } finally { setLeaveAiBusy(false); }
  }

  if (empQ.isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;
  if (!empQ.data) return <div className="p-6 text-center text-muted-foreground">الموظف غير موجود</div>;

  const emp = empQ.data;

  return (
    <div className="space-y-5 p-4 md:p-6" dir="rtl">
      <div className="flex items-center gap-3">
        <Link href="/hr/employees">
          <Button variant="ghost" size="sm" className="gap-1"><ArrowRight className="h-4 w-4" /> رجوع</Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <UserCog className="h-6 w-6 text-primary" /> {emp.nameAr}
          </h1>
          <p className="text-xs text-muted-foreground">{emp.jobTitle || "—"} · كود: {emp.code}</p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="contracts" className="gap-1.5"><FileSignature className="h-4 w-4" /> العقود</TabsTrigger>
          <TabsTrigger value="leaves" className="gap-1.5"><CalendarDays className="h-4 w-4" /> الإجازات</TabsTrigger>
        </TabsList>

        {/* CONTRACTS */}
        <TabsContent value="contracts" className="space-y-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={openNewContract} className="gap-1.5"><Plus className="h-4 w-4" /> عقد جديد</Button>
          </div>

          {showCForm && editingC && (
            <FormPanel
              icon={FileSignature}
              title={editingC.id ? "تعديل عقد" : "عقد جديد"}
              subtitle="استخدم زر الذكاء الاصطناعي لاقتراح بنود العقد والراتب وفق سوق العمل السعودي."
              width="5xl"
              onClose={() => { setShowCForm(false); setEditingC(null); }}
              onSave={() => upsertContract.mutate(editingC)}
              saving={upsertContract.isPending}
              saveDisabled={!editingC.startDate}
            >
              <div className="mb-4 flex items-center justify-between gap-2">
                <div className="text-sm text-muted-foreground">الوظيفة: <strong className="text-foreground">{emp.jobTitle || "غير محددة"}</strong></div>
                <Button onClick={suggestContract} disabled={aiBusy} className="gap-2 bg-purple-600 hover:bg-purple-700">
                  {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  اقتراح AI لبنود العقد
                </Button>
              </div>

              {aiReason && (
                <div className="mb-4 rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm text-purple-900 flex gap-2">
                  <Sparkles className="h-4 w-4 text-purple-600 mt-0.5 shrink-0" />
                  <span>{aiReason}</span>
                </div>
              )}

              <FormGrid>
                <Field label="رقم العقد"><Input value={editingC.contractNumber} onChange={e => setCF("contractNumber", e.target.value)} placeholder="تلقائي" /></Field>
                <Field label="نوع العقد">
                  <SearchCombobox
                    items={[
                      { value: "fixed", label: "محدد المدة" },
                      { value: "unlimited", label: "غير محدد المدة" },
                    ]}
                    value={editingC.contractType}
                    onValueChange={(v) => setCF("contractType", v)}
                    placeholder="نوع العقد"
                    className="w-full"
                  />
                </Field>
                <Field label="تاريخ البداية" required><Input type="date" value={editingC.startDate} onChange={e => setCF("startDate", e.target.value)} /></Field>
                <Field label="تاريخ النهاية"><Input type="date" value={editingC.endDate || ""} onChange={e => setCF("endDate", e.target.value)} /></Field>
                <Field label="الراتب الأساسي"><Input type="number" min="0" value={editingC.basicSalary} onChange={e => setCF("basicSalary", e.target.value)} /></Field>
                <Field label="بدل سكن"><Input type="number" min="0" value={editingC.housingAllow} onChange={e => setCF("housingAllow", e.target.value)} /></Field>
                <Field label="بدل انتقال"><Input type="number" min="0" value={editingC.transportAllow} onChange={e => setCF("transportAllow", e.target.value)} /></Field>
                <Field label="بدلات أخرى"><Input type="number" min="0" value={editingC.otherAllow} onChange={e => setCF("otherAllow", e.target.value)} /></Field>
                <Field label="ساعات العمل اليومية"><Input type="number" min="0" value={editingC.workingHours} onChange={e => setCF("workingHours", Number(e.target.value))} /></Field>
                <Field label="فترة التجربة (أيام)"><Input type="number" min="0" value={editingC.probationDays} onChange={e => setCF("probationDays", Number(e.target.value))} /></Field>
                <Field label="فترة الإشعار (أيام)"><Input type="number" min="0" value={editingC.noticePeriod} onChange={e => setCF("noticePeriod", Number(e.target.value))} /></Field>
                <Field label="الإجازة السنوية (أيام)"><Input type="number" min="0" value={editingC.vacationDays} onChange={e => setCF("vacationDays", Number(e.target.value))} /></Field>
                <Field label="بنود العقد" className="md:col-span-2"><Textarea rows={6} value={editingC.terms} onChange={e => setCF("terms", e.target.value)} placeholder="البنود الكاملة للعقد…" /></Field>
                <Field label="ملاحظات" className="md:col-span-2"><Textarea rows={2} value={editingC.notes} onChange={e => setCF("notes", e.target.value)} /></Field>
              </FormGrid>

              <div className="mt-4 rounded-lg border bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground mb-1">الإجمالي الشهري:</div>
                <div className="text-lg font-bold text-emerald-700">
                  {(Number(editingC.basicSalary || 0) + Number(editingC.housingAllow || 0) + Number(editingC.transportAllow || 0) + Number(editingC.otherAllow || 0)).toLocaleString()} ر.س
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
                <p>لا توجد عقود مسجلة. أنشئ العقد الأول.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase">
                  <tr>
                    <th className="px-3 py-2.5 text-start">رقم العقد</th>
                    <th className="px-3 py-2.5 text-start">النوع</th>
                    <th className="px-3 py-2.5 text-start">من</th>
                    <th className="px-3 py-2.5 text-start">إلى</th>
                    <th className="px-3 py-2.5 text-start">الإجمالي الشهري</th>
                    <th className="px-3 py-2.5 text-start">الحالة</th>
                    <th className="px-3 py-2.5 text-end">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(contractsQ.data ?? []).map((c: any) => {
                    const total = Number(c.basicSalary || 0) + Number(c.housingAllow || 0) + Number(c.transportAllow || 0) + Number(c.otherAllow || 0);
                    const st = STATUS_CFG[c.status] || STATUS_CFG.draft;
                    return (
                      <tr key={c.id} className="hover:bg-muted/30">
                        <td className="px-3 py-2.5 font-mono text-xs">{c.contractNumber}</td>
                        <td className="px-3 py-2.5 text-xs">{c.contractType === "fixed" ? "محدد" : "غير محدد"}</td>
                        <td className="px-3 py-2.5 text-xs">{c.startDate}</td>
                        <td className="px-3 py-2.5 text-xs">{c.endDate || "—"}</td>
                        <td className="px-3 py-2.5 text-xs font-semibold">{total.toLocaleString()} ر.س</td>
                        <td className="px-3 py-2.5"><Badge className={cn("border", st.cls)}>{st.label}</Badge></td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            {c.status === "active" && (
                              <Button size="sm" variant="ghost" onClick={() => openRenew(c)} className="h-8 px-2 gap-1 text-xs"><RefreshCcw className="h-3.5 w-3.5" /> تجديد</Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => { setEditingC({ ...c }); setShowCForm(true); }} className="h-8 w-8 p-0"><Pencil className="h-3.5 w-3.5" /></Button>
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" onClick={() => { if (confirm("حذف العقد؟")) deleteContract.mutate(c.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
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

        {/* LEAVES */}
        <TabsContent value="leaves" className="space-y-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => { setEditingL({ ...EMPTY_LEAVE }); setLeaveAdvice(""); setShowLForm(true); }} className="gap-1.5">
              <Plus className="h-4 w-4" /> طلب إجازة
            </Button>
          </div>

          {showLForm && editingL && (
            <FormPanel
              icon={CalendarDays}
              title="طلب إجازة"
              subtitle="اكتب السبب واطلب من الذكاء الاصطناعي تصنيف الإجازة وفق نظام العمل السعودي."
              width="3xl"
              onClose={() => { setShowLForm(false); setEditingL(null); }}
              onSave={() => upsertLeave.mutate(editingL)}
              saving={upsertLeave.isPending}
            >
              <FormGrid>
                <Field label="نوع الإجازة">
                  <SearchCombobox
                    items={Object.entries(LEAVE_LABEL).map(([v, l]) => ({ value: v, label: l as string }))}
                    value={editingL.leaveType}
                    onValueChange={(v) => setLF("leaveType", v)}
                    placeholder="نوع الإجازة"
                    searchPlaceholder="ابحث…"
                    className="w-full"
                  />
                </Field>
                <Field label="مدفوعة الأجر">
                  <SearchCombobox
                    items={[
                      { value: "1", label: "نعم — مدفوعة" },
                      { value: "0", label: "لا — بدون أجر" },
                    ]}
                    value={editingL.paid ? "1" : "0"}
                    onValueChange={(v) => setLF("paid", v === "1")}
                    placeholder="—"
                    className="w-full"
                  />
                </Field>
                <Field label="من تاريخ" required><Input type="date" value={editingL.startDate} onChange={e => { const v = e.target.value; setLF("startDate", v); const days = Math.max(1, Math.ceil((new Date(editingL.endDate).getTime() - new Date(v).getTime()) / 86400000) + 1); if (!isNaN(days)) setLF("days", days); }} /></Field>
                <Field label="إلى تاريخ" required><Input type="date" value={editingL.endDate} onChange={e => { const v = e.target.value; setLF("endDate", v); const days = Math.max(1, Math.ceil((new Date(v).getTime() - new Date(editingL.startDate).getTime()) / 86400000) + 1); if (!isNaN(days)) setLF("days", days); }} /></Field>
                <Field label="عدد الأيام"><Input type="number" min="1" value={editingL.days} onChange={e => setLF("days", Number(e.target.value))} /></Field>
                <Field label="السبب" className="md:col-span-2"><Textarea rows={3} value={editingL.reason} onChange={e => setLF("reason", e.target.value)} placeholder="مثال: مرض، زواج، حج…" /></Field>
              </FormGrid>
              <div className="mt-3 flex items-center gap-2">
                <Button onClick={suggestLeave} disabled={leaveAiBusy} className="gap-2 bg-purple-600 hover:bg-purple-700" size="sm">
                  {leaveAiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  تصنيف الإجازة بالذكاء الاصطناعي
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
                <p>لا توجد إجازات مسجلة.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase">
                  <tr>
                    <th className="px-3 py-2.5 text-start">النوع</th>
                    <th className="px-3 py-2.5 text-start">من</th>
                    <th className="px-3 py-2.5 text-start">إلى</th>
                    <th className="px-3 py-2.5 text-start">الأيام</th>
                    <th className="px-3 py-2.5 text-start">مدفوعة</th>
                    <th className="px-3 py-2.5 text-start">السبب</th>
                    <th className="px-3 py-2.5 text-start">الحالة</th>
                    <th className="px-3 py-2.5 text-end">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(leavesQ.data ?? []).map((l: any) => (
                    <tr key={l.id} className="hover:bg-muted/30">
                      <td className="px-3 py-2.5 text-xs">{LEAVE_LABEL[l.leaveType] || l.leaveType}</td>
                      <td className="px-3 py-2.5 text-xs">{l.startDate}</td>
                      <td className="px-3 py-2.5 text-xs">{l.endDate}</td>
                      <td className="px-3 py-2.5 text-xs">{l.days}</td>
                      <td className="px-3 py-2.5 text-xs">{l.paid ? "نعم" : "لا"}</td>
                      <td className="px-3 py-2.5 text-xs max-w-xs truncate">{l.reason || "—"}</td>
                      <td className="px-3 py-2.5">
                        <Badge className={cn("border",
                          l.status === "approved" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                          l.status === "rejected" ? "bg-rose-50 text-rose-700 border-rose-200" :
                          "bg-amber-50 text-amber-700 border-amber-200")}>
                          {l.status === "approved" ? "معتمدة" : l.status === "rejected" ? "مرفوضة" : "قيد الاعتماد"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          {l.status === "pending" && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => updateLeaveStatus.mutate({ id: l.id, status: "approved" })} className="h-8 px-2 text-xs text-emerald-700">اعتماد</Button>
                              <Button size="sm" variant="ghost" onClick={() => updateLeaveStatus.mutate({ id: l.id, status: "rejected" })} className="h-8 px-2 text-xs text-rose-700">رفض</Button>
                            </>
                          )}
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" onClick={() => { if (confirm("حذف الإجازة؟")) deleteLeave.mutate(l.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
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
