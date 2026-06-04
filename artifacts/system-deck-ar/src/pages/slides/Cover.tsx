export default function Cover() {
  return (
    <div
      dir="rtl"
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <div className="absolute -top-[22vh] -right-[14vw] w-[55vw] h-[55vw] rounded-full bg-gradient-to-br from-primary via-violet to-accent opacity-30 blur-[140px]" />
      <div className="absolute -bottom-[26vh] -left-[10vw] w-[48vw] h-[48vw] rounded-full bg-gradient-to-tr from-teal to-primary opacity-25 blur-[150px]" />
      <div className="absolute top-[8vh] left-[7vw] font-display font-black text-[22vw] leading-none text-white/[0.04] select-none">
        ERP
      </div>

      <div className="relative h-full w-full px-[7vw] py-[8vh] flex flex-col justify-between">
        <div className="flex items-center gap-[0.9vw]">
          <div className="flex h-[3.6vw] w-[3.6vw] items-center justify-center rounded-[1vw] bg-gradient-to-br from-primary via-violet to-accent">
            <span className="font-display text-[2.1vw] font-black text-white">Z</span>
          </div>
          <span className="font-display text-[1.9vw] font-extrabold tracking-tight">
            زاكود <span className="text-muted font-bold">ERP</span>
          </span>
        </div>

        <div className="max-w-[80%]">
          <span className="text-[1.5vw] font-bold tracking-[0.35em] text-teal">
            منظومة تخطيط موارد المؤسسات
          </span>
          <h1 className="mt-[2.5vh] font-display font-black text-[7vw] leading-[1.02] tracking-tight text-balance">
            إدارة أعمالك بالكامل
            <span className="block bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
              في منصّة واحدة ذكية
            </span>
          </h1>
          <p className="mt-[3.5vh] text-[2.1vw] text-muted leading-relaxed max-w-[70%]">
            نظام متكامل للفاتورة الإلكترونية والمحاسبة والمبيعات والمخزون
            والتصنيع — متوافق مع هيئة الزكاة والضريبة والجمارك.
          </p>
        </div>

        <div className="flex items-center gap-[1.5vw]">
          <span className="rounded-full border border-white/15 bg-white/5 px-[1.8vw] py-[1.4vh] text-[1.4vw] font-semibold">
            متعدد الشركات والفروع
          </span>
          <span className="rounded-full border border-white/15 bg-white/5 px-[1.8vw] py-[1.4vh] text-[1.4vw] font-semibold">
            عربي / إنجليزي · RTL
          </span>
          <span className="rounded-full border border-white/15 bg-white/5 px-[1.8vw] py-[1.4vh] text-[1.4vw] font-semibold">
            مدعوم بالذكاء الاصطناعي
          </span>
        </div>
      </div>
    </div>
  );
}
