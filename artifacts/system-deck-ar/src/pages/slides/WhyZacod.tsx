export default function WhyZacod() {
  return (
    <div
      dir="rtl"
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <div className="absolute -top-[20vh] -right-[14vw] w-[50vw] h-[50vw] rounded-full bg-gradient-to-br from-primary via-violet to-accent opacity-30 blur-[150px]" />
      <div className="absolute -bottom-[24vh] -left-[10vw] w-[44vw] h-[44vw] rounded-full bg-gradient-to-tr from-teal to-primary opacity-20 blur-[150px]" />
      <div className="absolute top-[6vh] left-[6vw] font-display font-black text-[15vw] leading-none text-white/[0.04] select-none">
        13
      </div>

      <div className="relative h-full w-full px-[7vw] py-[7vh] flex flex-col">
        <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
          القيمة المضافة
        </span>
        <h1 className="mt-[1.5vh] font-display font-black text-[4.6vw] leading-[1.06] tracking-tight">
          لماذا{" "}
          <span className="bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
            زاكود ERP؟
          </span>
        </h1>
        <div className="mt-[2vh] h-[0.6vh] w-[14vw] rounded-full bg-gradient-to-l from-accent via-violet to-primary" />

        <div className="mt-[4.5vh] flex flex-col gap-[1.8vh]">
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-accent to-primary shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              منظومة واحدة بدلاً من أنظمة متفرّقة — بيانات موحّدة وقرار أسرع.
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-violet to-teal shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              امتثال ضريبي كامل لمتطلبات هيئة الزكاة والضريبة والجمارك.
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-amber to-accent shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              قيود محاسبية تلقائية دقيقة خلف كل عملية تشغيلية.
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-teal to-primary shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              يعمل سحابيًا وأوفلاين — مرونة كاملة لكل فروعك ونقاط بيعك.
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-primary to-violet shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              ذكاء اصطناعي يحوّل بياناتك إلى رؤى وقرارات عملية.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
