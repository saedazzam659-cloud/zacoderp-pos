import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Plus, Pencil, Trash2, Target, Search, ChevronLeft, FolderTree } from "lucide-react";
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

const EXPORT_COLS = [
  { key: "code",      header: "الكود",       width: 14 },
  { key: "nameAr",    header: "الاسم بالعربية", width: 32 },
  { key: "nameEn",    header: "الاسم بالإنجليزية", width: 32 },
  { key: "level",     header: "المستوى",      width: 10 },
  { key: "isPosting", header: "ترحيل",       width: 10 },
  { key: "isActive",  header: "نشط",         width: 10 },
];

export default function CostCenters() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const qc = useQueryClient();
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

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

  // ─── Tree build ───────────────────────────────────────────────────────────
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

  // Filtered centers (flat) for search & status filter
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

  // Mutation: save (create or update)
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
      if (!r.ok) throw new Error(d?.error || "فشل الحفظ");
      return d;
    },
    onSuccess: () => {
      toast({ title: editId ? "تم تحديث مركز التكلفة" : "تم إنشاء مركز التكلفة" });
      qc.invalidateQueries({ queryKey: ["cost-centers", cid] });
      reset();
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${API}/api/cost-centers/${id}`, { method: "DELETE", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "فشل الحذف");
      return d;
    },
    onSuccess: () => {
      toast({ title: "تم حذف مركز التكلفة" });
      qc.invalidateQueries({ queryKey: ["cost-centers", cid] });
      setConfirmDelId(null);
    },
    onError: (e: any) => toast({ title: "خطأ", description: e.message, variant: "destructive" }),
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

  // Parent options — exclude self
  const parentOptions = useMemo(() => {
    return [
      { value: "", label: "— بدون أب (مركز رئيسي) —" },
      ...centers
        .filter(c => c.id !== editId)
        .map(c => ({ value: String(c.id), label: `${c.code} — ${c.nameAr}` })),
    ];
  }, [centers, editId]);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-cyan-500 via-teal-500 to-emerald-500 text-white shadow-md">
            <Target className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">مراكز التكلفة</h1>
            <p className="text-sm text-muted-foreground">
              تصنيف هرمي للمصروفات والإيرادات حسب الإدارة أو المشروع أو القسم
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons
            rows={centers}
            columns={EXPORT_COLS}
            filename="cost-centers"
            title="مراكز التكلفة"
          />
          <Button size="lg" onClick={() => startNew()} className="gap-2 bg-gradient-to-l from-cyan-600 to-teal-600 hover:from-cyan-700 hover:to-teal-700 shadow-md">
            <Plus className="h-5 w-5" />
            مركز جديد
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="بحث بالكود أو الاسم..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pr-9"
          />
        </div>
        <div className="flex items-center gap-1 border rounded-md p-1 bg-muted/30">
          {[
            { v: "all",      l: "الكل" },
            { v: "active",   l: "نشط" },
            { v: "inactive", l: "موقوف" },
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
          إجمالي: {centers.length}
        </Badge>
      </div>

      {/* Form */}
      {showForm && (
        <FormPanel
          icon={Target}
          title={editId ? "تعديل مركز تكلفة" : "مركز تكلفة جديد"}
          subtitle="مركز التكلفة يُستخدم لتتبع المصروفات والإيرادات حسب الإدارة أو المشروع"
          width="3xl"
          onClose={reset}
          onSave={() => saveMut.mutate(form)}
          saving={saveMut.isPending}
          saveDisabled={!form.code.trim() || !form.nameAr.trim()}
          saveLabel="حفظ مركز التكلفة"
        >
          <FormGrid>
            <Field label="الكود" required>
              <Input
                placeholder="مثال: CC001"
                value={form.code}
                onChange={e => setForm((p: any) => ({ ...p, code: e.target.value }))}
                dir="ltr"
                className="text-left font-mono"
              />
            </Field>
            <Field label="الاسم بالعربية" required>
              <Input value={form.nameAr} onChange={e => setForm((p: any) => ({ ...p, nameAr: e.target.value }))} />
            </Field>
            <Field label="الاسم بالإنجليزية">
              <Input dir="ltr" className="text-left" value={form.nameEn} onChange={e => setForm((p: any) => ({ ...p, nameEn: e.target.value }))} />
            </Field>
            <Field label="المركز الأب">
              <SearchCombobox
                items={parentOptions}
                value={form.parentId}
                onValueChange={(v) => setForm((p: any) => ({ ...p, parentId: v }))}
                placeholder="اختر المركز الأب..."
              />
            </Field>
            <Field label="ملاحظات" className="md:col-span-2">
              <Input value={form.notes} onChange={e => setForm((p: any) => ({ ...p, notes: e.target.value }))} />
            </Field>
          </FormGrid>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/20">
              <div>
                <Label className="text-xs font-semibold">قابل للترحيل</Label>
                <p className="text-[11px] text-muted-foreground">يمكن استخدامه في القيود مباشرة</p>
              </div>
              <Switch checked={form.isPosting} onCheckedChange={(v: boolean) => setForm((p: any) => ({ ...p, isPosting: v }))} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/20">
              <div>
                <Label className="text-xs font-semibold">نشط</Label>
                <p className="text-[11px] text-muted-foreground">المراكز الموقوفة لا تظهر في القوائم</p>
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
          <span className="text-sm font-semibold">شجرة مراكز التكلفة</span>
          {usingSearch && (
            <Badge variant="outline" className="text-[10px]">
              نتائج التصفية: {filtered.length}
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
            <p className="font-semibold mb-1">لا توجد مراكز تكلفة بعد</p>
            <p className="text-xs">ابدأ بإنشاء مركز التكلفة الرئيسي الأول</p>
          </div>
        ) : usingSearch ? (
          // Flat list when filtering
          <div className="divide-y">
            {filtered.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">لا توجد نتائج مطابقة</div>
            ) : filtered.map(c => (
              <RowFlat key={c.id} c={c} centers={centers}
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
          // Tree view
          <div className="divide-y">
            {tree.map(node => (
              <TreeRow
                key={node.id}
                node={node}
                depth={0}
                expanded={expanded}
                onToggle={(id) => setExpanded(prev => {
                  const n = new Set(prev);
                  if (n.has(id)) n.delete(id); else n.add(id);
                  return n;
                })}
                onEdit={(c) => startEdit(c)}
                onAddChild={(id) => startNew(id)}
                onDelete={(id) => setConfirmDelId(id)}
                confirmDelId={confirmDelId}
                onCancelDel={() => setConfirmDelId(null)}
                onConfirmDel={(id) => delMut.mutate(id)}
                delPending={delMut.isPending}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tree row ─────────────────────────────────────────────────────────────────
function TreeRow({
  node, depth, expanded, onToggle, onEdit, onAddChild, onDelete,
  confirmDelId, onCancelDel, onConfirmDel, delPending,
}: any) {
  const hasKids = node.children.length > 0;
  const isOpen = expanded.has(node.id);

  return (
    <div>
      <div className="flex items-center gap-2 p-2.5 hover:bg-muted/30 transition-colors" style={{ paddingRight: 12 + depth * 20 }}>
        {hasKids ? (
          <button onClick={() => onToggle(node.id)} className="p-0.5 rounded hover:bg-muted">
            <ChevronLeft className={cn("h-4 w-4 transition-transform", isOpen && "-rotate-90")} />
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
          {node.nameAr}
          {node.nameEn && <span className="text-[11px] text-muted-foreground mr-2">— {node.nameEn}</span>}
        </span>
        {!node.isPosting && (
          <Badge variant="outline" className="text-[10px] h-5 bg-amber-50 text-amber-700 border-amber-200">حساب رئيسي</Badge>
        )}
        {!node.isActive && (
          <Badge variant="outline" className="text-[10px] h-5 bg-gray-50 text-gray-600 border-gray-200">موقوف</Badge>
        )}
        <div className="flex items-center gap-1">
          {confirmDelId === node.id ? (
            <div className="flex items-center gap-1 bg-red-50 border border-red-300 rounded-md px-2 py-1">
              <span className="text-[10px] text-red-700 font-medium">تأكيد؟</span>
              <Button size="sm" variant="ghost" onClick={onCancelDel} className="h-6 px-2 text-[10px]">إلغاء</Button>
              <Button size="sm" variant="destructive" onClick={() => onConfirmDel(node.id)} disabled={delPending} className="h-6 px-2 text-[10px]">حذف</Button>
            </div>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => onAddChild(node.id)} className="h-7 w-7 p-0" title="إضافة فرعي">
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onEdit(node)} className="h-7 w-7 p-0" title="تعديل">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(node.id)} className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50" title="حذف">
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
              onConfirmDel={onConfirmDel} delPending={delPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Flat row (used when filtering/searching) ────────────────────────────────
function RowFlat({
  c, centers, onEdit, onAddChild, onDelete,
  confirmDel, onCancelDel, onConfirmDel, delPending,
}: any) {
  const parent = c.parentId ? centers.find((x: any) => x.id === c.parentId) : null;
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
          {c.nameAr}
          {c.nameEn && <span className="text-[11px] text-muted-foreground mr-2">— {c.nameEn}</span>}
        </div>
        {parent && (
          <div className="text-[10px] text-muted-foreground">
            تابع لـ: <span className="font-mono">{parent.code}</span> {parent.nameAr}
          </div>
        )}
      </div>
      {!c.isPosting && <Badge variant="outline" className="text-[10px] h-5 bg-amber-50 text-amber-700 border-amber-200">حساب رئيسي</Badge>}
      {!c.isActive && <Badge variant="outline" className="text-[10px] h-5 bg-gray-50 text-gray-600 border-gray-200">موقوف</Badge>}
      <div className="flex items-center gap-1">
        {confirmDel ? (
          <div className="flex items-center gap-1 bg-red-50 border border-red-300 rounded-md px-2 py-1">
            <span className="text-[10px] text-red-700 font-medium">تأكيد؟</span>
            <Button size="sm" variant="ghost" onClick={onCancelDel} className="h-6 px-2 text-[10px]">إلغاء</Button>
            <Button size="sm" variant="destructive" onClick={onConfirmDel} disabled={delPending} className="h-6 px-2 text-[10px]">حذف</Button>
          </div>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={onAddChild} className="h-7 w-7 p-0" title="إضافة فرعي"><Plus className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="ghost" onClick={onEdit} className="h-7 w-7 p-0" title="تعديل"><Pencil className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="ghost" onClick={onDelete} className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50" title="حذف"><Trash2 className="h-3.5 w-3.5" /></Button>
          </>
        )}
      </div>
    </div>
  );
}
