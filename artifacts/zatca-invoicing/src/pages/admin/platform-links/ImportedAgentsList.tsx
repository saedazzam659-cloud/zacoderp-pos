import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2, Server, Shield, Globe, Play, ShieldAlert, Pencil, UserPlus, Trash2, Building2, GitBranch, Settings2 } from "lucide-react";

const API = import.meta.env.VITE_API_URL ?? "";

type ConfirmAction = { title: string; description: string; run: () => Promise<void> };

async function importedManagementCall(token: string | null | undefined, linkId: string, operation: string, payload: any = {}) {
  const res = await fetch(`${API}/api/admin/agent-instances/platform-links/${encodeURIComponent(linkId)}/management`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation, payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || "فشل تنفيذ العملية على الوكيل");
  return body;
}

function managementErrorLabel(message: string): string {
  const labels: Record<string, string> = {
    authentication_required: "يجب تسجيل الدخول بحساب المشرف العام.",
    superadmin_required: "هذه العملية متاحة للمشرف العام فقط.",
    controller_link_not_found: "رابط التحكم غير موجود أو لا يطابق هذا الوكيل.",
    target_platform_mismatch: "هذا الرابط لا يخص المنصة الحالية.",
    controller_identity_mismatch: "رفض المصدر: هوية التثبيت أو النطاق أو بصمة قاعدة البيانات غير مطابقة.",
    controller_state_mismatch: "رفض المصدر الطلب لأنه قديم؛ أعد تحميل الرابط وتحقق من القيادة الحالية.",
    inactive_controller: "منصة المصدر هي المتحكم حالياً؛ استحوذ على القيادة أولاً.",
    linked_agent_inactive: "الوكيل المصدر موقوف.",
    license_expired: "ترخيص الوكيل منتهي.",
    agent_database_unavailable: "قاعدة بيانات المصدر غير مهيأة أو غير متاحة.",
    platform_control_token_mismatch: "بيانات اعتماد رابط التحكم غير صالحة.",
    platform_control_credentials_unavailable: "بيانات اعتماد رابط التحكم غير متاحة.",
    unsupported_management_operation: "هذه العملية غير مدعومة عبر الرابط.",
    management_payload_too_large: "الطلب أكبر من الحد المسموح.",
    target_private_address: "عنوان المصدر غير عام أو غير آمن.",
    target_origin_must_be_https: "يجب أن يستخدم المصدر HTTPS عاماً.",
  };
  return labels[message] ?? message;
}

function ManagementField({ label, value, onChange, type = "text", required = false }: {
  label: string; value: any; onChange: (value: string) => void; type?: string; required?: boolean;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="font-medium text-slate-700 dark:text-slate-200">{label}{required ? " *" : ""}</span>
      <Input type={type} value={value ?? ""} onChange={e => onChange(e.target.value)} />
    </label>
  );
}

