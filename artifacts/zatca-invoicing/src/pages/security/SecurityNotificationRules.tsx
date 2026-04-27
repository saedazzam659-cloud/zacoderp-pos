import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Plus, Pencil, Trash2 } from "lucide-react";
import {
  securityNotificationRulesApi,
  type SecurityNotificationRule,
  type SecurityNotificationRuleInput,
} from "@/lib/securityEventsApi";
import { branchesApi } from "@/lib/branchesApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectTrigger, SelectContent, SelectItem, SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.VITE_API_URL ?? "";
function authHeaders() {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}` } : ({} as Record<string, string>);
}

const EVENT_TYPES = [
  "intrusion", "theft", "suspicious_movement", "unknown_person",
  "after_hours_presence", "missing_item", "unusual_gathering",
  "tampering", "other",
] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;

interface CompanyUser {
  id: number;
  username: string;
  fullName?: string | null;
}
interface Branch { id: number; name: string }

type FormState = SecurityNotificationRuleInput & { id?: number };

const EMPTY_FORM: FormState = {
  name: "",
  isActive: true,
  minSeverity: "medium",
  eventTypes: [],
  branchIds: [],
  targetMode: "broadcast",
  targetUserIds: [],
};

export default function SecurityNotificationRules() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();

  // ── Data ─────────────────────────────────────────────────────────
  const rulesQ = useQuery({
    queryKey: ["security-notification-rules"],
    queryFn: () => securityNotificationRulesApi.list(),
  });
  const branchesQ = useQuery({
    queryKey: ["branches-for-rules"],
    queryFn: () => branchesApi.getBranches() as Promise<Branch[]>,
  });
  const usersQ = useQuery({
    queryKey: ["company-users-for-rules"],
    queryFn: async (): Promise<CompanyUser[]> => {
      const r = await fetch(`${API}/api/users`, { headers: authHeaders() });
      if (!r.ok) return [];
      return r.json();
    },
  });

  // ── Dialog state ─────────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const isEdit = form.id != null;

  function openCreate() {
    setForm(EMPTY_FORM);
    setOpen(true);
  }
  function openEdit(r: SecurityNotificationRule) {
    setForm({
      id: r.id,
      name: r.name,
      isActive: r.isActive,
      minSeverity: r.minSeverity,
      eventTypes: r.eventTypes ?? [],
      branchIds: r.branchIds ?? [],
      targetMode: r.targetMode,
      targetUserIds: r.targetUserIds ?? [],
    });
    setOpen(true);
  }

  // ── Mutations ────────────────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: async () => {
      const payload: SecurityNotificationRuleInput = {
        name: form.name.trim(),
        isActive: form.isActive ?? true,
        minSeverity: form.minSeverity,
        eventTypes: form.eventTypes,
        branchIds: form.branchIds,
        targetMode: form.targetMode,
        targetUserIds: form.targetMode === "users" ? form.targetUserIds : [],
      };
      return form.id != null
        ? securityNotificationRulesApi.update(form.id, payload)
        : securityNotificationRulesApi.create(payload);
    },
    onSuccess: () => {
      toast({ title: t("security.rules.ruleSaved") });
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["security-notification-rules"] });
    },
    onError: (e: any) =>
      toast({ title: t("common.error"), description: e?.message, variant: "destructive" }),
  });

  const toggleMut = useMutation({
    mutationFn: (id: number) => securityNotificationRulesApi.toggle(id),
    onSuccess: () => {
      toast({ title: t("security.rules.ruleToggled") });
      qc.invalidateQueries({ queryKey: ["security-notification-rules"] });
    },
    onError: (e: any) =>
      toast({ title: t("common.error"), description: e?.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => securityNotificationRulesApi.remove(id),
    onSuccess: () => {
      toast({ title: t("security.rules.ruleDeleted") });
      qc.invalidateQueries({ queryKey: ["security-notification-rules"] });
    },
    onError: (e: any) =>
      toast({ title: t("common.error"), description: e?.message, variant: "destructive" }),
  });

  // ── Helpers ──────────────────────────────────────────────────────
  const branchById = useMemo(() => {
    const m = new Map<number, string>();
    (branchesQ.data ?? []).forEach((b: Branch) => m.set(b.id, b.name));
    return m;
  }, [branchesQ.data]);

  const userLabel = (u: CompanyUser) => u.fullName?.trim() || u.username;
  const userById = useMemo(() => {
    const m = new Map<number, string>();
    (usersQ.data ?? []).forEach((u) => m.set(u.id, userLabel(u)));
    return m;
  }, [usersQ.data]);

  function toggleArrayValue<T>(arr: T[], v: T): T[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast({
        title: t("common.error"),
        description: t("security.rules.validation.nameRequired"),
        variant: "destructive",
      });
      return;
    }
    if (form.targetMode === "users" && form.targetUserIds.length === 0) {
      toast({
        title: t("common.error"),
        description: t("security.rules.validation.usersRequired"),
        variant: "destructive",
      });
      return;
    }
    saveMut.mutate();
  }

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <BellRing className="h-6 w-6 text-rose-500" />
            <div>
              <CardTitle>{t("security.rules.title")}</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {t("security.rules.description")}
              </p>
            </div>
          </div>
          <Button onClick={openCreate} data-testid="btn-new-notif-rule">
            <Plus className="h-4 w-4 me-1" />
            {t("security.rules.newRule")}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="notif-rules-table">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-3 text-start">{t("security.rules.col.name")}</th>
                  <th className="p-3 text-start">{t("security.rules.col.status")}</th>
                  <th className="p-3 text-start">{t("security.rules.col.minSeverity")}</th>
                  <th className="p-3 text-start">{t("security.rules.col.eventTypes")}</th>
                  <th className="p-3 text-start">{t("security.rules.col.branches")}</th>
                  <th className="p-3 text-start">{t("security.rules.col.target")}</th>
                  <th className="p-3 text-end">{t("security.rules.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {rulesQ.isLoading && (
                  <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">…</td></tr>
                )}
                {rulesQ.data?.length === 0 && !rulesQ.isLoading && (
                  <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">
                    {t("security.rules.empty")}
                  </td></tr>
                )}
                {rulesQ.data?.map((r) => (
                  <tr key={r.id} className="border-t" data-testid={`notif-rule-row-${r.id}`}>
                    <td className="p-3 font-medium">{r.name}</td>
                    <td className="p-3">
                      <Switch
                        checked={r.isActive}
                        onCheckedChange={() => toggleMut.mutate(r.id)}
                        data-testid={`btn-toggle-notif-rule-${r.id}`}
                      />
                    </td>
                    <td className="p-3">
                      <Badge variant="outline">{t(`security.severity.${r.minSeverity}`)}</Badge>
                    </td>
                    <td className="p-3">
                      {r.eventTypes.length === 0
                        ? <span className="text-muted-foreground">{t("security.rules.anyType")}</span>
                        : <div className="flex flex-wrap gap-1">
                            {r.eventTypes.map((et) => (
                              <Badge key={et} variant="secondary">{t(`security.type.${et}`)}</Badge>
                            ))}
                          </div>}
                    </td>
                    <td className="p-3">
                      {r.branchIds.length === 0
                        ? <span className="text-muted-foreground">{t("security.rules.anyBranch")}</span>
                        : <div className="flex flex-wrap gap-1">
                            {r.branchIds.map((bid) => (
                              <Badge key={bid} variant="secondary">
                                {branchById.get(bid) ?? `#${bid}`}
                              </Badge>
                            ))}
                          </div>}
                    </td>
                    <td className="p-3">
                      {r.targetMode === "broadcast"
                        ? <Badge>{t("security.rules.broadcast")}</Badge>
                        : <span>
                            {t("security.rules.specificUsers")}
                            <span className="text-muted-foreground ms-1">
                              ({r.targetUserIds.length})
                            </span>
                          </span>}
                    </td>
                    <td className="p-3 text-end whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(r)}
                              data-testid={`btn-edit-notif-rule-${r.id}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost"
                              onClick={() => {
                                if (window.confirm(t("security.rules.deleteConfirm"))) {
                                  deleteMut.mutate(r.id);
                                }
                              }}
                              data-testid={`btn-delete-notif-rule-${r.id}`}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {isEdit ? t("security.rules.editRule") : t("security.rules.newRule")}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit} data-testid="notif-rule-form" className="space-y-4">
            <div>
              <Label>{t("security.rules.ruleName")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                data-testid="input-rule-name"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>{t("security.rules.minSeverity")}</Label>
                <Select
                  value={form.minSeverity}
                  onValueChange={(v) =>
                    setForm({ ...form, minSeverity: v as FormState["minSeverity"] })
                  }
                >
                  <SelectTrigger data-testid="select-rule-severity"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>{t(`security.severity.${s}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2">
                <Switch
                  checked={form.isActive ?? true}
                  onCheckedChange={(v) => setForm({ ...form, isActive: v })}
                  data-testid="switch-rule-active"
                />
                <Label className="!mt-0">
                  {(form.isActive ?? true)
                    ? t("security.rules.active")
                    : t("security.rules.inactive")}
                </Label>
              </div>
            </div>

            <div>
              <Label>{t("security.rules.eventTypes")}</Label>
              <p className="text-xs text-muted-foreground mb-2">
                {t("security.rules.eventTypesHint")}
              </p>
              <div className="flex flex-wrap gap-2" data-testid="multi-rule-event-types">
                {EVENT_TYPES.map((et) => {
                  const sel = form.eventTypes.includes(et);
                  return (
                    <button
                      type="button"
                      key={et}
                      onClick={() =>
                        setForm({ ...form, eventTypes: toggleArrayValue(form.eventTypes, et) })
                      }
                      data-testid={`chip-event-type-${et}`}
                      className={`px-3 py-1 rounded-full border text-xs ${
                        sel ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background"
                      }`}
                    >
                      {t(`security.type.${et}`)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <Label>{t("security.rules.branches")}</Label>
              <p className="text-xs text-muted-foreground mb-2">
                {t("security.rules.branchesHint")}
              </p>
              <div className="flex flex-wrap gap-2" data-testid="multi-rule-branches">
                {(branchesQ.data ?? []).map((b: Branch) => {
                  const sel = form.branchIds.includes(b.id);
                  return (
                    <button
                      type="button"
                      key={b.id}
                      onClick={() =>
                        setForm({ ...form, branchIds: toggleArrayValue(form.branchIds, b.id) })
                      }
                      className={`px-3 py-1 rounded-full border text-xs ${
                        sel ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background"
                      }`}
                    >
                      {b.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <Label>{t("security.rules.targetMode")}</Label>
              <RadioGroup
                value={form.targetMode}
                onValueChange={(v) =>
                  setForm({ ...form, targetMode: v as FormState["targetMode"] })
                }
                className="mt-2 flex gap-6"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="broadcast" id="target-broadcast"
                                  data-testid="radio-rule-target-broadcast" />
                  <Label htmlFor="target-broadcast" className="!mt-0">
                    {t("security.rules.broadcast")}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="users" id="target-users"
                                  data-testid="radio-rule-target-users" />
                  <Label htmlFor="target-users" className="!mt-0">
                    {t("security.rules.specificUsers")}
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {form.targetMode === "users" && (
              <div>
                <Label>{t("security.rules.targetUsers")}</Label>
                <div className="flex flex-wrap gap-2 mt-2 max-h-48 overflow-y-auto p-2 border rounded-md"
                     data-testid="multi-rule-users">
                  {(usersQ.data ?? []).length === 0 && (
                    <span className="text-xs text-muted-foreground">
                      {t("security.rules.noUsers")}
                    </span>
                  )}
                  {(usersQ.data ?? []).map((u) => {
                    const sel = form.targetUserIds.includes(u.id);
                    return (
                      <button
                        type="button"
                        key={u.id}
                        onClick={() =>
                          setForm({
                            ...form,
                            targetUserIds: toggleArrayValue(form.targetUserIds, u.id),
                          })
                        }
                        className={`px-3 py-1 rounded-full border text-xs ${
                          sel ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background"
                        }`}
                      >
                        {userLabel(u)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={saveMut.isPending} data-testid="btn-save-rule">
                {saveMut.isPending ? "…" : t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
