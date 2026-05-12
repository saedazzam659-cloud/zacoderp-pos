import { useEffect, useState } from "react";
import { MessageCircle, X, Phone } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  PHONE_INTL,
  PHONE_DISPLAY,
  WA_HREF,
  TEL_HREF,
} from "@/components/SaudiContactCta";

// ─── WhatsAppFloat ────────────────────────────────────────────────────
// Persistent floating "Chat on WhatsApp" button shown to *unauthenticated*
// visitors on every public page (Home, Pricing, Login, Register, blog,
// PosLanding, etc.). Logged-in users already have an in-app Support inbox
// + ScreenAssistant + VoiceAssistant, so showing this would just clutter
// their workspace and overlap with the right-side sidebar.
//
// Why bottom-START (visually right in RTL Arabic):
//   - Conventional WhatsApp float position (right side in LTR, start in RTL)
//   - ScreenAssistant lives at bottom-LEFT in RTL (`left-4`), VoiceAssistant
//     is centered — so START is the only free corner for public pages.
//
// Behaviour:
//   - Bubble pulses gently to draw attention without being annoying.
//   - Click expands a small panel with two CTAs (WhatsApp + Tel) plus the
//     phone number, mirroring the SaudiContactCta options the user already
//     sees on Home/Pricing — so messaging is consistent.
//   - User can dismiss for the session (hidden until next browser tab open).
//     We use sessionStorage (not localStorage) so a returning visitor
//     tomorrow gets another chance — the goal is maximizing leads.
//   - We do NOT geo-gate to SA: even a non-Saudi browser may be a Saudi
//     expat researching ZATCA software, an agency evaluating, or a
//     prospective reseller. The phone number is a Saudi WhatsApp Business
//     line, so the targeting is implicit in the number itself.
const DISMISS_KEY = "whatsapp_float_dismissed";

export default function WhatsAppFloat() {
  const { isAuthenticated } = useAuth();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  });

  // Hide the bubble for the rest of this browser session. We don't unmount
  // entirely so React keeps the click handlers wired up if the user reopens.
  function handleDismiss(e: React.MouseEvent) {
    e.stopPropagation();
    setOpen(false);
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // sessionStorage may be unavailable in incognito + strict privacy
      // modes — silently ignore; the in-memory `dismissed` flag still works
      // for the current page lifetime.
    }
  }

  // Close the expanded panel when the user navigates away (history change)
  // or presses Escape — keeps the UI tidy without a full overlay.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Gate: only render for visitors. Logged-in users get the in-app support
  // tools (Support inbox, ScreenAssistant, VoiceAssistant) and don't need
  // an external WhatsApp shortcut — it would also overlap their sidebar.
  if (isAuthenticated) return null;
  if (dismissed) return null;

  return (
    <>
      {/* Expanded panel — appears above the bubble when clicked. Mirrors
          SaudiContactCta's two-button stack (WhatsApp + Tel) so messaging
          stays consistent with what the user sees inline on Home/Pricing. */}
      {open && (
        <div
          dir="rtl"
          className="fixed bottom-24 start-4 z-[60] w-[92vw] max-w-xs rounded-2xl border border-emerald-200 bg-white shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200"
          data-testid="whatsapp-float-panel"
          role="dialog"
          aria-label="تواصل معنا على واتساب"
        >
          <div className="bg-gradient-to-bl from-emerald-600 to-emerald-700 text-white p-4 flex items-start justify-between gap-2">
            <div className="flex-1">
              <div className="font-bold text-base mb-0.5">تحتاج مساعدة؟</div>
              <div className="text-xs opacity-90 leading-relaxed">
                فريق زاكود جاهز للرد على استفساراتك حول الباقات والتركيب وZATCA.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="إغلاق"
              className="shrink-0 -mt-1 -me-1 p-1 rounded-lg hover:bg-white/15 transition-colors"
              data-testid="whatsapp-float-close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-3 space-y-2">
            <a
              href={WA_HREF}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="whatsapp-float-cta"
              className="flex items-center gap-3 rounded-xl bg-[#25D366] hover:bg-[#1faa54] text-white font-bold px-4 py-3 shadow transition-all"
            >
              <MessageCircle className="h-5 w-5 shrink-0" />
              <span className="flex-1 text-sm leading-tight">
                راسلنا على واتساب
                <bdi dir="ltr" className="block text-[11px] font-normal opacity-90">
                  {PHONE_DISPLAY}
                </bdi>
              </span>
            </a>
            <a
              href={TEL_HREF}
              data-testid="whatsapp-float-tel"
              className="flex items-center gap-3 rounded-xl border-2 border-emerald-600 bg-white hover:bg-emerald-50 text-emerald-800 font-bold px-4 py-3 transition-all"
            >
              <Phone className="h-5 w-5 shrink-0" />
              <span className="flex-1 text-sm leading-tight">
                اتصل بنا
                <bdi dir="ltr" className="block text-[11px] font-normal opacity-80">
                  {PHONE_DISPLAY}
                </bdi>
              </span>
            </a>
            <button
              type="button"
              onClick={handleDismiss}
              className="w-full text-center text-[11px] text-slate-500 hover:text-slate-700 py-1 transition-colors"
              data-testid="whatsapp-float-dismiss"
            >
              عدم الإظهار في هذه الجلسة
            </button>
          </div>
        </div>
      )}

      {/* The bubble itself. Position: bottom-START — in RTL this lands on
          the visual RIGHT (the conventional WhatsApp location), in LTR
          it lands on the LEFT. Either way it avoids the bottom-LEFT-RTL
          ScreenAssistant slot used inside the app. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`تواصل معنا على واتساب — ${PHONE_DISPLAY}`}
        aria-expanded={open}
        data-testid="whatsapp-float-bubble"
        className="fixed bottom-6 start-4 z-[55] group"
      >
        {/* Pulsing halo — pure CSS, no JS animation cost. Only animates
            when the panel is closed, so an open dialog is calm. */}
        {!open && (
          <span
            aria-hidden
            className="absolute inset-0 rounded-full bg-[#25D366] opacity-60 animate-ping"
          />
        )}
        <span
          className="relative flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] hover:bg-[#1faa54] text-white shadow-2xl ring-2 ring-white transition-all hover:scale-110"
        >
          {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-7 w-7" />}
        </span>
        {/* Hover label — appears on desktop only, hidden on touch. Helps
            new visitors understand the bubble before clicking. */}
        {!open && (
          <span
            className="hidden md:block absolute bottom-1/2 translate-y-1/2 start-full ms-3 whitespace-nowrap rounded-lg bg-slate-900 text-white text-xs font-bold px-3 py-1.5 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
            dir="rtl"
          >
            تحتاج مساعدة؟ كلّمنا
          </span>
        )}
      </button>
    </>
  );
}

// Re-export so consumers don't need to know about the SaudiContactCta
// dependency for the contact constants.
export { PHONE_INTL, PHONE_DISPLAY, WA_HREF, TEL_HREF };
