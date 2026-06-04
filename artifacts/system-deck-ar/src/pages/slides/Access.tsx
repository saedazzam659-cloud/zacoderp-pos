import { useLang } from "@/lib/lang";
import LangToggle from "@/components/LangToggle";

export default function Access() {
  const lang = useLang();
  return (
    <div
      dir={lang === "ar" ? "rtl" : "ltr"}
      className="relative w-screen h-screen overflow-hidden bg-bg font-body text-ink"
    >
      <LangToggle />
      <div className="absolute -top-[18vh] -left-[12vw] w-[44vw] h-[44vw] rounded-full bg-gradient-to-br from-teal via-primary to-violet opacity-25 blur-[140px]" />
      <div className="absolute top-[6vh] left-[6vw] font-display font-black text-[15vw] leading-none text-white/[0.04] select-none">
        12
      </div>

      <div className="relative h-full w-full px-[7vw] py-[7vh] flex flex-col">
        <span className="text-[1.5vw] font-bold tracking-[0.3em] text-teal">
          {lang === "ar" ? "الوحدة الحادية عشرة" : "Module Eleven"}
        </span>
        <h1 className="mt-[1.5vh] font-display font-black text-[4.4vw] leading-[1.06] tracking-tight">
          {lang === "ar" ? "تعدّد الشركات " : "Multi-Company "}
          <span className="bg-gradient-to-l from-primary via-violet to-accent bg-clip-text text-transparent">
            {lang === "ar" ? "وإدارة الصلاحيات" : "& Access Management"}
          </span>
        </h1>
        <div className="mt-[2vh] h-[0.6vh] w-[14vw] rounded-full bg-gradient-to-l from-accent via-violet to-primary" />

        <div className="mt-[5vh] grid grid-cols-2 grid-rows-2 gap-[2.5vh_2.5vw]">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-primary to-violet" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "شركات وفروع متعددة" : "Multiple Companies & Branches"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "إدارة عدة شركات وفروع من منصّة واحدة مع عزل بيانات كل فرع."
                : "Manage several companies and branches from one platform with per-branch data isolation."}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-teal to-primary" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "صلاحيات دقيقة RBAC" : "Granular RBAC"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "تحكّم في وصول كل مستخدم لكل وحدة وعملية على حدة."
                : "Control each user's access to every module and operation individually."}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-amber to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "المشرف الأعلى" : "SuperAdmin"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "لوحة تحكم مركزية لإدارة الاشتراكات وتفعيل الوحدات لكل شركة."
                : "A central dashboard to manage subscriptions and enable modules per company."}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-[3vh_2vw]">
            <span className="inline-block w-[1.6vw] h-[1.6vw] rotate-45 rounded-[4px] bg-gradient-to-br from-violet to-accent" />
            <h3 className="mt-[1.6vh] text-[2.1vw] font-bold">
              {lang === "ar" ? "واجهة ثنائية اللغة" : "Bilingual Interface"}
            </h3>
            <p className="mt-[0.8vh] text-[1.55vw] text-muted leading-relaxed">
              {lang === "ar"
                ? "عربي وإنجليزي بدعم كامل للكتابة من اليمين لليسار RTL."
                : "Arabic and English with full right-to-left (RTL) support."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
