import { useState } from "react";
import { GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePermission } from "@/hooks/usePermission";
import { SchoolCrudPage, type CrudConfig } from "./SchoolCrud";
import { EnrollmentPromotionDialog } from "./EnrollmentPromotionDialog";
const config: CrudConfig = {
  resource: "enrollments", title: "القيد والتسكين", singular: "قيد", description: "ربط الطالب بالسنة والفصل وتسجيل الرسوم التشغيلية السنوية.",
  fields: [
    { key: "studentId", label: "الطالب", type: "relation", resource: "students", labelKey: "fullNameAr", required: true },
    { key: "academicYearId", label: "السنة الدراسية", type: "relation", resource: "academic-years", labelKey: "name", required: true },
    { key: "classId", label: "الفصل", type: "relation", resource: "classes", labelKey: "name", required: true },
    { key: "enrollmentDate", label: "تاريخ القيد", type: "date", required: true },
    { key: "status", label: "الحالة", type: "select", options: [["active", "نشط"], ["transferred", "منقول"], ["withdrawn", "منسحب"], ["completed", "مكتمل"]] },
    { key: "annualFee", label: "الرسوم السنوية", type: "number" }, { key: "discountAmount", label: "الخصم", type: "number" }, { key: "notes", label: "ملاحظات", type: "textarea" },
  ],
  columns: [{ key: "studentId", label: "الطالب", type: "relation", resource: "students", labelKey: "fullNameAr" }, { key: "academicYearId", label: "السنة", type: "relation", resource: "academic-years", labelKey: "name" }, { key: "classId", label: "الفصل", type: "relation", resource: "classes", labelKey: "name" }, { key: "enrollmentDate", label: "تاريخ القيد", type: "date" }, { key: "status", label: "الحالة", type: "status", options: [["active", "نشط"], ["transferred", "منقول"], ["withdrawn", "منسحب"], ["completed", "مكتمل"]] }, { key: "annualFee", label: "الرسوم", type: "number" }],
};
export default function Enrollments() {
  const [promotionOpen, setPromotionOpen] = useState(false);
  const canCreate = usePermission("school", "create");
  return <>
    <SchoolCrudPage
      config={config}
      headingExtra={canCreate && <Button variant="outline" className="gap-2" onClick={() => setPromotionOpen(true)}>
        <GraduationCap className="h-4 w-4" />ترحيل الطلاب
      </Button>}
    />
    {promotionOpen && <EnrollmentPromotionDialog open={promotionOpen} onOpenChange={setPromotionOpen} />}
  </>;
}
