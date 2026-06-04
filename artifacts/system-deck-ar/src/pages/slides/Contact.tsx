import { useLang } from "@/lib/lang";
import LangToggle from "@/components/LangToggle";

export default function Contact() {
  const lang = useLang();
  return (
    <div
      dir={lang === "ar" ? "rtl" : "ltr"}
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <LangToggle />
      <div className="absolute -top-[24vh] -right-[14vw] w-[55vw] h-[55vw] rounded-full bg-gradient-to-br from-primary via-violet to-accent opacity-30 blur-[150px]" />
      <div className="absolute -bottom-[26vh] -left-[10vw] w-[48vw] h-[48vw] rounded-full bg-gradient-to-tr from-teal to-primary opacity-25 blur-[150px]" />

      <div className="relative h-full w-full px-[7vw] py-[8vh] flex flex-col justify-between">
        <div className="flex items-center gap-[0.9vw]">
          <div className="flex h-[3.6vw] w-[3.6vw] items-center justify-center rounded-[1vw] bg-gradient-to-br from-primary via-violet to-accent">
            <span className="font-display text-[2.1vw] font-black text-white">Z</span>
          </div>
          <span className="font-display text-[1.9vw] font-extrabold tracking-tight">
            {lang === "ar" ? "زاكود " : "ZACOD "}
            <span className="text-muted font-bold">ERP</span>
          </span>
        </div>

        <div>
          <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
            {lang === "ar" ? "للتواصل والشراكة" : "Contact & Partnership"}
          </span>
          <h1 className="mt-[2vh] font-display font-black text-[5.4vw] leading-[1.04] tracking-tight">
            {lang === "ar" ? "لننقل أعمالك إلى" : "Let's Move Your Business To"}
            <span className="block bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
              {lang === "ar"
                ? "الجيل القادم من الإدارة"
                : "The Next Generation of Management"}
            </span>
          </h1>
          <p className="mt-[3vh] text-[2vw] text-muted leading-relaxed max-w-[80%]">
            {lang === "ar"
              ? "بالاتفاق مع شركة اكتيتك انترناشونال (Aktitech International)"
              : "In partnership with Aktitech International"}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-[2.5vw]">
          <div className="rounded-2xl border border-white/10 bg-white/5 px-[2.2vw] py-[3vh]">
            <span className="text-[1.4vw] font-semibold text-muted">
              {lang === "ar" ? "يمثّلها" : "Represented by"}
            </span>
            <h3 className="mt-[0.6vh] text-[2.4vw] font-bold">
              {lang === "ar" ? "م. ثائر عزام" : "Eng. Thaer Azzam"}
            </h3>
            <p className="mt-[0.6vh] text-[2.1vw] font-extrabold bg-gradient-to-l from-primary to-accent bg-clip-text text-transparent">
              0555325983
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 px-[2.2vw] py-[3vh]">
            <span className="text-[1.4vw] font-semibold text-muted">
              {lang === "ar" ? "مدير القسم التقني" : "Technical Department Manager"}
            </span>
            <h3 className="mt-[0.6vh] text-[2.4vw] font-bold">
              {lang === "ar" ? "م. سعيد عزام" : "Eng. Saeed Azzam"}
            </h3>
            <p className="mt-[0.6vh] text-[2.1vw] font-extrabold bg-gradient-to-l from-teal to-primary bg-clip-text text-transparent">
              0538089122
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
