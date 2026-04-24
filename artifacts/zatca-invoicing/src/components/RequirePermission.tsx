import { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { usePermission, type PermAction } from "@/hooks/usePermission";

interface Props {
  module: string;
  action?: PermAction;
  children: ReactNode;
  // Render nothing instead of the deny screen (useful when rendering inline).
  silent?: boolean;
}

// ─── RequirePermission ────────────────────────────────────────────────────
// Page-level guard. Wrap <Route component={Foo}/> children, or wrap any
// section. Shows a friendly Arabic "غير مصرح" screen if the user lacks the
// required permission; renders children if allowed.
//
// IMPORTANT: This is NOT a security boundary on its own — the matching API
// endpoints must also enforce `requirePermission`. The frontend guard only
// improves UX (no 403 toasts on every page load).
// ──────────────────────────────────────────────────────────────────────────

export default function RequirePermission({ module, action = "view", children, silent }: Props) {
  const { user } = useAuth() as any;
  const allowed = usePermission(module, action);

  if (!user) return null;        // AuthContext gate covers redirect
  if (allowed) return <>{children}</>;
  if (silent)  return null;

  return (
    <div dir="rtl" className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
      <div className="bg-amber-50 border border-amber-200 rounded-full p-6 mb-4">
        <ShieldAlert className="h-12 w-12 text-amber-600" />
      </div>
      <h1 className="text-2xl font-bold text-foreground">غير مصرح بالوصول</h1>
      <p className="text-sm text-muted-foreground mt-2 max-w-md">
        ليس لديك الصلاحية اللازمة للوصول إلى هذه الصفحة. الرجاء التواصل مع مدير النظام لطلب الصلاحية.
      </p>
      <p className="text-[11px] text-muted-foreground/70 mt-4 font-mono">
        {module} · {action}
      </p>
    </div>
  );
}
