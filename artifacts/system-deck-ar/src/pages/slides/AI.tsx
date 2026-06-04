export default function AI() {
  return (
    <div
      dir="rtl"
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <div className="absolute -bottom-[20vh] -right-[12vw] w-[48vw] h-[48vw] rounded-full bg-gradient-to-tr from-primary via-violet to-accent opacity-30 blur-[140px]" />
      <div className="absolute top-[6vh] left-[6vw] font-display font-black text-[15vw] leading-none text-white/[0.04] select-none">
        11
      </div>

      <div className="relative h-full w-full px-[7vw] py-[7vh] flex flex-col">
        <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
          الوحدة العاشرة
        </span>
        <h1 className="mt-[1.5vh] font-display font-black text-[4.4vw] leading-[1.06] tracking-tight">
          الذكاء{" "}
          <span className="bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
            الاصطناعي المدمج
          </span>
        </h1>
        <div className="mt-[2vh] h-[0.6vh] w-[14vw] rounded-full bg-gradient-to-l from-accent via-violet to-primary" />

        <div className="mt-[5vh] grid grid-cols-2 grid-rows-2 gap-[2.5vh_2.5vw]">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-primary to-violet" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">التحكم بالصوت والشاشة</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              تنفيذ إجراءات النظام بالأوامر الصوتية ومساعد ذكي للعمليات.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-teal to-primary" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">تقارير وتحليلات ذكية</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              تحليل المبيعات ومراكز التكلفة وصياغة رؤى قابلة للتنفيذ.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-amber to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">توليد المحتوى</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              كتابة أوصاف المنتجات وتحسين الظهور في محركات البحث.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-violet to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">مساعد القيود الضريبية</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              اقتراح القيود المحاسبية مع بدائل قائمة على القواعد عند الحاجة.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
