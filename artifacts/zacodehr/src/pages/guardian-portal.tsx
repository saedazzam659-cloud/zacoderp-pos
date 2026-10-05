import { useMemo, useState } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetGuardianPortalChildren, getGetGuardianPortalChildrenQueryKey, useSetGuardianStudentBiometricConsent } from "@workspace/api-client-react";
import type { GuardianPortalChild } from "@workspace/api-client-react";
import { ArrowDownLeft, BookOpen, CalendarCheck2, CalendarDays, ChevronDown, CircleAlert, CreditCard, Fingerprint, GraduationCap, LogOut, RefreshCw, ShieldCheck, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getGuardianAccount, getGuardianToken, clearGuardianSession } from "@/lib/guardianAuth";

const POLICY_VERSION = "school-face-v1";

function dateLabel(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ar", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function money(value: number) {
  return new Intl.NumberFormat("ar", { style: "currency", currency: "SAR", maximumFractionDigits: 2 }).format(value);
}

function statusLabel(status: string) {
  const normalized = status.toLowerCase();
  if (["paid", "مدفوع"].includes(normalized)) return "مدفوع";
  if (["present", "حاضر", "active", "نشط"].includes(normalized)) return "حاضر";
  if (["late", "متأخر"].includes(normalized)) return "متأخر";
  if (["absent", "غائب"].includes(normalized)) return "غائب";
  if (["excused", "معذور"].includes(normalized)) return "بعذر";
  if (["unpaid", "pending", "due", "مستحق", "غير مدفوع"].includes(normalized)) return "مستحق";
  if (["unpaid", "pending", "مستحق", "غير مدفوع"].includes(normalized)) return "مستحق";
  return status || "—";
}

function attendanceTone(status: string) {
  const value = status.toLowerCase();
  if (value.includes("present") || value.includes("حاضر")) return "good";
  if (value.includes("late") || value.includes("متأخر")) return "warning";
  if (value.includes("absent") || value.includes("غائب")) return "bad";
  return "neutral";
}

function ChildSkeleton() {
  return <div className="guardian-skeleton-wrap" aria-label="جارٍ تحميل بيانات الأبناء"><div className="guardian-skeleton sk-title" /><div className="guardian-skeleton sk-card" /><div className="guardian-skeleton sk-card" /></div>;
}

