export default function Manufacturing() {
  return (
    <div
      dir="rtl"
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <div className="absolute -bottom-[20vh] -right-[12vw] w-[46vw] h-[46vw] rounded-full bg-gradient-to-tr from-violet to-accent opacity-25 blur-[140px]" />
      <div className="absolute top-[6vh] left-[6vw] font-display font-black text-[15vw] leading-none text-white/[0.04] select-none">
        07
      </div>

      <div className="relative h-full w-full px-[7vw] py-[7vh] flex flex-col">
        <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
          الوحدة السادسة
        </span>
        <h1 className="mt-[1.5vh] font-display font-black text-[4.4vw] leading-[1.06] tracking-tight">
          التصنيع{" "}
          <span className="bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
            وإدارة الإنتاج
          </span>
        </h1>
        <div className="mt-[2vh] h-[0.6vh] w-[14vw] rounded-full bg-gradient-to-l from-accent via-violet to-primary" />

        <div className="mt-[5vh] grid grid-cols-2 grid-rows-2 gap-[2.5vh_2.5vw]">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-primary to-violet" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">قوائم المواد BOM</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              قوالب مواد خام قياسية تُنسخ تلقائيًا مع تحجيم الكميات.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-teal to-primary" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">أوامر الإنتاج</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              دورة إنتاج بنمط SAP مع صرف المواد للتشغيل تحت التشغيل WIP.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-amber to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">العمالة والتكاليف</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              توزيع العمالة والتكاليف غير المباشرة على تكلفة المنتج النهائي.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-violet to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">الهالك والانحرافات</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              احتساب تكلفة الوحدة المنتجة مع معالجة الهالك وفروق التكلفة.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
