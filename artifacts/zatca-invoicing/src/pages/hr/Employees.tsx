import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  Plus, Pencil, Trash2, Search, UserCog, BadgeAlert,
  Sparkles, FileSignature, Loader2, CheckCircle2, IdCard,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { DateField } from "@/components/ui/date-field";

const EMPTY: any = {
  code: "", nameAr: "", nameEn: "", idType: "iqama", idNumber: "",
  iqamaExpiry: "", passportNumber: "", passportExpiry: "",
  nationality: "", gender: "male", birthDate: "", mobile: "", email: "",
  hireDate: "", endDate: "", department: "", jobTitle: "",
  sponsor: "", profession: "", status: "active",
  basicSalary: 0, housingAllow: 0, transportAllow: 0, otherAllow: 0,
  bankAccountIban: "", bankName: "", notes: "",
};

function daysUntil(date?: string): number | null {
  if (!date) return null;
  return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
}

function ExpiryBadge({ date, tr }: { date?: string; tr: (k: string, opts?: any) => string }) {
  const d = daysUntil(date);
  if (d == null) return <span className="text-muted-foreground text-xs">—</span>;
  if (d < 0)   return <Badge className="bg-rose-100 text-rose-700 border border-rose-200 hover:bg-rose-100">{tr("expiredAgo", { n: Math.abs(d) })}</Badge>;
  if (d <= 30) return <Badge className="bg-rose-100 text-rose-700 border border-rose-200 hover:bg-rose-100">{tr("remainingDays", { n: d })}</Badge>;
  if (d <= 90) return <Badge className="bg-amber-100 text-amber-700 border border-amber-200 hover:bg-amber-100">{tr("remainingDays", { n: d })}</Badge>;
  return <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-50">{tr("remainingDays", { n: d })}</Badge>;
}

