import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Sparkles, X, Wallet, TrendingUp, Building2, CreditCard, PiggyBank, ListFilter } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

interface Account {
  id: number;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  accountType: AccountType;
  parentId?: number | null;
  isActive?: boolean;
  isPosting?: boolean;
}

interface CategoryDef {
  type: AccountType | "all";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  // Tailwind utility groups for the chip + the row badge.
  chip:        string; // unselected chip
  chipActive:  string; // selected chip
  badge:       string;
  ring:        string;
}

const CATEGORIES: CategoryDef[] = [
  { type: "all",       label: "الكل",            icon: ListFilter,  chip: "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100",       chipActive: "bg-slate-900 text-white border-slate-900 shadow-md",                 badge: "bg-slate-100 text-slate-700",   ring: "ring-slate-300" },
  { type: "expense",   label: "المصروفات",       icon: CreditCard,  chip: "bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100",   chipActive: "bg-gradient-to-br from-orange-500 to-amber-500 text-white border-orange-500 shadow-md",   badge: "bg-orange-100 text-orange-700", ring: "ring-orange-300" },
  { type: "revenue",   label: "الإيرادات",       icon: TrendingUp,  chip: "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100", chipActive: "bg-gradient-to-br from-emerald-500 to-green-500 text-white border-emerald-500 shadow-md", badge: "bg-emerald-100 text-emerald-700", ring: "ring-emerald-300" },
  { type: "asset",     label: "الأصول",          icon: Wallet,      chip: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100",          chipActive: "bg-gradient-to-br from-blue-500 to-cyan-500 text-white border-blue-500 shadow-md",       badge: "bg-blue-100 text-blue-700",     ring: "ring-blue-300" },
  { type: "liability", label: "الالتزامات",      icon: Building2,   chip: "bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100",          chipActive: "bg-gradient-to-br from-rose-500 to-red-500 text-white border-rose-500 shadow-md",        badge: "bg-rose-100 text-rose-700",     ring: "ring-rose-300" },
  { type: "equity",    label: "حقوق الملكية",    icon: PiggyBank,   chip: "bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100",  chipActive: "bg-gradient-to-br from-violet-500 to-purple-500 text-white border-violet-500 shadow-md",  badge: "bg-violet-100 text-violet-700", ring: "ring-violet-300" },
];

interface Props {
  open:        boolean;
  onOpenChange:(open: boolean) => void;
  onPick:      (account: Account) => void;
  /** Optional starter category (e.g. "expense") so the dialog opens pre-filtered. */
  initialType?: AccountType | "all";
}

/**
 * Smart Account Browser — a polished modal that lets the user discover
 * accounts by category (expenses/revenue/assets/…) when they don't
 * remember a specific name. Only LEAF posting accounts are returned
 * (anything that's a parent or marked non-posting is hidden), so a pick
 * is always safe to drop into a journal-entry line.
 */
export default function AccountBrowserDialog({ open, onOpenChange, onPick, initialType = "expense" }: Props) {
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const [active, setActive] = useState<AccountType | "all">(initialType);
  const [q, setQ]           = useState("");
  const [hoverIdx, setHoverIdx] = useState(0);
  const inputRef  = useRef<HTMLInputElement>(null);
  const listRef   = useRef<HTMLDivElement>(null);

  const { data: accounts = [], isLoading } = useQuery<Account[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user && open,
    staleTime: 60_000,
  });

  // Parent ids → header accounts that aren't transactable.
  const parentIds = useMemo(() => {
    const s = new Set<number>();
    for (const a of accounts) if (a.parentId != null) s.add(Number(a.parentId));
    return s;
  }, [accounts]);

  const leafActive = useMemo(
    () => accounts.filter(a =>
      a.isActive !== false &&
      a.isPosting !== false &&
      !parentIds.has(Number(a.id)),
    ),
    [accounts, parentIds],
  );

  // Counts per category — shown on each chip so the user sees how many
  // accounts they have in each bucket at a glance.
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: leafActive.length };
    for (const a of leafActive) m[a.accountType] = (m[a.accountType] ?? 0) + 1;
    return m;
  }, [leafActive]);

  const filtered = useMemo(() => {
    const byType = active === "all" ? leafActive : leafActive.filter(a => a.accountType === active);
    const needle = q.trim().toLowerCase();
    if (!needle) return byType;
    return byType.filter(a =>
      a.code.toLowerCase().includes(needle) ||
      a.nameAr.toLowerCase().includes(needle) ||
      (a.nameEn ?? "").toLowerCase().includes(needle),
    );
  }, [leafActive, active, q]);

  // Reset focus on every change so arrow-key nav starts at the top.
  useEffect(() => { setHoverIdx(0); }, [active, q, open]);
  useEffect(() => {
    if (open) {
      setActive(initialType);
      setQ("");
      // Focus the search input so the user can start typing immediately.
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, initialType]);

  // Keep the active row scrolled into view during keyboard navigation.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-idx="${hoverIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [hoverIdx]);

  function pick(a: Account) {
    onPick(a);
    onOpenChange(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHoverIdx(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHoverIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter")    { e.preventDefault(); const a = filtered[hoverIdx]; if (a) pick(a); }
  }

  const activeCat = CATEGORIES.find(c => c.type === active) ?? CATEGORIES[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden gap-0">
        {/* Header */}
        <DialogHeader className="bg-gradient-to-br from-violet-500 via-fuchsia-500 to-pink-500 text-white px-6 py-4">
          <DialogTitle className="flex items-center gap-2.5 text-white text-lg">
            <div className="rounded-lg bg-white/20 backdrop-blur p-1.5">
              <Sparkles className="h-5 w-5" />
            </div>
            مساعد البحث الذكي للحسابات
          </DialogTitle>
          <p className="text-xs text-white/85 mt-1 ms-9">
            اختر فئة (مثلاً المصروفات) لعرض كل حساباتها، أو ابحث بالاسم أو الكود — مناسب عندما لا تتذكر التفاصيل بالضبط.
          </p>
        </DialogHeader>

        {/* Category chips */}
        <div className="px-4 pt-3 pb-2 flex flex-wrap gap-1.5 border-b bg-muted/20">
          {CATEGORIES.map(cat => {
            const Icon = cat.icon;
            const isActive = cat.type === active;
            const n = counts[cat.type] ?? 0;
            return (
              <button
                key={cat.type}
                type="button"
                onClick={() => setActive(cat.type)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all",
                  isActive ? cat.chipActive : cat.chip,
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{cat.label}</span>
                <span className={cn(
                  "rounded-full px-1.5 py-0 text-[10px] font-bold tabular-nums",
                  isActive ? "bg-white/25 text-white" : "bg-white/80 text-slate-600",
                )}>
                  {n}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b bg-background">
          <div className="relative">
            <Search className="absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={onKey}
              placeholder={`ابحث في ${activeCat.label}… (مثال: إيجار، كهرباء، رواتب)`}
              className="ps-3 pe-9 h-10"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ("")}
                className="absolute end-9 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted"
                aria-label="مسح البحث"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center justify-between mt-2 text-[11px] text-muted-foreground">
            <span>↑↓ للتنقل • Enter للاختيار • Esc للإغلاق</span>
            <span className="tabular-nums">{filtered.length} / {leafActive.length} حساب</span>
          </div>
        </div>

        {/* List */}
        <div ref={listRef} className="max-h-[420px] min-h-[240px] overflow-y-auto">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">جارِ التحميل…</div>
          ) : filtered.length === 0 ? (
            <div className="p-10 text-center">
              <div className="mx-auto h-12 w-12 rounded-full bg-muted/50 grid place-items-center mb-3">
                <Search className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">لا توجد نتائج</p>
              <p className="text-xs text-muted-foreground mt-1">
                جرّب تغيير الفئة أو كلمات البحث
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {filtered.map((a, idx) => {
                const cat = CATEGORIES.find(c => c.type === a.accountType) ?? CATEGORIES[0];
                const isHover = idx === hoverIdx;
                return (
                  <li
                    key={a.id}
                    data-row-idx={idx}
                    onMouseEnter={() => setHoverIdx(idx)}
                    onClick={() => pick(a)}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors",
                      isHover ? cn("bg-violet-50/60 ring-2 ring-inset", cat.ring) : "hover:bg-muted/40",
                    )}
                  >
                    <span className={cn("rounded-md px-2 py-0.5 text-[10px] font-bold tabular-nums", cat.badge)}>
                      {cat.label}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums shrink-0 min-w-[70px]">
                      {a.code}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{a.nameAr}</p>
                      {a.nameEn && (
                        <p className="text-[11px] text-muted-foreground truncate">{a.nameEn}</p>
                      )}
                    </div>
                    {isHover && (
                      <span className="text-[10px] text-violet-600 font-semibold whitespace-nowrap">
                        ↵ اختر
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t bg-muted/20 text-[11px] text-muted-foreground flex items-center justify-between">
          <span>يتم عرض الحسابات الفرعية النشطة فقط (تستثنى الحسابات الرئيسية)</span>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onOpenChange(false)}>
            إغلاق
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type { Account as AccountBrowserAccount };