function ImportedAgentManagement({ link, token, onClose }: { link: any; token: string | null | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
  const [companyForm, setCompanyForm] = useState<any>(null);
  const [newCompany, setNewCompany] = useState({
    nameAr: "", nameEn: "", vatNumber: "", crNumber: "", username: "", email: "", password: "",
    city: "", district: "", street: "", buildingNumber: "", postalCode: "", phone: "",
    country: "SA", invoiceType: "both", plan: "starter", billingCycle: "monthly",
  });
  const [newUser, setNewUser] = useState<{ username: string; password: string; email: string; role: string; isActive: boolean; branchIds: number[] }>({ username: "", password: "", email: "", role: "user", isActive: true, branchIds: [] });
  const [userForm, setUserForm] = useState<any>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [showNewCompany, setShowNewCompany] = useState(false);
  const [showNewUser, setShowNewUser] = useState(false);

  const run = async (operation: string, payload: any = {}) =>
    importedManagementCall(token, link.linkId, operation, payload);

  const companiesQ = useQuery<any[]>({
    queryKey: ["imported-agent-management-companies", link.linkId],
    queryFn: () => run("company.list"),
    staleTime: 10_000,
  });
  const usersQ = useQuery<any[]>({
    queryKey: ["imported-agent-management-users", link.linkId, selectedCompanyId],
    queryFn: () => run("user.list", { companyId: selectedCompanyId }),
    enabled: selectedCompanyId != null,
    staleTime: 10_000,
  });
  const branchesQ = useQuery<any[]>({
    queryKey: ["imported-agent-management-branches", link.linkId, selectedCompanyId],
    queryFn: () => run("branch.list", { companyId: selectedCompanyId }),
    enabled: selectedCompanyId != null,
    staleTime: 10_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["imported-agent-management-companies", link.linkId] });
    qc.invalidateQueries({ queryKey: ["imported-agent-management-users", link.linkId, selectedCompanyId] });
    qc.invalidateQueries({ queryKey: ["imported-agent-management-branches", link.linkId, selectedCompanyId] });
  };
  const confirm = (action: ConfirmAction) => setConfirmAction(action);
  const execute = async () => {
    if (!confirmAction) return;
    const action = confirmAction;
    setConfirmAction(null);
    try {
      await action.run();
      invalidate();
      toast({ title: "تم تنفيذ العملية على الوكيل" });
    } catch (error: any) {
      toast({ title: "تعذر تنفيذ العملية", description: managementErrorLabel(error?.message ?? "حاول مرة أخرى"), variant: "destructive" });
    }
  };

  const companies = companiesQ.data ?? [];
  const selectedCompany = companies.find(c => Number(c.id) === selectedCompanyId);
  const users = usersQ.data ?? [];
  const branches = branchesQ.data ?? [];
  const startEditCompany = (company: any) => {
    setSelectedCompanyId(Number(company.id));
    setCompanyForm({
      id: Number(company.id), nameAr: company.nameAr ?? "", nameEn: company.nameEn ?? "",
      vatNumber: company.vatNumber ?? "", crNumber: company.crNumber ?? "", city: company.city ?? "",
      district: company.district ?? "", street: company.street ?? "", buildingNumber: company.buildingNumber ?? "",
      postalCode: company.postalCode ?? "", additionalNumber: company.additionalNumber ?? "",
      phone: company.phone ?? "", country: company.country ?? "SA", industryName: company.industryName ?? "",
      invoiceType: company.invoiceType ?? "both", isSandbox: !!company.isSandbox,
    });
  };
  const saveCompany = () => {
    if (!companyForm) return;
    const { id, ...fields } = companyForm;
    confirm({
      title: "تأكيد تعديل الشركة",
      description: `سيتم تعديل بيانات «${companyForm.nameAr}» على قاعدة بيانات الوكيل فقط. لا يتم نقل الشعار أو بيانات الاعتماد.`,
      run: async () => { await run("company.update", { id, ...fields }); setCompanyForm(null); },
    });
  };
  const createCompany = () => {
    if (!newCompany.nameAr || !newCompany.vatNumber || !newCompany.crNumber || !newCompany.username || !newCompany.password) {
      toast({ title: "بيانات ناقصة", description: "الاسم والرقم الضريبي والسجل وبيانات المستخدم مطلوبة", variant: "destructive" });
      return;
    }
    confirm({
      title: "تأكيد إنشاء الشركة",
      description: `سيتم إنشاء شركة «${newCompany.nameAr}» ومستخدمها الإداري داخل الوكيل المستورد.`,
      run: async () => {
        await run("company.create", { ...newCompany, isSandbox: false });
        setShowNewCompany(false);
        setNewCompany({ nameAr: "", nameEn: "", vatNumber: "", crNumber: "", username: "", email: "", password: "", city: "", district: "", street: "", buildingNumber: "", postalCode: "", phone: "", country: "SA", invoiceType: "both", plan: "starter", billingCycle: "monthly" });
      },
    });
  };
  const changeCompanyStatus = (company: any, status: string) => confirm({
    title: "تأكيد تغيير حالة الشركة",
    description: `سيتم تغيير حالة «${company.nameAr}» إلى «${status}» وتعطيل جلسات المستخدمين عند الإيقاف أو الرفض.`,
    run: async () => { await run("company.status", { id: Number(company.id), status }); },
  });
  const deleteCompany = (company: any) => confirm({
    title: "تأكيد نقل الشركة إلى المحذوفات",
    description: `سيتم نقل «${company.nameAr}» إلى سلة المحذوفات وتعطيل مستخدميها. هذا ليس حذفاً نهائياً ويمكن الاستعادة من مسار recycle-bin.`,
    run: async () => {
      await run("company.delete", { id: Number(company.id) });
      if (selectedCompanyId === Number(company.id)) setSelectedCompanyId(null);
      if (companyForm?.id === Number(company.id)) setCompanyForm(null);
    },
  });
  const startEditUser = (user: any) => setUserForm({
    id: Number(user.id), companyId: selectedCompanyId, username: user.username ?? "", email: user.email ?? "",
    role: user.role ?? "user", isActive: user.isActive !== false, nameAr: user.nameAr ?? "", nameEn: user.nameEn ?? "",
    code: user.code ?? "", password: "", branchIds: user.branchIds ?? [],
  });
  const saveUser = () => {
    if (!userForm || selectedCompanyId == null) return;
    const { id, companyId, ...fields } = userForm;
    confirm({
      title: "تأكيد تعديل المستخدم",
      description: `سيتم حفظ صلاحيات وبيانات «${userForm.username}» على الوكيل.`,
      run: async () => { await run("user.update", { id, companyId, ...fields }); setUserForm(null); },
    });
  };
  const createUser = () => {
    if (!newUser.username || !newUser.password || selectedCompanyId == null) return;
    confirm({
      title: "تأكيد إنشاء المستخدم",
      description: `سيتم إنشاء المستخدم «${newUser.username}» في شركة «${selectedCompany?.nameAr ?? selectedCompanyId}».`,
      run: async () => {
        await run("user.create", { ...newUser, companyId: selectedCompanyId });
        setShowNewUser(false);
        setNewUser({ username: "", password: "", email: "", role: "user", isActive: true, branchIds: [] });
      },
    });
  };
  const toggleUser = (user: any) => confirm({
    title: user.isActive ? "تأكيد تعطيل المستخدم" : "تأكيد تفعيل المستخدم",
    description: `${user.isActive ? "سيتم إبطال جلساته فوراً." : "سيتم السماح له بتسجيل الدخول مجدداً."}`,
    run: async () => { await run("user.status", { id: Number(user.id), companyId: selectedCompanyId, isActive: !user.isActive }); },
  });
  const removeUser = (user: any) => confirm({
    title: "تأكيد حذف المستخدم",
    description: `سيتم حذف حساب «${user.username}» من شركة الوكيل. هذا الإجراء لا يحذف الشركة.`,
    run: async () => { await run("user.delete", { id: Number(user.id), companyId: selectedCompanyId }); },
  });

  return (
    <>
      <Dialog open onOpenChange={open => !open && onClose()}>
        <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Settings2 className="h-5 w-5 text-emerald-600" />إدارة الوكيل: {link.name}</DialogTitle>
          </DialogHeader>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            هذه لوحة إدارة محدودة للشركة والمستخدمين والفروع عبر الرابط النشط فقط. لا يتم نسخ قاعدة البيانات أو الشعار أو بيانات الاعتماد إلى المنصة الحالية.
          </div>
          {companiesQ.isLoading ? <div className="py-8 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div> : (
            <div className="grid gap-5 lg:grid-cols-[1.1fr_1.4fr]">
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold flex items-center gap-2"><Building2 className="h-4 w-4" />الشركات</h3>
                  <Button size="sm" onClick={() => setShowNewCompany(v => !v)}><Building2 className="h-4 w-4 ms-1" />شركة جديدة</Button>
                </div>
                {showNewCompany && (
                  <div className="rounded-lg border bg-slate-50 p-3 space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <ManagementField label="اسم الشركة" required value={newCompany.nameAr} onChange={v => setNewCompany({ ...newCompany, nameAr: v })} />
                      <ManagementField label="الاسم الإنجليزي" value={newCompany.nameEn} onChange={v => setNewCompany({ ...newCompany, nameEn: v })} />
                      <ManagementField label="الرقم الضريبي" required value={newCompany.vatNumber} onChange={v => setNewCompany({ ...newCompany, vatNumber: v })} />
                      <ManagementField label="السجل التجاري" required value={newCompany.crNumber} onChange={v => setNewCompany({ ...newCompany, crNumber: v })} />
                      <ManagementField label="اسم المستخدم الإداري" required value={newCompany.username} onChange={v => setNewCompany({ ...newCompany, username: v })} />
                      <ManagementField label="كلمة المرور" required type="password" value={newCompany.password} onChange={v => setNewCompany({ ...newCompany, password: v })} />
                      <ManagementField label="البريد" value={newCompany.email} onChange={v => setNewCompany({ ...newCompany, email: v })} />
                      <ManagementField label="المدينة" value={newCompany.city} onChange={v => setNewCompany({ ...newCompany, city: v })} />
                    </div>
                    <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setShowNewCompany(false)}>إلغاء</Button><Button onClick={createCompany}>حفظ وطلب التأكيد</Button></div>
                  </div>
                )}
                <div className="space-y-2">
                  {companies.map(company => (
                    <div key={company.id} className={`rounded-lg border p-3 ${selectedCompanyId === Number(company.id) ? "border-emerald-500 bg-emerald-50/50" : "bg-white dark:bg-slate-950"}`}>
                      <div className="flex items-start justify-between gap-2">
                        <button className="text-start flex-1" onClick={() => { setSelectedCompanyId(Number(company.id)); setCompanyForm(null); }}>
                          <div className="font-semibold">{company.nameAr}</div><div className="text-xs text-muted-foreground font-mono">{company.code ?? `#${company.id}`}</div>
                        </button>
                        <div className="flex gap-1">
                          <Button size="icon" variant="ghost" title="تعديل" onClick={() => startEditCompany(company)}><Pencil className="h-4 w-4" /></Button>
                          <Button size="icon" variant="ghost" title="نقل للمحذوفات" className="text-rose-600" onClick={() => deleteCompany(company)}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <select className="h-8 rounded-md border bg-background px-2 text-xs" value={company.status ?? "active"} onChange={e => changeCompanyStatus(company, e.target.value)}>
                          {["active", "pending", "rejected", "suspended"].map(status => <option key={status} value={status}>{status}</option>)}
                        </select>
                        <span className="text-xs text-muted-foreground">{company.vatNumber}</span>
                      </div>
                    </div>
                  ))}
                  {!companies.length && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">لا توجد شركات على الوكيل</div>}
                </div>
                {companyForm && (
                  <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-3">
                    <h4 className="font-semibold">تعديل بيانات الشركة</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {(["nameAr", "nameEn", "vatNumber", "crNumber", "city", "district", "street", "buildingNumber", "postalCode", "phone", "industryName"] as const).map(key => (
                        <ManagementField key={key} label={key} value={companyForm[key]} onChange={v => setCompanyForm({ ...companyForm, [key]: v })} />
                      ))}
                    </div>
                    <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCompanyForm(null)}>إلغاء</Button><Button onClick={saveCompany}>حفظ وطلب التأكيد</Button></div>
                  </div>
                )}
              </section>
              <section className="space-y-4">
                {!selectedCompany ? <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">اختر شركة لعرض المستخدمين والفروع</div> : (
                  <>
                    <div className="flex items-center justify-between"><h3 className="font-bold flex items-center gap-2"><UserPlus className="h-4 w-4" />مستخدمو {selectedCompany.nameAr}</h3><Button size="sm" onClick={() => setShowNewUser(v => !v)}><UserPlus className="h-4 w-4 ms-1" />مستخدم جديد</Button></div>
                    {showNewUser && <div className="rounded-lg border bg-slate-50 p-3 grid grid-cols-2 gap-2">
                      <ManagementField label="اسم المستخدم" required value={newUser.username} onChange={v => setNewUser({ ...newUser, username: v })} />
                      <ManagementField label="كلمة المرور" required type="password" value={newUser.password} onChange={v => setNewUser({ ...newUser, password: v })} />
                      <ManagementField label="البريد" value={newUser.email} onChange={v => setNewUser({ ...newUser, email: v })} />
                      <label className="space-y-1 text-sm"><span className="font-medium">الدور</span><select className="h-10 w-full rounded-md border bg-background px-2" value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value })}><option value="user">مستخدم</option><option value="admin">مدير</option><option value="cashier">كاشير</option></select></label>
                      <div className="col-span-2"><span className="text-sm font-medium">الفروع المسموحة</span><div className="mt-1 flex flex-wrap gap-2">{branches.map(branch => <label key={branch.id} className="flex items-center gap-1 rounded border bg-white px-2 py-1 text-xs"><input type="checkbox" checked={newUser.branchIds.includes(Number(branch.id))} onChange={e => setNewUser({ ...newUser, branchIds: e.target.checked ? [...newUser.branchIds, Number(branch.id)] : newUser.branchIds.filter(id => id !== Number(branch.id)) })} />{branch.nameAr}</label>)}</div></div>
                      <div className="col-span-2 flex justify-end gap-2"><Button variant="ghost" onClick={() => setShowNewUser(false)}>إلغاء</Button><Button onClick={createUser}>حفظ وطلب التأكيد</Button></div>
                    </div>}
                    <div className="space-y-2">{usersQ.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : users.map(user => (
                      <div key={user.id} className="rounded-lg border p-3 flex items-center justify-between gap-2">
                        <div><div className="font-medium">{user.nameAr || user.username}</div><div className="text-xs text-muted-foreground">{user.username} · {user.role}</div></div>
                        <div className="flex items-center gap-1"><span className={`text-xs rounded-full px-2 py-1 ${user.isActive ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{user.isActive ? "نشط" : "معطل"}</span><Button size="icon" variant="ghost" onClick={() => startEditUser(user)}><Pencil className="h-4 w-4" /></Button><Button size="icon" variant="ghost" onClick={() => toggleUser(user)}>{user.isActive ? <ShieldAlert className="h-4 w-4 text-amber-600" /> : <Shield className="h-4 w-4 text-emerald-600" />}</Button><Button size="icon" variant="ghost" className="text-rose-600" onClick={() => removeUser(user)}><Trash2 className="h-4 w-4" /></Button></div>
                      </div>
                    ))}</div>
                    {userForm && <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-3"><h4 className="font-semibold">تعديل المستخدم</h4><div className="grid grid-cols-2 gap-2"><ManagementField label="اسم المستخدم" value={userForm.username} onChange={v => setUserForm({ ...userForm, username: v })} /><ManagementField label="الاسم" value={userForm.nameAr} onChange={v => setUserForm({ ...userForm, nameAr: v })} /><ManagementField label="البريد" value={userForm.email} onChange={v => setUserForm({ ...userForm, email: v })} /><ManagementField label="كلمة مرور جديدة" type="password" value={userForm.password} onChange={v => setUserForm({ ...userForm, password: v })} /></div><div><span className="text-sm font-medium">الفروع المسموحة</span><div className="mt-1 flex flex-wrap gap-2">{branches.map(branch => <label key={branch.id} className="flex items-center gap-1 rounded border bg-white px-2 py-1 text-xs"><input type="checkbox" checked={(userForm.branchIds ?? []).includes(Number(branch.id))} onChange={e => setUserForm({ ...userForm, branchIds: e.target.checked ? [...(userForm.branchIds ?? []), Number(branch.id)] : (userForm.branchIds ?? []).filter((id: number) => id !== Number(branch.id)) })} />{branch.nameAr}</label>)}</div></div><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setUserForm(null)}>إلغاء</Button><Button onClick={saveUser}>حفظ وطلب التأكيد</Button></div></div>}
                    <div className="rounded-lg border p-3"><h4 className="font-semibold flex items-center gap-2 mb-2"><GitBranch className="h-4 w-4" />الفروع (عرض فقط)</h4>{branchesQ.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : branches.length ? <div className="grid gap-1 text-sm">{branches.map(branch => <div key={branch.id} className="flex justify-between border-b py-1 last:border-0"><span>{branch.nameAr}</span><span className="text-muted-foreground font-mono">{branch.code}</span></div>)}</div> : <div className="text-sm text-muted-foreground">لا توجد فروع أو تعذر تحميلها</div>}</div>
                  </>
                )}
              </section>
            </div>
          )}
          <DialogFooter><Button variant="outline" onClick={onClose}>إغلاق</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!confirmAction} onOpenChange={open => !open && setConfirmAction(null)}>
        <DialogContent className="max-w-md" dir="rtl"><DialogHeader><DialogTitle>{confirmAction?.title}</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">{confirmAction?.description}</p><DialogFooter><Button variant="ghost" onClick={() => setConfirmAction(null)}>إلغاء</Button><Button onClick={execute}>تأكيد وتنفيذ</Button></DialogFooter></DialogContent>
      </Dialog>
    </>
  );
}

export function ImportedAgentsList() {
  const { token } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const [confirmSwitch, setConfirmSwitch] = useState<any>(null);
  const [managementLink, setManagementLink] = useState<any>(null);

  const { data: importedLinks, isLoading } = useQuery<any[]>({
    queryKey: ["agent-platform-imported"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/admin/agent-instances/platform-links/imported`, { headers });
      if (!res.ok) throw new Error("فشل جلب الروابط المستوردة");
      return res.json();
    }
  });

  const leadMut = useMutation({
    mutationFn: async ({ linkId, activeControllerId, epoch }: { linkId: string, activeControllerId: string, epoch: number }) => {
      const res = await fetch(`${API}/api/admin/agent-instances/platform-links/${linkId}/leadership`, {
        method: "POST", headers, body: JSON.stringify({ activeControllerId, controllerEpoch: epoch })
      });
      if (!res.ok) throw new Error("فشل تبديل القيادة");
      return res.json();
    },
    onSuccess: (data) => {
      if (data.shellSyncError) {
        toast({ title: "تم التحديث مع خطأ في السيرفر", description: data.shellSyncError, variant: "destructive" });
      } else {
        toast({ title: "تم نقل قيادة التحكم بنجاح" });
      }
      qc.invalidateQueries({ queryKey: ["agent-platform-imported"] });
      setConfirmSwitch(null);
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" })
  });

  if (isLoading) return <div className="p-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (!importedLinks || importedLinks.length === 0) return (
    <div className="border rounded-xl p-10 text-center text-muted-foreground bg-slate-50 dark:bg-slate-900/30">
      <Server className="h-10 w-10 mx-auto mb-3 opacity-30" />
      لا يوجد وكلاء مستوردون بعد
    </div>
  );

  return (
    <div className="space-y-4">
      {importedLinks.map((link) => {
        const isLocalActive = link.activeControllerId === link.targetPlatformId;
        return (
          <div key={link.linkId} className="border border-slate-200 dark:border-slate-800 rounded-xl p-5 bg-white dark:bg-slate-950 shadow-sm transition-all hover:shadow-md">
            <div className="flex items-start justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-100 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                  <Server className="h-6 w-6" />
                </div>
                <div>
                  <div className="font-bold text-lg flex items-center gap-2 text-slate-800 dark:text-slate-100">
                    {link.name}
                    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px] uppercase font-bold tracking-widest px-1.5 h-5">Imported</Badge>
                  </div>
                  <div className="text-sm text-slate-500 mt-1 flex items-center gap-4">
                    <span className="flex items-center gap-1 font-mono"><Globe className="h-3.5 w-3.5" /><span dir="ltr">{link.domain}</span></span>
                    <span className="flex items-center gap-1 opacity-80"><span className="text-[10px] uppercase">SRC:</span> <span dir="ltr" className="font-mono">{link.sourceOrigin}</span></span>
                  </div>
                </div>
              </div>
              <div>
                {!isLocalActive ? (
                  <Button onClick={() => setConfirmSwitch({ ...link, toLocal: true })} disabled={leadMut.isPending} className="bg-emerald-600 hover:bg-emerald-700 text-white h-9 shadow-sm">
                    <Play className="h-4 w-4 ms-1" />
                    استحواذ على التحكم
                  </Button>
                ) : (
                  <div className="flex gap-2">
                    <Button variant="outline" className="text-emerald-700 hover:bg-emerald-50 border-emerald-200 h-9 bg-white" onClick={() => setManagementLink(link)}>
                      <Settings2 className="h-4 w-4 ms-1" /> إدارة الشركات والمستخدمين
                    </Button>
                    <Button variant="outline" className="text-rose-600 hover:bg-rose-50 border-rose-200 h-9 bg-white" onClick={() => setConfirmSwitch({ ...link, toLocal: false })} disabled={leadMut.isPending}>
                      إعادة التحكم للمصدر
                    </Button>
                  </div>
                )}
              </div>
            </div>
            
            <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-wrap gap-6 text-sm">
              <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-900 px-2 py-1 rounded">
                <Shield className={`h-4 w-4 ${isLocalActive ? "text-emerald-600" : "text-slate-400"}`} />
                <span className="text-slate-500">القيادة الحالية:</span>
                <span className={`font-bold ${isLocalActive ? "text-emerald-700" : "text-slate-600"}`}>
                  {isLocalActive ? "هذه المنصة (نشط)" : "منصة المصدر"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-900 px-2 py-1 rounded">
                <span className="text-slate-500">Epoch:</span>
                <span className="font-mono font-bold text-slate-700">{link.controllerEpoch}</span>
              </div>
              <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-900 px-2 py-1 rounded">
                <span className="text-slate-500">Install ID:</span>
                <span className="font-mono font-bold text-slate-700" dir="ltr">{link.installationId.slice(0,8)}...</span>
              </div>
            </div>
          </div>
        );
      })}

      <Dialog open={!!confirmSwitch} onOpenChange={(o) => !o && setConfirmSwitch(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-emerald-800">
              {confirmSwitch?.toLocal ? <Shield className="h-5 w-5 text-emerald-600" /> : <ShieldAlert className="h-5 w-5 text-rose-600" />}
              تأكيد نقل قيادة التحكم
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm mt-2 text-slate-600">
            {confirmSwitch?.toLocal ? (
              <p>هل أنت متأكد من الاستحواذ على قيادة هذا السيرفر المستورد؟ ستتمكن من إرسال التحديثات والأوامر بدلاً من منصة المصدر.</p>
            ) : (
              <p>هل أنت متأكد من التخلي عن إدارة هذا السيرفر وإعادة التحكم إلى منصة المصدر الأساسية؟ لن تعود قادراً على نشر التحديثات إليه.</p>
            )}
            <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border text-xs leading-relaxed">
              <span className="font-bold text-slate-800 dark:text-slate-200">تنويه آمن:</span> هذا الإجراء يقتصر فقط على سيرفر التطبيق. قاعدة بيانات الوكيل المستقلة لم ولن تتأثر بهذا الإجراء إطلاقاً.
            </div>
          </div>
          <DialogFooter className="gap-2 pt-2 border-t mt-4">
            <Button variant="ghost" onClick={() => setConfirmSwitch(null)}>إلغاء</Button>
            <Button onClick={() => {
              const activeId = confirmSwitch.toLocal ? confirmSwitch.targetPlatformId : confirmSwitch.sourcePlatformId;
              leadMut.mutate({ linkId: confirmSwitch.linkId, activeControllerId: activeId, epoch: confirmSwitch.controllerEpoch + 1 });
            }} disabled={leadMut.isPending} className={confirmSwitch?.toLocal ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-rose-600 hover:bg-rose-700 text-white"}>
              {leadMut.isPending && <Loader2 className="h-4 w-4 ms-2 animate-spin" />}
              تأكيد الإجراء
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {managementLink && <ImportedAgentManagement link={managementLink} token={token} onClose={() => setManagementLink(null)} />}
    </div>
  );
}