export default function Employees() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === "ar";
  const tr = (k: string, opts?: any) => t(`hrPages.employees.${k}`, opts) as string;
  const pickName = (ar?: string, en?: string) => isRtl ? (ar ?? en ?? "") : (en ?? ar ?? "");

  const STATUS: Record<string, { label: string; cls: string }> = {
    active:    { label: tr("statusActive"),     cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    suspended: { label: tr("statusSuspended"),  cls: "bg-amber-50 text-amber-700 border-amber-200" },
    vacation:  { label: tr("statusVacation"),   cls: "bg-sky-50 text-sky-700 border-sky-200" },
    terminated:{ label: tr("statusTerminated"), cls: "bg-rose-50 text-rose-700 border-rose-200" },
  };

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editing, setEditing] = useState<any | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formTab, setFormTab] = useState("info");

  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const empQ = useQuery({ queryKey: ["employees"], queryFn: employeesApi.list });
  const alertsQ = useQuery({ queryKey: ["employees", "alerts"], queryFn: employeesApi.alerts });

  const filtered = useMemo(() => {
    const list = empQ.data ?? [];
    return list.filter((e: any) => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (!search.trim()) return true;
      const s = search.trim().toLowerCase();
      return [e.code, e.nameAr, e.nameEn, e.idNumber, e.mobile, e.email, e.jobTitle]
        .some(v => v && String(v).toLowerCase().includes(s));
    });
  }, [empQ.data, search, statusFilter]);

  const upsert = useMutation({
    mutationFn: (d: any) => editing?.id ? employeesApi.update(editing.id, d) : employeesApi.create(d),
    onSuccess: () => {
      toast({ title: editing?.id ? tr("toastUpdated") : tr("toastAdded") });
      qc.invalidateQueries({ queryKey: ["employees"] });
      setShowForm(false); setEditing(null);
    },
    onError: (e) => toast({ variant: "destructive", title: tr("toastError"), description: parseError(e) }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => employeesApi.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employees"] }); toast({ title: tr("toastDeleted") }); },
    onError: (e) => toast({ variant: "destructive", title: tr("toastError"), description: parseError(e) }),
  });

  const openNew = () => { setEditing({ ...EMPTY }); setFormTab("info"); setAiText(""); setShowForm(true); };
  const openEdit = (e: any) => { setEditing({ ...EMPTY, ...e }); setFormTab("info"); setShowForm(true); };

  const setF = (k: string, v: any) => setEditing((p: any) => ({ ...p, [k]: v }));

  async function runAiParse() {
    if (!aiText.trim()) { toast({ variant: "destructive", title: tr("aiPasteFirst") }); return; }
    setAiBusy(true);
    try {
      const r = await employeesApi.aiParseId(aiText);
      const merged: any = { ...editing };
      let count = 0;
      for (const k of ["nameAr","nameEn","idType","idNumber","iqamaExpiry","nationality","profession","sponsor","mobile","birthDate","gender"]) {
        if (r[k]) { merged[k] = r[k]; count++; }
      }
      setEditing(merged);
      toast({
        title: r.source === "ai" ? tr("aiSuccessAi") : tr("aiSuccessRule"),
        description: tr("aiFilledN", { count }),
      });
    } catch (e) {
      toast({ variant: "destructive", title: tr("aiFailed"), description: parseError(e) });
    } finally {
      setAiBusy(false);
    }
  }

  const alerts = alertsQ.data ?? { expiringIqamas: [], expiringContracts: [], expiringPassports: [] };
  const totalAlerts = (alerts.expiringIqamas?.length ?? 0) + (alerts.expiringContracts?.length ?? 0) + (alerts.expiringPassports?.length ?? 0);

  const align = isRtl ? "text-right" : "text-left";

  return (
    <div className="space-y-5 p-4 md:p-6" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <UserCog className="h-6 w-6 text-primary" /> {tr("title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">{tr("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={openNew} className="gap-1.5">
            <Plus className="h-4 w-4" /> {tr("addEmployee")}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="employees" className="space-y-4">
        <TabsList>
          <TabsTrigger value="employees" className="gap-1.5"><UserCog className="h-4 w-4" /> {tr("tabEmployees")}</TabsTrigger>
          <TabsTrigger value="alerts" className="gap-1.5">
            <BadgeAlert className="h-4 w-4" /> {tr("tabAlerts")}
            {totalAlerts > 0 && <span className="ms-1 rounded-full bg-rose-500 text-white text-[10px] px-1.5 py-0.5">{totalAlerts}</span>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="employees" className="space-y-4">
          <div className="flex flex-col md:flex-row gap-2">
            <div className="relative flex-1">
              <Search className={`absolute ${isRtl ? "right-3" : "left-3"} top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground`} />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr("searchPh")} className={isRtl ? "pr-9" : "pl-9"} />
            </div>
            <div className="flex gap-1 flex-wrap">
              {[["all", tr("filterAll")], ["active", tr("statusActive")], ["vacation", tr("statusVacation")], ["suspended", tr("statusSuspended")], ["terminated", tr("statusTerminated")]].map(([v, l]) => (
                <Button key={v} size="sm" variant={statusFilter === v ? "default" : "outline"} onClick={() => setStatusFilter(v)}>{l}</Button>
              ))}
            </div>
          </div>

          {showForm && editing && (
            <FormPanel
              icon={UserCog}
              title={editing.id ? tr("formEdit", { name: pickName(editing.nameAr, editing.nameEn) }) : tr("formNew")}
              subtitle={editing.id ? tr("formEditSubtitle", { code: editing.code }) : tr("formNewSubtitle")}
              width="5xl"
              onClose={() => { setShowForm(false); setEditing(null); }}
              onSave={() => upsert.mutate(editing)}
              saving={upsert.isPending}
              saveDisabled={!editing.nameAr?.trim()}
            >
              <Tabs value={formTab} onValueChange={setFormTab}>
                <TabsList className="mb-4">
                  <TabsTrigger value="info">{tr("tabInfo")}</TabsTrigger>
                  <TabsTrigger value="job">{tr("tabJob")}</TabsTrigger>
                  <TabsTrigger value="ai" className="gap-1.5"><Sparkles className="h-3.5 w-3.5" /> {tr("tabAi")}</TabsTrigger>
                </TabsList>

                <TabsContent value="info" className="space-y-4">
                  <FormGrid>
                    <Field label={tr("fEmpCode")}><Input value={editing.code} onChange={e => setF("code", e.target.value)} placeholder={tr("fEmpCodePh")} /></Field>
                    <Field label={tr("fStatus")}>
                      <SearchCombobox
                        items={[
                          { value: "active",     label: tr("statusActive") },
                          { value: "vacation",   label: tr("statusVacation") },
                          { value: "suspended",  label: tr("statusSuspended") },
                          { value: "terminated", label: tr("statusTerminated") },
                        ]}
                        value={editing.status}
                        onValueChange={(v) => setF("status", v)}
                        placeholder={tr("fStatusPh")}
                        className="w-full"
                      />
                    </Field>
                    <Field label={tr("fNameAr")} required><Input value={editing.nameAr} onChange={e => setF("nameAr", e.target.value)} /></Field>
                    <Field label={tr("fNameEn")}><Input value={editing.nameEn} onChange={e => setF("nameEn", e.target.value)} /></Field>
                    <Field label={tr("fIdType")}>
                      <SearchCombobox
                        items={[
                          { value: "iqama",    label: tr("idTypeIqama") },
                          { value: "national", label: tr("idTypeNational") },
                        ]}
                        value={editing.idType}
                        onValueChange={(v) => setF("idType", v)}
                        placeholder={tr("fIdTypePh")}
                        className="w-full"
                      />
                    </Field>
                    <Field label={tr("fIdNumber")}><Input value={editing.idNumber} onChange={e => setF("idNumber", e.target.value)} /></Field>
                    <Field label={tr("fIqamaExpiry")}><DateField value={editing.iqamaExpiry || ""} onChange={e => setF("iqamaExpiry", e.target.value)} /></Field>
                    <Field label={tr("fNationality")}><Input value={editing.nationality} onChange={e => setF("nationality", e.target.value)} placeholder={tr("fNationalityPh")} /></Field>
                    <Field label={tr("fPassportNumber")}><Input value={editing.passportNumber} onChange={e => setF("passportNumber", e.target.value)} /></Field>
                    <Field label={tr("fPassportExpiry")}><DateField value={editing.passportExpiry || ""} onChange={e => setF("passportExpiry", e.target.value)} /></Field>
                    <Field label={tr("fMobile")}><Input value={editing.mobile} onChange={e => setF("mobile", e.target.value)} dir="ltr" /></Field>
                    <Field label={tr("fEmail")}><Input type="email" value={editing.email} onChange={e => setF("email", e.target.value)} dir="ltr" /></Field>
                    <Field label={tr("fGender")}>
                      <SearchCombobox
                        items={[
                          { value: "male",   label: tr("genderMale") },
                          { value: "female", label: tr("genderFemale") },
                        ]}
                        value={editing.gender}
                        onValueChange={(v) => setF("gender", v)}
                        placeholder={tr("fGenderPh")}
                        className="w-full"
                      />
                    </Field>
                    <Field label={tr("fBirthDate")}><DateField value={editing.birthDate || ""} onChange={e => setF("birthDate", e.target.value)} /></Field>
                    <Field label={tr("fNotes")} className="md:col-span-2"><Textarea rows={2} value={editing.notes} onChange={e => setF("notes", e.target.value)} /></Field>
                  </FormGrid>
                </TabsContent>

                <TabsContent value="job" className="space-y-4">
                  <FormGrid>
                    <Field label={tr("fDepartment")}><Input value={editing.department} onChange={e => setF("department", e.target.value)} /></Field>
                    <Field label={tr("fJobTitle")}><Input value={editing.jobTitle} onChange={e => setF("jobTitle", e.target.value)} /></Field>
                    <Field label={tr("fProfession")}><Input value={editing.profession} onChange={e => setF("profession", e.target.value)} /></Field>
                    <Field label={tr("fSponsor")}><Input value={editing.sponsor} onChange={e => setF("sponsor", e.target.value)} /></Field>
                    <Field label={tr("fHireDate")}><DateField value={editing.hireDate || ""} onChange={e => setF("hireDate", e.target.value)} /></Field>
                    <Field label={tr("fEndDate")}><DateField value={editing.endDate || ""} onChange={e => setF("endDate", e.target.value)} /></Field>
                    <Field label={tr("fBasicSalary")}><Input type="number" min="0" value={editing.basicSalary} onChange={e => setF("basicSalary", e.target.value)} /></Field>
                    <Field label={tr("fHousingAllow")}><Input type="number" min="0" value={editing.housingAllow} onChange={e => setF("housingAllow", e.target.value)} /></Field>
                    <Field label={tr("fTransportAllow")}><Input type="number" min="0" value={editing.transportAllow} onChange={e => setF("transportAllow", e.target.value)} /></Field>
                    <Field label={tr("fOtherAllow")}><Input type="number" min="0" value={editing.otherAllow} onChange={e => setF("otherAllow", e.target.value)} /></Field>
                    <Field label={tr("fBankName")}><Input value={editing.bankName} onChange={e => setF("bankName", e.target.value)} /></Field>
                    <Field label={tr("fIban")}><Input value={editing.bankAccountIban} onChange={e => setF("bankAccountIban", e.target.value)} dir="ltr" /></Field>
                  </FormGrid>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <div className="text-xs text-muted-foreground mb-1">{tr("monthlyTotalLabel")}</div>
                    <div className="text-lg font-bold text-emerald-700">
                      {(Number(editing.basicSalary || 0) + Number(editing.housingAllow || 0) + Number(editing.transportAllow || 0) + Number(editing.otherAllow || 0)).toLocaleString()} {tr("currencySAR")}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="ai" className="space-y-3">
                  <div className="rounded-lg border border-purple-200 bg-purple-50/50 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <Sparkles className="h-4 w-4 text-purple-600 mt-0.5 shrink-0" />
                      <div className="text-sm text-purple-900" dangerouslySetInnerHTML={{ __html: tr("aiBlurbHtml") }} />
                    </div>
                    <Textarea
                      rows={6}
                      value={aiText}
                      onChange={e => setAiText(e.target.value)}
                      placeholder={tr("aiPlaceholder")}
                      className="bg-white"
                    />
                    <Button onClick={runAiParse} disabled={aiBusy || !aiText.trim()} className="gap-2 bg-purple-600 hover:bg-purple-700">
                      {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                      {tr("aiExtractBtn")}
                    </Button>
                  </div>
                </TabsContent>
              </Tabs>
            </FormPanel>
          )}

          <div className="rounded-xl border bg-card overflow-hidden">
            {empQ.isLoading ? (
              <div className="p-6 space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
            ) : filtered.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                <UserCog className="h-12 w-12 mx-auto mb-2 opacity-30" />
                <p>{tr("noEmployees")}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase">
                    <tr className={isRtl ? "text-end" : "text-start"}>
                      <th className={`px-3 py-2.5 ${align}`}>{tr("colCode")}</th>
                      <th className={`px-3 py-2.5 ${align}`}>{tr("colEmployee")}</th>
                      <th className={`px-3 py-2.5 ${align}`}>{tr("colJob")}</th>
                      <th className={`px-3 py-2.5 ${align}`}>{tr("colIdNumber")}</th>
                      <th className={`px-3 py-2.5 ${align}`}>{tr("colIqamaExpiry")}</th>
                      <th className={`px-3 py-2.5 ${align}`}>{tr("colSalary")}</th>
                      <th className={`px-3 py-2.5 ${align}`}>{tr("colStatus")}</th>
                      <th className={`px-3 py-2.5 ${isRtl ? "text-end" : "text-start"}`}>{tr("colActions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filtered.map((e: any) => {
                      const total = Number(e.basicSalary || 0) + Number(e.housingAllow || 0) + Number(e.transportAllow || 0) + Number(e.otherAllow || 0);
                      const st = STATUS[e.status] || STATUS.active;
                      return (
                        <tr key={e.id} className="hover:bg-muted/30">
                          <td className="px-3 py-2.5 font-mono text-xs">{e.code}</td>
                          <td className="px-3 py-2.5">
                            <div className="font-medium">{pickName(e.nameAr, e.nameEn)}</div>
                            {(isRtl ? e.nameEn : e.nameAr) && <div className="text-xs text-muted-foreground" dir={isRtl ? "ltr" : "rtl"}>{isRtl ? e.nameEn : e.nameAr}</div>}
                          </td>
                          <td className="px-3 py-2.5 text-xs">
                            <div>{e.jobTitle || "—"}</div>
                            {e.department && <div className="text-muted-foreground">{e.department}</div>}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs">{e.idNumber || "—"}</td>
                          <td className="px-3 py-2.5"><ExpiryBadge date={e.iqamaExpiry} tr={tr} /></td>
                          <td className="px-3 py-2.5 text-xs">{total > 0 ? `${total.toLocaleString()} ${tr("currencySAR")}` : "—"}</td>
                          <td className="px-3 py-2.5"><Badge className={cn("border", st.cls)}>{st.label}</Badge></td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center justify-end gap-1">
                              <Button size="sm" variant="ghost" onClick={() => openEdit(e)} className="h-8 w-8 p-0"><Pencil className="h-3.5 w-3.5" /></Button>
                              <Button size="sm" variant="ghost" onClick={() => { window.location.href = `/hr/employees/${e.id}/contracts`; }} className="h-8 px-2 gap-1 text-xs"><FileSignature className="h-3.5 w-3.5" />{tr("btnContracts")}</Button>
                              <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" onClick={() => { if (confirm(tr("deleteConfirm", { name: pickName(e.nameAr, e.nameEn) }))) remove.mutate(e.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="alerts" className="space-y-4">
          {alertsQ.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <AlertsCard
                title={tr("alertIqamas")}
                icon={IdCard}
                color="rose"
                rows={alerts.expiringIqamas}
                fields={[["nameAr", tr("alertEmployee")], ["idNumber", tr("alertIqamaNo")], ["iqamaExpiry", tr("alertExpires")]]}
                noneLabel={tr("alertCardNone")}
                tr={tr}
              />
              <AlertsCard
                title={tr("alertContracts")}
                icon={FileSignature}
                color="amber"
                rows={alerts.expiringContracts}
                fields={[["employeeName", tr("alertEmployee")], ["contractNumber", tr("alertContractNo")], ["endDate", tr("alertExpires")]]}
                noneLabel={tr("alertCardNone")}
                tr={tr}
              />
              <AlertsCard
                title={tr("alertPassports")}
                icon={BadgeAlert}
                color="sky"
                rows={alerts.expiringPassports}
                fields={[["nameAr", tr("alertEmployee")], ["passportNumber", tr("alertPassportNo")], ["passportExpiry", tr("alertExpires")]]}
                noneLabel={tr("alertCardNone")}
                tr={tr}
              />
            </div>
          )}
          {totalAlerts === 0 && !alertsQ.isLoading && (
            <div className="rounded-xl border bg-emerald-50/50 border-emerald-200 p-8 text-center">
              <CheckCircle2 className="h-12 w-12 mx-auto text-emerald-500 mb-2" />
              <p className="text-emerald-800 font-medium">{tr("noAlerts")}</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AlertsCard({ title, icon: Icon, color, rows, fields, noneLabel, tr }: any) {
  const colorMap: Record<string, string> = {
    rose:  "border-rose-200 bg-rose-50/30",
    amber: "border-amber-200 bg-amber-50/30",
    sky:   "border-sky-200 bg-sky-50/30",
  };
  const iconMap: Record<string, string> = {
    rose: "text-rose-600 bg-rose-100",
    amber: "text-amber-600 bg-amber-100",
    sky: "text-sky-600 bg-sky-100",
  };
  return (
    <div className={cn("rounded-xl border p-4", colorMap[color])}>
      <div className="flex items-center gap-2 mb-3">
        <span className={cn("h-8 w-8 rounded-lg flex items-center justify-center", iconMap[color])}>
          <Icon className="h-4 w-4" />
        </span>
        <h3 className="font-semibold text-sm">{title}</h3>
        <span className="ms-auto text-xs font-bold">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">{noneLabel}</p>
      ) : (
        <div className="space-y-1.5 max-h-72 overflow-y-auto">
          {rows.map((r: any, i: number) => (
            <div key={i} className="rounded-md border bg-card p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-medium">{r[fields[0][0]]}</span>
                <ExpiryBadge date={r[fields[2][0]]} tr={tr} />
              </div>
              <div className="text-muted-foreground font-mono text-[11px]">{fields[1][1]}: {r[fields[1][0]] || "—"}</div>
              <div className="text-muted-foreground text-[11px]">{fields[2][1]}: {r[fields[2][0]]}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
