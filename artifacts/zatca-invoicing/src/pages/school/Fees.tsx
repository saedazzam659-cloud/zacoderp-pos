import { SchoolCrudPage, type CrudConfig } from "./SchoolCrud";
const config: CrudConfig = {
  resource: "fees", title: "الرسوم المدرسية", singular: "رسم", description: "سجل تشغيلي للرسوم مع مرجع اختياري إلى فاتورة المبيعات القائمة. التحصيل والترحيل يتمان حصراً عبر مسارات ERP الحالية.",
  fields: [
    { key: "enrollmentId", label: "قيد الطالب", type: "relation", resource: "enrollments", required: true },
    { key: "guardianId", label: "ولي الأمر", type: "relation", resource: "guardians", labelKey: "name" },
    { key: "description", label: "وصف الرسم", required: true }, { key: "amount", label: "المبلغ", type: "number", required: true },
    { key: "dueDate", label: "تاريخ الاستحقاق", type: "date" },
    { key: "salesInvoiceId", label: "فاتورة المبيعات المرتبطة", type: "relation", resource: "sales-invoices", labelKey: "docNumber" },
    { key: "status", label: "الحالة", type: "select", options: [["planned", "مستحق"], ["invoiced", "مرتبط بفاتورة"], ["waived", "معفى"]] },
    { key: "notes", label: "ملاحظات", type: "textarea" },
  ],
  columns: [{ key: "description", label: "وصف الرسم" }, { key: "enrollmentId", label: "القيد", type: "relation", resource: "enrollments" }, { key: "amount", label: "المبلغ", type: "number" }, { key: "dueDate", label: "الاستحقاق", type: "date" }, { key: "salesInvoiceId", label: "فاتورة المبيعات", type: "relation", resource: "sales-invoices", labelKey: "docNumber" }, { key: "status", label: "الحالة", type: "status", options: [["planned", "مستحق"], ["invoiced", "مرتبط بفاتورة"], ["waived", "معفى"]] }],
};
export default function Fees() { return <SchoolCrudPage config={config} />; }
