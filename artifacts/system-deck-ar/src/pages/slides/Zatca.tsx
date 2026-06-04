import { useLang } from "@/lib/lang";
import LangToggle from "@/components/LangToggle";

export default function Zatca() {
  const lang = useLang();
  return (
    <div
      dir={lang === "ar" ? "rtl" : "ltr"}
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <LangToggle />
      <div className="absolute -top-[18vh] -left-[12vw] w-[44vw] h-[44vw] rounded-full bg-gradient-to-br from-primary via-violet to-accent opacity-25 blur-[140px]" />
      <div className="absolute top-[6vh] left-[6vw] font-display font-black text-[15vw] leading-none text-white/[0.04] select-none">
        02
      </div>

      <div className="relative h-full w-full px-[7vw] py-[7vh] flex flex-col">
        <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
          {lang === "ar" ? "الوحدة الأولى" : "Module One"}
        </span>
        <h1 className="mt-[1.5vh] font-display font-black text-[4.4vw] leading-[1.06] tracking-tight">
          {lang === "ar" ? "الفاتورة الإلكترونية " : "E-Invoicing "}
          <span className="bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
            {lang === "ar" ? "والامتثال الضريبي" : "& Tax Compliance"}
          </span>
        </h1>
        <div className="mt-[2vh] h-[0.6vh] w-[14vw] rounded-full bg-gradient-to-l from-accent via-violet to-primary" />

        <div className="mt-[4.5vh] flex flex-col gap-[2vh]">
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-accent to-primary shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              {lang === "ar"
                ? "توليد فواتير UBL 2.1 (XML) المعتمدة من هيئة الزكاة والضريبة والجمارك."
                : "Generation of ZATCA-approved UBL 2.1 (XML) invoices."}
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-violet to-teal shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              {lang === "ar"
                ? "إدارة شهادات CSR و CSID والتوقيع الإلكتروني للفواتير."
                : "Management of CSR & CSID certificates and electronic invoice signing."}
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-amber to-accent shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              {lang === "ar"
                ? "رمز QR بصيغة TLV على كل فاتورة وفق المتطلبات الرسمية."
                : "TLV-format QR code on every invoice per official requirements."}
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-teal to-primary shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              {lang === "ar"
                ? "المرحلتان: الإصدار (Generation) والربط والتكامل (Integration)."
                : "Both ZATCA phases: Generation and Integration."}
            </span>
          </div>
          <div className="flex items-center gap-[1.4vw] rounded-2xl border border-white/10 bg-white/5 px-[2vw] py-[2.2vh]">
            <span className="inline-block w-[1.4vw] h-[1.4vw] rotate-45 rounded-[3px] bg-gradient-to-br from-primary to-violet shrink-0" />
            <span className="text-[1.95vw] font-semibold">
              {lang === "ar"
                ? "عرض ضريبة القيمة المضافة بالريال على الفواتير بالعملات الأجنبية."
                : "VAT shown in SAR on foreign-currency invoices."}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
