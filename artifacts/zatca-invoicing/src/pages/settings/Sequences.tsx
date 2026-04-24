// Centralized Sequence Management screen (مسلسل الحركات).
// Admins-only. CRUD on sequences + reset action + quick logs viewer.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { sequencesApi, type SequenceRow, type SequenceLogRow } from "@/lib/sequencesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, RefreshCcw, ListOrdered, History, AlertTriangle } from "lucide-react";

const EMPTY_FORM = {
  code: "",
  nameAr: "",
  nameEn: "",
  prefix: "",
  startNumber: 1,
  endNumber: 999999,
  currentNumber: 1,
  padLength: 4,
  isActive: true,
  transactionTypes: [] as string[],
};

// Pretty-format a transaction type key for display. Falls back to the raw
// snake_case key if no i18n translation exists yet.
function txLabel(t: (k: string) => string, key: string) {
  const tr = t(`sequences.tx.${key}`);
  return tr.startsWith("sequences.tx.") ? key : tr;
}

function formatPreview(prefix: string, n: number, padLength: number): string {
  const padded = padLength > 0 ? String(n).padStart(padLength, "0") : String(n);
  return `${prefix ?? ""}${padded}`;
}

export default function Sequences() {
  const { t } = useTranslation();
  const { user } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const qc  = useQueryClient();
  const { toast } = useToast();

  const [showForm, setShowForm]   = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm]           = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [deleteId, setDeleteId]   = useState<number | null>(null);
  const [resetId, setResetId]     = useState<number | null>(null);
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
    mutationFn: (id: number) => sequencesApi.reset(id),
    onSuccess:  () => { inv(); setResetId(null); toast({ title: t("sequences.resetDone") }); },
    onError:    (e: any) => { setResetId(null); errToast(e); },
  });

  function reset() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  }

  function openNew() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(true);
  }

  function openEdit(r: SequenceRow) {
    setForm({
      code:             r.code,
      nameAr:           r.nameAr,
      nameEn:           r.nameEn ?? "",
      prefix:           r.prefix ?? "",
      startNumber:      r.startNumber,
      endNumber:        r.endNumber,
      currentNumber:    r.currentNumber,
      padLength:        r.padLength,
      isActive:         r.isActive,
      transactionTypes: Array.isArray(r.transactionTypes) ? r.transactionTypes : [],
    });
    setEditingId(r.id);
    setShowForm(true);
  }

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

  const previewNumber = formatPreview(form.prefix, form.currentNumber || form.startNumber, form.padLength);

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
                    const next = formatPreview(r.prefix, r.currentNumber, r.padLength);
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
                            <Button size="icon" variant="ghost" onClick={() => setDeleteId(r.id)}
                                    title={t("common.delete")} data-testid={`button-delete-${r.id}`}>
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

      {/* ─── Create / Edit dialog ─────────────────────────────────────────── */}
      <Dialog open={showForm} onOpenChange={(o) => { if (!o) reset(); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? t("sequences.editTitle") : t("sequences.newTitle")}</DialogTitle>
            <DialogDescription>{t("sequences.formHelp")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
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
                       placeholder="INV-" data-testid="input-prefix" />
              </div>
              <div>
                <Label>{t("sequences.padLength")}</Label>
                <Input type="number" min={0} max={12} value={form.padLength}
                       onChange={e => setForm({ ...form, padLength: Number(e.target.value) })}
                       data-testid="input-pad" />
              </div>
              <div>
                <Label>{t("sequences.startNumber")} *</Label>
                <Input type="number" min={0} value={form.startNumber}
                       onChange={e => setForm({ ...form, startNumber: Number(e.target.value) })}
                       data-testid="input-start" />
              </div>
              <div>
                <Label>{t("sequences.endNumber")} *</Label>
                <Input type="number" min={0} value={form.endNumber}
                       onChange={e => setForm({ ...form, endNumber: Number(e.target.value) })}
                       data-testid="input-end" />
              </div>
              <div>
                <Label>{t("sequences.currentNumber")}</Label>
                <Input type="number" min={0} value={form.currentNumber}
                       onChange={e => setForm({ ...form, currentNumber: Number(e.target.value) })}
                       data-testid="input-current" />
                <p className="text-xs text-muted-foreground mt-1">{t("sequences.currentHelp")}</p>
              </div>
              <div className="self-end pb-2">
                <Label className="text-xs text-muted-foreground">{t("sequences.preview")}</Label>
                <div className="font-mono text-base font-semibold mt-1" data-testid="text-preview">{previewNumber}</div>
              </div>
            </div>

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

            <DialogFooter>
              <Button type="button" variant="outline" onClick={reset} data-testid="button-cancel">{t("common.cancel")}</Button>
              <Button type="submit" disabled={create.isPending || update.isPending} data-testid="button-save">
                {create.isPending || update.isPending ? t("common.saving") : t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ─── Logs drawer (modal) ──────────────────────────────────────────── */}
      <Dialog open={logsId != null} onOpenChange={(o) => { if (!o) setLogsId(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("sequences.logsTitle")}</DialogTitle>
            <DialogDescription>{t("sequences.logsDesc")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
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
        </DialogContent>
      </Dialog>

      {/* ─── Reset confirm ────────────────────────────────────────────────── */}
      <AlertDialog open={resetId != null} onOpenChange={(o) => { if (!o) setResetId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-orange-500" />
              {t("sequences.resetConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("sequences.resetConfirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => resetId && resetMut.mutate(resetId)}
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
