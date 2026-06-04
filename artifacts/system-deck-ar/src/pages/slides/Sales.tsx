import { useLang } from "@/lib/lang";
import LangToggle from "@/components/LangToggle";

export default function Sales() {
  const lang = useLang();
  return (
    <div
      dir={lang === "ar" ? "rtl" : "ltr"}
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <LangToggle />
      <div className="absolute -top-[18vh] -left-[12vw] w-[44vw] h-[44vw] rounded-full bg-gradient-to-br from-accent via-violet to-primary opacity-25 blur-[140px]" />
      <div className="absolute top-[6vh] left-[6vw] font-display font-black text-[15vw] leading-none text-white/[0.04] select-none">
        04
      </div>

      <div className="relative h-full w-full px-[7vw] py-[7vh] flex flex-col">
        <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
          {lang === "ar" ? "الوحدة الثالثة" : "Module Three"}
        </span>
        <h1 className="mt-[1.5vh] font-display font-black text-[4.4vw] leading-[1.06] tracking-tight">
          {lang === "ar" ? "المبيعات " : "Sales "}
          <span className="bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
            {lang === "ar" ? "ونقاط البيع" : "& Point of Sale"}
          </span>
        </h1>
        <div className="mt-[2vh] h-[0.6vh] w-[14vw] rounded-full bg-gradient-to-l from-accent via-violet to-primary" />

        <div className="mt-[5vh] grid grid-cols-2 grid-rows-2 gap-[2.5vh_2.5vw]">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-primary to-violet" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "دورة مستندات متكاملة" : "Integrated Document Cycle"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "من عرض السعر إلى أمر البيع ثم الفاتورة، مع ربط وتتبّع كامل."
                : "From quotation to sales order to invoice, with full linking and tracking."}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-teal to-primary" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "نقاط البيع POS" : "Point of Sale (POS)"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "واجهة بيع سريعة للويب ونسخة سطح مكتب تعمل دون اتصال بالإنترنت."
                : "A fast web sales interface plus a desktop edition that works offline."}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-amber to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "العملاء والائتمان" : "Customers & Credit"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "حدود ائتمان، مدة استحقاق، وكشوف حساب تفصيلية لكل عميل."
                : "Credit limits, payment terms, and detailed statements for every customer."}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-violet to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "المرتجعات والتعدد" : "Returns & Flexibility"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "مرتجعات مبيعات، تعدد العملات، وقوالب فواتير قابلة للتخصيص."
                : "Sales returns, multi-currency, and customizable invoice templates."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
