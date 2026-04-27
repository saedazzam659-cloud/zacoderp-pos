import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Save, Settings, ArrowRight, Mail, Sparkles, Building2, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface SessionSettings {
  emailReportsEnabled: boolean;
  // The server stores recipients as a single comma/newline-separated string;
  // the GET response echoes it raw. We split on the client to drive the
  // textarea, then join again on save.
  emailRecipients: string;
  emailOnSessionEnd: boolean;
  autoGenerateReportOnEnd: boolean;
  requireBranchSelection: boolean;
  defaultBranchId: number | null;
  aiModel: string;
  idleTimeoutMinutes: number | null;
  sessionStartTime: string | null;
  sessionEndTime: string | null;
  endWarningMinutes: number;
}

interface BranchOption {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  isMain: boolean;
}

const AI_MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
];

export default function WorkSessionSettings() {
  const { token, user } = useAuth();
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isRtl = i18n.language === "ar";
  const tr = (k: string) => t(`workSessions.${k}`) as string;
  const headers = { Authorization: `Bearer ${token}` };
  const [, navigate] = useLocation();

  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  // Local form state — seeded from the GET response. We keep recipients as a
  // raw textarea string so the user can type freely (one address per line);
  // we split on save.
  const [emailReportsEnabled, setEmailReportsEnabled]   = useState(false);
  const [emailOnSessionEnd, setEmailOnSessionEnd]       = useState(true);
  const [autoGenerateReportOnEnd, setAutoGen]           = useState(true);
  const [requireBranchSelection, setRequireBranchSel]   = useState(false);
  const [recipientsRaw, setRecipientsRaw]               = useState("");
  const [defaultBranchId, setDefaultBranchId]           = useState<string>("none");
  const [aiModel, setAiModel]                           = useState<string>("claude-haiku-4-5");
  const [idleTimeoutMinutes, setIdleTimeoutMinutes]     = useState<number>(60);
  const [sessionStartTime, setSessionStartTime]         = useState<string>("");
  const [sessionEndTime, setSessionEndTime]             = useState<string>("");
  const [endWarningMinutes, setEndWarningMinutes]       = useState<number>(15);

  const { data: settings, isLoading } = useQuery<SessionSettings>({
    queryKey: ["work-session-settings"],
    enabled: isAdmin,
    queryFn: async () => {
      const r = await fetch(`${API}/api/work-session-settings`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const { data: branches = [] } = useQuery<BranchOption[]>({
    queryKey: ["work-session-settings-branches"],
    enabled: isAdmin,
    queryFn: async () => {
      const r = await fetch(`${API}/api/work-session-settings/branches`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  // Seed form once the GET resolves. We do this in a single effect so the
  // controlled inputs flip together (avoids flicker on each field).
  useEffect(() => {
    if (!settings) return;
    setEmailReportsEnabled(settings.emailReportsEnabled);
    setEmailOnSessionEnd(settings.emailOnSessionEnd);
    setAutoGen(settings.autoGenerateReportOnEnd);
    setRequireBranchSel(settings.requireBranchSelection);
    // Server returns a single comma/newline-separated string; normalize for the textarea.
    const raw = String(settings.emailRecipients ?? "");
    setRecipientsRaw(raw.split(/[\n,;]/).map(s => s.trim()).filter(Boolean).join("\n"));
    setDefaultBranchId(settings.defaultBranchId ? String(settings.defaultBranchId) : "none");
    setAiModel(settings.aiModel || "claude-haiku-4-5");
    setIdleTimeoutMinutes(settings.idleTimeoutMinutes || 60);
    setSessionStartTime(settings.sessionStartTime ?? "");
    setSessionEndTime(settings.sessionEndTime ?? "");
    setEndWarningMinutes(Number(settings.endWarningMinutes) || 15);
  }, [settings]);

  const saveMut = useMutation({
    mutationFn: async () => {
      const recipients = recipientsRaw
        .split(/[\n,;]/)
        .map(s => s.trim())
        .filter(Boolean);
      const body = {
        emailReportsEnabled,
        emailOnSessionEnd,
        autoGenerateReportOnEnd,
        requireBranchSelection,
        emailRecipients: recipients,
        defaultBranchId: defaultBranchId === "none" ? null : Number(defaultBranchId),
        aiModel,
        idleTimeoutMinutes: Number(idleTimeoutMinutes) || 60,
        sessionStartTime: sessionStartTime || null,
        sessionEndTime:   sessionEndTime   || null,
        endWarningMinutes: Math.max(1, Math.min(120, Number(endWarningMinutes) || 15)),
      };
      const r = await fetch(`${API}/api/work-session-settings`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const txt = await r.text();
        try { throw new Error(JSON.parse(txt).error || txt); }
        catch { throw new Error(txt); }
      }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: tr("toast.settingsSavedTitle"), description: tr("toast.settingsSavedBody") });
      qc.invalidateQueries({ queryKey: ["work-session-settings"] });
      // The topbar countdown reads /me/effective under a separate key — kick
      // it now so the saving admin sees their hour change reflected instantly.
      qc.invalidateQueries({ queryKey: ["work-session-settings", "me", "effective"] });
    },
    onError: (e: any) => toast({
      title: tr("toast.errorTitle"),
      description: String(e?.message ?? e),
      variant: "destructive",
    }),
  });

  if (!isAdmin) {
    return (
      <div dir={isRtl ? "rtl" : "ltr"} className="p-8 text-center text-muted-foreground">
        {tr("settings.adminOnly")}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div dir={isRtl ? "rtl" : "ltr"} className="space-y-4 max-w-3xl mx-auto">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5 text-primary" />
                {tr("settings.title")}
              </CardTitle>
              <CardDescription>{tr("settings.subtitle")}</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate("/work-sessions")}
                    className="gap-1" data-testid="link-back-sessions">
              <ArrowRight className={`h-4 w-4 ${isRtl ? "" : "rotate-180"}`} />
              {tr("settings.backToList")}
            </Button>
          </div>
        </CardHeader>
      </Card>

      {/* Email block ------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4 text-sky-600" />
            {tr("settings.emailGroup")}
          </CardTitle>
          <CardDescription>{tr("settings.emailGroupDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow
            label={tr("settings.emailReportsEnabled")}
            hint={tr("settings.emailReportsEnabledHint")}
            checked={emailReportsEnabled}
            onChange={setEmailReportsEnabled}
            testId="switch-email-enabled"
          />
          <ToggleRow
            label={tr("settings.emailOnSessionEnd")}
            hint={tr("settings.emailOnSessionEndHint")}
            checked={emailOnSessionEnd}
            onChange={setEmailOnSessionEnd}
            disabled={!emailReportsEnabled}
            testId="switch-email-on-end"
          />
          <ToggleRow
            label={tr("settings.autoGenerateOnEnd")}
            hint={tr("settings.autoGenerateOnEndHint")}
            checked={autoGenerateReportOnEnd}
            onChange={setAutoGen}
            testId="switch-auto-generate"
          />
          <div>
            <label className="text-sm font-medium block mb-1">
              {tr("settings.emailRecipients")}
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              {tr("settings.emailRecipientsHint")}
            </p>
            <Textarea
              value={recipientsRaw}
              onChange={(e) => setRecipientsRaw(e.target.value)}
              placeholder="admin@example.com"
              rows={4}
              dir="ltr"
              className="font-mono text-sm"
              disabled={!emailReportsEnabled}
              data-testid="input-email-recipients"
            />
          </div>
        </CardContent>
      </Card>

      {/* AI block ---------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-violet-600" />
            {tr("settings.aiGroup")}
          </CardTitle>
          <CardDescription>{tr("settings.aiGroupDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium block mb-1">{tr("settings.aiModel")}</label>
            <p className="text-xs text-muted-foreground mb-2">{tr("settings.aiModelHint")}</p>
            <Select value={aiModel} onValueChange={setAiModel}>
              <SelectTrigger data-testid="select-ai-model"><SelectValue /></SelectTrigger>
              <SelectContent>
                {AI_MODELS.map(m => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">{tr("settings.idleTimeout")}</label>
            <p className="text-xs text-muted-foreground mb-2">{tr("settings.idleTimeoutHint")}</p>
            <Input
              type="number"
              min={5}
              max={1440}
              value={idleTimeoutMinutes}
              onChange={(e) => setIdleTimeoutMinutes(Number(e.target.value))}
              className="max-w-[160px]"
              dir="ltr"
              data-testid="input-idle-timeout"
            />
          </div>
        </CardContent>
      </Card>

      {/* Branch block ------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4 text-emerald-600" />
            {tr("settings.branchGroup")}
          </CardTitle>
          <CardDescription>{tr("settings.branchGroupDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow
            label={tr("settings.requireBranchSelection")}
            hint={tr("settings.requireBranchSelectionHint")}
            checked={requireBranchSelection}
            onChange={setRequireBranchSel}
            testId="switch-require-branch"
          />
          <div>
            <label className="text-sm font-medium block mb-1">{tr("settings.defaultBranch")}</label>
            <p className="text-xs text-muted-foreground mb-2">{tr("settings.defaultBranchHint")}</p>
            <Select value={defaultBranchId} onValueChange={setDefaultBranchId}>
              <SelectTrigger data-testid="select-default-branch"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{tr("settings.noDefaultBranch")}</SelectItem>
                {branches.map(b => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.nameAr}{b.isMain ? ` (${tr("dialog.mainBranch")})` : ""} — {b.code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* WORKING HOURS — drives the topbar countdown clock + auto-logout */}
      <Card className="border-emerald-200/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-emerald-600" />
            {tr("settings.hoursGroup")}
          </CardTitle>
          <CardDescription>{tr("settings.hoursGroupDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium block mb-1">{tr("settings.sessionStartTime")}</label>
              <p className="text-xs text-muted-foreground mb-2">{tr("settings.sessionStartTimeHint")}</p>
              <Input
                type="time"
                value={sessionStartTime}
                onChange={(e) => setSessionStartTime(e.target.value)}
                dir="ltr"
                data-testid="input-session-start-time"
              />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">{tr("settings.sessionEndTime")}</label>
              <p className="text-xs text-muted-foreground mb-2">{tr("settings.sessionEndTimeHint")}</p>
              <Input
                type="time"
                value={sessionEndTime}
                onChange={(e) => setSessionEndTime(e.target.value)}
                dir="ltr"
                data-testid="input-session-end-time"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">{tr("settings.endWarningMinutes")}</label>
            <p className="text-xs text-muted-foreground mb-2">{tr("settings.endWarningMinutesHint")}</p>
            <Input
              type="number"
              min={1}
              max={120}
              value={endWarningMinutes}
              onChange={(e) => setEndWarningMinutes(Number(e.target.value) || 15)}
              dir="ltr"
              className="max-w-[160px]"
              data-testid="input-end-warning-minutes"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2 sticky bottom-0 bg-background py-3 border-t border-border -mx-1 px-1">
        <Link href="/work-sessions">
          <Button variant="outline">{tr("close")}</Button>
        </Link>
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
                className="gap-1" data-testid="button-save-settings">
          {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {tr("save")}
        </Button>
      </div>
    </div>
  );
}

function ToggleRow({
  label, hint, checked, onChange, disabled, testId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 ${disabled ? "opacity-60" : ""}`}>
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} data-testid={testId} />
    </div>
  );
}
