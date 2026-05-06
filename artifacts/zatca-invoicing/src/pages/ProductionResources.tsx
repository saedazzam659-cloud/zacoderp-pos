import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Pencil, Cog, X, Factory } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import ProductionAIAssistant from "@/components/ProductionAIAssistant";

const API = import.meta.env.VITE_API_URL || "";
const TYPES = ["machine", "line", "station"] as const;
const STATUSES = ["available", "busy", "maintenance", "offline"] as const;

type Resource = {
  id: number;
  name: string;
  type: string;
  status: string;
  capacityPerHour: string | null;
  notes: string | null;
};

const STATUS_TONES: Record<string, string> = {
  available: "bg-emerald-100 text-emerald-700",
  busy: "bg-amber-100 text-amber-800",
  maintenance: "bg-blue-100 text-blue-700",
  offline: "bg-slate-100 text-slate-700",
};

export default function ProductionResources() {
  const { t } = useTranslation();
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [rows, setRows] = useState<Resource[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Resource | null>(null);
  const [form, setForm] = useState({
    name: "",
    type: "machine",
    status: "available",
    capacityPerHour: "",
    notes: "",
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  function closePanel() {
    setOpen(false);
    setEditing(null);
    setForm({ name: "", type: "machine", status: "available", capacityPerHour: "", notes: "" });
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      firstFieldRef.current?.focus();
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closePanel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/production/resources`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRows(await r.json());
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token, t, toast]);

  useEffect(() => { void load(); }, [load]);

  function openCreate() {
    setEditing(null);
    setForm({ name: "", type: "machine", status: "available", capacityPerHour: "", notes: "" });
    setOpen(true);
  }
  function openEdit(r: Resource) {
    setEditing(r);
    setForm({
      name: r.name,
      type: r.type,
      status: r.status,
      capacityPerHour: r.capacityPerHour ?? "",
      notes: r.notes ?? "",
    });
    setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast({ title: t("production.errorOccurred"), description: t("production.resourceName"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        type: form.type,
        status: form.status,
        capacityPerHour: Number(form.capacityPerHour) || 0,
        notes: form.notes || null,
      };
      const r = await fetch(
        editing ? `${API}/api/production/resources/${editing.id}` : `${API}/api/production/resources`,
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        },
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast({ title: `✓ ${t("production.saved")}` });
      setOpen(false);
      void load();
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function del(id: number) {
    if (!confirm(t("production.confirmDelete"))) return;
    try {
      const r = await fetch(`${API}/api/production/resources/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      toast({ title: `✓ ${t("production.deleted")}` });
      void load();
    } catch (e: any) {
      toast({ title: t("production.errorOccurred"), description: e?.message, variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-gradient-to-br from-indigo-500 to-blue-500 p-2 text-white shadow">
            <Cog className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t("production.resources")}</h1>
            <p className="text-sm text-slate-500">{t("production.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/production/work-centers">
            <Button variant="outline" data-testid="btn-go-work-centers">
              <Factory className="h-4 w-4 me-1" />
              مراكز العمل
            </Button>
          </Link>
          <Button
            ref={triggerRef}
            onClick={() => (open ? closePanel() : openCreate())}
            data-testid="btn-new-resource"
            variant={open ? "outline" : "default"}
            aria-expanded={open}
            aria-controls="panel-resource-form"
          >
            {open ? <X className="h-4 w-4 me-1" /> : <Plus className="h-4 w-4 me-1" />}
            {open ? t("common.cancel") : t("production.addResource")}
          </Button>
        </div>
      </div>

      {/* Phase B — Hint linking machines/lines to the new Work Centers page */}
      <div className="rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2 text-xs text-violet-900 dark:border-violet-900/50 dark:bg-violet-950/20 dark:text-violet-200 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          <Factory className="h-3.5 w-3.5" />
          الموارد هنا (ماكينات/خطوط/محطات) للتوثيق التشغيلي. لإسناد <strong>تكاليف الأجور والـOH</strong> لأوامر الإنتاج، استخدم <strong>مراكز العمل</strong> بمعدلات بالساعة.
        </span>
        <Link href="/production/work-centers" className="font-medium text-violet-700 underline-offset-2 hover:underline dark:text-violet-300">
          فتح مراكز العمل ←
        </Link>
      </div>

      {open && (
        <div
          ref={panelRef}
          id="panel-resource-form"
          role="region"
          aria-label={editing ? `${t("common.edit")}: ${editing.name}` : t("production.addResource")}
          className="rounded-lg border border-indigo-200 dark:border-indigo-900/50 bg-gradient-to-br from-indigo-50/60 to-blue-50/40 dark:from-indigo-950/20 dark:to-blue-950/10 shadow-sm"
          data-testid="panel-resource-form"
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-indigo-200/70 dark:border-indigo-900/40">
            <div className="flex items-center gap-2 text-sm font-semibold text-indigo-700 dark:text-indigo-300">
              {editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {editing ? `${t("common.edit")}: ${editing.name}` : t("production.addResource")}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={closePanel}
              aria-label={t("common.cancel")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <form onSubmit={save} className="p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="md:col-span-2 lg:col-span-2">
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.resourceName")}</Label>
                <Input
                  ref={firstFieldRef}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  data-testid="input-res-name"
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.resourceType")}</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TYPES.map((tp) => (
                      <SelectItem key={tp} value={tp}>{t(`production.type_${tp}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.status")}</Label>
                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{t(`production.resourceStatus_${s}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.capacityPerHour")}</Label>
                <Input
                  type="number" step="0.01"
                  value={form.capacityPerHour}
                  onChange={(e) => setForm({ ...form, capacityPerHour: e.target.value })}
                  className="mt-1"
                />
              </div>
              <div className="md:col-span-2 lg:col-span-3">
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("production.notes")}</Label>
                <Input
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="mt-1"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={closePanel}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={saving} data-testid="btn-save-res">
                {saving ? t("common.loading") : t("common.save")}
              </Button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <div className="rounded-lg border bg-white dark:bg-slate-900">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th className="text-start p-3">{t("production.resourceName")}</th>
                  <th className="text-start p-3">{t("production.resourceType")}</th>
                  <th className="text-start p-3">{t("production.status")}</th>
                  <th className="text-end p-3">{t("production.capacityPerHour")}</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading && rows === null && (
                  <tr><td colSpan={5} className="p-3"><Skeleton className="h-6 w-full" /></td></tr>
                )}
                {!loading && (rows ?? []).length === 0 && (
                  <tr><td colSpan={5} className="p-8 text-center text-slate-500">{t("production.noResources")}</td></tr>
                )}
                {(rows ?? []).map((r) => (
                  <tr key={r.id} className="border-t" data-testid={`row-res-${r.id}`}>
                    <td className="p-3 font-medium">{r.name}</td>
                    <td className="p-3 text-xs">{t(`production.type_${r.type}`)}</td>
                    <td className="p-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONES[r.status] ?? "bg-slate-100"}`}>
                        {t(`production.resourceStatus_${r.status}`)}
                      </span>
                    </td>
                    <td className="p-3 text-end">{Number(r.capacityPerHour ?? 0).toLocaleString()}</td>
                    <td className="p-3 text-end space-x-1 rtl:space-x-reverse">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(r)} data-testid={`btn-edit-res-${r.id}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => del(r.id)} data-testid={`btn-del-res-${r.id}`}>
                        <Trash2 className="h-4 w-4 text-red-600" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <ProductionAIAssistant
            screenContext="production.resources"
            currentAction="managing machines and resources"
          />
        </div>
      </div>
    </div>
  );
}
