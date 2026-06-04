import { useLang } from "@/lib/lang";
import LangToggle from "@/components/LangToggle";

export default function Overview() {
  const lang = useLang();
  return (
    <div
      dir={lang === "ar" ? "rtl" : "ltr"}
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <LangToggle />
      <div className="absolute -top-[18vh] -left-[12vw] w-[44vw] h-[44vw] rounded-full bg-gradient-to-br from-violet to-primary opacity-25 blur-[140px]" />
      <div className="absolute bottom-[6vh] left-[6vw] font-display font-black text-[15vw] leading-none text-white/[0.04] select-none">
        01
      </div>

      <div className="relative h-full w-full px-[7vw] py-[8vh] grid grid-cols-2 gap-[5vw] items-center">
        <div>
          <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
            {lang === "ar" ? "نظرة عامة" : "Overview"}
          </span>
          <h1 className="mt-[2vh] font-display font-black text-[4.6vw] leading-[1.08] tracking-tight text-balance">
            {lang === "ar" ? "منصّة واحدة تدير" : "One Platform Running"}
            <span className="bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
              {lang === "ar" ? " دورة العمل كاملة" : " Your Entire Workflow"}
            </span>
          </h1>
          <div className="mt-[3vh] h-[0.6vh] w-[14vw] rounded-full bg-gradient-to-l from-accent via-violet to-primary" />
          <p className="mt-[3.5vh] text-[2vw] text-muted leading-relaxed">
            {lang === "ar"
              ? "من الفاتورة الإلكترونية إلى المحاسبة والمخزون والتصنيع — كل البيانات مترابطة لحظيًا، بقيود محاسبية تُنشأ تلقائيًا خلف كل عملية."
              : "From e-invoicing to accounting, inventory and manufacturing — all data is linked in real time, with accounting entries generated automatically behind every operation."}
          </p>
        </div>

        <div className="flex flex-col gap-[2.2vh]">
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.4vh]">
            <span className="font-display text-[2.6vw] font-black bg-gradient-to-br from-primary to-accent bg-clip-text text-transparent">
              +20
            </span>
            <span className="text-[1.9vw] font-bold">
              {lang === "ar"
                ? "وحدة تشغيلية متكاملة"
                : "Integrated operational modules"}
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.4vh]">
            <span className="font-display text-[2.6vw] font-black bg-gradient-to-br from-teal to-primary bg-clip-text text-transparent">
              ∞
            </span>
            <span className="text-[1.9vw] font-bold">
              {lang === "ar"
                ? "شركات وفروع بلا حدود"
                : "Unlimited companies & branches"}
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.4vh]">
            <span className="font-display text-[2.6vw] font-black bg-gradient-to-br from-amber to-accent bg-clip-text text-transparent">
              AI
            </span>
            <span className="text-[1.9vw] font-bold">
              {lang === "ar"
                ? "ذكاء اصطناعي مدمج"
                : "Built-in artificial intelligence"}
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.4vh]">
            <span className="font-display text-[2.2vw] font-black bg-gradient-to-br from-violet to-primary bg-clip-text text-transparent">
              ☁
            </span>
            <span className="text-[1.9vw] font-bold">
              {lang === "ar"
                ? "سحابي وأوفلاين معًا"
                : "Cloud & offline together"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
