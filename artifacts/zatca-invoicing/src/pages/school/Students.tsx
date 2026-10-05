import { useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SchoolCrudPage, type CrudConfig } from "./SchoolCrud";
import { StudentAcademicHistoryDialog } from "./StudentAcademicHistoryDialog";
import type { Row } from "./schoolApi";

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
  return <>
    <div dir="rtl">
      <div className="flex gap-2 px-4 pt-4 sm:px-5">
        <Button variant={tab === "students" ? "default" : "outline"} size="sm" onClick={() => setTab("students")}>الطلاب</Button>
        <Button variant={tab === "guardians" ? "default" : "outline"} size="sm" onClick={() => { setHistoryStudent(null); setTab("guardians"); }}>أولياء الأمور</Button>
      </div>
      <SchoolCrudPage
        key={tab}
        config={tab === "students" ? studentConfig : guardianConfig}
        rowAction={tab === "students" ? (row) => (
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setHistoryStudent(row)} aria-label="السجل الدراسي" title="السجل الدراسي">
            <History className="h-4 w-4" />
          </Button>
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
