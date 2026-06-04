import { useLang } from "@/lib/lang";
import LangToggle from "@/components/LangToggle";

export default function SisterCompanies() {
  const lang = useLang();
  return (
    <div
      dir={lang === "ar" ? "rtl" : "ltr"}
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <LangToggle />
      <div className="absolute -top-[18vh] -left-[12vw] w-[44vw] h-[44vw] rounded-full bg-gradient-to-br from-primary via-teal to-violet opacity-25 blur-[140px]" />
      <div className="absolute top-[6vh] left-[6vw] font-display font-black text-[15vw] leading-none text-white/[0.04] select-none">
        08
      </div>

      <div className="relative h-full w-full px-[7vw] py-[7vh] flex flex-col">
        <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
          {lang === "ar" ? "الوحدة السابعة" : "Module Seven"}
        </span>
        <h1 className="mt-[1.5vh] font-display font-black text-[4.4vw] leading-[1.06] tracking-tight">
          {lang === "ar" ? "الشركات " : "Sister "}
          <span className="bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
            {lang === "ar" ? "الشقيقة" : "Companies"}
          </span>
        </h1>
        <div className="mt-[2vh] h-[0.6vh] w-[14vw] rounded-full bg-gradient-to-l from-accent via-violet to-primary" />

        <div className="mt-[5vh] grid grid-cols-2 grid-rows-2 gap-[2.5vh_2.5vw]">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-primary to-violet" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "تحويلات داخلية" : "Internal Transfers"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "نقل بضائع بين الشركات الشقيقة بقيود تكلفة وإيراد تلقائية."
                : "Move goods between sister companies with automatic cost and revenue entries."}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-teal to-primary" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "المرتجعات" : "Returns"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "عكس دقيق للحسابات واستعادة المخزون بالتكلفة الأصلية."
                : "Precise reversal of the accounts and restoration of inventory at original cost."}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-amber to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "التسويات المالية" : "Financial Settlements"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "تسوية ثنائية الاتجاه (قبض/دفع) مع كشف حساب لكل شركة شقيقة."
                : "Bidirectional settlement (receive/pay) with a statement for each sister company."}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-violet to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "معالجة مستقلة" : "Independent Handling"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "منفصلة عن العملاء لتجنّب تعارض الرقم الضريبي والسجل التجاري."
                : "Separate from customers to avoid VAT-number and commercial-registration conflicts."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
