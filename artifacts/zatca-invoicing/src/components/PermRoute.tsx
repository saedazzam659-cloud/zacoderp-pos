import { Route } from "wouter";
import RequirePermission from "./RequirePermission";
import type { PermAction } from "@/hooks/usePermission";

// ─── PermRoute ────────────────────────────────────────────────────────────
// Drop-in replacement for <Route path component> that gates the rendered
// component behind a permission check. If the user lacks permission, the
// shared "غير مصرح" screen renders instead.
//
// Use:
//   <PermRoute path="/customers" module="customers" component={Customers} />
//
// Notes:
//   - Admin/superadmin always pass (matches backend `requirePermission`).
//   - The sidebar already hides menu items via `permKey`, so this is the
//     belt-and-suspenders guard for direct URL navigation.
// ──────────────────────────────────────────────────────────────────────────

interface Props {
  path: string;
  module: string;
  action?: PermAction;
  component: React.ComponentType<any>;
}

export default function PermRoute({ path, module, action = "view", component: Component }: Props) {
  return (
    <Route path={path}>
      {(params: any) => (
        <RequirePermission module={module} action={action}>
          <Component params={params} />
        </RequirePermission>
      )}
    </Route>
  );
}
