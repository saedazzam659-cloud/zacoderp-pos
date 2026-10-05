import { useState } from "react";
import { Link } from "wouter";
import { History, ScanFace, UserRoundCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SchoolCrudPage, type CrudConfig } from "./SchoolCrud";
import { StudentAcademicHistoryDialog } from "./StudentAcademicHistoryDialog";
import type { Row } from "./schoolApi";
import { useGetSchoolStudentFaceEnrollmentStatus } from "@workspace/api-client-react";

const studentConfig: CrudConfig = {
  resource: "students", title: "سجلات الطلاب", singular: "طالب", description: "ملف موحّد للطلاب وبيانات الاتصال الأساسية.",
  fields: [
    { key: "studentNumber", label: "الرقم الطلابي", required: true }, { key: "fullNameAr", label: "اسم الطالب بالعربية", required: true },
    { key: "fullNameEn", label: "الاسم بالإنجليزية" }, { key: "nationalId", label: "رقم الهوية" },
    { key: "gender", label: "الجنس", type: "select", options: [["male", "ذكر"], ["female", "أنثى"], ["unspecified", "غير محدد"]] },
    { key: "birthDate", label: "تاريخ الميلاد", type: "date" }, { key: "phone", label: "الهاتف" },
    { key: "email", label: "البريد الإلكتروني", type: "email" }, { key: "address", label: "العنوان" },
    { key: "status", label: "الحالة", type: "select", options: [["active", "نشط"], ["suspended", "موقوف مؤقتاً"], ["graduated", "متخرج"], ["withdrawn", "منسحب"]] },
    { key: "notes", label: "ملاحظات", type: "textarea" },
  ],
  columns: [{ key: "studentNumber", label: "الرقم الطلابي" }, { key: "fullNameAr", label: "اسم الطالب" }, { key: "nationalId", label: "رقم الهوية" }, { key: "phone", label: "الهاتف" }, { key: "status", label: "الحالة", type: "status", options: [["active", "نشط"], ["suspended", "موقوف مؤقتاً"], ["graduated", "متخرج"], ["withdrawn", "منسحب"]] }],
};
const guardianConfig: CrudConfig = {
  resource: "guardians", title: "أولياء الأمور", singular: "ولي أمر", description: "بيانات التواصل وربط ولي الأمر بملف الطالب والعميل.",
  fields: [
    { key: "studentId", label: "الطالب", type: "relation", resource: "students", labelKey: "fullNameAr", required: true },
    { key: "name", label: "اسم ولي الأمر", required: true }, { key: "relationship", label: "صلة القرابة", required: true },
    { key: "phone", label: "الهاتف" }, { key: "email", label: "البريد الإلكتروني", type: "email" },
    { key: "customerId", label: "حساب ولي الأمر في العملاء", type: "relation", resource: "customers", labelKey: "nameAr" },
    { key: "isPrimary", label: "جهة الاتصال الأساسية", type: "select", options: [["true", "نعم"], ["false", "لا"]] },
    { key: "isInvoicePayer", label: "مسؤول الفاتورة", type: "select", options: [["true", "نعم"], ["false", "لا"]] },
    { key: "notes", label: "ملاحظات", type: "textarea" },
  ],
  columns: [{ key: "name", label: "ولي الأمر" }, { key: "studentId", label: "الطالب", type: "relation", resource: "students", labelKey: "fullNameAr" }, { key: "relationship", label: "صلة القرابة" }, { key: "phone", label: "الهاتف" }, { key: "isInvoicePayer", label: "مسؤول الفاتورة", type: "status", options: [["true", "نعم"], ["false", "لا"]] }],
};
export default function Students() {
  const [tab, setTab] = useState<"students" | "guardians">("students");
  const [historyStudent, setHistoryStudent] = useState<Row | null>(null);
  const faceStatus = useGetSchoolStudentFaceEnrollmentStatus();
  const faceByStudent = new Map((faceStatus.data ?? []).map(item => [item.studentId, item]));
  return <>
    <div dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-5">
        <div className="flex gap-2">
          <Button variant={tab === "students" ? "default" : "outline"} size="sm" onClick={() => setTab("students")}>الطلاب</Button>
          <Button variant={tab === "guardians" ? "default" : "outline"} size="sm" onClick={() => { setHistoryStudent(null); setTab("guardians"); }}>أولياء الأمور</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/school/guardian-accounts" className="inline-flex h-9 items-center gap-2 rounded-md border bg-card px-3 text-sm font-medium hover:bg-muted" data-testid="link-guardian-accounts"><UserRoundCog className="h-4 w-4" />حسابات أولياء الأمور</Link>
          <Link href="/school/face-attendance" className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90" data-testid="link-face-attendance"><ScanFace className="h-4 w-4" />الحضور بالوجه</Link>
        </div>
      </div>
      <SchoolCrudPage
        key={tab}
        config={tab === "students" ? studentConfig : guardianConfig}
        rowAction={tab === "students" ? (row) => (
          <div className="flex items-center gap-1">
            {(() => {
              const face = faceByStudent.get(row.id);
              return face ? <span className={`hidden rounded-full px-2 py-1 text-[11px] font-semibold sm:inline ${face.enrolled ? "bg-teal-100 text-teal-800" : face.consentActive ? "bg-amber-100 text-amber-900" : "bg-muted text-muted-foreground"}`}>{face.enrolled ? "وجه مسجل" : face.consentActive ? "جاهز للتسجيل" : "بلا موافقة"}</span> : faceStatus.isLoading ? <span className="hidden text-[11px] text-muted-foreground sm:inline">...</span> : null;
            })()}
            <Link href={`/school/face-attendance?studentId=${row.id}`} className="inline-flex h-8 items-center justify-center rounded-md px-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="حالة تسجيل الوجه" title="حالة تسجيل الوجه" data-testid={`link-student-face-${row.id}`}><ScanFace className="h-4 w-4" /></Link>
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setHistoryStudent(row)} aria-label="السجل الدراسي" title="السجل الدراسي" data-testid={`button-student-history-${row.id}`}>
              <History className="h-4 w-4" />
            </Button>
          </div>
        ) : undefined}
      />
    </div>
    <StudentAcademicHistoryDialog
      student={historyStudent}
      open={!!historyStudent}
      onOpenChange={(open) => !open && setHistoryStudent(null)}
    />
  </>;
}
