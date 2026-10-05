import { useState } from "react";
import { BusFront, MapPinned, Signpost, UsersRound, CircleDot, Route } from "lucide-react";
import { SchoolCrudPage, type CrudConfig } from "./SchoolCrud";

const vehicleConfig: CrudConfig = {
  resource: "transport-vehicles",
  title: "الحافلات", singular: "حافلة",
  description: "سجل موحد للحافلات المملوكة والمستأجرة وحالتها التشغيلية.",
  defaultValues: { ownerType: "school_owned", status: "active" },
  fields: [
    { key: "code", label: "رمز الحافلة", required: true },
    { key: "plateNumber", label: "رقم اللوحة", required: true },
    { key: "ownerType", label: "نوع الملكية", type: "select", required: true, options: [["school_owned", "مملوكة للمدرسة"], ["rented", "مستأجرة"]] },
    { key: "capacity", label: "السعة (طالب)", type: "number", required: true },
    { key: "fixedAssetId", label: "الأصل الثابت المرتبط", type: "relation", resource: "fixed-assets", labelKey: "nameAr", required: true, showWhen: { key: "ownerType", value: "school_owned" } },
    { key: "supplierId", label: "المورّد", type: "relation", resource: "transport-suppliers", labelKey: "nameAr", required: true, showWhen: { key: "ownerType", value: "rented" } },
    { key: "leaseContractNo", label: "رقم عقد الإيجار", required: true, showWhen: { key: "ownerType", value: "rented" } },
    { key: "leaseStartDate", label: "بداية العقد", type: "date", required: true, showWhen: { key: "ownerType", value: "rented" } },
    { key: "leaseEndDate", label: "نهاية العقد", type: "date", required: true, showWhen: { key: "ownerType", value: "rented" } },
    { key: "monthlyRent", label: "الإيجار الشهري", type: "number", required: true, showWhen: { key: "ownerType", value: "rented" } },
    { key: "status", label: "الحالة التشغيلية", type: "select", required: true, options: [["active", "جاهزة"], ["out_of_service", "خارج الخدمة"], ["retired", "مستبعدة"]] },
    { key: "notes", label: "ملاحظات", type: "textarea", clearable: true },
  ],
  columns: [
    { key: "code", label: "الرمز" }, { key: "plateNumber", label: "رقم اللوحة" },
    { key: "ownerType", label: "الملكية", type: "status", options: [["school_owned", "مملوكة"], ["rented", "مستأجرة"]] },
    { key: "fixedAssetId", label: "الأصل الثابت", type: "relation", resource: "fixed-assets", labelKey: "nameAr" },
    { key: "supplierId", label: "المورد", type: "relation", resource: "transport-suppliers", labelKey: "nameAr" },
    { key: "capacity", label: "السعة", type: "number" },
    { key: "status", label: "الحالة", type: "status", options: [["active", "جاهزة"], ["out_of_service", "خارج الخدمة"], ["retired", "مستبعدة"]] },
  ],
};

