import React from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

export type HubTone =
  | "blue" | "indigo" | "violet" | "fuchsia" | "rose"
  | "amber" | "emerald" | "teal" | "cyan" | "sky"
  | "slate" | "orange" | "lime" | "pink";

const toneStyles: Record<HubTone, { bg: string; fg: string; ring: string; soft: string }> = {
  blue:    { bg: "bg-blue-500",    fg: "text-blue-50",    ring: "ring-blue-200/60",    soft: "bg-blue-50" },
  indigo:  { bg: "bg-indigo-500",  fg: "text-indigo-50",  ring: "ring-indigo-200/60",  soft: "bg-indigo-50" },
  violet:  { bg: "bg-violet-500",  fg: "text-violet-50",  ring: "ring-violet-200/60",  soft: "bg-violet-50" },
  fuchsia: { bg: "bg-fuchsia-500", fg: "text-fuchsia-50", ring: "ring-fuchsia-200/60", soft: "bg-fuchsia-50" },
  rose:    { bg: "bg-rose-500",    fg: "text-rose-50",    ring: "ring-rose-200/60",    soft: "bg-rose-50" },
  amber:   { bg: "bg-amber-500",   fg: "text-amber-50",   ring: "ring-amber-200/60",   soft: "bg-amber-50" },
  emerald: { bg: "bg-emerald-500", fg: "text-emerald-50", ring: "ring-emerald-200/60", soft: "bg-emerald-50" },
  teal:    { bg: "bg-teal-500",    fg: "text-teal-50",    ring: "ring-teal-200/60",    soft: "bg-teal-50" },
  cyan:    { bg: "bg-cyan-500",    fg: "text-cyan-50",    ring: "ring-cyan-200/60",    soft: "bg-cyan-50" },
  sky:     { bg: "bg-sky-500",     fg: "text-sky-50",     ring: "ring-sky-200/60",     soft: "bg-sky-50" },
  slate:   { bg: "bg-slate-600",   fg: "text-slate-50",   ring: "ring-slate-200/60",   soft: "bg-slate-50" },
  orange:  { bg: "bg-orange-500",  fg: "text-orange-50",  ring: "ring-orange-200/60",  soft: "bg-orange-50" },
  lime:    { bg: "bg-lime-500",    fg: "text-lime-50",    ring: "ring-lime-200/60",    soft: "bg-lime-50" },
  pink:    { bg: "bg-pink-500",    fg: "text-pink-50",    ring: "ring-pink-200/60",    soft: "bg-pink-50" },
};

export type HubTile = {
  /** i18n key for the tile label (e.g. "nav.customers") */
  nameKey: string;
  /** i18n key for an optional short description shown beneath the label. */
  descKey?: string;
  /** Route to navigate to. */
  href: string;
  /** Lucide icon component. */
  icon: React.ElementType;
  /** Color tone for the icon backdrop — pick a distinct one per tile. */
  tone: HubTone;
  /** Permission key required to see this tile (matches user.permissions.<permKey>.view). */
  permKey?: string;
  /** When true, hide from non-admin users even if perm is granted. */
  requireAdmin?: boolean;
};

// Mirror of Layout.tsx navItemAllowed: admin/superadmin always see everything,
// otherwise need view perm (and not requireAdmin).
function tileAllowed(tile: HubTile, user: any): boolean {
  if (!user) return false;
  if (user.role === "superadmin" || user.role === "admin") return true;
  if (tile.requireAdmin) return false;
  if (!tile.permKey) return true;
  const perm = (user.permissions ?? {})[tile.permKey];
  return !!perm?.view;
}

