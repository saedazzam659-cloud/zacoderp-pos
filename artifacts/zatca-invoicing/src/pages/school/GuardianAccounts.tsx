import { useMemo, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, KeyRound, Link2, Plus, RefreshCw, Search, ShieldCheck, UserRoundCog, UsersRound } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SchoolExportMenu from "./SchoolExportMenu";
import { useCreateSchoolGuardianPortalAccount, useGetSchoolGuardianPortalAccounts, useUpdateSchoolGuardianPortalAccount, getGetSchoolGuardianPortalAccountsQueryKey } from "@workspace/api-client-react";
import type { SchoolGuardianPortalAccount } from "@workspace/api-client-react";
import { useSchoolList, type Row } from "./schoolApi";

type AccountDraft = { username: string; displayName: string; password: string; guardianIds: number[] };
const initialDraft: AccountDraft = { username: "", displayName: "", password: "", guardianIds: [] };

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "تعذر إكمال العملية. حاول مرة أخرى.";
}

export default function GuardianAccounts() {
  const qc = useQueryClient();
  const accounts = useGetSchoolGuardianPortalAccounts();
  const guardians = useSchoolList<Row>("guardians", { page: 1, limit: 1000 });
  const students = useSchoolList<Row>("students", { page: 1, limit: 1000 });
  const createAccount = useCreateSchoolGuardianPortalAccount();
  const updateAccount = useUpdateSchoolGuardianPortalAccount();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<SchoolGuardianPortalAccount | null>(null);
  const [draft, setDraft] = useState<AccountDraft>(initialDraft);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busy = createAccount.isPending || updateAccount.isPending;
  const studentById = useMemo(() => new Map((students.data?.items ?? []).map(s => [s.id, s])), [students.data?.items]);
  const linkedRows = useMemo(() => (guardians.data?.items ?? []).map(g => ({
    ...g,
    student: studentById.get(Number(g.studentId)),
  })), [guardians.data?.items, studentById]);
  const rows = (accounts.data ?? []).filter(a => `${a.displayName} ${a.username}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const accountColumns = [
    { key: "displayName", header: "اسم العرض", width: 24 },
    { key: "username", header: "اسم المستخدم", width: 22 },
    { key: "status", header: "الحالة", width: 14 },
    { key: "guardians", header: "أولياء الأمور والطلاب", width: 44 },
    { key: "createdAt", header: "تاريخ الإنشاء", width: 18 },
  ];
  const toAccountExportRow = (account: SchoolGuardianPortalAccount) => ({
    displayName: account.displayName,
    username: account.username,
    status: account.isActive ? "نشط" : "موقوف",
    guardians: account.guardians.map(link => `${link.studentNameAr} · ولي أمر #${link.guardianId}`).join("، ") || "—",
    createdAt: account.createdAt,
  });
  const accountExportRows = rows.map(toAccountExportRow);

  function openCreate() {
    setEditing(null); setDraft(initialDraft); setError(""); setNotice(""); setFormOpen(true);
  }
  function openEdit(account: SchoolGuardianPortalAccount) {
    setEditing(account);
    setDraft({ username: account.username, displayName: account.displayName, password: "", guardianIds: account.guardians.map(g => g.guardianId) });
    setError(""); setNotice(""); setFormOpen(true);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    if (!draft.guardianIds.length) { setError("اربط الحساب بسجل ولي أمر واحد على الأقل."); return; }
    if (!editing && draft.password.length < 10) { setError("يجب ألا تقل كلمة المرور عن 10 أحرف."); return; }
    try {
      if (editing) {
        const data = { username: draft.username.trim(), displayName: draft.displayName.trim(), guardianIds: draft.guardianIds, ...(draft.password ? { password: draft.password } : {}) };
        await updateAccount.mutateAsync({ id: editing.id, data });
      } else {
        await createAccount.mutateAsync({ data: { username: draft.username.trim(), displayName: draft.displayName.trim(), password: draft.password, guardianIds: draft.guardianIds } });
      }
      await qc.invalidateQueries({ queryKey: getGetSchoolGuardianPortalAccountsQueryKey() });
      setEditing(null); setFormOpen(false); setDraft(initialDraft); setNotice(editing ? "تم تحديث بيانات الحساب وروابطه." : "تم إنشاء حساب ولي الأمر.");
    } catch (e) { setError(errorText(e)); }
  }
  async function toggleActive(account: SchoolGuardianPortalAccount) {
    setError(""); setNotice("");
    try {
      await updateAccount.mutateAsync({ id: account.id, data: { isActive: !account.isActive } });
      await qc.invalidateQueries({ queryKey: getGetSchoolGuardianPortalAccountsQueryKey() });
      setNotice(account.isActive ? "تم إيقاف الحساب." : "تمت إعادة تفعيل الحساب.");
    } catch (e) { setError(errorText(e)); }
  }
  const toggleGuardian = (id: number) => setDraft(current => ({
    ...current,
    guardianIds: current.guardianIds.includes(id) ? current.guardianIds.filter(g => g !== id) : [...current.guardianIds, id],
  }));

  return <main dir="rtl" className="mx-auto min-h-[100dvh] max-w-7xl space-y-6 p-4 sm:p-6" data-testid="page-guardian-accounts">
    <header className="relative overflow-hidden rounded-2xl border border-teal-900/10 bg-[#eaf4f0] p-5 sm:p-7">
      <div className="absolute -left-8 -top-12 h-48 w-48 rounded-full border-[26px] border-teal-800/[0.05]" />
      <Link href="/school/students" className="inline-flex items-center gap-2 text-sm font-semibold text-teal-900/75 hover:text-teal-900"><ArrowRight className="h-4 w-4" />العودة إلى الطلاب</Link>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-xs font-bold tracking-[.16em] text-teal-800">بوابة الأسرة</p><h1 className="mt-2 text-3xl font-extrabold tracking-tight text-[#183b34]">حسابات أولياء الأمور</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-teal-950/65">أنشئ وصولاً آمناً للبوابة واربط كل حساب بسجلات أولياء الأمور الموجودة في المدرسة.</p></div>
        <Button onClick={openCreate} data-testid="button-create-guardian-account"><Plus className="ms-2 h-4 w-4" />حساب جديد</Button>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-teal-900/10 pt-4 text-sm text-teal-950/70">
        <span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-teal-700" />إدارة وصول منفصلة عن سجل ولي الأمر</span>
        <span className="inline-flex items-center gap-2"><Link2 className="h-4 w-4 text-teal-700" />{accounts.data?.length ?? "—"} حساباً مسجلاً</span>
      </div>
    </header>

    {(error || notice) && <div role="status" className={`rounded-lg border px-4 py-3 text-sm ${error ? "border-rose-300 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{error || notice}</div>}
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="font-bold">سجل الحسابات</h2><p className="mt-1 text-xs text-muted-foreground">تظهر هنا روابط الحساب بسجلات ولي الأمر والطالب.</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <SchoolExportMenu rows={accountExportRows} columns={accountColumns} filename="school-guardian-portal-accounts" title="حسابات أولياء الأمور" subtitle="بيانات الدخول وروابط سجلات ولي الأمر والطالب. لا يتضمن المستند كلمات مرور." disabled={accounts.isLoading || accounts.isError} />
          <label className="relative block w-full sm:w-72"><Search className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={e => setSearch(e.target.value)} className="pr-9" placeholder="بحث بالاسم أو اسم المستخدم" data-testid="input-account-search" /></label>
        </div>
      </div>
      {accounts.isLoading ? (
        <div className="space-y-3 p-5" aria-label="تحميل الحسابات">
          {[1, 2, 3].map(n => <div key={n} className="h-16 animate-pulse rounded-lg bg-muted" />)}
        </div>
      ) : accounts.isError ? (
        <div className="p-8 text-center">
          <p className="font-semibold">تعذر تحميل الحسابات</p>
          <p className="mt-1 text-sm text-muted-foreground">{errorText(accounts.error)}</p>
          <Button variant="outline" className="mt-4" onClick={() => accounts.refetch()}>
            <RefreshCw className="ms-2 h-4 w-4" />إعادة المحاولة
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-12 text-center">
          <UsersRound className="mx-auto h-8 w-8 text-teal-700/50" />
          <p className="mt-3 font-semibold">لا توجد حسابات مطابقة</p>
          <p className="mt-1 text-sm text-muted-foreground">أنشئ حساباً جديداً أو غيّر عبارة البحث.</p>
        </div>
      ) : (
        <div className="divide-y">
          {rows.map(account => (
            <article key={account.id} className="flex flex-col gap-4 p-4 transition-colors hover:bg-muted/20 sm:flex-row sm:items-center sm:justify-between" data-testid={`row-guardian-account-${account.id}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-bold">{account.displayName}</h3>
                  <span dir="ltr" className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{account.username}</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${account.isActive ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>
                    {account.isActive ? "نشط" : "موقوف"}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {account.guardians.map(link => (
                    <span key={link.guardianId}>
                      {link.studentNameAr} <span className="text-foreground/70">· ولي الأمر #{link.guardianId}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <SchoolExportMenu rows={[toAccountExportRow(account)]} columns={accountColumns} filename={`school-guardian-portal-account-${account.id}`} title={`حساب ولي الأمر: ${account.displayName}`} subtitle="بيانات الحساب وروابط السجلات المرتبطة." label="مستند" />
                <Button size="sm" variant="outline" onClick={() => openEdit(account)} data-testid={`button-edit-account-${account.id}`}>
                  <UserRoundCog className="ms-2 h-4 w-4" />تعديل / كلمة المرور
                </Button>
                <Button size="sm" variant={account.isActive ? "ghost" : "outline"} onClick={() => toggleActive(account)} disabled={updateAccount.isPending} data-testid={`button-toggle-account-${account.id}`}>
                  {account.isActive ? "إيقاف الحساب" : "إعادة التفعيل"}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>

    <AccountForm
      key={editing?.id ?? "new"}
      open={formOpen}
      editing={editing}
      draft={draft}
      setDraft={setDraft}
      linkedRows={linkedRows}
      guardiansLoading={guardians.isLoading}
      guardiansError={guardians.isError ? errorText(guardians.error) : ""}
      onRetryGuardians={() => guardians.refetch()}
      busy={busy}
      error={error}
      onSubmit={submit}
      onClose={() => { setEditing(null); setDraft(initialDraft); setError(""); setFormOpen(false); }}
      onToggleGuardian={toggleGuardian}
    />
  </main>;
}

function AccountForm({ open, editing, draft, setDraft, linkedRows, guardiansLoading, guardiansError, onRetryGuardians, busy, error, onSubmit, onClose, onToggleGuardian }: {
  open: boolean; editing: SchoolGuardianPortalAccount | null; draft: AccountDraft;
  setDraft: Dispatch<SetStateAction<AccountDraft>>;
  linkedRows: (Row & { student?: Row })[]; guardiansLoading: boolean; guardiansError: string; onRetryGuardians: () => void; busy: boolean; error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; onClose: () => void; onToggleGuardian: (id: number) => void;
}) {
  if (!open) return null;
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#173b34]/35 p-0 backdrop-blur-[2px] sm:items-center sm:p-5" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <form onSubmit={onSubmit} className="max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border bg-background p-5 shadow-2xl sm:w-[calc(100vw-2rem)] sm:max-w-none sm:rounded-2xl" aria-label={editing ? "تعديل حساب ولي الأمر" : "إنشاء حساب ولي أمر"}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold tracking-wide text-primary">إعداد وصول البوابة</p><h2 className="mt-1 text-xl font-bold">{editing ? "تعديل الحساب" : "حساب ولي أمر جديد"}</h2><p className="mt-1 text-sm text-muted-foreground">اربط الحساب بسجل واحد أو أكثر من سجلات أولياء الأمور.</p></div><Button type="button" variant="ghost" onClick={onClose}>إغلاق</Button></div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm font-semibold">اسم العرض<Input required maxLength={160} value={draft.displayName} onChange={e => setDraft(v => ({ ...v, displayName: e.target.value }))} data-testid="input-account-display-name" /></label>
        <label className="space-y-1.5 text-sm font-semibold">اسم المستخدم<Input required minLength={3} maxLength={120} dir="ltr" value={draft.username} onChange={e => setDraft(v => ({ ...v, username: e.target.value }))} data-testid="input-account-username" /></label>
        <label className="space-y-1.5 text-sm font-semibold sm:col-span-2">{editing ? "كلمة مرور جديدة (اختياري)" : "كلمة المرور"}<Input type="password" minLength={10} required={!editing} autoComplete="new-password" value={draft.password} onChange={e => setDraft(v => ({ ...v, password: e.target.value }))} placeholder={editing ? "اتركها فارغة للإبقاء على الحالية" : "10 أحرف على الأقل"} data-testid="input-account-password" /></label>
      </div>
      <fieldset className="mt-5 rounded-xl border p-4"><legend className="px-2 text-sm font-bold">روابط سجلات أولياء الأمور</legend>
        {guardiansLoading ? <div className="space-y-2 py-2">{[1,2,3].map(n => <div key={n} className="h-10 animate-pulse rounded bg-muted" />)}</div> : guardiansError ? <div role="alert" className="flex items-center justify-between gap-3 text-sm text-rose-800"><span>تعذر تحميل سجلات أولياء الأمور: {guardiansError}</span><Button type="button" size="sm" variant="outline" onClick={onRetryGuardians}>إعادة المحاولة</Button></div> : linkedRows.length === 0 ? <p className="text-sm text-muted-foreground">لا توجد سجلات أولياء أمور متاحة للربط.</p> : <div className="max-h-56 space-y-1 overflow-y-auto">{linkedRows.map(g => <label key={g.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-muted/40">
          <input type="checkbox" checked={draft.guardianIds.includes(g.id)} onChange={() => onToggleGuardian(g.id)} className="h-4 w-4 accent-teal-700" data-testid={`checkbox-guardian-link-${g.id}`} />
          <span className="min-w-0 flex-1"><span className="block font-medium">{g.name || g.fullNameAr || `ولي أمر #${g.id}`}</span><span className="text-xs text-muted-foreground">{g.student?.fullNameAr || `طالب #${g.studentId ?? "—"}`} · {g.relationship || "صلة القرابة غير محددة"}</span></span>
          <span dir="ltr" className="font-mono text-xs text-muted-foreground">#{g.id}</span>
        </label>)}</div>}
      </fieldset>
      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>إلغاء</Button><Button type="submit" disabled={busy || guardiansLoading || !!guardiansError || linkedRows.length === 0} data-testid="button-save-account">{busy ? "جارٍ الحفظ..." : editing ? <><KeyRound className="ms-2 h-4 w-4" />حفظ التغييرات</> : "إنشاء الحساب"}</Button></div>
    </form>
  </div>;
}
