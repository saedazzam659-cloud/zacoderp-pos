export default function Overview() {
  return (
    <div
      dir="rtl"
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <div className="absolute -top-[18vh] -left-[12vw] w-[44vw] h-[44vw] rounded-full bg-gradient-to-br from-violet to-primary opacity-25 blur-[140px]" />
      <div className="absolute bottom-[6vh] left-[6vw] font-display font-black text-[15vw] leading-none text-white/[0.04] select-none">
        01
      </div>

      <div className="relative h-full w-full px-[7vw] py-[8vh] grid grid-cols-2 gap-[5vw] items-center">
        <div>
          <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
            نظرة عامة
          </span>
          <h1 className="mt-[2vh] font-display font-black text-[4.6vw] leading-[1.08] tracking-tight text-balance">
            منصّة واحدة تدير
            <span className="bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
              {" "}دورة العمل كاملة
            </span>
          </h1>
          <div className="mt-[3vh] h-[0.6vh] w-[14vw] rounded-full bg-gradient-to-l from-accent via-violet to-primary" />
          <p className="mt-[3.5vh] text-[2vw] text-muted leading-relaxed">
            من الفاتورة الإلكترونية إلى المحاسبة والمخزون والتصنيع — كل البيانات
            مترابطة لحظيًا، بقيود محاسبية تُنشأ تلقائيًا خلف كل عملية.
          </p>
        </div>

        <div className="flex flex-col gap-[2.2vh]">
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.4vh]">
            <span className="font-display text-[2.6vw] font-black bg-gradient-to-br from-primary to-accent bg-clip-text text-transparent">
              +20
            </span>
            <span className="text-[1.9vw] font-bold">وحدة تشغيلية متكاملة</span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.4vh]">
            <span className="font-display text-[2.6vw] font-black bg-gradient-to-br from-teal to-primary bg-clip-text text-transparent">
              ∞
            </span>
            <span className="text-[1.9vw] font-bold">شركات وفروع بلا حدود</span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.4vh]">
            <span className="font-display text-[2.6vw] font-black bg-gradient-to-br from-amber to-accent bg-clip-text text-transparent">
              AI
            </span>
            <span className="text-[1.9vw] font-bold">ذكاء اصطناعي مدمج</span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.4vh]">
            <span className="font-display text-[2.2vw] font-black bg-gradient-to-br from-violet to-primary bg-clip-text text-transparent">
              ☁
            </span>
            <span className="text-[1.9vw] font-bold">سحابي وأوفلاين معًا</span>
          </div>
        </div>
      </div>
    </div>
  );
}
