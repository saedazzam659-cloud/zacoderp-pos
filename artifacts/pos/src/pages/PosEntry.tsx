import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  api,
  clearAuth,
  getPosDeviceId,
  getToken,
  setPosSessionId,
  setStoredUser,
  type AuthUser,
  type Branch,
} from "@/lib/api";

type LandingScreen = {
  feature: "pos_cashier" | "pos_returns" | "pos_waiter" | "pos_kitchen";
  path: "/pos" | "/super" | "/returns" | "/waiter" | "/kitchen";
};

const LANDING_SCREENS: Record<string, LandingScreen> = {
  "/pos": { path: "/pos", feature: "pos_cashier" },
  "/super": { path: "/super", feature: "pos_cashier" },
  "/returns": { path: "/returns", feature: "pos_returns" },
  "/waiter": { path: "/waiter", feature: "pos_waiter" },
  "/kitchen": { path: "/kitchen", feature: "pos_kitchen" },
};

export default function PosEntry() {
  const [, navigate] = useLocation();
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cashierOnly, setCashierOnly] = useState(false);

  useEffect(() => {
    let active = true;
    const enter = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!getToken()) {
          navigate("/login");
          return;
        }

        const user: AuthUser = await api.me();
        if (!active) return;
        const screen = LANDING_SCREENS[
          user.role === "cashier" ? "/pos" : String(user.posDefaultScreen ?? "")
        ];
        if (!screen) {
          throw new Error("لم تُعيّن لك شاشة نقاط بيع افتراضية. اطلب من مدير الشركة ضبطها من ملف المستخدم.");
        }
        setCashierOnly(user.role === "cashier");

        const isSuperAdmin = user.role === "superadmin";
        const companyEnabled = user.companyMenuPermissions?.[screen.feature] === true;
        const userAllowed = user.role === "admin" || user.permissions?.[screen.feature]?.view === true;
        if (!isSuperAdmin && (!companyEnabled || !userAllowed)) {
          throw new Error("الشاشة الافتراضية غير متاحة: تحقق من تفعيل موديول الشركة ومنح المستخدم صلاحية العرض.");
        }
        if (!user.companyId) {
          throw new Error("لا توجد شركة مرتبطة بحسابك.");
        }
        setStoredUser(user);

        if (user.role === "cashier") {
          // A station-bound cashier gets the branch from their explicitly
          // assigned terminal; do not require or create a duplicate branch link.
          const terminals = await api.getPosTerminals({ activeOnly: true });
          if (!active) return;
          if (!terminals.length) {
            throw new Error("هذا الحساب غير مرتبط بمحطة بيع نشطة. اطلب من المدير ربطه بمحطة من إعدادات محطات البيع.");
          }

          const current = await api.getCurrentPosSession();
          if (!active) return;
          if (current) {
            const linkedTerminal = terminals.find(item => item.id === current.posTerminalId);
            if (!linkedTerminal || (current.branchId != null && current.branchId !== linkedTerminal.branchId)) {
              throw new Error("الجلسة المفتوحة ليست على محطة بيع نشطة ومربوطة بحسابك.");
            }
            setPosSessionId(current.id);
            localStorage.setItem("pos_branch_id", String(linkedTerminal.branchId));
            localStorage.setItem("pos_terminal_id", String(linkedTerminal.id));
            navigate("/pos");
            return;
          }

          const deviceId = getPosDeviceId();
          const terminal = terminals.find(item => item.machineCode === deviceId && !item.busyUserId)
            ?? terminals.find(item => !item.busyUserId)
            ?? null;
          if (!terminal) {
            throw new Error("محطة البيع المرتبطة بحسابك مستخدمة حالياً. أعد المحاولة بعد إتاحتها.");
          }

          const session = await api.openPosSession({
            branchId: terminal.branchId,
            cashBoxId: null,
            openingCash: 0,
            device: navigator.userAgent.slice(0, 120),
            posTerminalId: terminal.id,
            machineCode: deviceId,
          });
          if (!active) return;
          setPosSessionId(session.id);
          localStorage.setItem("pos_branch_id", String(session.branchId ?? terminal.branchId));
          localStorage.setItem("pos_terminal_id", String(session.posTerminalId ?? terminal.id));
          navigate("/pos");
          return;
        }

        // Strict POS branch scope intentionally applies even to administrators:
        // only existing user-branch links can be used for automatic entry.
        const branches = await api.getBranches(user.companyId, { onlyUserBranches: true });
        if (!active) return;
        if (!branches.length) {
          throw new Error("لا توجد فروع مرتبطة بحسابك. اطلب من المدير ربطك بفرع من تبويب الفروع.");
        }

        const storedBranchId = Number(localStorage.getItem("pos_branch_id") || 0);
        const branch = branches.find((item) => item.id === storedBranchId)
          ?? branches.find((item) => (item as Branch & { isMain?: boolean }).isMain === true)
          ?? branches[0];

        const current = await api.getCurrentPosSession();
        if (!active) return;
        if (current) {
          if (current.branchId != null && !branches.some((item) => item.id === current.branchId)) {
            throw new Error("جلسة نقطة البيع المفتوحة مرتبطة بفرع غير معيّن لحسابك. تواصل مع مدير الشركة قبل المتابعة.");
          }
          setPosSessionId(current.id);
          localStorage.setItem("pos_branch_id", String(current.branchId ?? branch.id));
          if (current.posTerminalId) {
            localStorage.setItem("pos_terminal_id", String(current.posTerminalId));
          } else {
            localStorage.removeItem("pos_terminal_id");
          }
          navigate(screen.path);
          return;
        }

        const terminals = await api.getPosTerminals({ branchId: branch.id, activeOnly: true });
        if (!active) return;
        const deviceId = getPosDeviceId();
        const terminal = terminals.find((item) => item.machineCode === deviceId && !item.busyUserId)
          ?? terminals.find((item) => !item.busyUserId)
          ?? null;

        // Keep the POS-only Cashier role station-bound. Ordinary company users
        // retain the existing manual-session path only when the branch has no
        // active terminals at all.
        if (user.role === "cashier" && !terminal) {
          throw new Error("لا توجد محطة بيع متاحة ومربوطة بحسابك في هذا الفرع.");
        }
        if (terminals.length > 0 && !terminal) {
          throw new Error("كل محطات البيع المسموح بها مشغولة حالياً. أعد المحاولة بعد إتاحة محطة.");
        }

        const storedCashBox = Number(localStorage.getItem("pos_cash_box_id") || 0);
        const session = await api.openPosSession({
          branchId: branch.id,
          cashBoxId: terminal
            ? null
            : Number.isFinite(storedCashBox) && storedCashBox > 0
              ? storedCashBox
              : null,
          openingCash: 0,
          device: navigator.userAgent.slice(0, 120),
          posTerminalId: terminal?.id ?? null,
          machineCode: terminal ? deviceId : null,
        });
        if (!active) return;
        setPosSessionId(session.id);
        localStorage.setItem("pos_branch_id", String(session.branchId ?? branch.id));
        if (session.posTerminalId) {
          localStorage.setItem("pos_terminal_id", String(session.posTerminalId));
        } else {
          localStorage.removeItem("pos_terminal_id");
        }
        navigate(screen.path);
      } catch (cause) {
        if (!active) return;
        if (!getToken()) {
          navigate("/login");
          return;
        }
        setError(cause instanceof Error ? cause.message : "تعذّر فتح شاشة نقاط البيع.");
        setLoading(false);
      }
    };

    void enter();
    return () => {
      active = false;
    };
  }, [navigate, retry]);

  return (
    <main dir="rtl" className="grid min-h-[100dvh] place-items-center bg-slate-50 p-6 text-slate-900">
      <section className="w-full max-w-lg rounded-2xl border bg-white p-7 text-center shadow-sm">
        {loading ? (
          <>
            <LoaderCircle className="mx-auto h-9 w-9 animate-spin text-primary" aria-hidden />
            <h1 className="mt-4 text-xl font-black">جارٍ فتح شاشة نقاط البيع</h1>
            <p role="status" className="mt-2 text-sm leading-6 text-slate-600">
              نتحقق من الصلاحيات والفروع والمحطة، ثم نفتح الجلسة المسموح بها.
            </p>
          </>
        ) : (
          <>
            <AlertTriangle className="mx-auto h-9 w-9 text-amber-600" aria-hidden />
            <h1 className="mt-4 text-xl font-black">تعذّر فتح شاشة البداية</h1>
            <p role="alert" className="mt-2 text-sm leading-6 text-slate-600">{error}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button onClick={() => setRetry((value) => value + 1)} data-testid="button-retry-pos-entry">
                <RefreshCw className="ml-2 h-4 w-4" />
                إعادة المحاولة
              </Button>
              {cashierOnly ? (
                <Button variant="outline" onClick={async () => {
                  try { await api.logout(); } catch { /* local sign-out still proceeds */ }
                  clearAuth();
                  window.location.replace(`${import.meta.env.BASE_URL}login`);
                }}>
                  تسجيل الخروج
                </Button>
              ) : (
                <a href="/" className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-semibold hover:bg-slate-50">
                  العودة إلى النظام الرئيسي
                </a>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
