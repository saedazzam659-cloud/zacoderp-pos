import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SchoolCrudPage, type CrudConfig } from "./SchoolCrud";

const examConfig: CrudConfig = {
  resource: "exams", title: "الاختبارات", singular: "اختبار", description: "تعريف الاختبارات حسب السنة والفصل والمادة.",
  fields: [
    { key: "academicYearId", label: "السنة الدراسية", type: "relation", resource: "academic-years", labelKey: "name", required: true },
    { key: "classId", label: "الفصل", type: "relation", resource: "classes", labelKey: "name", required: true },
    { key: "subjectId", label: "المادة", type: "relation", resource: "subjects", labelKey: "nameAr", required: true },
    { key: "name", label: "اسم الاختبار", required: true }, { key: "examDate", label: "التاريخ", type: "date", required: true },
    { key: "maxScore", label: "الدرجة القصوى", type: "number", required: true }, { key: "status", label: "الحالة", type: "select", options: [["planned", "مجدول"], ["open", "مفتوح"], ["closed", "مغلق"]] }, { key: "notes", label: "ملاحظات", type: "textarea" },
  ],
  defaultValues: { maxScore: 100, status: "planned" },
  columns: [{ key: "name", label: "الاختبار" }, { key: "examDate", label: "التاريخ", type: "date" }, { key: "classId", label: "الفصل", type: "relation", resource: "classes", labelKey: "name" }, { key: "subjectId", label: "المادة", type: "relation", resource: "subjects", labelKey: "nameAr" }, { key: "maxScore", label: "الدرجة القصوى", type: "number" }, { key: "status", label: "الحالة", type: "status", options: [["planned", "مجدول"], ["open", "مفتوح"], ["closed", "مغلق"]] }],
};
const resultConfig: CrudConfig = {
  resource: "results", title: "نتائج الطلاب", singular: "نتيجة", description: "إدخال ومراجعة درجات الطلاب لكل اختبار.",
  fields: [
    { key: "examId", label: "الاختبار", type: "relation", resource: "exams", labelKey: "name", required: true },
    { key: "enrollmentId", label: "قيد الطالب", type: "relation", resource: "enrollments", required: true },
    { key: "score", label: "الدرجة", type: "number", required: true }, { key: "notes", label: "ملاحظات", type: "textarea" },
  ],
  columns: [{ key: "examId", label: "الاختبار", type: "relation", resource: "exams", labelKey: "name" }, { key: "enrollmentId", label: "القيد", type: "relation", resource: "enrollments" }, { key: "score", label: "الدرجة", type: "number" }, { key: "notes", label: "ملاحظات" }],
};
export default function Assessments() {
  const [tab, setTab] = useState<"exams" | "results">("exams");
  return <div dir="rtl"><div className="flex gap-2 px-4 pt-4 sm:px-5"><Button size="sm" variant={tab === "exams" ? "default" : "outline"} onClick={() => setTab("exams")}>الاختبارات</Button><Button size="sm" variant={tab === "results" ? "default" : "outline"} onClick={() => setTab("results")}>النتائج</Button></div><SchoolCrudPage key={tab} config={tab === "exams" ? examConfig : resultConfig} /></div>;
}
