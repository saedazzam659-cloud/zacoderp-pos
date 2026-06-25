import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  useExtDataList,
  useExtDataCreate,
  useExtDataUpdate,
  useExtDataRemove,
  type ExtDataRecord,
} from "./registry";

// ─────────────────────────────────────────────────────────────────────────
// ExtensionDataGrid — a generic, host-provided back-office table for ANY
// extension collection. It is fully schema-less: an extension's rows are
// freeform JSON (`ext_records.data`), so the grid DERIVES its columns from the
// keys present across the loaded rows and offers a key/value editor (plus a
// raw-JSON escape hatch) for create/edit. All reads/writes go through the
// existing, tenant-scoped, manifest-gated /api/ext/:extId/data/:collection
// endpoints — the grid adds ZERO new backend surface.
// ─────────────────────────────────────────────────────────────────────────

type FieldRow = { id: number; key: string; value: string };

// Render a JSON value compactly for a table cell.
function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Turn a stored value into something editable in a text field.
function valueToInput(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Parse an edited string back to a JSON value: try JSON first (so numbers,
// booleans, objects round-trip), otherwise keep it a plain string.
function inputToValue(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.parse(s);
    } catch {
      return raw;
    }
  }
  return raw;
}

let fieldSeq = 0;
function fieldsFromData(data: Record<string, unknown>): FieldRow[] {
  const rows = Object.entries(data).map(([key, value]) => ({
    id: ++fieldSeq,
    key,
    value: valueToInput(value),
  }));
  return rows.length > 0 ? rows : [{ id: ++fieldSeq, key: "", value: "" }];
}