function ConsentControl({ child, token, onChange }: { child: GuardianPortalChild; token: string; onChange: () => void }) {
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const consent = useSetGuardianStudentBiometricConsent({
    request: { headers: { Authorization: `Bearer ${token}` } },
  });
  const changeConsent = (consented: boolean) => {
    consent.mutate({ studentId: child.id, data: { consented, policyVersion: POLICY_VERSION } }, {
      onSuccess: () => {
        setDisclosureOpen(false);
        onChange();
      },
    });
  };
  return (
    <div className={`consent-panel ${child.biometricConsentActive ? "is-consented" : ""}`} data-testid={`panel-consent-${child.id}`}>
      <div className="consent-icon"><Fingerprint size={20} /></div>
      <div className="consent-copy">
        <div className="consent-heading"><b>الحضور بالتعرّف على الوجه</b><span className={`consent-state ${child.biometricConsentActive ? "active" : ""}`} data-testid={`status-consent-${child.id}`}><i />{child.biometricConsentActive ? "مفعّل بموافقتك" : "غير مفعّل"}</span></div>
        <p>{child.biometricConsentActive ? (child.faceEnrolled ? "الموافقة سارية، والتسجيل الحيوي مكتمل." : "الموافقة سارية؛ لم يتم تسجيل الوجه بعد.") : "لا تُستخدم هذه الميزة إلا بعد موافقتك الصريحة."}</p>
        {consent.isError && <p className="consent-error" role="alert">لم يتم حفظ التغيير. يرجى المحاولة مرة أخرى.</p>}
      </div>
      <div className="consent-action">
        {child.biometricConsentActive ? (
          <Button variant="outline" className="revoke-button" onClick={() => changeConsent(false)} disabled={consent.isPending} data-testid={`button-revoke-consent-${child.id}`}>
            {consent.isPending ? "جارٍ الحفظ..." : "سحب الموافقة"}
          </Button>
        ) : (
          <Button className="consent-button" onClick={() => setDisclosureOpen(true)} disabled={consent.isPending} data-testid={`button-consent-${child.id}`}>مراجعة الموافقة</Button>
        )}
      </div>
      {disclosureOpen && (
        <div className="consent-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDisclosureOpen(false); }}>
          <section className="consent-dialog" role="dialog" aria-modal="true" aria-labelledby={`consent-title-${child.id}`} dir="rtl">
            <button className="dialog-close" onClick={() => setDisclosureOpen(false)} aria-label="إغلاق" data-testid={`button-close-consent-${child.id}`}><X size={19} /></button>
            <div className="dialog-icon"><Fingerprint size={26} /></div>
            <span className="dialog-kicker">موافقة ولي الأمر</span>
            <h3 id={`consent-title-${child.id}`}>الحضور بالتعرّف على الوجه</h3>
            <p>بموافقتك، يمكن للمدرسة استخدام بيانات الوجه للتحقق من حضور <strong>{child.fullNameAr}</strong>. تُستخدم هذه البيانات لغرض تسجيل الحضور فقط، وتبقى الموافقة تحت سيطرتك.</p>
            <div className="disclosure-points"><span><ShieldCheck size={17} /> الموافقة اختيارية ويمكنك سحبها في أي وقت.</span><span><LockKeyholeIcon /> لا يتم تفعيلها دون تأكيدك أدناه.</span></div>
            {consent.isError && <p className="consent-error" role="alert">تعذر تسجيل الموافقة. حاول مرة أخرى.</p>}
            <div className="dialog-actions">
              <Button variant="outline" onClick={() => setDisclosureOpen(false)} data-testid={`button-cancel-consent-${child.id}`}>ليس الآن</Button>
              <Button onClick={() => changeConsent(true)} disabled={consent.isPending} data-testid={`button-confirm-consent-${child.id}`}>{consent.isPending ? "جارٍ الحفظ..." : "أوافق وأفعّل"}</Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function LockKeyholeIcon() {
  return <ShieldCheck size={17} />;
}

function ChildDetails({ child, token, onChange }: { child: GuardianPortalChild; token: string; onChange: () => void }) {
  const summary = child.attendanceSummary;
  const attendanceRate = summary.total ? Math.round((summary.present / summary.total) * 100) : 0;
  const dueFees = child.fees.filter((fee) => !["paid", "مدفوع"].includes(fee.status.toLowerCase()));
  const dueTotal = dueFees.reduce((sum, fee) => sum + fee.amount, 0);
  return (
    <div className="child-content">
      <div className="overview-grid">
        <section className="attendance-card data-card">
          <div className="section-heading"><div><span className="section-kicker">ملخص الحضور</span><h3>الالتزام اليومي</h3></div><span className="soft-icon green"><CalendarCheck2 size={19} /></span></div>
          <div className="attendance-meter-row">
            <div className="attendance-score"><strong>{attendanceRate}<small>%</small></strong><span>نسبة الحضور</span></div>
            <div className="attendance-ring" style={{ "--attendance": `${attendanceRate}%` } as React.CSSProperties}><div><b>{summary.present}</b><small>من {summary.total}</small></div></div>
          </div>
          <div className="attendance-legend">
            <span><i className="dot present" /> حاضر <b>{summary.present}</b></span>
            <span><i className="dot late" /> متأخر <b>{summary.late}</b></span>
            <span><i className="dot absent" /> غائب <b>{summary.absent}</b></span>
            <span><i className="dot excused" /> بعذر <b>{summary.excused}</b></span>
          </div>
        </section>
        <section className="fees-card data-card">
          <div className="section-heading"><div><span className="section-kicker">الرسوم المدرسية</span><h3>ملخص الرسوم</h3></div><span className="soft-icon amber"><CreditCard size={19} /></span></div>
          <div className="fee-total"><strong>{money(dueTotal)}</strong><span>{dueFees.length ? "مبالغ مستحقة" : "لا توجد مبالغ مستحقة"}</span></div>
          <div className="fee-meta"><span>{child.fees.length} بنود مسجلة</span><span className={dueFees.length ? "fee-due" : "fee-clear"}>{dueFees.length ? `${dueFees.length} مستحق` : "الحساب محدّث"}</span></div>
          {child.fees.map((fee) => <div className="fee-mini" key={fee.id} data-testid={`fee-row-${fee.id}`}><span>{fee.description}<small>{fee.invoiceNumber || "—"} · الاستحقاق {dateLabel(fee.dueDate)}</small></span><b>{money(fee.amount)}<small className={["paid", "مدفوع"].includes(fee.status.toLowerCase()) ? "fee-paid-label" : "fee-due-label"}>{statusLabel(fee.status)}</small></b></div>)}
          {!child.fees.length && <p className="inline-empty">لا توجد رسوم مسجلة حالياً.</p>}
        </section>
      </div>
      <div className="details-grid">
        <section className="data-card recent-card">
          <div className="section-heading"><div><span className="section-kicker">آخر التحديثات</span><h3>سجل الحضور</h3></div><span className="soft-icon blue"><CalendarDays size={18} /></span></div>
          {child.recentAttendance.length ? <div className="record-list">{child.recentAttendance.slice(0, 5).map((record, index) => <div className="record-row" key={`${record.date}-${record.period}-${index}`} data-testid={`attendance-row-${child.id}-${index}`}><span className="record-date">{dateLabel(record.date)}</span><span className="record-period">{record.period}</span><span className={`status-pill ${attendanceTone(record.status)}`}>{statusLabel(record.status)}</span></div>)}</div> : <div className="mini-empty"><CalendarDays size={18} /><span>لا يوجد سجل حضور حديث.</span></div>}
        </section>
        <section className="data-card exams-card">
          <div className="section-heading"><div><span className="section-kicker">التقدم الدراسي</span><h3>أحدث النتائج</h3></div><span className="soft-icon violet"><BookOpen size={18} /></span></div>
          {child.recentExams.length ? <div className="exam-list">{child.recentExams.slice(0, 4).map((exam) => <div className="exam-row" key={exam.id} data-testid={`exam-row-${exam.id}`}><span className="exam-mark"><GraduationCap size={17} /></span><span className="exam-name"><b>{exam.name}</b><small>{exam.subject} · {dateLabel(exam.examDate)}</small></span><span className="exam-score"><b>{exam.score}<small>/{exam.maxScore}</small></b><i>{exam.maxScore ? Math.round((exam.score / exam.maxScore) * 100) : 0}%</i></span></div>)}</div> : <div className="mini-empty"><BookOpen size={18} /><span>لم تُسجل نتائج حديثة.</span></div>}
        </section>
      </div>
      <ConsentControl child={child} token={token} onChange={onChange} />
    </div>
  );
}

export default function GuardianPortal() {
  const token = getGuardianToken();
  const account = getGuardianAccount();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const childrenQuery = useGetGuardianPortalChildren({
    query: { enabled: !!token, queryKey: getGetGuardianPortalChildrenQueryKey() },
    request: { headers: { Authorization: `Bearer ${token ?? ""}` } },
  });
  const children = useMemo(() => childrenQuery.data ?? [], [childrenQuery.data]);
  const selected = children.find((child) => child.id === selectedId) ?? children[0];
  if (!token) return <Redirect to="/guardian/login" />;

  const logout = () => {
    clearGuardianSession();
    queryClient.removeQueries({ queryKey: getGetGuardianPortalChildrenQueryKey() });
    setLocation("/guardian/login");
  };
  const retry = () => { void childrenQuery.refetch(); };
  const refresh = () => { void childrenQuery.refetch(); };
  const isLoading = childrenQuery.isLoading;
  const isError = childrenQuery.isError;
  const errorMessage = childrenQuery.error instanceof Error ? childrenQuery.error.message : "تعذر تحميل معلومات الأبناء.";

  return (
    <main dir="rtl" className="guardian-app min-h-[100dvh]">
      <header className="guardian-header">
        <Link href="/guardian" className="guardian-brand" data-testid="link-guardian-home">
          <span className="brand-mark"><GraduationCap size={22} /></span>
          <span><strong>ZacodeHR</strong><small>بوابة الأسرة</small></span>
        </Link>
        <div className="guardian-header-actions">
          <span className="secure-tag"><ShieldCheck size={15} /> حساب ولي أمر آمن</span>
          <button className="logout-button" onClick={logout} data-testid="button-guardian-logout"><LogOut size={17} /><span>تسجيل الخروج</span></button>
        </div>
      </header>
      <div className="portal-shell">
        <section className="welcome-band">
          <div className="welcome-copy">
            <span className="welcome-kicker"><span className="welcome-dot" /> بوابتك لمتابعة الأبناء</span>
            <h1>صباح الخير، <em>{account?.displayName || "ولي الأمر"}</em></h1>
            <p>من هنا تتابع يومهم الدراسي — بخطوة واحدة واطمئنان أكبر.</p>
          </div>
          <div className="welcome-count"><span className="count-mark"><UserRound size={21} /></span><span><b>{account?.childrenCount ?? children.length}</b><small>أبناء مرتبطون</small></span></div>
          <div className="welcome-decoration decor-ring-a" /><div className="welcome-decoration decor-ring-b" />
        </section>

        <section className="children-section">
          <div className="children-heading">
            <div><span className="section-kicker">ملف الأسرة</span><h2>أبنائي <span>{children.length ? `(${children.length})` : ""}</span></h2></div>
            {children.length > 1 && <div className="child-switcher"><label htmlFor="child-picker">عرض ملف</label><div className="picker-wrap"><select id="child-picker" value={selected?.id ?? ""} onChange={(event) => setSelectedId(Number(event.target.value))} data-testid="select-child">{children.map((child) => <option key={child.id} value={child.id}>{child.fullNameAr}</option>)}</select><ChevronDown size={16} /></div></div>}
            <button className="refresh-button" onClick={refresh} disabled={childrenQuery.isFetching} data-testid="button-refresh-children"><RefreshCw size={16} className={childrenQuery.isFetching ? "spin" : ""} /><span>تحديث</span></button>
          </div>
          {isLoading && <ChildSkeleton />}
          {isError && <section className="state-card error-state" role="alert" data-testid="state-children-error"><span className="state-symbol"><CircleAlert size={22} /></span><div><h3>لم نتمكن من تحميل بيانات الأسرة</h3><p>{errorMessage}</p></div><Button onClick={retry} variant="outline" data-testid="button-retry-children"><RefreshCw size={15} /> إعادة المحاولة</Button></section>}
          {!isLoading && !isError && !children.length && <section className="state-card empty-state" data-testid="state-children-empty"><span className="state-symbol"><GraduationCap size={24} /></span><div><h3>لا يوجد أبناء مرتبطون بهذا الحساب</h3><p>إذا كنت تتوقع ظهور بيانات هنا، يرجى التواصل مع إدارة المدرسة للتحقق من ربط حساب ولي الأمر.</p></div></section>}
          {!isLoading && !isError && selected && (
            <article className="child-profile" data-testid={`card-child-${selected.id}`}>
              <div className="child-identity">
                <div className="student-monogram">{selected.fullNameAr.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("")}</div>
                <div className="student-details"><div className="student-name-row"><h3 data-testid={`text-student-name-${selected.id}`}>{selected.fullNameAr}</h3><span className="student-status">{selected.status}</span></div><p>{selected.fullNameEn || selected.studentNumber}</p></div>
                <div className="student-facts"><span><small>الصف</small><b>{[selected.gradeName, selected.className].filter(Boolean).join(" · ") || "غير محدد"}</b></span><span><small>العام الدراسي</small><b>{selected.academicYear || "—"}</b></span><span><small>رقم الطالب</small><b>{selected.studentNumber}</b></span></div>
                <ArrowDownLeft className="identity-arrow" size={19} />
              </div>
              <ChildDetails child={selected} token={token} onChange={() => void queryClient.invalidateQueries({ queryKey: getGetGuardianPortalChildrenQueryKey() })} />
            </article>
          )}
        </section>
        <footer className="portal-footer"><span>بيانات مدرسية خاصة بحسابك</span><span><ShieldCheck size={14} /> محفوظة ضمن بوابة ولي الأمر</span></footer>
      </div>
    </main>
  );
}
