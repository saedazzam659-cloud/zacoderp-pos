import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { SearchCombobox } from "@/components/ui/search-combobox";
import ExportButtons from "@/components/ExportButtons";
import { FormPanel, Field, FormGrid } from "@/components/FormPanel";
import { Plus, Pencil, Trash2, Target, Search, ChevronLeft, ChevronRight, FolderTree } from "lucide-react";
import { cn } from "@/lib/utils";

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
          saveDisabled={!form.code.trim() || !form.nameAr.trim()}
          saveLabel={t("costCenters.saveAction")}
        >
          <FormGrid>
            <Field label={t("costCenters.code")} required>
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
