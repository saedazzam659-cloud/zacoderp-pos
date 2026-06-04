import { useLang, toggleLang } from "@/lib/lang";

export default function LangToggle() {
  const lang = useLang();

  if (
    typeof window !== "undefined" &&
    window.location.pathname.endsWith("/allslides")
  ) {
    return null;
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={toggleLang}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") toggleLang();
      }}
      dir="ltr"
      className="absolute top-[2.6vh] left-1/2 -translate-x-1/2 z-50 flex cursor-pointer select-none items-center gap-[0.7vw] rounded-full border border-white/20 bg-white/10 px-[1.5vw] py-[1vh] text-[1.15vw] font-extrabold backdrop-blur-md transition-colors hover:bg-white/20"
    >
      <span className={lang === "ar" ? "text-white" : "text-muted"}>عربي</span>
      <span className="text-white/30">|</span>
      <span className={lang === "en" ? "text-white" : "text-muted"}>EN</span>
    </div>
  );
}
