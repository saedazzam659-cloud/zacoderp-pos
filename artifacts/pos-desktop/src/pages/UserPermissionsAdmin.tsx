// Per-user screen permissions admin (Task #207).
// Admin picks a user, then toggles each screen on/off. The role default
// is shown for context; explicit overrides override it. Save persists
// to SQLite and refreshes the current user's cached allowed-set so the
// sidebar updates immediately if the admin tweaked their own perms.

import { useEffect, useMemo, useState } from "react";
import { listLocalUsers, type LocalUser, type LocalSession } from "../lib/standalone";
import {
  SCREEN_KEYS, defaultsForRole, listUserPermissions,
  setPermission, clearAllPermissions, computeAllowed, persistAllowedToLS,
  type UserPermission, type ScreenKey,
} from "../lib/permissions";
import { Page, Card, Empty, btnPrimary, btnSecondary, btnLink } from "./_adminUi";

export default function UserPermissionsAdmin({ session }: { session: LocalSession }) {
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [selected, setSelected] = useState<LocalUser | null>(null);
  const [overrides, setOverrides] = useState<UserPermission[]>([]);
  const [savingKey, setSavingKey] = useState<ScreenKey | null>(null);

  async function refreshUsers() {
    const u = await listLocalUsers();
    setUsers(u);
    if (!selected && u.length) setSelected(u[0]);
  }
  useEffect(() => { void refreshUsers(); }, []);

  useEffect(() => {
    if (!selected) { setOverrides([]); return; }
    void (async () => setOverrides(await listUserPermissions(selected.id)))();
  }, [selected?.id]);

  if (session.role !== "admin") {
    return <div style={{ padding: 24, color: "#dc2626" }}>هذه الشاشة متاحة للمسؤول فقط.</div>;
  }

  const defaults = useMemo(() => selected ? defaultsForRole(selected.role) : new Set<ScreenKey>(), [selected]);
  const effective = useMemo(() => selected ? computeAllowed(selected.role, overrides) : new Set<ScreenKey>(), [selected, overrides]);
  const overrideMap = useMemo(() => new Map(overrides.map((o) => [o.screenKey, o.canView])), [overrides]);

  async function toggle(key: ScreenKey, on: boolean) {
    if (!selected) return;
    setSavingKey(key);
    try {
      await setPermission(selected.id, key, on);
      const next = await listUserPermissions(selected.id);
      setOverrides(next);
      // If we just tweaked the currently-signed-in user, refresh their cache.
      if (selected.id === session.userId) {
        persistAllowedToLS(computeAllowed(selected.role, next));
      }
    } finally { setSavingKey(null); }
  }
  async function resetAll() {
    if (!selected) return;
    if (!confirm("استرجاع الإعدادات الافتراضية للدور؟")) return;
    await clearAllPermissions(selected.id);
    setOverrides([]);
    if (selected.id === session.userId) {
      persistAllowedToLS(defaultsForRole(selected.role));
    }
  }

  // Group screens by group label.
  const groups = useMemo(() => {
    const g: Record<string, typeof SCREEN_KEYS> = {};
    for (const s of SCREEN_KEYS) (g[s.group] ??= []).push(s);
    return g;
  }, []);

  return (
    <Page title="صلاحيات المستخدمين" subtitle="ضع إعداداً خاصاً لكل مستخدم — يتجاوز الإعداد الافتراضي للدور">
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16 }}>
        {/* Users list */}
        <Card style={{ padding: 8 }}>
          {users.length === 0 ? <Empty text="لا يوجد مستخدمون" /> : users.map((u) => (
            <button key={u.id}
              onClick={() => setSelected(u)}
              style={{
                display: "block", width: "100%", textAlign: "right",
                padding: "10px 12px", borderRadius: 8, cursor: "pointer",
                border: "1px solid " + (selected?.id === u.id ? "#2563eb" : "transparent"),
                background: selected?.id === u.id ? "#eff6ff" : "transparent",
                fontFamily: "inherit", marginBottom: 4,
              }}>
              <div style={{ fontWeight: 600 }}>{u.displayName}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>{u.username} · {u.role === "admin" ? "مسؤول" : "كاشير"}</div>
            </button>
          ))}
        </Card>

        {/* Permissions matrix */}
        <Card style={{ padding: 16 }}>
          {!selected ? <Empty text="اختر مستخدماً" /> : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{selected.displayName}</div>
                  <div style={{ fontSize: 13, color: "#64748b" }}>الدور: {selected.role === "admin" ? "مسؤول" : "كاشير"} · {effective.size} شاشة مفعّلة</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={resetAll} style={btnSecondary}>استرجاع الافتراضي</button>
                </div>
              </div>

              {Object.entries(groups).map(([groupName, items]) => (
                <div key={groupName} style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, color: "#64748b", fontWeight: 700, marginBottom: 6, paddingBottom: 4, borderBottom: "1px solid #e2e8f0" }}>{groupName}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>
                    {items.map((s) => {
                      const isOn = effective.has(s.key);
                      const isOverride = overrideMap.has(s.key);
                      const isDefault = defaults.has(s.key);
                      return (
                        <label key={s.key} style={{
                          display: "flex", alignItems: "center", gap: 10, padding: 10,
                          border: "1px solid " + (isOverride ? "#fbbf24" : "#e2e8f0"),
                          background: isOverride ? "#fffbeb" : "#fff",
                          borderRadius: 8, cursor: "pointer",
                        }}>
                          <input type="checkbox" checked={isOn}
                            disabled={savingKey === s.key}
                            onChange={(e) => void toggle(s.key, e.target.checked)} />
                          <span style={{ fontSize: 18 }}>{s.icon}</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</div>
                            <div style={{ fontSize: 11, color: "#94a3b8" }}>
                              افتراضي: {isDefault ? "مفعّل" : "معطّل"}
                              {isOverride && <span style={{ color: "#b45309", marginInlineStart: 6 }}>· مخصص</span>}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}
        </Card>
      </div>
    </Page>
  );
}

void btnPrimary; void btnLink;