const routeConfig: CrudConfig = {
  resource: "transport-routes", title: "المسارات", singular: "مسار",
  description: "تخطيط خطوط النقل حسب العام الدراسي والمجمّع والحافلة والطاقم.",
  defaultValues: { direction: "round_trip", isActive: "true" },
  fields: [
    { key: "academicYearId", label: "السنة الدراسية", type: "relation", resource: "academic-years", labelKey: "name", required: true },
    { key: "campusId", label: "المجمّع", type: "relation", resource: "campuses", labelKey: "nameAr", required: true },
    { key: "code", label: "رمز المسار", required: true }, { key: "name", label: "اسم المسار", required: true },
    { key: "vehicleId", label: "الحافلة", type: "relation", resource: "transport-vehicles", labelKey: "code", required: true },
    { key: "driverEmployeeId", label: "السائق", type: "relation", resource: "employees", labelKey: "nameAr", required: true },
    { key: "attendantEmployeeId", label: "المرافق", type: "relation", resource: "employees", labelKey: "nameAr", clearable: true },
    { key: "direction", label: "اتجاه الخدمة", type: "select", required: true, options: [["morning", "صباحي"], ["afternoon", "مسائي"], ["round_trip", "ذهاب وعودة"]] },
    { key: "capacityOverride", label: "السعة المعتمدة للمسار", type: "number", clearable: true },
    { key: "isActive", label: "الحالة", type: "select", options: [["true", "نشط"], ["false", "موقوف"]] },
    { key: "notes", label: "ملاحظات", type: "textarea", clearable: true },
  ],
  columns: [
    { key: "code", label: "الرمز" }, { key: "name", label: "المسار" },
    { key: "campusId", label: "المجمّع", type: "relation", resource: "campuses", labelKey: "nameAr" },
    { key: "vehicleId", label: "الحافلة", type: "relation", resource: "transport-vehicles", labelKey: "code" },
    { key: "direction", label: "الاتجاه", type: "status", options: [["morning", "صباحي"], ["afternoon", "مسائي"], ["round_trip", "ذهاب وعودة"]] },
    { key: "isActive", label: "الحالة", type: "status", options: [["true", "نشط"], ["false", "موقوف"]] },
  ],
};

const stopConfig: CrudConfig = {
  resource: "transport-stops", title: "نقاط التوقف", singular: "نقطة توقف",
  description: "ترتيب نقاط الصعود والنزول ومواعيدها على كل مسار.",
  fields: [
    { key: "routeId", label: "المسار", type: "relation", resource: "transport-routes", labelKey: "name", required: true },
    { key: "sequence", label: "الترتيب", type: "number", required: true },
    { key: "name", label: "اسم النقطة", required: true },
    { key: "address", label: "العنوان", required: true },
    { key: "pickupTime", label: "موعد الصعود", type: "text", clearable: true },
    { key: "dropoffTime", label: "موعد النزول", type: "text", clearable: true },
    { key: "notes", label: "ملاحظات", type: "textarea", clearable: true },
  ],
  columns: [
    { key: "sequence", label: "الترتيب", type: "number" }, { key: "name", label: "نقطة التوقف" },
    { key: "routeId", label: "المسار", type: "relation", resource: "transport-routes", labelKey: "name" },
    { key: "pickupTime", label: "الصعود" }, { key: "dropoffTime", label: "النزول" }, { key: "address", label: "العنوان" },
  ],
};

const assignmentConfig: CrudConfig = {
  resource: "transport-assignments", title: "اشتراكات الطلاب", singular: "اشتراك نقل",
  description: "يُسجل الاشتراك النشط فقط للطالب الذي اختار خدمة النقل؛ لا يُضاف النقل تلقائياً لكل قيد.",
  defaultValues: { serviceType: "round_trip", status: "active" },
  fields: [
    { key: "academicYearId", label: "السنة الدراسية", type: "relation", resource: "academic-years", labelKey: "name", required: true },
    { key: "enrollmentId", label: "قيد الطالب", type: "relation", resource: "enrollments", required: true },
    { key: "routeId", label: "المسار", type: "relation", resource: "transport-routes", labelKey: "name", required: true },
    { key: "pickupStopId", label: "نقطة الصعود", type: "relation", resource: "transport-stops", labelKey: "name", clearable: true, showWhen: { key: "serviceType", value: ["round_trip", "pickup_only"] } },
    { key: "dropoffStopId", label: "نقطة النزول", type: "relation", resource: "transport-stops", labelKey: "name", clearable: true, showWhen: { key: "serviceType", value: ["round_trip", "dropoff_only"] } },
    { key: "serviceType", label: "نوع الخدمة", type: "select", required: true, options: [["round_trip", "ذهاب وعودة"], ["pickup_only", "صعود فقط"], ["dropoff_only", "نزول فقط"]] },
    { key: "startDate", label: "تاريخ بدء الخدمة", type: "date", required: true },
    { key: "endDate", label: "تاريخ انتهاء الخدمة", type: "date", clearable: true },
    { key: "status", label: "الحالة", type: "select", required: true, options: [["active", "نشط"], ["inactive", "غير نشط"]] },
    { key: "notes", label: "ملاحظات", type: "textarea", clearable: true },
  ],
  columns: [
    { key: "enrollmentId", label: "قيد الطالب", type: "relation", resource: "enrollments" },
    { key: "routeId", label: "المسار", type: "relation", resource: "transport-routes", labelKey: "name" },
    { key: "serviceType", label: "الخدمة", type: "status", options: [["round_trip", "ذهاب وعودة"], ["pickup_only", "صعود فقط"], ["dropoff_only", "نزول فقط"]] },
    { key: "startDate", label: "تبدأ في", type: "date" },
    { key: "endDate", label: "تنتهي في", type: "date" },
    { key: "status", label: "الحالة", type: "status", options: [["active", "نشط"], ["inactive", "غير نشط"]] },
  ],
};

