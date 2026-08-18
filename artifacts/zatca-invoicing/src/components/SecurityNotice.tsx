import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Post-login weak-password security banner.
 *
 * Shows an animated notice for a few seconds right after a login where the
 * server flagged `weakPassword` (password < 6 chars and the user is not
 * exempted by the SuperAdmin), then re-appears every 30 minutes while the
 * session lasts. The flag lives in localStorage ("zatca_sec_notice", set by
 * AuthContext.login) so a page refresh keeps the schedule.
 */
const LS_KEY = "zatca_sec_notice";
const SHOW_MS = 3000;          // visible duration (per the requirement: ~3s)
const REPEAT_MS = 30 * 60_000; // re-show every 30 minutes

export default function SecurityNotice() {
  const { user } = useAuth();
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (!localStorage.getItem(LS_KEY)) return;

    let hideT: ReturnType<typeof setTimeout> | undefined;
    let leaveT: ReturnType<typeof setTimeout> | undefined;

    const showOnce = () => {
      if (!localStorage.getItem(LS_KEY)) return; // may have been cleared
      setLeaving(false);
      setVisible(true);
      leaveT = setTimeout(() => setLeaving(true), SHOW_MS);
      hideT = setTimeout(() => setVisible(false), SHOW_MS + 450);
    };

    const first = setTimeout(showOnce, 700); // let the app settle after login
    const interval = setInterval(showOnce, REPEAT_MS);
    return () => { clearTimeout(first); clearInterval(interval); clearTimeout(hideT); clearTimeout(leaveT); };
  }, [user]);

  if (!visible) return null;

  return (
    <div
      dir="rtl"
      className={`fixed top-4 left-1/2 z-[200] w-[min(94vw,480px)] -translate-x-1/2 ${leaving ? "sec-notice-out" : "sec-notice-in"}`}
      role="alert"
    >
      <div className="rounded-2xl border border-amber-300/70 bg-gradient-to-l from-amber-50 via-orange-50 to-rose-50 shadow-xl shadow-amber-900/10 px-4 py-3.5">
        <div className="flex items-start gap-3">
          <div className="text-2xl leading-none mt-0.5">🔐</div>
          <div className="min-w-0">
            <p className="font-extrabold text-amber-900 text-sm mb-1">تنبيه أمني مهم</p>
            <p className="text-[12.5px] leading-relaxed text-amber-950/90">
              لأمان حسابك، يُرجى تغيير اسم المستخدم وكلمة المرور الافتراضية عند أول تسجيل
              دخول، واختيار كلمة مرور قوية (6 أحرف أو أرقام على الأقل).
            </p>
            <p className="text-[12px] font-semibold text-rose-800 mt-1.5">
              ⚠️ لا تشارك بيانات الدخول مع أي شخص.
            </p>
          </div>
        </div>
      </div>
      <style>{`
        @keyframes secNoticeIn {
          0%   { opacity: 0; transform: translate(-50%, -24px) scale(.96); }
          60%  { opacity: 1; transform: translate(-50%, 4px) scale(1.01); }
          100% { opacity: 1; transform: translate(-50%, 0) scale(1); }
        }
        @keyframes secNoticeOut {
          0%   { opacity: 1; transform: translate(-50%, 0) scale(1); }
          100% { opacity: 0; transform: translate(-50%, -20px) scale(.97); }
        }
        .sec-notice-in  { animation: secNoticeIn .45s cubic-bezier(.2,.9,.3,1.2) both; }
        .sec-notice-out { animation: secNoticeOut .45s ease-in both; }
      `}</style>
    </div>
  );
}
