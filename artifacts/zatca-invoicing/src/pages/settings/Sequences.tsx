// Centralized Sequence Management screen (مسلسل الحركات).
// Admins-only. CRUD on sequences + reset action + quick logs viewer.

import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { sequencesApi, type SequenceRow, type SequenceLogRow } from "@/lib/sequencesApi";
import { branchesApi } from "@/lib/branchesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, RefreshCcw, ListOrdered, History, AlertTriangle, X, ChevronsUpDown, Search } from "lucide-react";

const EMPTY_FORM = {
  code: "",
  nameAr: "",
  nameEn: "",
  prefix: "",
  // Optional free-form pattern with date tokens (`{MM} {M} {YY} {YYYY}`).
  // Empty string = legacy format (prefix + padded number, no month/year).
  monthPattern: "",
  startNumber: 1,
  endNumber: 999999,
  currentNumber: 1,
  padLength: 4,
  isActive: true,
  transactionTypes: [] as string[],
  branchIds: [] as number[],
};

// ─── Searchable multi-select for branches ──────────────────────────────────
// Inline component (kept in this file because it's only used here) — uses
// the project's existing Popover primitive plus a plain text input for
// filtering. Empty selection means "all branches", matching the backend
// contract; we surface that explicitly in the trigger label.
type BranchOption = { id: number; nameAr: string; nameEn?: string | null; code?: string };

