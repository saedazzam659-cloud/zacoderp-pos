export default function Inventory() {
  return (
    <div
      dir="rtl"
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <div className="absolute -top-[18vh] -right-[12vw] w-[44vw] h-[44vw] rounded-full bg-gradient-to-br from-teal via-primary to-violet opacity-25 blur-[140px]" />
      <div className="absolute top-[6vh] left-[6vw] font-display font-black text-[15vw] leading-none text-white/[0.04] select-none">
        06
      </div>

      <div className="relative h-full w-full px-[7vw] py-[7vh] flex flex-col">
        <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
          الوحدة الخامسة
        </span>
        <h1 className="mt-[1.5vh] font-display font-black text-[4.4vw] leading-[1.06] tracking-tight">
          المخزون{" "}
          <span className="bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
            والمستودعات
          </span>
        </h1>
        <div className="mt-[2vh] h-[0.6vh] w-[14vw] rounded-full bg-gradient-to-l from-accent via-violet to-primary" />

        <div className="mt-[5vh] grid grid-cols-2 grid-rows-2 gap-[2.5vh_2.5vw]">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-primary to-violet" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">مستودعات متعددة</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              إدارة أرصدة كل مستودع مع منتقي مستودع على مستوى المستند.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-teal to-primary" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">وحدات قياس متعددة</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              تحويل تلقائي بين الوحدات مع تسعير لكل وحدة بيع وشراء.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-amber to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">حركة المخزون والتكلفة</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              سجل حركة لحظي وتكلفة دقيقة تنعكس مباشرة على الحسابات.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-violet to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">الجرد والتسويات</h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              عمليات جرد وتسوية مع قيود تلقائية للفروقات والهالك.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
