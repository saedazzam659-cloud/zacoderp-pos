import { useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronLeft, FileBarChart, LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { MODULE_GROUPS, SIZE_TIERS, screenKey, type ModuleGroupDef } from "@/lib/menuItems";

// ─────────────────────────────────────────────────────────────────────
// ModuleScreenPicker — reusable module + per-screen selector
//
// Drives the "مخصص" custom picker on /register AND the SuperAdmin
// add-company form (CompanyNew). Single source of truth: MODULE_GROUPS in
// lib/menuItems.ts (same registry behind /admin/menu-permissions).
//
// CONTROLLED. The value is:
//   • moduleKeys — the high-level menuPermission keys that are ON. Enabling
//     a module turns ALL of its `moduleKeys` on; disabling turns them off.
//   • navOff     — route paths the tenant should NOT see. A screen is
//     visible by default (absent from navOff). The consumer maps these to
//     `nav:<path>=false` / `selectedNavOff`.
//
// Tier buttons (صغيرة/متوسطة/كبيرة) replace the whole selection with the
// preset's module set and clear navOff (all screens visible).
// ─────────────────────────────────────────────────────────────────────

export interface ModulePickerValue {
  moduleKeys: string[];
  navOff: string[];
}

interface Props {
  value: ModulePickerValue;
  onChange: (next: ModulePickerValue) => void;
  /** Hide the size-tier preset strip (defaults to shown). */
  hideTiers?: boolean;
  className?: string;
}

function moduleEnabled(group: ModuleGroupDef, set: Set<string>): boolean {
  return group.moduleKeys.some(k => set.has(k));
}

export default function ModuleScreenPicker({ value, onChange, hideTiers, className }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const moduleSet = useMemo(() => new Set(value.moduleKeys), [value.moduleKeys]);
  const navOffSet = useMemo(() => new Set(value.navOff), [value.navOff]);

  const enabledCount = useMemo(
    () => MODULE_GROUPS.filter(g => moduleEnabled(g, moduleSet)).length,
    [moduleSet],
  );

  const toggleExpanded = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Which tier (if any) the current selection exactly matches — so we can
  // highlight the active preset chip.
  const activeTier = useMemo(() => {
    for (const t of SIZE_TIERS) {
      const ts = new Set(t.moduleKeys);
      if (ts.size === moduleSet.size && [...ts].every(k => moduleSet.has(k))) return t.key;
    }
    return null;
  }, [moduleSet]);

  const applyTier = (moduleKeys: string[]) =>
    onChange({ moduleKeys: Array.from(new Set(moduleKeys)), navOff: [] });

  const toggleModule = (group: ModuleGroupDef) => {
    const on = moduleEnabled(group, moduleSet);
    const nextSet = new Set(moduleSet);
    if (on) {
      for (const k of group.moduleKeys) nextSet.delete(k);
    } else {
      for (const k of group.moduleKeys) nextSet.add(k);
    }
    // Turning a module off clears any per-screen overrides we kept for it.
    const groupPaths = new Set(group.screens.map(s => s.path));
    const nextNavOff = on
      ? value.navOff.filter(p => !groupPaths.has(p))
      : value.navOff;
    onChange({ moduleKeys: Array.from(nextSet), navOff: nextNavOff });
  };

  const toggleScreen = (path: string) => {
    const next = new Set(navOffSet);
    next.has(path) ? next.delete(path) : next.add(path);
    onChange({ moduleKeys: value.moduleKeys, navOff: Array.from(next) });
  };

  const setAllScreens = (group: ModuleGroupDef, on: boolean) => {
    const groupPaths = new Set(group.screens.map(s => s.path));
    const next = new Set(value.navOff);
    if (on) {
      for (const p of groupPaths) next.delete(p);
    } else {
      for (const p of groupPaths) next.add(p);
    }
    onChange({ moduleKeys: value.moduleKeys, navOff: Array.from(next) });
  };

  const enableAll = () =>
    onChange({
      moduleKeys: Array.from(new Set(MODULE_GROUPS.flatMap(g => g.moduleKeys))),
      navOff: [],
    });
  const clearAll = () => onChange({ moduleKeys: [], navOff: [] });

  return (
    <div className={cn("space-y-4", className)} dir="rtl">
      {/* Size-tier presets */}
      {!hideTiers && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {SIZE_TIERS.map(t => {
            const active = activeTier === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => applyTier(t.moduleKeys)}
                className={cn(
                  "text-right rounded-xl border p-3 transition-all",
                  active
                    ? "border-primary bg-primary/5 ring-2 ring-primary/30 shadow-sm"
                    : "border-border bg-card hover:border-primary/40 hover:bg-muted/40",
                )}
              >
                <div className="flex items-center gap-2 font-semibold">
                  <span className="text-lg">{t.emoji}</span>
                  <span>{t.label}</span>
                  {active && <Badge variant="secondary" className="ms-auto">محدد</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{t.desc}</p>
              </button>
            );
          })}
        </div>
      )}

      {/* Bulk actions + count */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <LayoutGrid className="h-3.5 w-3.5" />
          مفعّل {enabledCount} من {MODULE_GROUPS.length} وحدة
        </Badge>
        <div className="ms-auto flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={enableAll}>
            تفعيل كل الوحدات
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={clearAll}>
            مسح الكل
          </Button>
        </div>
      </div>

      {/* Module cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {MODULE_GROUPS.map(group => {
          const on = moduleEnabled(group, moduleSet);
          const isOpen = expanded.has(group.key);
          const total = group.screens.length;
          const offInGroup = group.screens.filter(s => navOffSet.has(s.path)).length;
          const onInGroup = total - offInGroup;
          const screensList = group.screens.filter(s => !s.report);
          const reportsList = group.screens.filter(s => s.report);
          return (
            <div
              key={group.key}
              className={cn(
                "rounded-xl border transition-colors",
                on ? "border-primary/30 bg-card" : "border-border bg-muted/30",
              )}
            >
              <div className="flex items-center gap-2 p-3">
                <span className="text-lg shrink-0">{group.emoji}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{group.label}</div>
                  {on && (
                    <div className="text-xs text-muted-foreground">
                      الشاشات المرئية {onInGroup} من {total}
                    </div>
                  )}
                </div>
                {on && total > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleExpanded(group.key)}
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
                    aria-label="توسيع"
                  >
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                  </button>
                )}
                <Switch checked={on} onCheckedChange={() => toggleModule(group)} />
              </div>

              {on && isOpen && total > 0 && (
                <div className="border-t px-3 py-2 space-y-3">
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="outline"
                      className="h-7 text-xs" onClick={() => setAllScreens(group, true)}>
                      تحديد الكل
                    </Button>
                    <Button type="button" size="sm" variant="ghost"
                      className="h-7 text-xs" onClick={() => setAllScreens(group, false)}>
                      إلغاء الكل
                    </Button>
                  </div>

                  {screensList.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        <LayoutGrid className="h-3.5 w-3.5" /> الشاشات
                      </div>
                      {screensList.map(s => (
                        <label key={s.path}
                          className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted/50 cursor-pointer">
                          <span className="text-sm truncate">{s.label}</span>
                          <Switch
                            checked={!navOffSet.has(s.path)}
                            onCheckedChange={() => toggleScreen(s.path)}
                          />
                        </label>
                      ))}
                    </div>
                  )}

                  {reportsList.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        <FileBarChart className="h-3.5 w-3.5" /> التقارير
                      </div>
                      {reportsList.map(s => (
                        <label key={s.path}
                          className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted/50 cursor-pointer">
                          <span className="text-sm truncate">{s.label}</span>
                          <Switch
                            checked={!navOffSet.has(s.path)}
                            onCheckedChange={() => toggleScreen(s.path)}
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