function BranchMultiSelect({
  options, value, onChange, t, allLabel, searchPlaceholder, emptyText, summaryFn,
}: {
  options: BranchOption[];
  value: number[];
  onChange: (next: number[]) => void;
  t: (k: string) => string;
  allLabel: string;
  searchPlaceholder: string;
  emptyText: string;
  summaryFn: (n: number) => string;
}) {
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Cheap fuzzy: substring match on Arabic / English / code, case-insensitive.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(b =>
      b.nameAr?.toLowerCase().includes(q) ||
      b.nameEn?.toLowerCase().includes(q) ||
      b.code?.toLowerCase().includes(q)
    );
  }, [options, query]);

  const selected = new Set(value);
  const triggerLabel = value.length === 0
    ? allLabel
    : value.length <= 2
      ? options.filter(o => selected.has(o.id)).map(o => o.nameAr).join(" • ")
      : summaryFn(value.length);

  function toggle(id: number) {
    if (selected.has(id)) onChange(value.filter(v => v !== id));
    else onChange([...value, id]);
  }
  function clearAll() { onChange([]); }
  function selectAll() { onChange(options.map(o => o.id)); }

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setTimeout(() => inputRef.current?.focus(), 50); }}>
      <PopoverTrigger asChild>
        <Button
          type="button" variant="outline"
          className="w-full justify-between font-normal"
          data-testid="trigger-branch-multiselect"
        >
          <span className="truncate text-start flex-1">{triggerLabel}</span>
          <ChevronsUpDown className="w-4 h-4 opacity-50 ms-2 flex-shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[--radix-popover-trigger-width] min-w-[260px]"
        align="start"
      >
        <div className="flex items-center gap-2 border-b px-2 py-1.5">
          <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="flex-1 bg-transparent text-sm outline-none py-1"
            data-testid="input-branch-search"
          />
          {query && (
            <button
              type="button" onClick={() => setQuery("")}
              className="text-muted-foreground hover:text-foreground"
              aria-label="clear"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-b px-2 py-1 text-xs">
          <button
            type="button" onClick={selectAll}
            className="text-primary hover:underline disabled:opacity-50"
            disabled={options.length === 0 || value.length === options.length}
            data-testid="button-branch-select-all"
          >
            {t("sequences.branchSelectAll")}
          </button>
          <button
            type="button" onClick={clearAll}
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            disabled={value.length === 0}
            data-testid="button-branch-clear"
          >
            {t("sequences.branchClear")}
          </button>
        </div>
        <div className="max-h-60 overflow-auto py-1">
          {filtered.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-4">{emptyText}</p>
          ) : (
            filtered.map(b => {
              const checked = selected.has(b.id);
              return (
                <label
                  key={b.id}
                  className="flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-muted/40"
                  data-testid={`option-branch-${b.id}`}
                >
                  <Checkbox checked={checked} onCheckedChange={() => toggle(b.id)} />
                  <span className="flex-1 truncate">
                    {b.nameAr}
                    {b.code ? <span className="text-muted-foreground ms-2 font-mono text-xs">{b.code}</span> : null}
                  </span>
                </label>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Pretty-format a transaction type key for display. Falls back to the raw
// snake_case key if no i18n translation exists yet.
function txLabel(t: (k: string) => string, key: string) {
  const tr = t(`sequences.tx.${key}`);
  return tr.startsWith("sequences.tx.") ? key : tr;
}

// Render the optional dynamic month/year pattern against the current date.
// Mirrors the server-side helper exactly so the on-screen preview matches
// what `nextSequenceNumber` will actually issue at submit time.
function renderMonthPattern(pattern: string | null | undefined, now: Date = new Date()): string {
  if (!pattern) return "";
  const m  = now.getMonth() + 1;
  const y  = now.getFullYear();
  const MM = String(m).padStart(2, "0");
  const YY = String(y).slice(-2);
  return pattern
    .replace(/\{MM\}/g,   MM)
    .replace(/\{M\}/g,    String(m))
    .replace(/\{YYYY\}/g, String(y))
    .replace(/\{YY\}/g,   YY);
}

function formatPreview(
  prefix: string,
  n: number,
  padLength: number,
  monthPattern?: string | null,
): string {
  const padded = padLength > 0 ? String(n).padStart(padLength, "0") : String(n);
  return `${prefix ?? ""}${renderMonthPattern(monthPattern)}${padded}`;
}

export default function Sequences() {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc  = useQueryClient();
  const { toast } = useToast();

  const [showForm, setShowForm]   = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingRow, setEditingRow] = useState<SequenceRow | null>(null);
  const [form, setForm]           = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [deleteId, setDeleteId]   = useState<number | null>(null);
  const [resetId, setResetId]     = useState<number | null>(null);
  const [resetAck, setResetAck]   = useState(false);
  const [logsId,  setLogsId]      = useState<number | null>(null);

  const { data: rows = [], isLoading } = useQuery<SequenceRow[]>({
    queryKey: ["sequences", cid],
    queryFn:  () => sequencesApi.list(cid),
    enabled:  !!user,
  });

  const { data: txTypes = [] } = useQuery<string[]>({
    queryKey: ["sequence-tx-types"],
    queryFn:  () => sequencesApi.transactionTypes(),
    enabled:  !!user,
  });

  // Branches list for the multi-select. Scoped to the caller's company so
  // SuperAdmin (no cid) sees an empty list — that's intentional, since the
  // sequence-to-branch link is a tenant-level concept.
  const { data: branches = [] } = useQuery<BranchOption[]>({
    queryKey: ["branches-for-sequence", cid],
    queryFn:  () => branchesApi.getBranches(cid),
    enabled:  !!user && !!cid,
  });

  const { data: logs = [] } = useQuery<SequenceLogRow[]>({
    queryKey: ["sequence-logs", logsId],
    queryFn:  () => sequencesApi.logs(logsId!),
    enabled:  logsId != null,
  });

  const inv = () => qc.invalidateQueries({ queryKey: ["sequences", cid] });

  const errToast = (e: any) =>
    toast({ title: t("sequences.errGeneric"), description: e?.message ?? String(e), variant: "destructive" });

  const create = useMutation({
    mutationFn: (data: any) => sequencesApi.create({ ...data, companyId: cid }),
    onSuccess:  () => { inv(); reset(); toast({ title: t("sequences.created") }); },
    onError:    errToast,
  });
  const update = useMutation({
    mutationFn: ({ id, data }: any) => sequencesApi.update(id, data),
    onSuccess:  () => { inv(); reset(); toast({ title: t("sequences.updated") }); },
    onError:    errToast,
  });
  const remove = useMutation({
    mutationFn: (id: number) => sequencesApi.remove(id),
    onSuccess:  () => { inv(); setDeleteId(null); toast({ title: t("sequences.deleted") }); },
    onError:    (e: any) => { setDeleteId(null); errToast(e); },
  });
  const resetMut = useMutation({
    mutationFn: ({ id, acknowledgeReuse }: { id: number; acknowledgeReuse: boolean }) =>
      sequencesApi.reset(id, { acknowledgeReuse }),
    onSuccess:  () => { inv(); setResetId(null); setResetAck(false); toast({ title: t("sequences.resetDone") }); },
    onError:    (e: any) => { setResetId(null); setResetAck(false); errToast(e); },
  });

  function reset() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setEditingRow(null);
    setShowForm(false);
  }

  function openNew() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setEditingRow(null);
    setShowForm(true);
  }

  function openEdit(r: SequenceRow) {
    setForm({
      code:             r.code,
      nameAr:           r.nameAr,
      nameEn:           r.nameEn ?? "",
      prefix:           r.prefix ?? "",
      monthPattern:     r.monthPattern ?? "",
      startNumber:      r.startNumber,
      endNumber:        r.endNumber,
      currentNumber:    r.currentNumber,
      padLength:        r.padLength,
      isActive:         r.isActive,
      transactionTypes: Array.isArray(r.transactionTypes) ? r.transactionTypes : [],
      // Coerce in case the column round-trips strings (older rows or when
      // jsonb is read back unparsed). The backend stores numeric ids.
      branchIds:        Array.isArray(r.branchIds) ? r.branchIds.map(Number) : [],
    });
    setEditingId(r.id);
    setEditingRow(r);
    setShowForm(true);
  }

  // A sequence is "in use" once it's issued at least one number
  // (currentNumber moves past startNumber). When in use, the SHAPE-defining
  // fields (prefix, startNumber, padLength) become immutable on the server,
  // and currentNumber may only increase. The UI mirrors that contract.
  const editingIsUsed = !!editingRow && editingRow.currentNumber !== editingRow.startNumber;
  const minCurrent    = editingIsUsed ? (editingRow?.currentNumber ?? 0) : 0;
  const minEnd        = editingIsUsed ? Math.max(0, (editingRow?.currentNumber ?? 1) - 1) : 0;

  function toggleType(key: string) {
    setForm(f => ({
      ...f,
      transactionTypes: f.transactionTypes.includes(key)
        ? f.transactionTypes.filter(k => k !== key)
        : [...f.transactionTypes, key],
    }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.code.trim() || !form.nameAr.trim()) {
      toast({ title: t("sequences.errCodeNameRequired"), variant: "destructive" }); return;
    }
    if (form.transactionTypes.length === 0) {
      toast({ title: t("sequences.errSelectTx"), variant: "destructive" }); return;
    }
    if (Number(form.endNumber) < Number(form.startNumber)) {
      toast({ title: t("sequences.errEndBeforeStart"), variant: "destructive" }); return;
    }
    const payload = {
      ...form,
      startNumber:   Number(form.startNumber),
      endNumber:     Number(form.endNumber),
      currentNumber: Number(form.currentNumber),
      padLength:     Number(form.padLength),
    };
    if (editingId) update.mutate({ id: editingId, data: payload });
    else create.mutate(payload);
  }

  const previewNumber = formatPreview(
    form.prefix,
    form.currentNumber || form.startNumber,
    form.padLength,
    form.monthPattern,
  );

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6" data-testid="page-sequences">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ListOrdered className="w-6 h-6" />
            {t("sequences.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("sequences.subtitle")}</p>
        </div>
        <Button onClick={openNew} data-testid="button-new-sequence">
          <Plus className="w-4 h-4 me-1" /> {t("sequences.new")}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("sequences.listTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-center text-muted-foreground py-8">{t("common.loading")}</p>
          ) : rows.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">{t("sequences.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-start px-3 py-2">{t("sequences.col.code")}</th>
                    <th className="text-start px-3 py-2">{t("sequences.col.name")}</th>
                    <th className="text-start px-3 py-2">{t("sequences.col.prefix")}</th>
                    <th className="text-start px-3 py-2">{t("sequences.col.range")}</th>
                    <th className="text-start px-3 py-2">{t("sequences.col.next")}</th>
                    <th className="text-start px-3 py-2">{t("sequences.col.usage")}</th>
                    <th className="text-start px-3 py-2">{t("sequences.col.boundTo")}</th>
                    <th className="text-start px-3 py-2">{t("common.status")}</th>
                    <th className="text-end px-3 py-2">{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const pct  = r.usedPct ?? 0;
                    const warn = pct >= 80;
                    const next = formatPreview(r.prefix, r.currentNumber, r.padLength, r.monthPattern);
                    return (
                      <tr key={r.id} className="border-b hover:bg-muted/20" data-testid={`row-sequence-${r.id}`}>
                        <td className="px-3 py-2 font-mono">{r.code}</td>
                        <td className="px-3 py-2">{r.nameAr}{r.nameEn ? ` / ${r.nameEn}` : ""}</td>
                        <td className="px-3 py-2 font-mono text-muted-foreground">{r.prefix || "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.startNumber} – {r.endNumber}</td>
                        <td className="px-3 py-2 font-mono">{next}</td>
                        <td className="px-3 py-2 w-44">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-muted rounded overflow-hidden">
                              <div
                                className={warn ? "h-full bg-orange-500" : "h-full bg-emerald-500"}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className={"text-xs " + (warn ? "text-orange-600 font-semibold" : "text-muted-foreground")}>
                              {pct}%
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {(r.transactionTypes ?? []).map(tx => (
                              <Badge key={tx} variant="secondary" className="text-[10px]">{txLabel(t, tx)}</Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {r.isActive
                            ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">{t("sequences.statusActive")}</Badge>
                            : <Badge variant="outline">{t("sequences.statusInactive")}</Badge>}
                        </td>
                        <td className="px-3 py-2 text-end">
                          <div className="inline-flex gap-1">
                            <Button size="icon" variant="ghost" onClick={() => setLogsId(r.id)}
                                    title={t("sequences.viewLogs")} data-testid={`button-logs-${r.id}`}>
                              <History className="w-4 h-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => setResetId(r.id)}
                                    title={t("sequences.reset")} data-testid={`button-reset-${r.id}`}>
                              <RefreshCcw className="w-4 h-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => openEdit(r)}
                                    title={t("common.edit")} data-testid={`button-edit-${r.id}`}>
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              size="icon" variant="ghost"
                              onClick={() => setDeleteId(r.id)}
                              disabled={(r.usedCount ?? 0) > 0}
                              title={(r.usedCount ?? 0) > 0 ? t("sequences.deleteBlockedUsed") : t("common.delete")}
                              data-testid={`button-delete-${r.id}`}
                            >
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Inline Create / Edit form (replaces popup) ───────────────────── */}
      {showForm && (
        <Card className="border-primary/40" data-testid="inline-form-sequence">
          <CardHeader className="pb-3 flex flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="text-base">
                {editingId ? t("sequences.editTitle") : t("sequences.newTitle")}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">{t("sequences.formHelp")}</p>
            </div>
            <Button size="icon" variant="ghost" onClick={reset} title={t("common.cancel")}
                    data-testid="button-close-form">
              <X className="w-4 h-4" />
            </Button>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              {editingIsUsed && (
                <div
                  className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                  data-testid="banner-locked"
                >
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="font-semibold">{t("sequences.lockedTitle")}</div>
                    <div className="text-xs">{t("sequences.lockedDesc")}</div>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>{t("sequences.col.code")} *</Label>
                  <Input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })}
                         placeholder="SALES_INV" data-testid="input-code" />
                </div>
                <div className="flex items-center gap-2 self-end pb-2">
                  <Switch checked={form.isActive} onCheckedChange={v => setForm({ ...form, isActive: v })}
                          data-testid="switch-active" />
                  <Label>{t("sequences.statusActive")}</Label>
                </div>
                <div>
                  <Label>{t("sequences.nameAr")} *</Label>
                  <Input value={form.nameAr} onChange={e => setForm({ ...form, nameAr: e.target.value })}
                         data-testid="input-name-ar" />
                </div>
                <div>
                  <Label>{t("sequences.nameEn")}</Label>
                  <Input value={form.nameEn} onChange={e => setForm({ ...form, nameEn: e.target.value })}
                         data-testid="input-name-en" />
                </div>
                <div>
                  <Label>{t("sequences.col.prefix")}</Label>
                  <Input value={form.prefix} onChange={e => setForm({ ...form, prefix: e.target.value })}
                         placeholder="INV-" disabled={editingIsUsed} data-testid="input-prefix" />
                </div>
                <div>
                  <Label>{t("sequences.monthPattern")}</Label>
                  <Input value={form.monthPattern}
                         onChange={e => setForm({ ...form, monthPattern: e.target.value })}
                         placeholder="{MM}-"
                         data-testid="input-month-pattern" />
                  <p className="text-xs text-muted-foreground mt-1">
                    {t("sequences.monthPatternHelp")}
                  </p>
                </div>
                <div>
                  <Label>{t("sequences.padLength")}</Label>
                  <Input type="number" min={0} max={12} value={form.padLength}
                         onChange={e => setForm({ ...form, padLength: Number(e.target.value) })}
                         disabled={editingIsUsed} data-testid="input-pad" />
                </div>
                <div>
                  <Label>{t("sequences.startNumber")} *</Label>
                  <Input type="number" min={0} value={form.startNumber}
                         onChange={e => setForm({ ...form, startNumber: Number(e.target.value) })}
                         disabled={editingIsUsed} data-testid="input-start" />
                </div>
                <div>
                  <Label>{t("sequences.endNumber")} *</Label>
                  <Input type="number" min={minEnd} value={form.endNumber}
                         onChange={e => setForm({ ...form, endNumber: Number(e.target.value) })}
                         data-testid="input-end" />
                </div>
                <div>
                  <Label>{t("sequences.currentNumber")}</Label>
                  <Input type="number" min={minCurrent} value={form.currentNumber}
                         onChange={e => setForm({ ...form, currentNumber: Number(e.target.value) })}
                         data-testid="input-current" />
                  <p className="text-xs text-muted-foreground mt-1">{t("sequences.currentHelp")}</p>
                </div>
                <div className="self-end pb-2">
                  <Label className="text-xs text-muted-foreground">{t("sequences.preview")}</Label>
                  <div className="font-mono text-base font-semibold mt-1" data-testid="text-preview">{previewNumber}</div>
                </div>
              </div>

              {/* Branch picker — searchable multi-select. Empty = all branches.
                  Hidden for SuperAdmin (no cid → branch list isn't loaded). */}
              {!!cid && (
                <div>
                  <Label className="block mb-2">{t("sequences.boundBranches")}</Label>
                  <BranchMultiSelect
                    options={branches}
                    value={form.branchIds}
                    onChange={(next) => setForm(f => ({ ...f, branchIds: next }))}
                    t={t}
                    allLabel={t("sequences.boundBranchesAll")}
                    searchPlaceholder={t("sequences.branchSearch")}
                    emptyText={t("sequences.branchesEmpty")}
                    summaryFn={(n) => t("sequences.branchesSelected").replace("{count}", String(n))}
                  />
                  <p className="text-xs text-muted-foreground mt-1">{t("sequences.boundBranchesHelp")}</p>
                </div>
              )}

              <div>
                <Label className="block mb-2">{t("sequences.boundScreens")} *</Label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-auto border rounded p-2">
                  {txTypes.map(tx => {
                    const checked = form.transactionTypes.includes(tx);
                    return (
                      <label key={tx} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/40 rounded px-1 py-1">
                        <Checkbox checked={checked} onCheckedChange={() => toggleType(tx)}
                                  data-testid={`checkbox-tx-${tx}`} />
                        <span>{txLabel(t, tx)}</span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{t("sequences.boundHelp")}</p>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t">
                <Button type="button" variant="outline" onClick={reset} data-testid="button-cancel">
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={create.isPending || update.isPending} data-testid="button-save">
                  {create.isPending || update.isPending ? t("common.saving") : t("common.save")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ─── Inline Logs panel (replaces popup) ───────────────────────────── */}
      {logsId != null && (
        <Card data-testid="inline-logs-panel">
          <CardHeader className="pb-3 flex flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <History className="w-4 h-4" />
                {t("sequences.logsTitle")}
                {(() => {
                  const r = rows.find(x => x.id === logsId);
                  return r ? <span className="font-mono text-xs text-muted-foreground">{r.code}</span> : null;
                })()}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">{t("sequences.logsDesc")}</p>
            </div>
            <Button size="icon" variant="ghost" onClick={() => setLogsId(null)} title={t("common.close") || "إغلاق"}
                    data-testid="button-close-logs">
              <X className="w-4 h-4" />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="max-h-[50vh] overflow-auto">
              {logs.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">{t("sequences.noLogs")}</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b">
                      <th className="text-start px-2 py-2">{t("sequences.col.time")}</th>
                      <th className="text-start px-2 py-2">{t("sequences.col.tx")}</th>
                      <th className="text-start px-2 py-2">{t("sequences.col.number")}</th>
                      <th className="text-start px-2 py-2">{t("sequences.col.ref")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map(l => (
                      <tr key={l.id} className="border-b">
                        <td className="px-2 py-1 text-xs whitespace-nowrap">{new Date(l.createdAt).toLocaleString()}</td>
                        <td className="px-2 py-1">{txLabel(t, l.transactionType)}</td>
                        <td className="px-2 py-1 font-mono">{l.generatedNumber}</td>
                        <td className="px-2 py-1 text-xs text-muted-foreground">
                          {l.refTable ? `${l.refTable}#${l.refId ?? "—"}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Reset confirm ────────────────────────────────────────────────── */}
      <AlertDialog
        open={resetId != null}
        onOpenChange={(o) => { if (!o) { setResetId(null); setResetAck(false); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-orange-500" />
              {t("sequences.resetConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("sequences.resetConfirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          {(() => {
            const r = resetId != null ? rows.find(x => x.id === resetId) : null;
            const used = !!r && r.currentNumber !== r.startNumber;
            if (!used) return null;
            return (
              <div
                className="flex items-start gap-2 text-sm cursor-pointer mt-2 px-1 select-none"
                data-testid="label-ack-reuse"
                onClick={() => setResetAck(v => !v)}
              >
                <Checkbox
                  checked={resetAck}
                  onCheckedChange={(v) => setResetAck(v === true)}
                  data-testid="checkbox-ack-reuse"
                  onClick={(e) => e.stopPropagation()}
                />
                <span>{t("sequences.ackReuseLabel")}</span>
              </div>
            );
          })()}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!resetId) return;
                const r = rows.find(x => x.id === resetId);
                const used = !!r && r.currentNumber !== r.startNumber;
                if (used && !resetAck) return;
                resetMut.mutate({ id: resetId, acknowledgeReuse: used });
              }}
              disabled={(() => {
                const r = resetId != null ? rows.find(x => x.id === resetId) : null;
                const used = !!r && r.currentNumber !== r.startNumber;
                return used && !resetAck;
              })()}
              className="bg-orange-500 hover:bg-orange-600"
              data-testid="button-confirm-reset"
            >
              {t("sequences.resetConfirmBtn")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Delete confirm ───────────────────────────────────────────────── */}
      <AlertDialog open={deleteId != null} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sequences.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("sequences.deleteConfirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && remove.mutate(deleteId)}
              className="bg-destructive hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