export function MenuHub({
  title,
  subtitle,
  icon: HeaderIcon,
  headerTone = "indigo",
  tiles,
  variant = "full",
}: {
  title: string;
  subtitle?: string;
  icon?: React.ElementType;
  headerTone?: HubTone;
  tiles: HubTile[];
  /** "full" = standalone hub page with header banner; "compact" = header strip only, for embedding above other dashboards. */
  variant?: "full" | "compact";
}) {
  const { user } = useAuth() as any;
  const { i18n } = useTranslation();
  const visible = tiles.filter(t => tileAllowed(t, user));
  const isRtl = i18n.dir() === "rtl";
  const Chevron = isRtl ? ChevronLeft : ChevronRight;

  if (variant === "compact") {
    return (
      <div className="rounded-2xl border bg-card p-4 md:p-5 mb-5 shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          {HeaderIcon && (
            <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center shrink-0", toneStyles[headerTone].bg, toneStyles[headerTone].fg)}>
              <HeaderIcon className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-base font-semibold truncate">{title}</h2>
            {subtitle && <p className="text-xs text-muted-foreground truncate">{subtitle}</p>}
          </div>
        </div>
        <HubGrid tiles={visible} compact Chevron={Chevron} />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Hero banner */}
      <div className={cn(
        "relative overflow-hidden rounded-2xl mb-6 md:mb-8 p-6 md:p-8",
        "bg-gradient-to-br from-white to-slate-50 border shadow-sm"
      )}>
        <div className="flex items-center gap-4 md:gap-5">
          {HeaderIcon && (
            <div className={cn(
              "h-14 w-14 md:h-16 md:w-16 rounded-2xl flex items-center justify-center shrink-0 shadow-sm",
              toneStyles[headerTone].bg, toneStyles[headerTone].fg
            )}>
              <HeaderIcon className="h-7 w-7 md:h-8 md:w-8" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-xl md:text-2xl font-bold tracking-tight">{title}</h1>
            {subtitle && <p className="mt-1 text-sm md:text-base text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          {/* No accessible tiles for this user */}
          —
        </div>
      ) : (
        <HubGrid tiles={visible} Chevron={Chevron} />
      )}
    </div>
  );
}

// ─── Grid + Tile ────────────────────────────────────────────────────────────────
function HubGrid({
  tiles, compact = false, Chevron,
}: { tiles: HubTile[]; compact?: boolean; Chevron: React.ElementType }) {
  const { t } = useTranslation();
  return (
    <div className={cn(
      "grid gap-3 md:gap-4",
      compact
        ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
        : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
    )}>
      {tiles.map(tile => (
        <Tile key={tile.href} tile={tile} compact={compact} t={t} Chevron={Chevron} />
      ))}
    </div>
  );
}

function Tile({
  tile, compact, t, Chevron,
}: { tile: HubTile; compact: boolean; t: (k: string) => string; Chevron: React.ElementType }) {
  const Icon = tile.icon;
  const tone = toneStyles[tile.tone];
  return (
    <Link
      href={tile.href}
      className={cn(
        "group relative block rounded-2xl border bg-card transition-all overflow-hidden",
        "hover:shadow-lg hover:-translate-y-0.5 hover:border-slate-300",
        compact ? "p-3" : "p-5"
      )}
    >
        {/* Soft top accent strip */}
        <div className={cn("absolute inset-x-0 top-0 h-1.5", tone.bg, "opacity-90")} />
        <div className={cn("flex flex-col items-center text-center", compact ? "gap-2" : "gap-3 pt-2")}>
          <div className={cn(
            "rounded-2xl flex items-center justify-center transition-transform group-hover:scale-105",
            tone.bg, tone.fg, "ring-4 ring-white shadow-md",
            compact ? "h-12 w-12" : "h-16 w-16 md:h-[72px] md:w-[72px]"
          )}>
            <Icon className={cn(compact ? "h-6 w-6" : "h-8 w-8 md:h-9 md:w-9")} />
          </div>
          <div className="min-w-0 w-full">
            <div className={cn(
              "font-semibold text-foreground leading-tight line-clamp-2",
              compact ? "text-xs" : "text-sm md:text-[15px]"
            )}>
              {t(tile.nameKey)}
            </div>
            {!compact && tile.descKey && (
              <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
                {t(tile.descKey)}
              </div>
            )}
          </div>
        </div>
        {/* Hover affordance */}
        {!compact && (
          <div className="absolute bottom-2 end-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <Chevron className="h-4 w-4 text-muted-foreground" />
          </div>
      )}
    </Link>
  );
}
