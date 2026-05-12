import { MessageCircle, Phone, ShieldCheck } from "lucide-react";
import { useVisitorCountry } from "@/lib/useVisitorCountry";

const PHONE_INTL    = "+966538089122";
const PHONE_DISPLAY = "+966 53 808 9122";
const PHONE_LOCAL   = "0538089122";
const WA_TEXT       = encodeURIComponent(
  "السلام عليكم، أرغب في الاستفسار عن نظام زاكود المحاسبي.",
);
const WA_HREF  = `https://wa.me/${PHONE_INTL.replace(/^\+/, "")}?text=${WA_TEXT}`;
const TEL_HREF = `tel:${PHONE_INTL}`;

export default function SaudiContactCta({ className }: { className?: string }) {
  // The hook returns [code, setter, explicit]. Until geo resolution is
  // explicit (cookie / query / API echo) the code falls back to the default
  // ("SA"), which would briefly flash this card to non-Saudi visitors. We
  // only render once we have a confirmed signal that the visitor is in SA.
  const [country, , explicit] = useVisitorCountry();
  if (!explicit || country !== "SA") return null;

  return (
    <section
      dir="rtl"
      className={`max-w-5xl mx-auto px-4 py-10 ${className ?? ""}`}
      data-testid="saudi-contact-cta"
    >
      <div className="relative overflow-hidden rounded-3xl border border-emerald-200 bg-gradient-to-bl from-emerald-50 via-white to-emerald-50 shadow-lg">
        {/* Decorative ribbons */}
        <div className="absolute -top-16 -left-16 h-48 w-48 rounded-full bg-emerald-200/40 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-16 -right-16 h-48 w-48 rounded-full bg-teal-200/40 blur-3xl pointer-events-none" />

        <div className="relative grid md:grid-cols-[1fr,auto] gap-6 items-center p-7 md:p-9">
          {/* Left: copy */}
          <div className="text-center md:text-right">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold mb-3">
              <ShieldCheck className="h-3.5 w-3.5" />
              دعم عربي مباشر داخل السعودية
            </span>
            <h2 className="text-2xl md:text-3xl font-extrabold mb-2 text-emerald-950">
              تحتاج مساعدة؟ كلّمنا الآن
            </h2>
            <p className="text-emerald-900/80 leading-relaxed mb-1">
              فريق خدمة العملاء جاهز للرد على استفساراتك حول الباقات،
              التركيب، أو ZATCA — على الواتس أو بمكالمة مباشرة.
            </p>
            <p className="hidden md:block text-xs text-emerald-700/70">
              متاح طوال أيام الأسبوع — من 9 صباحاً حتى 11 مساءً (بتوقيت الرياض).
            </p>
          </div>

          {/* Right: action stack */}
          <div className="flex flex-col gap-3 w-full md:w-auto md:min-w-[280px]">
            <a
              href={WA_HREF}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`راسلنا على واتساب على الرقم ${PHONE_DISPLAY}`}
              data-testid="saudi-cta-whatsapp"
              className="group relative inline-flex items-center justify-between gap-3 rounded-2xl bg-[#25D366] hover:bg-[#1faa54] active:bg-[#198a44] text-white font-bold px-5 py-4 shadow-md hover:shadow-lg transition-all"
            >
              <span className="inline-flex items-center gap-2">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/20 group-hover:bg-white/30 transition-colors">
                  <MessageCircle className="h-5 w-5" />
                </span>
                <span className="text-base leading-tight text-right">
                  راسلنا على واتساب
                  <bdi dir="ltr" className="block text-[11px] font-normal opacity-90 tracking-wide">
                    {PHONE_DISPLAY}
                  </bdi>
                </span>
              </span>
              <span className="hidden sm:inline text-[11px] font-semibold bg-white/15 px-2 py-1 rounded-full">
                رد فوري
              </span>
            </a>

            <a
              href={TEL_HREF}
              aria-label={`اتصل بنا على الرقم ${PHONE_DISPLAY}`}
              data-testid="saudi-cta-call"
              className="group inline-flex items-center justify-between gap-3 rounded-2xl bg-white border-2 border-emerald-600 text-emerald-800 hover:bg-emerald-50 font-bold px-5 py-4 shadow-sm transition-all"
            >
              <span className="inline-flex items-center gap-2">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-white group-hover:bg-emerald-700 transition-colors">
                  <Phone className="h-5 w-5" />
                </span>
                <span className="text-base leading-tight text-right">
                  اتصل بنا
                  <bdi dir="ltr" className="block text-[11px] font-normal opacity-80 tracking-wide">
                    {PHONE_DISPLAY}
                  </bdi>
                </span>
              </span>
              <span className="hidden sm:inline text-[11px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-1 rounded-full">
                مباشر
              </span>
            </a>

            <p className="md:hidden text-center text-[11px] text-emerald-700/70 mt-1">
              متاح من 9 صباحاً حتى 11 مساءً
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export { PHONE_INTL, PHONE_DISPLAY, PHONE_LOCAL, WA_HREF, TEL_HREF };
