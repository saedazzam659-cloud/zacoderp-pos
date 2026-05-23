import { useState, useMemo, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Plus, Pencil, Trash2, Target, Search, ChevronLeft, ChevronRight, ChevronDown, FolderTree, Sparkles, TrendingUp, TrendingDown, Scale, ListTree, BarChart3, ExternalLink, Loader2, Lightbulb, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Link } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

type CostCenter = {
  id: number; companyId: number; parentId: number | null;
  code: string; nameAr: string; nameEn: string | null;
  level: number; isPosting: boolean; isActive: boolean;
  notes: string | null;
};

const EMPTY: any = {
  code: "", nameAr: "", nameEn: "",
  parentId: "", level: 1, isPosting: true, isActive: true, notes: "",
};

export default function CostCenters() {
  const { user, token } = useAuth() as any;
  const { t } = useTranslation();
  const { isRtl } = useFormatters();
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const EXPORT_COLS = [
    { key: "code",      header: t("costCenters.code"),     width: 14 },
    { key: "nameAr",    header: t("costCenters.nameAr"),   width: 32 },
    { key: "nameEn",    header: t("costCenters.nameEn"),   width: 32 },
    { key: "level",     header: t("chartOfAccounts.level"), width: 10 },
    { key: "isPosting", header: t("costCenters.isPosting"), width: 10 },
    { key: "isActive",  header: t("costCenters.isActive"),  width: 10 },
  ];

  // ── Tab state synced to URL (?tab=analysis) so navigating to a JE and
  // hitting browser-back returns to the same tab. `replace: true` keeps
  // history clean — only the JE link click pushes a forward entry.
  const [, setLocation] = useLocation();
  const searchString    = useSearch();
  const initialTab      = useMemo(() => {
    const t = new URLSearchParams(searchString || "").get("tab");
    return t === "analysis" ? "analysis" : "manage";
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [tab, setTab]   = useState<string>(initialTab);
  useEffect(() => {
    const next = new URLSearchParams(searchString || "");
    if (tab === "analysis") next.set("tab", "analysis");
    else next.delete("tab");
    const nextStr = next.toString();
    const currentStr = new URLSearchParams(searchString || "").toString();
    if (nextStr !== currentStr) {
      setLocation(`/accounting/cost-centers${nextStr ? "?" + nextStr : ""}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const [search, setSearch]     = useState("");
  const [filter, setFilter]     = useState<"all" | "active" | "inactive">("all");
  const [form, setForm]         = useState<any>(EMPTY);
  const [editId, setEditId]     = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirmDelId, setConfirmDelId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const { data: centers = [], isLoading } = useQuery<CostCenter[]>({
    queryKey: ["cost-centers", cid],
    queryFn: async () => {
      const url = cid ? `${API}/api/cost-centers?companyId=${cid}` : `${API}/api/cost-centers`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return [];
      return r.json();
    },
  });

  type Node = CostCenter & { children: Node[] };
  const tree = useMemo<Node[]>(() => {
    const map = new Map<number, Node>();
    const roots: Node[] = [];
    centers.forEach(c => map.set(c.id, { ...c, children: [] }));
    centers.forEach(c => {
      const node = map.get(c.id)!;
      if (c.parentId && map.has(c.parentId)) map.get(c.parentId)!.children.push(node);
      else roots.push(node);
    });
    return roots;
  }, [centers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return centers.filter(c => {
      if (filter === "active"   && !c.isActive) return false;
      if (filter === "inactive" &&  c.isActive) return false;
      if (!q) return true;
      return c.code.toLowerCase().includes(q)
          || c.nameAr.toLowerCase().includes(q)
          || (c.nameEn ?? "").toLowerCase().includes(q);
    });
  }, [centers, search, filter]);

  const usingSearch = search.trim().length > 0 || filter !== "all";

  const saveMut = useMutation({
    mutationFn: async (payload: any) => {
      const url = editId ? `${API}/api/cost-centers/${editId}` : `${API}/api/cost-centers`;
      const method = editId ? "PUT" : "POST";
      const body = JSON.stringify({
        ...payload,
        parentId: payload.parentId ? Number(payload.parentId) : null,
        level: payload.parentId ? 2 : 1,
      });
      const r = await fetch(url, { method, headers, body });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || t("costCenters.saveError"));
      return d;
    },
    onSuccess: () => {
      toast({ title: editId ? t("costCenters.saveUpdate") : t("costCenters.saveCreate") });
      qc.invalidateQueries({ queryKey: ["cost-centers", cid] });
      reset();
    },
    onError: (e: any) => toast({ title: t("costCenters.error"), description: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/cost-centers/${id}`, { method: "DELETE", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || t("costCenters.deleteError"));
      return d;
    },
    onSuccess: () => {
      toast({ title: t("costCenters.deleteSuccess") });
      qc.invalidateQueries({ queryKey: ["cost-centers", cid] });
      setConfirmDelId(null);
    },
    onError: (e: any) => toast({ title: t("costCenters.error"), description: e.message, variant: "destructive" }),
  });

  function reset() {
    setForm(EMPTY);
    setEditId(null);
    setShowForm(false);
  }

  function startEdit(c: CostCenter) {
    setForm({
      code: c.code, nameAr: c.nameAr, nameEn: c.nameEn ?? "",
      parentId: c.parentId ? String(c.parentId) : "",
      level: c.level, isPosting: c.isPosting, isActive: c.isActive,
      notes: c.notes ?? "",
    });
    setEditId(c.id);
    setShowForm(true);
  }

  function startNew(parentId?: number) {
    setForm({ ...EMPTY, parentId: parentId ? String(parentId) : "" });
    setEditId(null);
    setShowForm(true);
    if (parentId) setExpanded(prev => new Set(prev).add(parentId));
  }

  const parentOptions = useMemo(() => {
    return [
      { value: "", label: t("costCenters.noParent") },
      ...centers
        .filter(c => c.id !== editId)
        .map(c => ({ value: String(c.id), label: `${c.code} — ${isRtl ? c.nameAr : (c.nameEn || c.nameAr)}` })),
    ];
  }, [centers, editId, t, isRtl]);

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-cyan-500 via-teal-500 to-emerald-500 text-white shadow-md">
            <Target className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t("costCenters.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("costCenters.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons
            rows={centers.map(c => ({
              ...c,
              nameAr: isRtl ? c.nameAr : (c.nameEn || c.nameAr),
              isPosting: c.isPosting ? t("chartOfAccounts.exportYes") : t("chartOfAccounts.exportNo"),
              isActive: c.isActive ? t("costCenters.isActive") : t("costCenters.inactive"),
            }))}
            columns={EXPORT_COLS}
            filename={t("costCenters.filename")}
            title={t("costCenters.export_title")}
          />
          <Button size="lg" onClick={() => startNew()} className="gap-2 bg-gradient-to-l from-cyan-600 to-teal-600 hover:from-cyan-700 hover:to-teal-700 shadow-md">
            <Plus className="h-5 w-5" />
            {t("costCenters.newCenter")}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="manage" className="gap-2">
            <ListTree className="h-4 w-4" />
            {t("costCenters.tabManage")}
          </TabsTrigger>
          <TabsTrigger value="analysis" className="gap-2">
            <BarChart3 className="h-4 w-4" />
            {t("costCenters.tabAnalysis")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="manage" className="space-y-5 mt-0">

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <Search className={cn("absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground", isRtl ? "right-3" : "left-3")} />
          <Input
            placeholder={t("costCenters.searchPlaceholder")}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={isRtl ? "pr-9" : "pl-9"}
          />
        </div>
        <div className="flex items-center gap-1 border rounded-md p-1 bg-muted/30">
          {[
            { v: "all",      l: t("costCenters.filterAll") },
            { v: "active",   l: t("costCenters.filterActive") },
            { v: "inactive", l: t("costCenters.filterInactive") },
          ].map(o => (
            <button
              key={o.v}
              onClick={() => setFilter(o.v as any)}
              className={cn(
                "px-3 py-1.5 text-xs rounded transition-all",
                filter === o.v ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-muted/50",
              )}
            >
              {o.l}
            </button>
          ))}
        </div>
        <Badge variant="secondary" className="text-xs">
          {t("costCenters.totalLabel", { count: centers.length })}
        </Badge>
      </div>

      {/* Form */}
      {showForm && (
        <FormPanel
          icon={Target}
          title={editId ? t("costCenters.editCenter") : t("costCenters.addCenter")}
          subtitle={t("costCenters.formSubtitle")}
          width="3xl"
          onClose={reset}
          onSave={() => saveMut.mutate(form)}
          saving={saveMut.isPending}
          saveDisabled={!form.nameAr.trim()}
          saveLabel={t("costCenters.saveAction")}
        >
          <FormGrid>
            <Field
              label={t("costCenters.code")}
              hint={<span className="text-muted-foreground text-xs">{t("costCenters.codeAutoHint")}</span>}
            >
              <Input
                placeholder={t("costCenters.placeholderCode")}
                value={form.code}
                onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))}
                dir="ltr"
                className="text-left font-mono"
              />
            </Field>
            <Field label={t("costCenters.nameAr")} required>
              <Input value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} />
            </Field>
            <Field label={t("costCenters.nameEn")}>
              <Input dir="ltr" className="text-left" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
            </Field>
            <Field label={t("costCenters.parentCenter")}>
              <SearchCombobox
                items={parentOptions}
                value={form.parentId}
                onValueChange={(v) => setForm((p: any) => ({ ...p, parentId: v }))}
                placeholder={t("costCenters.parentPlaceholder")}
              />
            </Field>
            <Field label={t("costCenters.notes")} className="md:col-span-2">
              <Input value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
            </Field>
          </FormGrid>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/20">
              <div>
                <Label className="text-xs font-semibold">{t("costCenters.isPosting")}</Label>
                <p className="text-[11px] text-muted-foreground">{t("costCenters.isPostingDesc")}</p>
              </div>
              <Switch checked={form.isPosting} onCheckedChange={(v: boolean) => setForm((p: any) => ({ ...p, isPosting: v }))} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/20">
              <div>
                <Label className="text-xs font-semibold">{t("costCenters.isActive")}</Label>
                <p className="text-[11px] text-muted-foreground">{t("costCenters.isActiveDesc")}</p>
              </div>
              <Switch checked={form.isActive} onCheckedChange={(v: boolean) => setForm((p: any) => ({ ...p, isActive: v }))} />
            </div>
          </div>
        </FormPanel>
      )}

      {/* List */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        <div className="p-3 border-b bg-muted/30 flex items-center gap-2">
          <FolderTree className="h-4 w-4 text-cyan-600" />
          <span className="text-sm font-semibold">{t("costCenters.treeLabel")}</span>
          {usingSearch && (
            <Badge variant="outline" className="text-[10px]">
              {t("costCenters.filterResults", { count: filtered.length })}
            </Badge>
          )}
        </div>

        {isLoading ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : centers.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground text-sm">
            <Target className="h-12 w-12 mx-auto mb-2 opacity-20" />
            <p className="font-semibold mb-1">{t("costCenters.emptyTitle")}</p>
            <p className="text-xs">{t("costCenters.emptyHint")}</p>
          </div>
        ) : usingSearch ? (
          <div className="divide-y">
            {filtered.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">{t("costCenters.noMatches")}</div>
            ) : filtered.map(c => (
              <RowFlat key={c.id} c={c} centers={centers} t={t} isRtl={isRtl}
                onEdit={() => startEdit(c)}
                onAddChild={() => startNew(c.id)}
                onDelete={() => setConfirmDelId(c.id)}
                confirmDel={confirmDelId === c.id}
                onCancelDel={() => setConfirmDelId(null)}
                onConfirmDel={() => delMut.mutate(c.id)}
                delPending={delMut.isPending}
              />
            ))}
          </div>
        ) : (
          <div className="divide-y">
            {tree.map(node => (
              <TreeRow
                key={node.id}
                node={node}
                depth={0}
                expanded={expanded}
                t={t}
                isRtl={isRtl}
                onToggle={(id: number) => setExpanded(prev => {
                  const n = new Set(prev);
                  if (n.has(id)) n.delete(id); else n.add(id);
                  return n;
                })}
                onEdit={(c: any) => startEdit(c)}
                onAddChild={(id: number) => startNew(id)}
                onDelete={(id: number) => setConfirmDelId(id)}
                confirmDelId={confirmDelId}
                onCancelDel={() => setConfirmDelId(null)}
                onConfirmDel={(id: number) => delMut.mutate(id)}
                delPending={delMut.isPending}
              />
            ))}
          </div>
        )}
      </div>
        </TabsContent>

        <TabsContent value="analysis" className="mt-0">
          <TransactionsTab centers={centers} headers={headers} t={t} isRtl={isRtl} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TreeRow({
  node, depth, expanded, onToggle, onEdit, onAddChild, onDelete,
  confirmDelId, onCancelDel, onConfirmDel, delPending, t, isRtl,
}: any) {
  const hasKids = node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const Chevron = isRtl ? ChevronLeft : ChevronRight;
  const padStyle = isRtl ? { paddingRight: 12 + depth * 20 } : { paddingLeft: 12 + depth * 20 };

  return (
    <div>
      <div className="flex items-center gap-2 p-2.5 hover:bg-muted/30 transition-colors" style={padStyle}>
        {hasKids ? (
          <button onClick={() => onToggle(node.id)} className="p-0.5 rounded hover:bg-muted">
            <Chevron className={cn("h-4 w-4 transition-transform", isOpen && (isRtl ? "-rotate-90" : "rotate-90"))} />
          </button>
        ) : (
          <span className="w-5" />
        )}
        <span className={cn(
          "font-mono text-xs px-2 py-0.5 rounded border",
          node.isActive ? "bg-cyan-50 text-cyan-700 border-cyan-200" : "bg-gray-100 text-gray-500 border-gray-200",
        )}>
          {node.code}
        </span>
        <span className={cn("flex-1 text-sm font-medium", !node.isActive && "text-muted-foreground line-through")}>
          {isRtl ? node.nameAr : (node.nameEn || node.nameAr)}
          {isRtl && node.nameEn && <span className="text-[11px] text-muted-foreground mx-2">— {node.nameEn}</span>}
        </span>
        {!node.isPosting && (
          <Badge variant="outline" className="text-[10px] h-5 bg-amber-50 text-amber-700 border-amber-200">{t("costCenters.headerAccount")}</Badge>
        )}
        {!node.isActive && (
          <Badge variant="outline" className="text-[10px] h-5 bg-gray-50 text-gray-600 border-gray-200">{t("costCenters.inactive")}</Badge>
        )}
        <div className="flex items-center gap-1">
          {confirmDelId === node.id ? (
            <div className="flex items-center gap-1 bg-red-50 border border-red-300 rounded-md px-2 py-1">
              <span className="text-[10px] text-red-700 font-medium">{t("costCenters.confirmShort")}</span>
              <Button size="sm" variant="ghost" onClick={onCancelDel} className="h-6 px-2 text-[10px]">{t("costCenters.cancel")}</Button>
              <Button size="sm" variant="destructive" onClick={() => onConfirmDel(node.id)} disabled={delPending} className="h-6 px-2 text-[10px]">{t("costCenters.delete")}</Button>
            </div>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => onAddChild(node.id)} className="h-7 w-7 p-0" title={t("costCenters.addChild")}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onEdit(node)} className="h-7 w-7 p-0" title={t("costCenters.edit")}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(node.id)} className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50" title={t("costCenters.delete")}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>
      {hasKids && isOpen && (
        <div>
          {node.children.map((child: any) => (
            <TreeRow
              key={child.id} node={child} depth={depth + 1}
              expanded={expanded} onToggle={onToggle}
              onEdit={onEdit} onAddChild={onAddChild} onDelete={onDelete}
              confirmDelId={confirmDelId} onCancelDel={onCancelDel}
              onConfirmDel={onConfirmDel} delPending={delPending} t={t} isRtl={isRtl}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RowFlat({
  c, centers, onEdit, onAddChild, onDelete,
  confirmDel, onCancelDel, onConfirmDel, delPending, t, isRtl,
}: any) {
  const parent = c.parentId ? centers.find((x: any) => x.id === c.parentId) : null;
  const parentName = parent ? (isRtl ? parent.nameAr : (parent.nameEn || parent.nameAr)) : "";
  return (
    <div className="flex items-center gap-2 p-2.5 hover:bg-muted/30 transition-colors">
      <span className={cn(
        "font-mono text-xs px-2 py-0.5 rounded border",
        c.isActive ? "bg-cyan-50 text-cyan-700 border-cyan-200" : "bg-gray-100 text-gray-500 border-gray-200",
      )}>
        {c.code}
      </span>
      <div className="flex-1 min-w-0">
        <div className={cn("text-sm font-medium truncate", !c.isActive && "text-muted-foreground line-through")}>
          {isRtl ? c.nameAr : (c.nameEn || c.nameAr)}
          {isRtl && c.nameEn && <span className="text-[11px] text-muted-foreground mx-2">— {c.nameEn}</span>}
        </div>
        {parent && (
          <div className="text-[10px] text-muted-foreground">
            {t("costCenters.childOf")} <span className="font-mono">{parent.code}</span> {parentName}
          </div>
        )}
      </div>
      {!c.isPosting && <Badge variant="outline" className="text-[10px] h-5 bg-amber-50 text-amber-700 border-amber-200">{t("costCenters.headerAccount")}</Badge>}
      {!c.isActive && <Badge variant="outline" className="text-[10px] h-5 bg-gray-50 text-gray-600 border-gray-200">{t("costCenters.inactive")}</Badge>}
      <div className="flex items-center gap-1">
        {confirmDel ? (
          <div className="flex items-center gap-1 bg-red-50 border border-red-300 rounded-md px-2 py-1">
            <span className="text-[10px] text-red-700 font-medium">{t("costCenters.confirmShort")}</span>
            <Button size="sm" variant="ghost" onClick={onCancelDel} className="h-6 px-2 text-[10px]">{t("costCenters.cancel")}</Button>
            <Button size="sm" variant="destructive" onClick={onConfirmDel} disabled={delPending} className="h-6 px-2 text-[10px]">{t("costCenters.delete")}</Button>
          </div>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={onAddChild} className="h-7 w-7 p-0" title={t("costCenters.addChild")}><Plus className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="ghost" onClick={onEdit} className="h-7 w-7 p-0" title={t("costCenters.edit")}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="ghost" onClick={onDelete} className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50" title={t("costCenters.delete")}><Trash2 className="h-3.5 w-3.5" /></Button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Transactions / Activity & Analysis Tab ──────────────────────────────────
type TxRow = {
  lineId: number; entryId: number; docNumber: string | null;
  entryDate: string; entryType: string | null; entryStatus: string | null;
  entryDescription: string | null; lineDescription: string | null;
  accountId: number | null; accountCode: string | null;
  accountNameAr: string | null; accountNameEn: string | null;
  debit: string; credit: string;
};
type TxResp = {
  center: { id: number; code: string; nameAr: string; nameEn: string | null };
  range:  { from: string | null; to: string | null };
  rows:   TxRow[];
  totals: { totalDebit: number; totalCredit: number; balance: number; lineCount: number };
  byAccount: Array<{ accountId: number; accountCode: string; accountNameAr: string; accountNameEn: string; debit: number; credit: number; balance: number; count: number }>;
};
type AiResp = { headline: string; highlights: string[]; concerns: string[]; recommendation: string };

function TransactionsTab({ centers, headers, t, isRtl }: { centers: CostCenter[]; headers: any; t: any; isRtl: boolean }) {
  const { fmtMoney } = useFormatters();
  const { toast } = useToast();
  // Hydrate filter state from URL (?cc=1,3,7&from=...&to=...) so back-nav
  // from a JE detail returns to the same selection.
  const [, setLocation] = useLocation();
  const searchString    = useSearch();
  const initialFilters  = useMemo(() => {
    const p = new URLSearchParams(searchString || "");
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + "01";
    const cc = (p.get("cc") || "").split(",").map(s => s.trim()).filter(Boolean);
    return {
      centerIds: cc,
      from: p.get("from") || monthStart,
      to:   p.get("to")   || today,
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [centerIds, setCenterIds] = useState<string[]>(initialFilters.centerIds);
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";
  const [from, setFrom] = useState<string>(initialFilters.from);
  const [to, setTo]     = useState<string>(initialFilters.to);

  // Mirror selection into URL with replace:true. Preserves ?tab=analysis
  // (managed by parent) by merging into the existing params.
  useEffect(() => {
    const next = new URLSearchParams(searchString || "");
    if (centerIds.length) next.set("cc", centerIds.join(",")); else next.delete("cc");
    if (from && from !== monthStart) next.set("from", from); else next.delete("from");
    if (to   && to   !== today)      next.set("to",   to);   else next.delete("to");
    const nextStr = next.toString();
    const currentStr = new URLSearchParams(searchString || "").toString();
    if (nextStr !== currentStr) {
      setLocation(`/accounting/cost-centers${nextStr ? "?" + nextStr : ""}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerIds.join(","), from, to]);
  const [ai, setAi]         = useState<AiResp | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const activeCenters = useMemo(() => centers.filter(c => c.isActive !== false), [centers]);

  // Parallel fetch one query per selected center
  const txQueries = useQueries({
    queries: centerIds.map(id => ({
      queryKey: ["cost-center-transactions", id, from, to],
      queryFn: async (): Promise<TxResp> => {
        const qs = new URLSearchParams();
        if (from) qs.set("from", from);
        if (to)   qs.set("to", to);
        const r = await fetch(`${API}/api/cost-centers/${id}/transactions?${qs.toString()}`, { headers });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d?.error || "Request failed");
        }
        return r.json();
      },
    })),
  });

  const isLoading  = centerIds.length > 0 && txQueries.some(q => q.isLoading);
  const allSuccess = centerIds.length > 0 && txQueries.every(q => q.isSuccess);
  const errorIdxs  = txQueries
    .map((q, i) => q.isError ? i : -1)
    .filter(i => i >= 0);
  const hasErrors  = errorIdxs.length > 0;
  const updatedKey = txQueries.map(q => q.dataUpdatedAt).join(",");

  type Row = TxRow & { centerId: number; centerCode: string; centerNameAr: string; centerNameEn: string | null };
  type Merged = {
    centers: TxResp["center"][];
    range:   TxResp["range"];
    totals:  TxResp["totals"];
    byAccount: TxResp["byAccount"];
    rows: Row[];
  };

  // Only build merged data when EVERY selected query has succeeded, so
  // totals/byAccount/rows always reflect the full selection — never a
  // partial set caused by a still-loading or errored center.
  const data: Merged | null = useMemo(() => {
    if (!allSuccess) return null;
    const datas = txQueries.map(q => q.data).filter(Boolean) as TxResp[];
    if (datas.length === 0 || datas.length !== centerIds.length) return null;

    const totals = datas.reduce((acc, d) => ({
      totalDebit:  acc.totalDebit  + d.totals.totalDebit,
      totalCredit: acc.totalCredit + d.totals.totalCredit,
      balance:     acc.balance     + d.totals.balance,
      lineCount:   acc.lineCount   + d.totals.lineCount,
    }), { totalDebit: 0, totalCredit: 0, balance: 0, lineCount: 0 });

    const acctMap = new Map<number, Merged["byAccount"][number]>();
    datas.forEach(d => d.byAccount.forEach(a => {
      const ex = acctMap.get(a.accountId);
      if (ex) {
        ex.debit   += a.debit;
        ex.credit  += a.credit;
        ex.balance += a.balance;
        ex.count   += a.count;
      } else {
        acctMap.set(a.accountId, { ...a });
      }
    }));
    const byAccount = Array.from(acctMap.values())
      .sort((a, b) => (b.debit + b.credit) - (a.debit + a.credit));

    const rows: Row[] = datas.flatMap(d => d.rows.map(r => ({
      ...r,
      centerId: d.center.id,
      centerCode: d.center.code,
      centerNameAr: d.center.nameAr,
      centerNameEn: d.center.nameEn,
    })));
    rows.sort((a, b) => {
      if (a.entryDate !== b.entryDate) return b.entryDate.localeCompare(a.entryDate);
      return b.entryId - a.entryId;
    });

    return { centers: datas.map(d => d.center), range: datas[0].range, totals, byAccount, rows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedKey, centerIds.join(",")]);

  const totals = data?.totals;
  const balanceSign = totals ? (totals.balance > 0 ? "debit" : totals.balance < 0 ? "credit" : "zero") : "zero";

  const isAll = centerIds.length > 0 && centerIds.length === activeCenters.length;
  const centersLabel =
    centerIds.length === 0 ? ""
      : isAll ? t("costCenters.txTab.selectedAll", { count: activeCenters.length })
      : centerIds.length === 1
        ? (() => {
            const c = activeCenters.find(x => String(x.id) === centerIds[0]);
            return c ? `${c.code} — ${isRtl ? c.nameAr : (c.nameEn || c.nameAr)}` : t("costCenters.txTab.selectedOne");
          })()
        : t("costCenters.txTab.selectedSome", { count: centerIds.length });

  async function runAi() {
    if (centerIds.length !== 1) {
      toast({ title: t("costCenters.txTab.aiSingleOnly") });
      return;
    }
    if (!data) {
      toast({ title: t("costCenters.txTab.aiNeedDataFirst") });
      return;
    }
    setAiLoading(true); setAi(null);
    try {
      const r = await fetch(`${API}/api/cost-centers/${centerIds[0]}/ai-insights`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          totals: data.totals,
          byAccount: data.byAccount,
          range: data.range,
          language: isRtl ? "ar" : "en",
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || t("costCenters.txTab.aiError"));
      setAi(d);
    } catch (e: any) {
      toast({ title: t("costCenters.txTab.aiError"), description: e.message, variant: "destructive" });
    } finally {
      setAiLoading(false);
    }
  }

  // ─── Export rows for the per-line transactions table ────────────────────
  // Per-line balance = debit − credit. Positive → debit nature ("مدين"),
  // negative → credit nature ("دائن"), zero → "—". Both the absolute amount
  // AND a separate "balance type" column are emitted so the user can see at
  // a glance whether each posting increased the debit side or the credit
  // side of the centre — answering "ارصده دائنه او مدينه" in both Excel
  // and PDF exports.
  const natureLabel = (n: number) =>
    n > 0 ? t("costCenters.txTab.balanceDebit")
    : n < 0 ? t("costCenters.txTab.balanceCredit")
    : t("costCenters.txTab.balanceBalanced");

  const exportRows = useMemo(() => {
    if (!data) return [];
    return data.rows.map(r => {
      const debit  = Number(r.debit);
      const credit = Number(r.credit);
      const bal    = debit - credit;
      return {
        entryDate:   r.entryDate,
        docNumber:   r.docNumber || ("#" + r.entryId),
        center:      `${r.centerCode} — ${isRtl ? r.centerNameAr : (r.centerNameEn || r.centerNameAr)}`,
        account:     `${r.accountCode ?? ""} — ${isRtl ? (r.accountNameAr ?? "") : (r.accountNameEn || r.accountNameAr || "")}`,
        description: r.lineDescription || r.entryDescription || "",
        debit:       debit  > 0 ? fmtMoney(debit)  : "",
        credit:      credit > 0 ? fmtMoney(credit) : "",
        balance:     bal !== 0 ? fmtMoney(Math.abs(bal)) : "—",
        nature:      bal !== 0 ? natureLabel(bal) : "—",
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isRtl, fmtMoney, t]);

  const exportColumns = useMemo(() => [
    { key: "entryDate",   header: t("costCenters.txTab.tableDate"),        width: 14 },
    { key: "docNumber",   header: t("costCenters.txTab.tableDoc"),         width: 14 },
    { key: "center",      header: t("costCenters.txTab.tableCenter"),      width: 24 },
    { key: "account",     header: t("costCenters.txTab.tableAccount"),     width: 28 },
    { key: "description", header: t("costCenters.txTab.tableDescription"), width: 32 },
    { key: "debit",       header: t("costCenters.txTab.tableDebit"),       width: 14 },
    { key: "credit",      header: t("costCenters.txTab.tableCredit"),      width: 14 },
    { key: "balance",     header: t("costCenters.txTab.tableBalance"),     width: 14 },
    { key: "nature",      header: t("costCenters.txTab.tableNature"),      width: 12 },
  ], [t]);

  // Net balance for the totals row, with explicit nature label appended
  // (e.g. "1,200.00 مدين") so the closing balance and its side are visible
  // on a single line at the bottom of the exported sheet / PDF — same
  // information the on-screen KPI cards show.
  const totalsRow = useMemo(() => {
    if (!data || !totals) return null;
    const bal = totals.balance;
    return {
      entryDate:   "",
      docNumber:   "",
      center:      "",
      account:     "",
      description: t("costCenters.txTab.lineCount") + ": " + totals.lineCount,
      debit:       fmtMoney(totals.totalDebit),
      credit:      fmtMoney(totals.totalCredit),
      balance:     fmtMoney(Math.abs(bal)),
      nature:      natureLabel(bal),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, totals, fmtMoney, t]);

  // ─── Extra export section: pre-aggregated "totals per GL account" ─────
  // Mirrors the on-screen "تجميع حسب الحساب" card so PDF and Excel
  // exports of the cost-centre report carry the SAME aggregate the
  // user sees in the UI: one row per GL account with entry count,
  // debit, credit, balance and nature (debit/credit/balanced).
  const byAccountSection = useMemo(() => {
    if (!data || data.byAccount.length === 0) return null;
    return {
      title: t("costCenters.txTab.byAccount"),
      columns: [
        { key: "account", header: t("costCenters.txTab.tableAccount"), width: 32 },
        { key: "count",   header: t("costCenters.txTab.tableEntries"), width: 10 },
        { key: "debit",   header: t("costCenters.txTab.tableDebit"),   width: 16 },
        { key: "credit",  header: t("costCenters.txTab.tableCredit"),  width: 16 },
        { key: "balance", header: t("costCenters.txTab.tableBalance"), width: 16 },
        { key: "nature",  header: t("costCenters.txTab.tableNature"),  width: 12 },
      ],
      rows: data.byAccount.map(a => ({
        account: `${a.accountCode ?? ""} — ${isRtl ? (a.accountNameAr ?? "") : (a.accountNameEn || a.accountNameAr || "")}`,
        count:   a.count,
        debit:   a.debit  > 0 ? fmtMoney(a.debit)  : "—",
        credit:  a.credit > 0 ? fmtMoney(a.credit) : "—",
        balance: a.balance !== 0 ? fmtMoney(Math.abs(a.balance)) : "—",
        nature:  a.balance !== 0 ? natureLabel(a.balance) : t("costCenters.txTab.balanceBalanced"),
      })),
      totalsRow: totals ? {
        account: t("costCenters.txTab.total") || "الإجمالي",
        count:   totals.lineCount,
        debit:   fmtMoney(totals.totalDebit),
        credit:  fmtMoney(totals.totalCredit),
        balance: fmtMoney(Math.abs(totals.balance)),
        nature:  natureLabel(totals.balance),
      } : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, totals, isRtl, fmtMoney, t]);

  const extraSections = useMemo(
    () => (byAccountSection ? [byAccountSection] : null),
    [byAccountSection],
  );

  const summaryFooter = useMemo(() => {
    if (!data || !totals) return null;
    return [
      { label: t("costCenters.txTab.totalDebit"),  value: fmtMoney(totals.totalDebit),  tone: "debit"   as const },
      { label: t("costCenters.txTab.totalCredit"), value: fmtMoney(totals.totalCredit), tone: "credit"  as const },
      { label: t("costCenters.txTab.balance"),
        value: fmtMoney(Math.abs(totals.balance)) + " " + (
          balanceSign === "debit"  ? t("costCenters.txTab.balanceDebit")
          : balanceSign === "credit" ? t("costCenters.txTab.balanceCredit")
          : t("costCenters.txTab.balanceBalanced")
        ),
        tone: "primary" as const },
    ];
  }, [data, totals, balanceSign, fmtMoney, t]);

  const exportSubtitle = data
    ? (centerIds.length === 1
        ? t("costCenters.txTab.exportSubtitleSingle", {
            center: centersLabel,
            from: from || "—",
            to:   to   || "—",
          })
        : t("costCenters.txTab.exportSubtitleMulti", {
            count: data.centers.length,
            from:  from || "—",
            to:    to   || "—",
          }))
    : "";

  return (
    <div className="space-y-4">
      {/* Filters bar */}
      <div className="rounded-xl border bg-gradient-to-br from-slate-50 to-cyan-50/40 p-4 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-5">
            <Label className="text-xs font-semibold mb-1.5 block">{t("costCenters.txTab.pickCenters")}</Label>
            <MultiCenterPicker
              centers={activeCenters}
              value={centerIds}
              onChange={(ids) => { setCenterIds(ids); setAi(null); }}
              t={t}
              isRtl={isRtl}
            />
          </div>
          <div className="md:col-span-3">
            <Label className="text-xs font-semibold mb-1.5 block">{t("costCenters.txTab.from")}</Label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} dir="ltr" />
          </div>
          <div className="md:col-span-3">
            <Label className="text-xs font-semibold mb-1.5 block">{t("costCenters.txTab.to")}</Label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} dir="ltr" />
          </div>
          <div className="md:col-span-1">
            <Button
              variant="outline"
              size="sm"
              className="w-full h-9"
              onClick={() => { setFrom(""); setTo(""); }}
              title={t("costCenters.txTab.clear")}
            >
              {t("costCenters.txTab.clear")}
            </Button>
          </div>
        </div>

        {/* Selected centers badges + export */}
        {centerIds.length > 0 && (
          <div className="mt-3 pt-3 border-t flex items-start justify-between flex-wrap gap-2">
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              <span className="text-[11px] font-semibold text-muted-foreground">{t("costCenters.txTab.centersHeader")}:</span>
              {isAll ? (
                <Badge variant="secondary" className="gap-1 text-[11px]">
                  {t("costCenters.txTab.selectedAll", { count: activeCenters.length })}
                  <button onClick={() => setCenterIds([])} className="opacity-60 hover:opacity-100">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ) : (
                centerIds.slice(0, 8).map(id => {
                  const c = activeCenters.find(x => String(x.id) === id);
                  if (!c) return null;
                  return (
                    <Badge key={id} variant="secondary" className="gap-1 text-[11px]">
                      <span className="font-mono">{c.code}</span>
                      <button
                        onClick={() => setCenterIds(centerIds.filter(v => v !== id))}
                        className="opacity-60 hover:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  );
                })
              )}
              {!isAll && centerIds.length > 8 && (
                <Badge variant="outline" className="text-[11px]">+{centerIds.length - 8}</Badge>
              )}
            </div>
            <ExportButtons
              rows={exportRows}
              columns={exportColumns}
              filename={t("costCenters.txTab.exportTitle")}
              title={t("costCenters.txTab.exportTitle")}
              subtitle={exportSubtitle}
              totalsRow={totalsRow}
              summaryFooter={summaryFooter}
              extraSections={extraSections}
              disabled={!data || exportRows.length === 0}
              size="sm"
            />
          </div>
        )}
      </div>

      {/* Empty state when no centers picked */}
      {centerIds.length === 0 && (
        <div className="rounded-xl border border-dashed bg-card p-12 text-center text-muted-foreground">
          <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-semibold">{t("costCenters.txTab.noCentersMulti")}</p>
        </div>
      )}

      {centerIds.length > 0 && hasErrors && (
        <div className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-800 flex items-start gap-2">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="font-bold mb-0.5">{t("costCenters.error")}</div>
            <div className="text-xs mb-1">
              {(txQueries[errorIdxs[0]]?.error as any)?.message || ""}
            </div>
            <div className="text-[11px] opacity-80 flex flex-wrap gap-1">
              {errorIdxs.map(i => {
                const c = activeCenters.find(x => String(x.id) === centerIds[i]);
                return c ? (
                  <span key={i} className="font-mono px-1.5 py-0.5 rounded bg-rose-100 border border-rose-200">
                    {c.code}
                  </span>
                ) : null;
              })}
            </div>
          </div>
        </div>
      )}

      {centerIds.length > 0 && isLoading && !data && !hasErrors && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      )}

      {centerIds.length > 0 && data && (
        <>
          {/* KPI cards: debit / credit / balance */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <KpiCard
              tone="emerald"
              icon={<TrendingUp className="h-5 w-5" />}
              label={t("costCenters.txTab.totalDebit")}
              value={fmtMoney(totals!.totalDebit)}
              sub={t("costCenters.txTab.lineCount") + ": " + (totals!.lineCount)}
            />
            <KpiCard
              tone="rose"
              icon={<TrendingDown className="h-5 w-5" />}
              label={t("costCenters.txTab.totalCredit")}
              value={fmtMoney(totals!.totalCredit)}
              sub={centersLabel}
            />
            <KpiCard
              tone={balanceSign === "debit" ? "blue" : balanceSign === "credit" ? "amber" : "slate"}
              icon={<Scale className="h-5 w-5" />}
              label={t("costCenters.txTab.balance")}
              value={fmtMoney(Math.abs(totals!.balance))}
              sub={
                balanceSign === "debit"   ? t("costCenters.txTab.balanceDebit")  :
                balanceSign === "credit"  ? t("costCenters.txTab.balanceCredit") :
                                            t("costCenters.txTab.balanceBalanced")
              }
            />
          </div>

          {/* AI insights button + result card */}
          <div className="rounded-xl border bg-gradient-to-br from-violet-50 via-fuchsia-50 to-pink-50 p-4 shadow-sm">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-bold">{t("costCenters.txTab.aiTitle")}</div>
                  <div className="text-[11px] text-muted-foreground">
                    gpt-5.4 · {centerIds.length === 1 ? data.centers[0]?.code : t("costCenters.txTab.aiSingleOnly")}
                  </div>
                </div>
              </div>
              <Button
                onClick={runAi}
                disabled={aiLoading || !data || data.totals.lineCount === 0 || centerIds.length !== 1}
                className="gap-2 bg-gradient-to-l from-violet-600 to-fuchsia-600 hover:from-violet-700 hover:to-fuchsia-700 text-white shadow"
                title={centerIds.length !== 1 ? t("costCenters.txTab.aiSingleOnly") : undefined}
              >
                {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {aiLoading ? t("costCenters.txTab.aiLoading") : t("costCenters.txTab.aiButton")}
              </Button>
            </div>

            {ai && centerIds.length === 1 && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                {ai.headline && (
                  <div className="md:col-span-2 rounded-lg bg-white/70 backdrop-blur border border-violet-200 p-3">
                    <div className="text-sm font-bold text-violet-900 leading-relaxed">{ai.headline}</div>
                  </div>
                )}
                {ai.highlights?.length > 0 && (
                  <InsightList tone="emerald" icon={<CheckCircle2 className="h-4 w-4" />} title={t("costCenters.txTab.aiHighlights")} items={ai.highlights} />
                )}
                {ai.concerns?.length > 0 && (
                  <InsightList tone="amber" icon={<AlertTriangle className="h-4 w-4" />} title={t("costCenters.txTab.aiConcerns")} items={ai.concerns} />
                )}
                {ai.recommendation && (
                  <div className="md:col-span-2 rounded-lg bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 p-3 flex gap-3">
                    <Lightbulb className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
                    <div>
                      <div className="text-[11px] font-bold text-blue-900 mb-0.5">{t("costCenters.txTab.aiRecommendation")}</div>
                      <div className="text-sm text-blue-900/90 leading-relaxed">{ai.recommendation}</div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* By-account aggregation */}
          {data.byAccount.length > 0 && (
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              <div className="p-3 border-b bg-muted/30 flex items-center gap-2">
                <FolderTree className="h-4 w-4 text-cyan-600" />
                <span className="text-sm font-semibold">{t("costCenters.txTab.byAccount")}</span>
                <Badge variant="secondary" className="text-[10px]">{data.byAccount.length}</Badge>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/20 text-xs">
                    <tr>
                      <th className={cn("p-2 font-semibold", isRtl ? "text-right" : "text-left")}>{t("costCenters.txTab.tableAccount")}</th>
                      <th className="p-2 font-semibold text-center">{t("costCenters.txTab.tableEntries")}</th>
                      <th className="p-2 font-semibold text-end">{t("costCenters.txTab.tableDebit")}</th>
                      <th className="p-2 font-semibold text-end">{t("costCenters.txTab.tableCredit")}</th>
                      <th className="p-2 font-semibold text-end">{t("costCenters.txTab.balance")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.byAccount.map(a => (
                      <tr key={a.accountId} className="hover:bg-muted/20 transition-colors">
                        <td className="p-2">
                          <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-700 mx-1">{a.accountCode}</span>
                          <span className="font-medium">{isRtl ? a.accountNameAr : (a.accountNameEn || a.accountNameAr)}</span>
                        </td>
                        <td className="p-2 text-center text-xs text-muted-foreground">{a.count}</td>
                        <td className="p-2 text-end font-mono text-emerald-700 font-semibold">{a.debit ? fmtMoney(a.debit) : "—"}</td>
                        <td className="p-2 text-end font-mono text-rose-700 font-semibold">{a.credit ? fmtMoney(a.credit) : "—"}</td>
                        <td className={cn("p-2 text-end font-mono font-bold",
                          a.balance > 0 ? "text-blue-700" : a.balance < 0 ? "text-amber-700" : "text-muted-foreground")}>
                          {fmtMoney(Math.abs(a.balance))}
                          {a.balance !== 0 && (
                            <span className="text-[10px] mx-1 opacity-70">{a.balance > 0 ? t("costCenters.txTab.balanceDebit") : t("costCenters.txTab.balanceCredit")}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Per-line transactions table */}
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            <div className="p-3 border-b bg-muted/30 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-cyan-600" />
              <span className="text-sm font-semibold">{t("costCenters.txTab.transactions")}</span>
              <Badge variant="secondary" className="text-[10px]">{data.rows.length}</Badge>
            </div>
            {data.rows.length === 0 ? (
              <div className="p-12 text-center text-sm text-muted-foreground">
                {t("costCenters.txTab.noTransactions")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/20 text-xs">
                    <tr>
                      <th className={cn("p-2 font-semibold", isRtl ? "text-right" : "text-left")}>{t("costCenters.txTab.tableDate")}</th>
                      <th className={cn("p-2 font-semibold", isRtl ? "text-right" : "text-left")}>{t("costCenters.txTab.tableDoc")}</th>
                      {centerIds.length > 1 && (
                        <th className={cn("p-2 font-semibold", isRtl ? "text-right" : "text-left")}>{t("costCenters.txTab.tableCenter")}</th>
                      )}
                      <th className={cn("p-2 font-semibold", isRtl ? "text-right" : "text-left")}>{t("costCenters.txTab.tableAccount")}</th>
                      <th className={cn("p-2 font-semibold", isRtl ? "text-right" : "text-left")}>{t("costCenters.txTab.tableDescription")}</th>
                      <th className="p-2 font-semibold text-end">{t("costCenters.txTab.tableDebit")}</th>
                      <th className="p-2 font-semibold text-end">{t("costCenters.txTab.tableCredit")}</th>
                      <th className="p-2 font-semibold text-center">·</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.rows.map(r => {
                      const d = Number(r.debit);
                      const c = Number(r.credit);
                      return (
                        <tr key={r.centerId + ":" + r.lineId} className="hover:bg-muted/20 transition-colors">
                          <td className="p-2 font-mono text-xs whitespace-nowrap">{r.entryDate}</td>
                          <td className="p-2 font-mono text-xs">{r.docNumber || ("#" + r.entryId)}</td>
                          {centerIds.length > 1 && (
                            <td className="p-2 text-xs">
                              <span className="font-mono px-1.5 py-0.5 rounded bg-cyan-50 border border-cyan-200 text-cyan-800">{r.centerCode}</span>
                            </td>
                          )}
                          <td className="p-2 text-xs">
                            <span className="font-mono px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-700 mx-1">{r.accountCode}</span>
                            <span className="font-medium">{isRtl ? r.accountNameAr : (r.accountNameEn || r.accountNameAr)}</span>
                          </td>
                          <td className="p-2 text-xs text-muted-foreground max-w-xs truncate">{r.lineDescription || r.entryDescription || ""}</td>
                          <td className="p-2 text-end font-mono">
                            {d > 0 ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">
                                {fmtMoney(d)}
                              </span>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="p-2 text-end font-mono">
                            {c > 0 ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 font-semibold">
                                {fmtMoney(c)}
                              </span>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="p-2 text-center">
                            <Link href={`/accounting/journals/${r.entryId}`}>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title={t("costCenters.txTab.linkToEntry")}>
                                <ExternalLink className="h-3.5 w-3.5" />
                              </Button>
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-muted/20 font-bold text-sm">
                    <tr>
                      <td colSpan={centerIds.length > 1 ? 5 : 4} className={cn("p-2", isRtl ? "text-right" : "text-left")}>
                        {t("costCenters.txTab.lineCount")}: {data.rows.length}
                      </td>
                      <td className="p-2 text-end font-mono text-emerald-700">{fmtMoney(totals!.totalDebit)}</td>
                      <td className="p-2 text-end font-mono text-rose-700">{fmtMoney(totals!.totalCredit)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Multi-select cost-center picker ────────────────────────────────────────
function MultiCenterPicker({
  centers, value, onChange, t, isRtl,
}: {
  centers: CostCenter[]; value: string[]; onChange: (v: string[]) => void;
  t: any; isRtl: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return centers;
    return centers.filter(c =>
      c.code.toLowerCase().includes(q)
      || c.nameAr.toLowerCase().includes(q)
      || (c.nameEn ?? "").toLowerCase().includes(q),
    );
  }, [centers, search]);

  const allSelected = value.length === centers.length && centers.length > 0;
  const label =
    value.length === 0      ? t("costCenters.txTab.pickCentersPlaceholder")
    : allSelected           ? t("costCenters.txTab.selectedAll", { count: centers.length })
    : value.length === 1    ? (() => {
        const c = centers.find(x => String(x.id) === value[0]);
        return c ? `${c.code} — ${isRtl ? c.nameAr : (c.nameEn || c.nameAr)}` : t("costCenters.txTab.selectedOne");
      })()
    : t("costCenters.txTab.selectedSome", { count: value.length });

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id]);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal h-9"
        >
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>{label}</span>
          <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <div className="p-2 border-b">
          <Input
            placeholder={t("costCenters.txTab.pickCentersPlaceholder")}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-8 text-sm"
            autoFocus
          />
        </div>
        <div className="p-2 border-b flex gap-2">
          <Button
            size="sm" variant="outline" className="h-7 flex-1 text-xs"
            onClick={() => onChange(centers.map(c => String(c.id)))}
            disabled={allSelected}
          >
            {t("costCenters.txTab.selectAll")}
          </Button>
          <Button
            size="sm" variant="outline" className="h-7 flex-1 text-xs"
            onClick={() => onChange([])}
            disabled={value.length === 0}
          >
            {t("costCenters.txTab.clearSelection")}
          </Button>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">—</div>
          ) : (
            filtered.map(c => {
              const id = String(c.id);
              const checked = value.includes(id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggle(id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 text-sm",
                    isRtl ? "text-right" : "text-left",
                    checked && "bg-cyan-50/40",
                  )}
                >
                  <Checkbox checked={checked} className="pointer-events-none shrink-0" />
                  <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-700 shrink-0">{c.code}</span>
                  <span className="truncate flex-1">{isRtl ? c.nameAr : (c.nameEn || c.nameAr)}</span>
                </button>
              );
            })
          )}
        </div>
        {value.length > 0 && (
          <div className="p-2 border-t text-[11px] text-muted-foreground text-center">
            {t("costCenters.txTab.selectedSome", { count: value.length })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function KpiCard({ tone, icon, label, value, sub }: { tone: "emerald" | "rose" | "blue" | "amber" | "slate"; icon: React.ReactNode; label: string; value: string; sub?: string }) {
  const toneMap: Record<string, string> = {
    emerald: "from-emerald-500 to-green-600 ring-emerald-200/50",
    rose:    "from-rose-500 to-red-600 ring-rose-200/50",
    blue:    "from-blue-500 to-indigo-600 ring-blue-200/50",
    amber:   "from-amber-500 to-orange-600 ring-amber-200/50",
    slate:   "from-slate-500 to-slate-600 ring-slate-200/50",
  };
  const bgMap: Record<string, string> = {
    emerald: "from-emerald-50 to-white border-emerald-200",
    rose:    "from-rose-50 to-white border-rose-200",
    blue:    "from-blue-50 to-white border-blue-200",
    amber:   "from-amber-50 to-white border-amber-200",
    slate:   "from-slate-50 to-white border-slate-200",
  };
  return (
    <div className={cn("rounded-xl border bg-gradient-to-br p-4 shadow-sm", bgMap[tone])}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</div>
          <div className="text-2xl font-extrabold mt-1 font-mono tabular-nums">{value}</div>
          {sub && <div className="text-[11px] text-muted-foreground mt-1 truncate">{sub}</div>}
        </div>
        <div className={cn("p-2.5 rounded-xl text-white shadow-md ring-4 bg-gradient-to-br shrink-0", toneMap[tone])}>
          {icon}
        </div>
      </div>
    </div>
  );
}

function InsightList({ tone, icon, title, items }: { tone: "emerald" | "amber"; icon: React.ReactNode; title: string; items: string[] }) {
  const cls = tone === "emerald"
    ? "bg-emerald-50 border-emerald-200 text-emerald-900"
    : "bg-amber-50 border-amber-200 text-amber-900";
  return (
    <div className={cn("rounded-lg border p-3", cls)}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold mb-1.5">
        {icon}
        {title}
      </div>
      <ul className="text-xs space-y-1 leading-relaxed">
        {items.map((it, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="opacity-50">•</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
