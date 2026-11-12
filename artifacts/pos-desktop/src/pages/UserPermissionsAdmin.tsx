// Per-user screen permissions admin. Changes stay in a local draft until the
// administrator saves; the role defaults remain the reference state.

import { useEffect, useMemo, useState } from "react";
import { listLocalUsers, type LocalUser, type LocalSession } from "../lib/standalone";
import {
  SCREEN_KEYS,
  defaultsForRole,
  listUserPermissions,
  replaceUserPermissions,
  computeAllowed,
  type UserPermission,
  type ScreenKey,
} from "../lib/permissions";
import { Page, Card, Empty, btnPrimary, btnSecondary } from "./_adminUi";

function sameScreens(a: Set<ScreenKey>, b: Set<ScreenKey>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

function errorMessage(error: unknown): string {
  return typeof error === "string" ? error : (error as Error)?.message ?? "تعذر حفظ الصلاحيات";
}

export default function UserPermissionsAdmin({
  session,
  onAllowedChange,
}: {
  session: LocalSession;
  onAllowedChange?: (allowed: Set<ScreenKey>) => void;
}) {
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [selected, setSelected] = useState<LocalUser | null>(null);
  const [overrides, setOverrides] = useState<UserPermission[]>([]);
  const [draftAllowed, setDraftAllowed] = useState<Set<ScreenKey>>(new Set());
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingPermissions, setLoadingPermissions] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void listLocalUsers()
      .then((loadedUsers) => {
        if (cancelled) return;
        setUsers(loadedUsers);
        setSelected((current) => current ?? loadedUsers[0] ?? null);
      })
      .catch((loadError) => {
        if (!cancelled) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoadingUsers(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setOverrides([]);
      setDraftAllowed(new Set());
      setLoadingPermissions(false);
      setPermissionsLoaded(false);
      return;
    }

    setLoadingPermissions(true);
    setPermissionsLoaded(false);
    setOverrides([]);
    setDraftAllowed(new Set());
    setMessage("");
    setError("");
    void listUserPermissions(selected.id)
      .then((loadedOverrides) => {
        if (cancelled) return;
        setOverrides(loadedOverrides);
        setDraftAllowed(computeAllowed(selected.role, loadedOverrides));
        setPermissionsLoaded(true);
      })
      .catch((loadError) => {
        if (!cancelled) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoadingPermissions(false);
      });
    return () => { cancelled = true; };
  }, [selected?.id]);

  const defaults = useMemo(
    () => selected ? defaultsForRole(selected.role) : new Set<ScreenKey>(),
    [selected],
  );
  const savedAllowed = useMemo(
    () => selected ? computeAllowed(selected.role, overrides) : new Set<ScreenKey>(),
    [selected, overrides],
  );
  const overrideMap = useMemo(
    () => new Map(overrides.map((override) => [override.screenKey, override.canView])),
    [overrides],
  );
  const isDirty = Boolean(selected) && !sameScreens(draftAllowed, savedAllowed);

  const groups = useMemo(() => {
    const grouped: Record<string, typeof SCREEN_KEYS> = {};
    for (const screen of SCREEN_KEYS) (grouped[screen.group] ??= []).push(screen);
    return grouped;
  }, []);

  if (session.role !== "admin") {
    return <div style={{ padding: 24, color: "#dc2626" }}>هذه الشاشة متاحة للمسؤول فقط.</div>;
  }

  function setAll(enabled: boolean) {
    setDraftAllowed(enabled ? new Set(SCREEN_KEYS.map((screen) => screen.key)) : new Set());
    setMessage("");
    setError("");
  }

  function setGroup(items: typeof SCREEN_KEYS, enabled: boolean) {
    setDraftAllowed((current) => {
      const next = new Set(current);
      for (const screen of items) {
        if (enabled) next.add(screen.key);
        else next.delete(screen.key);
      }
      return next;
    });
    setMessage("");
    setError("");
  }

  function setScreen(key: ScreenKey, enabled: boolean) {
    setDraftAllowed((current) => {
      const next = new Set(current);
      if (enabled) next.add(key);
      else next.delete(key);
      return next;
    });
    setMessage("");
    setError("");
  }

  function chooseUser(user: LocalUser) {
    if (selected?.id === user.id) return;
    if (isDirty && !confirm("لديك تغييرات غير محفوظة. هل تريد تجاهلها والتبديل إلى مستخدم آخر؟")) return;
    setSelected(user);
  }

  function resetDraftToDefaults() {
    setDraftAllowed(new Set(defaults));
    setMessage("");
    setError("");
  }

  async function save() {
    if (!selected || !isDirty || loadingPermissions || !permissionsLoaded || saving) return;
    const selectedUser = selected;
    const nextAllowed = new Set(draftAllowed);
    const nextOverrides = SCREEN_KEYS
      .filter((screen) => nextAllowed.has(screen.key) !== defaults.has(screen.key))
      .map((screen) => ({ screenKey: screen.key, canView: nextAllowed.has(screen.key) }));

    setSaving(true);
    setMessage("");
    setError("");
    try {
      await replaceUserPermissions(
        selectedUser.id,
        SCREEN_KEYS.map((screen) => screen.key),
        nextOverrides,
      );
      setOverrides(nextOverrides.map((override) => ({ ...override, userId: selectedUser.id })));
      setDraftAllowed(nextAllowed);
      if (selectedUser.id === session.userId) {
        onAllowedChange?.(nextAllowed);
      }
      setMessage("تم حفظ إعدادات الصلاحيات بنجاح.");
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  const actionsDisabled = loadingUsers || loadingPermissions || !permissionsLoaded || saving || !selected;
  const compactButton = {
    ...btnSecondary,
    padding: "5px 9px",
    fontSize: 12,
  };

  return (
    <Page title="صلاحيات المستخدمين" subtitle="تخصيص الشاشات لكل مستخدم، بما في ذلك الحسابات المسؤولة">
      <div role="note" style={{
        marginBottom: 12, padding: "10px 12px", borderRadius: 8,
        background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e",
        fontSize: 13, lineHeight: 1.6,
      }}>
        إذا أغلقت شاشة الصلاحيات لحساب مسؤول، فلن يستطيع تعديلها بنفسه؛ يلزم مسؤول آخر لإعادتها.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr)", gap: 16 }}>
        <Card style={{ padding: 8 }}>
          {loadingUsers ? <Empty text="جاري تحميل المستخدمين..." /> : users.length === 0 ? <Empty text="لا يوجد مستخدمون" /> : users.map((user) => (
            <button
              key={user.id}
              type="button"
              disabled={saving}
              onClick={() => chooseUser(user)}
              style={{
                display: "block", width: "100%", textAlign: "right",
                padding: "10px 12px", borderRadius: 8, cursor: saving ? "default" : "pointer",
                border: "1px solid " + (selected?.id === user.id ? "#2563eb" : "transparent"),
                background: selected?.id === user.id ? "#eff6ff" : "transparent",
                fontFamily: "inherit", marginBottom: 4,
              }}
            >
              <div style={{ fontWeight: 600 }}>{user.displayName}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>{user.username} · {user.role === "admin" ? "مسؤول" : "كاشير"}</div>
            </button>
          ))}
        </Card>

        <Card style={{ padding: 16, minWidth: 0 }}>
          {!selected ? <Empty text="اختر مستخدماً" /> : (
            <>
              <div style={{
                display: "flex", justifyContent: "space-between", alignItems: "flex-start",
                flexWrap: "wrap", gap: 12, marginBottom: 14,
              }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{selected.displayName}</div>
                  <div style={{ fontSize: 13, color: "#64748b" }}>
                    الدور: {selected.role === "admin" ? "مسؤول" : "كاشير"} · {draftAllowed.size} شاشة مفعّلة
                    {isDirty && <span style={{ color: "#b45309", marginInlineStart: 8 }}>· تغييرات غير محفوظة</span>}
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button type="button" disabled={actionsDisabled} onClick={() => setAll(true)} style={btnSecondary}>تفعيل الكل</button>
                  <button type="button" disabled={actionsDisabled} onClick={() => setAll(false)} style={btnSecondary}>إغلاق الكل</button>
                  <button type="button" disabled={actionsDisabled || sameScreens(draftAllowed, defaults)} onClick={resetDraftToDefaults} style={btnSecondary}>استرجاع الافتراضي</button>
                  <button type="button" disabled={actionsDisabled || !isDirty} onClick={() => void save()} style={btnPrimary}>
                    {saving ? "جارٍ الحفظ..." : "حفظ الإعدادات"}
                  </button>
                </div>
              </div>

              {error && <div role="alert" style={{ marginBottom: 10, color: "#b91c1c", fontSize: 13 }}>{error}</div>}
              {message && <div role="status" style={{ marginBottom: 10, color: "#15803d", fontSize: 13 }}>{message}</div>}
              {loadingPermissions ? <Empty text="جاري تحميل الصلاحيات..." /> : (
                Object.entries(groups).map(([groupName, items]) => (
                  <div key={groupName} style={{ marginBottom: 16 }}>
                    <div style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      flexWrap: "wrap", gap: 8, marginBottom: 6, paddingBottom: 5,
                      borderBottom: "1px solid #e2e8f0",
                    }}>
                      <div style={{ fontSize: 12, color: "#64748b", fontWeight: 700 }}>{groupName}</div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button type="button" disabled={actionsDisabled} onClick={() => setGroup(items, true)} style={compactButton}>تفعيل</button>
                        <button type="button" disabled={actionsDisabled} onClick={() => setGroup(items, false)} style={compactButton}>إغلاق</button>
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>
                      {items.map((screen) => {
                        const isOn = draftAllowed.has(screen.key);
                        const isOverride = isOn !== defaults.has(screen.key);
                        const wasSavedOverride = overrideMap.has(screen.key);
                        return (
                          <label key={screen.key} style={{
                            display: "flex", alignItems: "center", gap: 10, padding: 10,
                            border: "1px solid " + (isOverride ? "#fbbf24" : "#e2e8f0"),
                            background: isOverride ? "#fffbeb" : "#fff",
                            borderRadius: 8, cursor: actionsDisabled ? "default" : "pointer",
                          }}>
                            <input
                              type="checkbox"
                              checked={isOn}
                              disabled={actionsDisabled}
                              onChange={(event) => setScreen(screen.key, event.target.checked)}
                            />
                            <span style={{ fontSize: 18 }}>{screen.icon}</span>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 13, fontWeight: 600 }}>{screen.label}</div>
                              <div style={{ fontSize: 11, color: "#94a3b8" }}>
                                افتراضي: {defaults.has(screen.key) ? "مفعّل" : "معطّل"}
                                {isOverride && <span style={{ color: "#b45309", marginInlineStart: 6 }}>· مخصص{!wasSavedOverride ? " (غير محفوظ)" : ""}</span>}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </Card>
      </div>
    </Page>
  );
}
