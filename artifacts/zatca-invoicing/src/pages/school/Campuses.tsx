import { SchoolCrudPage, type CrudConfig } from "./SchoolCrud";
const config: CrudConfig = {
  resource: "campuses", title: "المجمّعات والمدارس", singular: "مجمّع", description: "إدارة مواقع المدرسة وبيانات التواصل والمسؤولية التشغيلية.",
  fields: [
    { key: "code", label: "رمز الموقع", required: true }, { key: "nameAr", label: "الاسم بالعربية", required: true },
    { key: "nameEn", label: "الاسم بالإنجليزية" }, { key: "city", label: "المدينة" },
    { key: "address", label: "العنوان" }, { key: "phone", label: "الهاتف" },
    { key: "email", label: "البريد الإلكتروني", type: "email" }, { key: "managerEmployeeId", label: "الموظف المسؤول", type: "relation", resource: "employees", labelKey: "nameAr" },
    { key: "branchId", label: "الفرع المرتبط", type: "relation", resource: "company-branches", labelKey: "nameAr" },
    { key: "isActive", label: "الحالة", type: "select", options: [["true", "نشط"], ["false", "موقوف"]] },
    { key: "notes", label: "ملاحظات", type: "textarea" },
  ],
  columns: [{ key: "code", label: "الرمز" }, { key: "nameAr", label: "اسم المجمّع" }, { key: "city", label: "المدينة" }, { key: "phone", label: "الهاتف" }, { key: "isActive", label: "الحالة", type: "status", options: [["true", "نشط"], ["false", "موقوف"]] }],
};
export default function Campuses() { return <SchoolCrudPage config={config} />; }