const sections = [
  { id: "vehicles", title: "الحافلات", hint: "الأسطول", icon: BusFront, config: vehicleConfig },
  { id: "routes", title: "المسارات", hint: "الخطوط والطاقم", icon: Route, config: routeConfig },
  { id: "stops", title: "نقاط التوقف", hint: "المواعيد والتسلسل", icon: MapPinned, config: stopConfig },
  { id: "assignments", title: "اشتراكات الطلاب", hint: "اختيار اختياري", icon: UsersRound, config: assignmentConfig },
] as const;

export default function Transport() {
  const [active, setActive] = useState<(typeof sections)[number]["id"]>("vehicles");
  const current = sections.find(section => section.id === active)!;
  return (
    <div dir="rtl" className="min-h-[100dvh] space-y-4 bg-[hsl(var(--background))] px-3 py-4 sm:px-5">
      <section className="overflow-hidden rounded-2xl border border-emerald-900/10 bg-gradient-to-l from-emerald-50 via-card to-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 p-4 sm:px-6 sm:py-5">
          <div className="flex items-start gap-3">
            <span className="mt-1 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-800 text-emerald-50 shadow-sm"><BusFront className="h-5 w-5" /></span>
            <div><div className="flex items-center gap-2"><h1 className="text-xl font-extrabold tracking-tight text-emerald-950 sm:text-2xl">النقل المدرسي</h1><span className="hidden items-center gap-1 rounded-full border border-emerald-200 bg-white/70 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 sm:inline-flex"><CircleDot className="h-3 w-3" />إدارة يومية</span></div><p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">تنسيق الأسطول والمسارات ونقاط التوقف واشتراكات الطلاب من مساحة تشغيل واحدة.</p></div>
          </div>
          <div className="rounded-xl border border-emerald-100 bg-white/75 px-3 py-2 text-xs leading-5 text-emerald-950"><strong className="block">اشتراك حسب الاختيار</strong><span className="text-emerald-900/70">لا تُفعّل خدمة النقل إلا بإسناد نشط.</span></div>
        </div>
        <nav aria-label="أقسام النقل المدرسي" className="grid grid-cols-2 border-t border-emerald-900/10 bg-white/55 sm:grid-cols-4">
          {sections.map((section, index) => {
            const Icon = section.icon;
            const selected = active === section.id;
            return <button key={section.id} onClick={() => setActive(section.id)} aria-current={selected ? "page" : undefined} className={`group flex min-h-[66px] items-center gap-3 border-b-2 px-3 py-3 text-start transition-colors sm:px-5 ${selected ? "border-emerald-800 bg-emerald-100/70 text-emerald-950" : "border-transparent text-muted-foreground hover:bg-emerald-50/70 hover:text-emerald-900"} ${index % 2 === 0 ? "border-e border-emerald-900/5" : ""}`}>
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected ? "bg-emerald-800 text-white" : "bg-emerald-900/5 text-emerald-800 group-hover:bg-emerald-100"}`}><Icon className="h-4 w-4" /></span>
              <span><span className="block text-sm font-bold">{section.title}</span><span className="mt-0.5 block text-[11px] opacity-70">{section.hint}</span></span>
            </button>;
          })}
        </nav>
      </section>
      <SchoolCrudPage key={current.id} config={current.config} />
    </div>
  );
}
