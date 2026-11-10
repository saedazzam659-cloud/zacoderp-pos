import "./_group.css";
import { ChevronDown, Clock3, GitBranch, Plus, Search, Trash2, X } from "lucide-react";

const field =
  "h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 shadow-sm outline-none placeholder:text-slate-400";

export function Wide() {
  return (
    <main
      dir="rtl"
      lang="ar"
      className="flex min-h-screen items-center justify-center bg-slate-900/25 p-3 font-sans text-foreground sm:p-5"
    >
      <section className="flex h-[min(96vh,820px)] w-full max-w-[1180px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-gradient-to-l from-violet-50 via-white to-teal-50 px-5 py-4 sm:px-7">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-100 text-violet-700">
              <GitBranch className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900">تعديل مسار الإنتاج</h1>
              <p className="mt-0.5 text-xs text-slate-500">تنظيم واضح للمراحل والموارد قبل إنشاء أوامر جديدة.</p>
            </div>
          </div>
          <button className="rounded-md p-2 text-slate-400 hover:bg-white" aria-label="إغلاق">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 sm:px-7">
          <div className="grid gap-4 rounded-xl border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm font-semibold text-slate-700">
              <span>المنتج المرتبط</span>
              <span className={`${field} flex items-center justify-between font-normal`}>
                <span>فطائر زاكود بالجبن</span><Search className="h-4 w-4 text-slate-400" />
              </span>
            </label>
            <label className="space-y-1.5 text-sm font-semibold text-slate-700">
              <span>اسم المسار</span>
              <span className={`${field} font-normal`}>خط إنتاج المعجنات</span>
            </label>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">مراحل الإنتاج بالترتيب</h2>
              <p className="mt-1 text-xs text-slate-500">تُنسخ هذه الإعدادات إلى أوامر الإنتاج الجديدة.</p>
            </div>
            <button className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-violet-200 bg-white px-3 text-xs font-semibold text-violet-700 shadow-sm hover:bg-violet-50">
              <Plus className="h-4 w-4" /> إضافة مرحلة
            </button>
          </div>

          <article className="rounded-xl border border-violet-200 bg-violet-50/25 p-3 shadow-sm sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-full border-2 border-violet-300 bg-violet-100 text-sm font-bold text-violet-800">1</span>
                <div>
                  <span className="block text-[11px] font-bold text-slate-500">المرحلة 1</span>
                  <span className="text-sm font-semibold text-slate-800">الخلط والتشغيل</span>
                </div>
              </div>
              <button className="rounded-md p-2 text-rose-500 hover:bg-rose-50" aria-label="حذف المرحلة">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(150px,1fr)]">
              <label className="space-y-1.5 text-xs font-semibold text-slate-600">
                <span>اسم المرحلة</span><span className={field}>الخلط والتشغيل</span>
              </label>
              <label className="space-y-1.5 text-xs font-semibold text-slate-600">
                <span>المدة المتوقعة (دقيقة)</span>
                <span className={`${field} flex items-center gap-2`}><Clock3 className="h-4 w-4 text-slate-400" /><span dir="ltr">45</span></span>
              </label>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="space-y-1.5 text-xs font-semibold text-slate-600">
                <span>مركز العمل</span>
                <span className={`${field} flex items-center justify-between font-normal`}>
                  <span>خط المعجنات</span><ChevronDown className="h-4 w-4 text-slate-400" />
                </span>
              </label>
              <label className="space-y-1.5 text-xs font-semibold text-slate-600">
                <span>موارد المرحلة</span>
                <span className={`${field} flex items-center justify-between font-normal`}>
                  <span>آلة + عمالة</span><ChevronDown className="h-4 w-4 text-slate-400" />
                </span>
              </label>
              <label className="space-y-1.5 text-xs font-semibold text-slate-600">
                <span>عدد العمال</span><span className={`${field} font-normal`}>2</span>
              </label>
            </div>

            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <label className="text-xs font-bold text-slate-700">آلات المرحلة البديلة</label>
                  <p className="mt-0.5 text-[11px] text-slate-500">اختر أكثر من آلة لتفعيل الاختيار عند التنفيذ.</p>
                </div>
                <button className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold text-violet-700 hover:bg-violet-50">
                  <Plus className="h-3.5 w-3.5" /> إضافة آلة وقدرة
                </button>
              </div>
              <span className={`${field} flex items-center justify-between font-normal text-slate-500`}>
                <span>ابحث عن آلة لإضافتها...</span><ChevronDown className="h-4 w-4" />
              </span>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-2 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs shadow-sm">
                  <span className="font-bold text-slate-800">خلاط صناعي M-04</span>
                  <span className="rounded-full bg-violet-100 px-1.5 py-0.5 font-semibold text-violet-800">أساسية</span>
                  <span className="text-amber-700">7.5 kW</span>
                  <X className="h-3.5 w-3.5 text-slate-400" />
                </span>
                <span className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
                  <span className="font-semibold text-slate-700">عجانة صناعية M-02</span>
                  <span className="text-amber-700">4.0 kW</span>
                  <X className="h-3.5 w-3.5 text-slate-400" />
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-violet-200 bg-violet-50/80 p-2.5">
                <div>
                  <p className="text-xs font-bold text-violet-950">اختيار الآلة عند تنفيذ المرحلة</p>
                  <p className="mt-1 text-[11px] leading-5 text-violet-800">
                    يختار المنفذ آلة واحدة من البدائل؛ لا تُجمع ساعات الآلات أو تكاليفها.
                  </p>
                </div>
                <span className="flex h-6 w-11 items-center justify-end rounded-full bg-violet-600 p-0.5 shadow-inner" aria-label="مفعّل">
                  <span className="h-5 w-5 rounded-full bg-white shadow-sm" />
                </span>
              </div>
            </div>
          </article>

        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-5 py-3 sm:px-7">
          <p className="text-xs text-slate-500">عند وجود آلة واحدة، يستمر مسارها الحالي دون تغيير.</p>
          <div className="flex gap-2">
            <button className="h-10 rounded-md border border-slate-200 px-4 text-sm font-medium text-slate-600 hover:bg-slate-50">إلغاء</button>
            <button className="h-10 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm">حفظ المسار</button>
          </div>
        </footer>
      </section>
    </main>
  );
}
