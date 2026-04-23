import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronLeft, ChevronDown, Search, Loader2, Network, X } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface PickedAccount {
  id: number;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  accountType?: string;
  isPosting?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentAccountId?: number | null;
  /** Account IDs that are linked to a real entity. Shown with a green dot. Not a hard filter. */
  linkedAccountIds?: Set<number> | null;
  /** Filter accounts by type (e.g. ["asset"], ["liability"]). When omitted, all types shown. */
  accountTypes?: string[];
  /** Only allow selecting posting (leaf) accounts. Default true. */
  onlyPosting?: boolean;
  title?: string;
  description?: string;
  onSelect: (account: PickedAccount) => void;
}

export function AccountTreePickerDialog({
  open, onOpenChange, currentAccountId,
  linkedAccountIds = null, accountTypes,
  onlyPosting = true,
  title = "اختر حسابًا من شجرة الحسابات",
  description,
  onSelect,
}: Props) {
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState<number | null>(currentAccountId ?? null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: accounts = [], isLoading } = useQuery<any[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/accounts?companyId=${cid}` : `${API}/api/accounts`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return r.json();
    },
    enabled: open && !!user,
  });

  // Reset selection + scroll into view when (re)opened
  useEffect(() => {
    if (open) {
      setSelectedId(currentAccountId ?? null);
      setSearch("");
      // Scroll the inline panel into view shortly after it mounts
      requestAnimationFrame(() => {
        containerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [open, currentAccountId]);

  // Filter by type
  const typed = useMemo(() => {
    if (!accountTypes?.length) return accounts;
    return accounts.filter((a: any) => accountTypes.includes(a.accountType));
  }, [accounts, accountTypes]);

  // Build children index
  const childrenIndex = useMemo(() => {
    const map = new Map<number | null, any[]>();
    for (const a of typed) {
      const k = a.parentId ?? null;
      const arr = map.get(k) || [];
      arr.push(a);
      map.set(k, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => String(a.code).localeCompare(String(b.code)));
    }
    return map;
  }, [typed]);

  // Determine which accounts match current search (and their ancestors so they remain visible)
  const visibleIds = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null; // null → show all
    const byId = new Map<number, any>(typed.map((a: any) => [a.id, a]));
    const visible = new Set<number>();
    for (const a of typed) {
      const hay = `${a.code} ${a.nameAr ?? ""} ${a.nameEn ?? ""}`.toLowerCase();
      if (hay.includes(q)) {
        let cur: any = a;
        while (cur) {
          visible.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : null;
        }
      }
    }
    return visible;
  }, [typed, search]);

  // Auto-expand path to current selection or matching search
  useEffect(() => {
    if (!accounts.length) return;
    const byId = new Map<number, any>(accounts.map((a: any) => [a.id, a]));
    const next = new Set(expanded);
    const expandTo = (id: number | null | undefined) => {
      let cur = id ? byId.get(id) : null;
      while (cur?.parentId) { next.add(cur.parentId); cur = byId.get(cur.parentId); }
    };
    if (currentAccountId) expandTo(currentAccountId);
    if (visibleIds) for (const id of visibleIds) next.add(id);
    setExpanded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, currentAccountId, visibleIds]);

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selected = useMemo(
    () => (selectedId ? accounts.find((a: any) => a.id === selectedId) : null),
    [selectedId, accounts]
  );

  const isSelectable = (a: any) => {
    if (onlyPosting && !a.isPosting) return false;
    return true;
  };
  const isLinked = (a: any) => !!linkedAccountIds && linkedAccountIds.has(a.id);

  function renderNode(node: any, depth: number): JSX.Element | null {
    if (visibleIds && !visibleIds.has(node.id)) return null;
    const kids = childrenIndex.get(node.id) || [];
    const hasKids = kids.length > 0;
    const isOpen = expanded.has(node.id) || !!visibleIds;
    const selectable = isSelectable(node);
    const isSelected = selectedId === node.id;
    const isCurrent = currentAccountId === node.id;
    return (
      <div key={node.id} className="select-none">
        <div
          className={cn(
            "flex items-center gap-2 py-1.5 px-2 rounded-md text-sm",
            selectable ? "cursor-pointer hover:bg-muted" : "opacity-50 cursor-not-allowed",
            isSelected && "bg-primary/10 ring-1 ring-primary/40",
          )}
          style={{ paddingInlineStart: 8 + depth * 18 }}
          onClick={() => { if (selectable) setSelectedId(node.id); }}
          onDoubleClick={() => {
            if (selectable) {
              onSelect({
                id: node.id, code: node.code, nameAr: node.nameAr, nameEn: node.nameEn,
                accountType: node.accountType, isPosting: node.isPosting,
              });
              onOpenChange(false);
            }
          }}
          data-testid={`tree-account-${node.id}`}
        >
          {hasKids ? (
            <button
              type="button"
              className="p-0.5 hover:bg-muted-foreground/10 rounded"
              onClick={(e) => { e.stopPropagation(); toggle(node.id); }}
            >
              {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
            </button>
          ) : (
            <span className="w-4" />
          )}
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums w-16 shrink-0">{node.code}</span>
          <span className={cn("flex-1 truncate", node.isPosting ? "" : "font-semibold")}>{node.nameAr}</span>
          {isLinked(node) && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200" title="مرتبط بكيان">● مرتبط</span>
          )}
          {isCurrent && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">الحالي</span>
          )}
          {!node.isPosting && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border">رئيسي</span>
          )}
        </div>
        {hasKids && isOpen && (
          <div>{kids.map(k => renderNode(k, depth + 1))}</div>
        )}
      </div>
    );
  }

  const roots = childrenIndex.get(null) || [];

  const handleConfirm = () => {
    if (!selected) return;
    onSelect({
      id: selected.id, code: selected.code, nameAr: selected.nameAr, nameEn: selected.nameEn,
      accountType: selected.accountType, isPosting: selected.isPosting,
    });
    onOpenChange(false);
  };

  if (!open) return null;

  return (
    <Card ref={containerRef as any} className="border-primary/40 shadow-sm" dir="rtl" data-testid="account-tree-panel">
      <CardContent className="p-4 md:p-5 space-y-3">
        <div className="flex items-start justify-between gap-3 border-b pb-3">
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-primary" />
            <div>
              <h3 className="text-base font-bold">{title}</h3>
              {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
            </div>
          </div>
          <Button
            type="button" variant="ghost" size="sm"
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground"
            data-testid="account-tree-close"
          >
            <X className="h-4 w-4" />
            إغلاق
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute top-1/2 -translate-y-1/2 right-3 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="ابحث بالكود أو الاسم..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pe-9"
            data-testid="account-tree-search"
            autoFocus
          />
        </div>

        <ScrollArea className="h-[360px] border rounded-lg p-2 bg-muted/20">
          {isLoading ? (
            <div className="grid place-items-center h-full">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
            </div>
          ) : roots.length === 0 ? (
            <div className="text-center text-muted-foreground py-10 text-sm">لا توجد حسابات</div>
          ) : (
            roots.map(r => renderNode(r, 0))
          )}
        </ScrollArea>

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs text-muted-foreground">
            {selected ? (
              <>المختار: <span className="font-mono">{selected.code}</span> — <strong>{selected.nameAr}</strong></>
            ) : (
              <>اضغط مرتين على الحساب لاختياره مباشرة، أو اختره ثم اضغط "تأكيد"</>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>إلغاء</Button>
            <Button size="sm" onClick={handleConfirm} disabled={!selected || !isSelectable(selected)} data-testid="account-tree-confirm">تأكيد</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
