import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SchoolCrudPage, type CrudConfig } from "./SchoolCrud";

const configs: Record<string, CrudConfig> = {
  years: { resource: "academic-years", title: "السنوات الدراسية", singular: "سنة دراسية", description: "تعريف الفترات الدراسية والسنة الحالية.", fields: [
    { key: "name", label: "اسم السنة", required: true }, { key: "startDate", label: "تاريخ البداية", type: "date", required: true }, { key: "endDate", label: "تاريخ النهاية", type: "date", required: true },
    { key: "status", label: "الحالة", type: "select", options: [["planned", "تخطيط"], ["active", "جارية"], ["closed", "مغلقة"]] },
    { key: "isCurrent", label: "السنة الحالية", type: "select", options: [["true", "نعم"], ["false", "لا"]] }, { key: "notes", label: "ملاحظات", type: "textarea" },
  ], columns: [{ key: "name", label: "السنة الدراسية" }, { key: "startDate", label: "من", type: "date" }, { key: "endDate", label: "إلى", type: "date" }, { key: "status", label: "الحالة", type: "status", options: [["planned", "تخطيط"], ["active", "جارية"], ["closed", "مغلقة"]] }, { key: "isCurrent", label: "الحالية", type: "status", options: [["true", "نعم"], ["false", "لا"]] }] },
  grades: { resource: "grades", title: "المراحل والصفوف", singular: "صف", description: "ضبط تسلسل المراحل والصفوف الدراسية من الروضة إلى الصف الثاني عشر.", fields: [
    { key: "stage", label: "المرحلة", type: "select", options: [["kindergarten", "رياض الأطفال"], ["primary", "ابتدائي"], ["middle", "متوسط"], ["secondary", "ثانوي"]], required: true },
    { key: "nameAr", label: "اسم الصف بالعربية", required: true }, { key: "nameEn", label: "الاسم بالإنجليزية" }, { key: "orderNo", label: "الترتيب", type: "number", required: true }, { key: "isActive", label: "الحالة", type: "select", options: [["true", "نشط"], ["false", "موقوف"]] },
  ], defaultValues: { orderNo: 1 }, columns: [{ key: "orderNo", label: "الترتيب", type: "number" }, { key: "stage", label: "المرحلة", type: "status", options: [["kindergarten", "رياض الأطفال"], ["primary", "ابتدائي"], ["middle", "متوسط"], ["secondary", "ثانوي"]] }, { key: "nameAr", label: "الصف" }, { key: "nameEn", label: "بالإنجليزية" }, { key: "isActive", label: "الحالة", type: "status", options: [["true", "نشط"], ["false", "موقوف"]] }] },
  classes: { resource: "classes", title: "الفصول والشُعب", singular: "فصل", description: "توزيع الفصول حسب الموقع والسنة والصف والسعة.", fields: [
    { key: "campusId", label: "المجمّع", type: "relation", resource: "campuses", required: true }, { key: "academicYearId", label: "السنة الدراسية", type: "relation", resource: "academic-years", labelKey: "name", required: true },
    { key: "gradeId", label: "الصف الدراسي", type: "relation", resource: "grades", labelKey: "nameAr", required: true }, { key: "code", label: "رمز الفصل", required: true }, { key: "name", label: "اسم الفصل", required: true },
    { key: "capacity", label: "السعة", type: "number" }, { key: "classTeacherEmployeeId", label: "معلم الفصل", type: "relation", resource: "employees", labelKey: "nameAr" }, { key: "isActive", label: "الحالة", type: "select", options: [["true", "نشط"], ["false", "موقوف"]] }, { key: "notes", label: "ملاحظات", type: "textarea" },
  ], columns: [{ key: "code", label: "الرمز" }, { key: "name", label: "الفصل" }, { key: "gradeId", label: "الصف", type: "relation", resource: "grades", labelKey: "nameAr" }, { key: "academicYearId", label: "السنة", type: "relation", resource: "academic-years", labelKey: "name" }, { key: "capacity", label: "السعة", type: "number" }, { key: "isActive", label: "الحالة", type: "status", options: [["true", "نشط"], ["false", "موقوف"]] }] },
  subjects: { resource: "subjects", title: "المواد الدراسية", singular: "مادة", description: "إدارة المواد وربطها بالصفوف والمعلمين.", fields: [
    { key: "code", label: "رمز المادة", required: true }, { key: "nameAr", label: "اسم المادة بالعربية", required: true }, { key: "nameEn", label: "الاسم بالإنجليزية" },
    { key: "gradeId", label: "الصف", type: "relation", resource: "grades", labelKey: "nameAr" }, { key: "teacherEmployeeId", label: "المعلم", type: "relation", resource: "employees", labelKey: "nameAr" }, { key: "isActive", label: "الحالة", type: "select", options: [["true", "نشطة"], ["false", "موقوفة"]] }, { key: "notes", label: "ملاحظات", type: "textarea" },
  ], columns: [{ key: "code", label: "الرمز" }, { key: "nameAr", label: "المادة" }, { key: "nameEn", label: "بالإنجليزية" }, { key: "gradeId", label: "الصف", type: "relation", resource: "grades", labelKey: "nameAr" }, { key: "teacherEmployeeId", label: "المعلم", type: "relation", resource: "employees", labelKey: "nameAr" }, { key: "isActive", label: "الحالة", type: "status", options: [["true", "نشطة"], ["false", "موقوفة"]] }] },
};
const tabs = [["years", "السنوات"], ["grades", "المراحل والصفوف"], ["classes", "الفصول"], ["subjects", "المواد"]] as const;
export default function Academic() {
  const [tab, setTab] = useState<string>("years");
  return <div dir="rtl"><div className="flex flex-wrap gap-2 px-4 pt-4 sm:px-5" role="tablist" aria-label="بيانات أكاديمية">{tabs.map(([key, label]) => <Button key={key} role="tab" aria-selected={tab === key} variant={tab === key ? "default" : "outline"} size="sm" onClick={() => setTab(key)}>{label}</Button>)}</div><SchoolCrudPage key={tab} config={configs[tab]} /></div>;
}
