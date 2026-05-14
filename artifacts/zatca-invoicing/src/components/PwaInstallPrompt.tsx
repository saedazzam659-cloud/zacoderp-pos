import { useEffect, useState } from "react";
import { Download, X, Share, Smartphone } from "lucide-react";

type BIPEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "zatca_pwa_install_dismissed_at";
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isMobile(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 767px)").matches
    || /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as any).standalone === true;
}

function isIOS(): boolean {
  if (typeof window === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window as any).MSStream;
}

function recentlyDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    return Date.now() - Number(raw) < DISMISS_TTL_MS;
  } catch { return false; }
}

export default function PwaInstallPrompt() {
  const [bip, setBip] = useState<BIPEvent | null>(null);
  const [show, setShow] = useState(false);
  const [showIOS, setShowIOS] = useState(false);

  useEffect(() => {
    if (!isMobile() || isStandalone() || recentlyDismissed()) return;

    const onBip = (e: Event) => {
      e.preventDefault();
      setBip(e as BIPEvent);
      setTimeout(() => setShow(true), 1500);
    };
    window.addEventListener("beforeinstallprompt", onBip as EventListener);

    // iOS Safari has no beforeinstallprompt — show manual instructions
    if (isIOS()) {
      const t = setTimeout(() => setShowIOS(true), 2500);
      return () => {
        clearTimeout(t);
        window.removeEventListener("beforeinstallprompt", onBip as EventListener);
      };
    }

    return () => window.removeEventListener("beforeinstallprompt", onBip as EventListener);
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
    setShow(false);
    setShowIOS(false);
  };

  const install = async () => {
    if (!bip) return;
    try {
      await bip.prompt();
      const { outcome } = await bip.userChoice;
      if (outcome === "accepted") {
        setShow(false);
        setBip(null);
      } else {
        dismiss();
      }
    } catch {
      dismiss();
    }
  };

  if (!show && !showIOS) return null;

  return (
    <div className="md:hidden fixed bottom-24 inset-x-4 z-50 animate-in slide-in-from-bottom-5 fade-in duration-500" dir="rtl">
      <div className="relative rounded-2xl bg-gradient-to-br from-emerald-600 via-emerald-500 to-teal-500 shadow-2xl border border-white/20 overflow-hidden">
        <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_top_right,white,transparent_50%)]" />
        <button
          onClick={dismiss}
          className="absolute top-2 end-2 z-10 h-7 w-7 rounded-full bg-white/15 hover:bg-white/25 grid place-items-center text-white transition"
          aria-label="إغلاق"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="relative p-4 pe-10 flex items-center gap-3">
          <div className="h-14 w-14 rounded-2xl bg-white/95 grid place-items-center shrink-0 shadow-inner">
            <Smartphone className="h-7 w-7 text-emerald-600" />
          </div>
          <div className="flex-1 min-w-0 text-white">
            <p className="font-bold text-sm leading-tight">ثبّت زاكود على هاتفك</p>
            <p className="text-[11px] text-white/90 mt-0.5 leading-snug">
              {showIOS
                ? "اضغط مشاركة ثم \"إضافة إلى الشاشة الرئيسية\""
                : "للوصول السريع كأنه تطبيق أصلي — بدون متجر"}
            </p>
          </div>
        </div>

        {showIOS ? (
          <div className="relative px-4 pb-3 flex items-center justify-center gap-1.5 text-white text-xs bg-black/10">
            <span>اضغط</span>
            <Share className="h-4 w-4 text-white" />
            <span>أسفل المتصفح ← أضِف إلى الشاشة الرئيسية</span>
          </div>
        ) : (
          <button
            onClick={install}
            className="relative w-full py-3 bg-white/15 hover:bg-white/25 backdrop-blur text-white font-bold text-sm flex items-center justify-center gap-2 border-t border-white/20 transition"
            data-testid="btn-pwa-install"
          >
            <Download className="h-4 w-4" />
            تثبيت الآن
          </button>
        )}
      </div>
    </div>
  );
}
