export default function Zatca() {
  return (
    <div
      dir="rtl"
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <div className="absolute -top-[18vh] -left-[12vw] w-[44vw] h-[44vw] rounded-full bg-gradient-to-br from-primary via-violet to-accent opacity-25 blur-[140px]" />
      <div className="absolute top-[6vh] left-[6vw] font-display font-black text-[15vw] leading-none text-white/[0.04] select-none">
        02
      </div>

      <div className="relative h-full w-full px-[7vw] py-[7vh] flex flex-col">
        <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
          الوحدة الأولى
        </span>
        <h1 className="mt-[1.5vh] font-display font-black text-[4.4vw] leading-[1.06] tracking-tight">
          الفاتورة الإلكترونية{" "}
          <span className="bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
            والامتثال الضريبي
          </span>
        </h1>
        <div className="mt-[2vh] h-[0.6vh] w-[14vw] rounded-full bg-gradient-to-l from-accent via-violet to-primary" />

        <div className="mt-[4.5vh] flex flex-col gap-[2vh]">
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-accent to-primary shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              توليد فواتير UBL 2.1 (XML) المعتمدة من هيئة الزكاة والضريبة والجمارك.
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-violet to-teal shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              إدارة شهادات CSR و CSID والتوقيع الإلكتروني للفواتير.
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-amber to-accent shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              رمز QR بصيغة TLV على كل فاتورة وفق المتطلبات الرسمية.
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-teal to-primary shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              المرحلتان: الإصدار (Generation) والربط والتكامل (Integration).
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-primary to-violet shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              عرض ضريبة القيمة المضافة بالريال على الفواتير بالعملات الأجنبية.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
