import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  securityEventsApi, aiClassifyEvent, type SecurityEvent, type SecurityEventInput,
} from "@/lib/securityEventsApi";

const TYPES = [
  "intrusion", "theft", "suspicious_movement", "unknown_person",
  "after_hours_presence", "missing_item", "unusual_gathering",
  "tampering", "other",
];
const SEVERITIES = ["low", "medium", "high", "critical"];
const STATUSES = ["open", "investigating", "closed", "false_positive"];

interface Props {
  event?: SecurityEvent | null;
  onClose: () => void;
  onSaved: () => void;
}

function toInputDateTime(s: string | undefined | null): string {
  if (!s) {
    const d = new Date();
    d.setSeconds(0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function SecurityEventForm({ event, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isEdit = !!event;

  const [form, setForm] = useState<SecurityEventInput>({
    eventType: event?.eventType ?? "other",
    severity: event?.severity ?? "medium",
    status: event?.status ?? "open",
    title: event?.title ?? "",
    description: event?.description ?? "",
    cameraLabel: event?.cameraLabel ?? "",
    eventDateTime: toInputDateTime(event?.eventDateTime),
    resolutionNote: event?.resolutionNote ?? "",
  });
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    if (event) {
      setForm({
        eventType: event.eventType,
        severity: event.severity,
        status: event.status,
        title: event.title,
        description: event.description ?? "",
        cameraLabel: event.cameraLabel ?? "",
        eventDateTime: toInputDateTime(event.eventDateTime),
        resolutionNote: event.resolutionNote ?? "",
      });
    }
  }, [event]);

  const saveM = useMutation({
    mutationFn: (input: SecurityEventInput) =>
      isEdit
        ? securityEventsApi.update(event!.id, input)
        : securityEventsApi.create(input),
    onSuccess: () => {
      toast({ title: isEdit ? t("security.toast.updated") : t("security.toast.created") });
      onSaved();
    },
    onError: (e: any) => toast({ title: t("common.error"), description: e?.message, variant: "destructive" }),
  });

  async function runAiSuggest() {
    if (!form.description || form.description.length < 5) {
      toast({ title: t("security.ai.needDescription"), variant: "destructive" });
      return;
    }
    setAiBusy(true);
    try {
      const r = await aiClassifyEvent(form.description, form.cameraLabel ?? undefined);
      setForm(f => ({
        ...f,
        eventType: r.eventType,
        severity: r.severity,
        // Don't overwrite a title the user already wrote.
        title: f.title.trim() ? f.title : r.suggestedTitle,
      }));
      toast({ title: t("security.ai.applied"), description: r.reasoning });
    } catch (e: any) {
      toast({ title: t("common.error"), description: e?.message, variant: "destructive" });
    } finally {
      setAiBusy(false);
    }
  }

  function submit() {
    if (!form.title.trim()) {
      toast({ title: t("security.validation.titleRequired"), variant: "destructive" });
      return;
    }
    const payload: SecurityEventInput = {
      ...form,
      title: form.title.trim(),
      description: form.description?.trim() || null,
      cameraLabel: form.cameraLabel?.trim() || null,
      resolutionNote: form.resolutionNote?.trim() || null,
      eventDateTime: form.eventDateTime
        ? new Date(form.eventDateTime).toISOString()
        : new Date().toISOString(),
    };
    saveM.mutate(payload);
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="security-event-form">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("security.form.editTitle") : t("security.form.newTitle")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>{t("security.form.title")}</Label>
            <Input
              value={form.title}
              onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder={t("security.form.titlePlaceholder")}
              data-testid="input-event-title"
            />
          </div>

          <div>
            <Label>{t("security.form.description")}</Label>
            <Textarea
              rows={3}
              value={form.description ?? ""}
              onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder={t("security.form.descriptionPlaceholder")}
              data-testid="input-event-description"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={runAiSuggest}
              disabled={aiBusy}
              data-testid="btn-ai-suggest"
            >
              <Sparkles className="h-4 w-4 me-1" />
              {aiBusy ? t("security.ai.thinking") : t("security.ai.suggest")}
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label>{t("security.form.type")}</Label>
              <Select value={form.eventType} onValueChange={(v) => setForm(f => ({ ...f, eventType: v }))}>
                <SelectTrigger data-testid="select-event-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TYPES.map(s => <SelectItem key={s} value={s}>{t(`security.type.${s}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t("security.form.severity")}</Label>
              <Select value={form.severity} onValueChange={(v) => setForm(f => ({ ...f, severity: v }))}>
                <SelectTrigger data-testid="select-event-severity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map(s => <SelectItem key={s} value={s}>{t(`security.severity.${s}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t("security.form.status")}</Label>
              <Select value={form.status} onValueChange={(v) => setForm(f => ({ ...f, status: v }))}>
                <SelectTrigger data-testid="select-event-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUSES.map(s => <SelectItem key={s} value={s}>{t(`security.status.${s}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label>{t("security.form.cameraLabel")}</Label>
              <Input
                value={form.cameraLabel ?? ""}
                onChange={(e) => setForm(f => ({ ...f, cameraLabel: e.target.value }))}
                placeholder={t("security.form.cameraLabelPlaceholder")}
                data-testid="input-event-camera"
              />
            </div>
            <div>
              <Label>{t("security.form.eventDateTime")}</Label>
              <Input
                type="datetime-local"
                value={form.eventDateTime ?? ""}
                onChange={(e) => setForm(f => ({ ...f, eventDateTime: e.target.value }))}
                data-testid="input-event-datetime"
              />
            </div>
          </div>

          {(form.status === "closed" || form.status === "false_positive") && (
            <div>
              <Label>{t("security.form.resolutionNote")}</Label>
              <Textarea
                rows={2}
                value={form.resolutionNote ?? ""}
                onChange={(e) => setForm(f => ({ ...f, resolutionNote: e.target.value }))}
                placeholder={t("security.form.resolutionPlaceholder")}
                data-testid="input-event-resolution"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            <X className="h-4 w-4 me-1" />
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={saveM.isPending} data-testid="btn-save-event">
            {saveM.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
