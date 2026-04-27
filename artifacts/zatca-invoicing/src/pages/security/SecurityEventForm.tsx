import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { Sparkles, X, Camera, Video, Trash2, Eye } from "lucide-react";
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
  securityEventsApi, aiClassifyEvent, aiAnalyzeImage, uploadSecurityMedia, mediaUrl,
  type SecurityEvent, type SecurityEventInput,
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
    imageUrl: event?.imageUrl ?? null,
    videoClipUrl: event?.videoClipUrl ?? null,
  });
  const [aiBusy, setAiBusy] = useState(false);
  const [visionBusy, setVisionBusy] = useState(false);
  const [imgUploading, setImgUploading] = useState(false);
  const [vidUploading, setVidUploading] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const vidInputRef = useRef<HTMLInputElement>(null);

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
        imageUrl: event.imageUrl ?? null,
        videoClipUrl: event.videoClipUrl ?? null,
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

  async function runVisionAnalyze() {
    if (!form.imageUrl) {
      toast({ title: t("security.ai.needImage"), variant: "destructive" });
      return;
    }
    setVisionBusy(true);
    try {
      const r = await aiAnalyzeImage(
        form.imageUrl,
        form.description ?? undefined,
        form.cameraLabel ?? undefined,
      );
      setForm(f => ({
        ...f,
        eventType: r.eventType,
        severity: r.severity,
        // Don't overwrite text the user already typed.
        title: f.title.trim() ? f.title : (r.suggestedTitle || f.title),
        description: f.description?.trim()
          ? f.description
          : (r.suggestedDescription || f.description),
        confidence: r.confidence,
      }));
      toast({
        title: r.isSecurityConcern
          ? t("security.ai.visionApplied")
          : t("security.ai.visionNoConcern"),
        description: r.reasoning,
      });
    } catch (e: any) {
      toast({ title: t("security.ai.visionFailed"), description: e?.message, variant: "destructive" });
    } finally {
      setVisionBusy(false);
    }
  }

  async function handleImageFile(file: File) {
    if (!file.type.startsWith("image/")) {
      toast({ title: t("security.media.notImage"), variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: t("security.media.imageTooLarge"), variant: "destructive" });
      return;
    }
    setImgUploading(true);
    try {
      const path = await uploadSecurityMedia(file);
      setForm(f => ({ ...f, imageUrl: path }));
      toast({ title: t("security.media.imageUploaded") });
    } catch (e: any) {
      toast({ title: t("security.media.uploadFailed"), description: e?.message, variant: "destructive" });
    } finally {
      setImgUploading(false);
    }
  }

  async function handleVideoFile(file: File) {
    if (!file.type.startsWith("video/")) {
      toast({ title: t("security.media.notVideo"), variant: "destructive" });
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast({ title: t("security.media.videoTooLarge"), variant: "destructive" });
      return;
    }
    setVidUploading(true);
    try {
      const path = await uploadSecurityMedia(file);
      setForm(f => ({ ...f, videoClipUrl: path }));
      toast({ title: t("security.media.videoUploaded") });
    } catch (e: any) {
      toast({ title: t("security.media.uploadFailed"), description: e?.message, variant: "destructive" });
    } finally {
      setVidUploading(false);
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

          {/* Image + Video upload + AI vision analysis */}
          <div className="rounded-md border bg-muted/20 p-3 space-y-3" data-testid="security-media-section">
            <div className="text-xs font-medium text-muted-foreground">
              {t("security.media.title")}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Image */}
              <div className="flex items-start gap-3">
                <div
                  className="w-24 h-24 rounded-md border bg-background grid place-items-center overflow-hidden shrink-0 relative group"
                  data-testid="security-image-preview"
                >
                  {form.imageUrl ? (
                    <>
                      <img
                        src={mediaUrl(form.imageUrl)}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => setLightboxOpen(true)}
                        className="absolute inset-0 bg-black/0 hover:bg-black/40 transition grid place-items-center"
                        title={t("security.media.viewImage")}
                        data-testid="btn-view-image"
                      >
                        <Eye className="h-5 w-5 text-white opacity-0 group-hover:opacity-100" />
                      </button>
                    </>
                  ) : (
                    <Camera className="h-8 w-8 text-muted-foreground/40" />
                  )}
                </div>
                <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                  <Label className="text-xs">{t("security.media.image")}</Label>
                  <input
                    ref={imgInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={imgUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleImageFile(f);
                      e.target.value = "";
                    }}
                    data-testid="input-image-file"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={imgUploading}
                      onClick={() => imgInputRef.current?.click()}
                      data-testid="btn-upload-image"
                    >
                      {imgUploading
                        ? t("security.media.uploading")
                        : form.imageUrl
                          ? t("security.media.changeImage")
                          : t("security.media.uploadImage")}
                    </Button>
                    {form.imageUrl && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-rose-600"
                        onClick={() => setForm(f => ({ ...f, imageUrl: null }))}
                        data-testid="btn-remove-image"
                      >
                        <Trash2 className="h-3 w-3 me-1" />
                        {t("security.media.remove")}
                      </Button>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="h-7 text-xs w-fit"
                    disabled={!form.imageUrl || visionBusy}
                    onClick={runVisionAnalyze}
                    data-testid="btn-ai-vision"
                  >
                    <Sparkles className="h-3 w-3 me-1" />
                    {visionBusy ? t("security.ai.thinking") : t("security.ai.analyzeImage")}
                  </Button>
                </div>
              </div>

              {/* Video */}
              <div className="flex items-start gap-3">
                <div className="w-24 h-24 rounded-md border bg-background grid place-items-center overflow-hidden shrink-0">
                  {form.videoClipUrl ? (
                    <video
                      src={mediaUrl(form.videoClipUrl)}
                      className="w-full h-full object-cover"
                      controls
                      data-testid="security-video-preview"
                    />
                  ) : (
                    <Video className="h-8 w-8 text-muted-foreground/40" />
                  )}
                </div>
                <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                  <Label className="text-xs">{t("security.media.video")}</Label>
                  <input
                    ref={vidInputRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    disabled={vidUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleVideoFile(f);
                      e.target.value = "";
                    }}
                    data-testid="input-video-file"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={vidUploading}
                      onClick={() => vidInputRef.current?.click()}
                      data-testid="btn-upload-video"
                    >
                      {vidUploading
                        ? t("security.media.uploading")
                        : form.videoClipUrl
                          ? t("security.media.changeVideo")
                          : t("security.media.uploadVideo")}
                    </Button>
                    {form.videoClipUrl && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-rose-600"
                        onClick={() => setForm(f => ({ ...f, videoClipUrl: null }))}
                        data-testid="btn-remove-video"
                      >
                        <Trash2 className="h-3 w-3 me-1" />
                        {t("security.media.remove")}
                      </Button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">
                    {t("security.media.videoHint")}
                  </p>
                </div>
              </div>
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

        {lightboxOpen && form.imageUrl && (
          <Dialog open onOpenChange={(o) => { if (!o) setLightboxOpen(false); }}>
            <DialogContent className="max-w-4xl p-2 bg-black border-0">
              <img
                src={mediaUrl(form.imageUrl)}
                alt=""
                className="w-full h-auto max-h-[85vh] object-contain"
                data-testid="security-image-lightbox"
              />
            </DialogContent>
          </Dialog>
        )}

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