export default function ExtensionDataGrid({
  extensionId,
  collection,
  title,
}: {
  extensionId: string;
  collection: string;
  title?: string;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const list = useExtDataList(extensionId, collection, { limit: 500 });
  const createM = useExtDataCreate(extensionId, collection);
  const updateM = useExtDataUpdate(extensionId, collection);
  const removeM = useExtDataRemove(extensionId, collection);

  const records = list.data ?? [];

  // Columns = the union of all keys appearing in the rows' `data`, in first-seen
  // order. Schema-less by design.
  const columns = useMemo(() => {
    const seen: string[] = [];
    for (const r of records) {
      const d = r.data && typeof r.data === "object" ? r.data : {};
      for (const k of Object.keys(d)) if (!seen.includes(k)) seen.push(k);
    }
    return seen;
  }, [records]);

  // ── Editor state ────────────────────────────────────────────────────────
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ExtDataRecord | null>(null);
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState("");
  const [formError, setFormError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ExtDataRecord | null>(null);

  function openCreate() {
    setEditing(null);
    setFields([{ id: ++fieldSeq, key: "", value: "" }]);
    setRawMode(false);
    setRawText("{}");
    setFormError("");
    setEditorOpen(true);
  }

  function openEdit(rec: ExtDataRecord) {
    setEditing(rec);
    const data = rec.data && typeof rec.data === "object" ? rec.data : {};
    setFields(fieldsFromData(data));
    setRawMode(false);
    setRawText(JSON.stringify(data, null, 2));
    setFormError("");
    setEditorOpen(true);
  }

  function setField(id: number, patch: Partial<FieldRow>) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }
  function addField() {
    setFields((prev) => [...prev, { id: ++fieldSeq, key: "", value: "" }]);
  }
  function removeField(id: number) {
    setFields((prev) => (prev.length > 1 ? prev.filter((f) => f.id !== id) : prev));
  }

  // Keep the raw editor and the field editor in sync when toggling modes.
  function toggleRaw() {
    if (!rawMode) {
      const obj = buildFromFields();
      if (obj == null) return; // error already set
      setRawText(JSON.stringify(obj, null, 2));
      setRawMode(true);
    } else {
      try {
        const parsed = JSON.parse(rawText || "{}");
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setFormError(t("extensions.data.errorObject", "يجب أن تكون البيانات كائن JSON."));
          return;
        }
        setFields(fieldsFromData(parsed as Record<string, unknown>));
        setRawMode(false);
        setFormError("");
      } catch {
        setFormError(t("extensions.data.errorJson", "صيغة JSON غير صحيحة."));
      }
    }
  }

  function buildFromFields(): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const key = f.key.trim();
      if (!key) {
        if (f.value.trim()) {
          setFormError(t("extensions.data.errorEmptyKey", "كل قيمة تحتاج اسم حقل."));
          return null;
        }
        continue;
      }
      if (key in out) {
        setFormError(t("extensions.data.errorDupKey", "اسم الحقل مكرر: ") + key);
        return null;
      }
      out[key] = inputToValue(f.value);
    }
    setFormError("");
    return out;
  }

  function collectData(): Record<string, unknown> | null {
    if (rawMode) {
      try {
        const parsed = JSON.parse(rawText || "{}");
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setFormError(t("extensions.data.errorObject", "يجب أن تكون البيانات كائن JSON."));
          return null;
        }
        setFormError("");
        return parsed as Record<string, unknown>;
      } catch {
        setFormError(t("extensions.data.errorJson", "صيغة JSON غير صحيحة."));
        return null;
      }
    }
    return buildFromFields();
  }

  function onSubmit() {
    const data = collectData();
    if (data == null) return;
    const onErr = (e: unknown) =>
      toast({
        title: t("common.error", "حدث خطأ"),
        description: (e as Error)?.message,
        variant: "destructive",
      });
    if (editing) {
      updateM.mutate(
        { id: editing.id, data },
        {
          onSuccess: () => {
            toast({ title: t("extensions.data.saved", "تم حفظ السجل") });
            setEditorOpen(false);
          },
          onError: onErr,
        },
      );
    } else {
      createM.mutate(data, {
        onSuccess: () => {
          toast({ title: t("extensions.data.created", "تمت إضافة السجل") });
          setEditorOpen(false);
        },
        onError: onErr,
      });
    }
  }

  function onConfirmDelete() {
    if (!deleteTarget) return;
    removeM.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast({ title: t("extensions.data.deleted", "تم حذف السجل") });
        setDeleteTarget(null);
      },
      onError: (e) => {
        toast({
          title: t("common.error", "حدث خطأ"),
          description: (e as Error)?.message,
          variant: "destructive",
        });
        setDeleteTarget(null);
      },
    });
  }

  const saving = createM.isPending || updateM.isPending;

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid={`ext-data-grid-${collection}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">
          {title || collection}
        </h2>
        <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {records.length}
        </span>
        <div className="ms-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void list.refetch()}
            disabled={list.isFetching}
            data-testid="ext-data-refresh"
          >
            <RefreshCw className={"h-4 w-4 me-1 " + (list.isFetching ? "animate-spin" : "")} />
            {t("common.refresh", "تحديث")}
          </Button>
          <Button size="sm" onClick={openCreate} data-testid="ext-data-add">
            <Plus className="h-4 w-4 me-1" />
            {t("extensions.data.add", "إضافة سجل")}
          </Button>
        </div>
      </div>

      {list.isLoading && (
        <div className="text-muted-foreground" data-testid="ext-data-loading">
          {t("common.loading", "جارٍ التحميل…")}
        </div>
      )}

      {list.isError && (
        <div className="text-destructive" data-testid="ext-data-error">
          {(list.error as Error)?.message || t("common.error", "حدث خطأ")}
        </div>
      )}

      {!list.isLoading && !list.isError && records.length === 0 && (
        <div
          className="rounded-md border border-dashed py-10 text-center text-muted-foreground"
          data-testid="ext-data-empty"
        >
          {t("extensions.data.empty", "لا توجد سجلات في هذا الجدول بعد.")}
        </div>
      )}

      {!list.isLoading && !list.isError && records.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c} className="whitespace-nowrap">
                    {c}
                  </TableHead>
                ))}
                <TableHead className="whitespace-nowrap">
                  {t("extensions.data.updatedAt", "آخر تحديث")}
                </TableHead>
                <TableHead className="w-px text-end">{t("common.actions", "إجراءات")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r) => {
                const d = r.data && typeof r.data === "object" ? r.data : {};
                const ts = r.updatedAt || r.createdAt;
                return (
                  <TableRow key={r.id} data-testid={`ext-data-row-${r.id}`}>
                    {columns.map((c) => (
                      <TableCell key={c} className="max-w-xs truncate align-top">
                        {cellText((d as Record<string, unknown>)[c])}
                      </TableCell>
                    ))}
                    <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
                      {ts ? new Date(ts).toLocaleString() : ""}
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openEdit(r)}
                          data-testid={`ext-data-edit-${r.id}`}
                          aria-label={t("common.edit", "تعديل")}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={() => setDeleteTarget(r)}
                          data-testid={`ext-data-delete-${r.id}`}
                          aria-label={t("common.delete", "حذف")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-lg" data-testid="ext-data-editor">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("extensions.data.editTitle", "تعديل سجل")
                : t("extensions.data.addTitle", "إضافة سجل")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {rawMode ? (
              <div className="space-y-1">
                <Label htmlFor="ext-data-raw">{t("extensions.data.rawJson", "JSON")}</Label>
                <Textarea
                  id="ext-data-raw"
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  rows={10}
                  className="font-mono text-xs"
                  dir="ltr"
                  data-testid="ext-data-raw-input"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs text-muted-foreground">
                  <span>{t("extensions.data.fieldName", "اسم الحقل")}</span>
                  <span>{t("extensions.data.fieldValue", "القيمة")}</span>
                  <span />
                </div>
                {fields.map((f) => (
                  <div key={f.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <Input
                      value={f.key}
                      onChange={(e) => setField(f.id, { key: e.target.value })}
                      placeholder={t("extensions.data.fieldName", "اسم الحقل")}
                      dir="ltr"
                      data-testid={`ext-data-field-key-${f.id}`}
                    />
                    <Input
                      value={f.value}
                      onChange={(e) => setField(f.id, { value: e.target.value })}
                      placeholder={t("extensions.data.fieldValue", "القيمة")}
                      dir="ltr"
                      data-testid={`ext-data-field-value-${f.id}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-destructive"
                      onClick={() => removeField(f.id)}
                      aria-label={t("common.delete", "حذف")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addField}
                  data-testid="ext-data-add-field"
                >
                  <Plus className="h-4 w-4 me-1" />
                  {t("extensions.data.addField", "إضافة حقل")}
                </Button>
              </div>
            )}

            {formError && (
              <p className="text-sm text-destructive" data-testid="ext-data-form-error">
                {formError}
              </p>
            )}

            <button
              type="button"
              className="text-xs text-primary underline"
              onClick={toggleRaw}
              data-testid="ext-data-toggle-raw"
            >
              {rawMode
                ? t("extensions.data.useFields", "تحرير بالحقول")
                : t("extensions.data.useJson", "تحرير JSON")}
            </button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>
              {t("common.cancel", "إلغاء")}
            </Button>
            <Button onClick={onSubmit} disabled={saving} data-testid="ext-data-save">
              {saving ? t("common.saving", "جارٍ الحفظ…") : t("common.save", "حفظ")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("extensions.data.deleteTitle", "حذف السجل")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("extensions.data.deleteConfirm", "هل تريد حذف هذا السجل؟ لا يمكن التراجع.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel", "إلغاء")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="ext-data-confirm-delete"
            >
              {t("common.delete", "حذف")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
