// Voice Assistant — admin settings page.
//
// Exposes:
//   - Master enable + auto-activate-on-login toggles.
//   - Recognition language (BCP-47).
//   - Anthropic model picker.
//   - Confidence threshold slider (0..100).
//   - Optional wake-word + free-text notes.
//   - Recent command log (last 50) so admins can audit what users said.

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save, Mic, Sparkles, ListMusic, ArrowRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BrowserPermissionsCard } from "@/components/BrowserPermissionsCard";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Settings {
  companyId: number;
  enabled: boolean;
  autoActivateOnLogin: boolean;
  language: string;
  aiModel: string;
  wakeWord: string | null;
  confidenceThreshold: number;
  voiceBiometricsEnabled: boolean;
  notes: string;
  updatedAt: string | null;
  isDefault?: boolean;
}

interface CommandLogRow {
  id: number;
  transcript: string;
  action: string;
  route: string | null;
  status: string;
  contextRoute: string | null;
  errorMessage: string | null;
  createdAt: string;
}

const AI_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-opus-4-7", "claude-opus-4-5"];
const LANGS = [
  { code: "ar-SA", labelAr: "العربية (السعودية)", labelEn: "Arabic (Saudi Arabia)" },
  { code: "ar-EG", labelAr: "العربية (مصر)",      labelEn: "Arabic (Egypt)" },
  { code: "ar-AE", labelAr: "العربية (الإمارات)", labelEn: "Arabic (UAE)" },
  { code: "en-US", labelAr: "الإنجليزية (أمريكا)", labelEn: "English (US)" },
  { code: "en-GB", labelAr: "الإنجليزية (بريطانيا)", labelEn: "English (UK)" },
];

export default function VoiceAssistantSettings() {
  const { token, user } = useAuth();
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isRtl = i18n.language === "ar";
  const tr = (k: string) => t(`voiceAssistant.${k}`) as string;
  const headers = { Authorization: `Bearer ${token}` };
  const [, navigate] = useLocation();

  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  const [enabled, setEnabled]                         = useState(false);
  const [autoActivateOnLogin, setAutoActivate]        = useState(false);
  const [language, setLanguage]                       = useState("ar-SA");
  const [aiModel, setAiModel]                         = useState("claude-haiku-4-5");
  const [wakeWord, setWakeWord]                       = useState("");
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(50);
  // Optional, future feature — see schema comment / hint text below.
  const [voiceBiometricsEnabled, setVoiceBiometricsEnabled] = useState(false);
  const [notes, setNotes]                             = useState("");

  const { data: settings, isLoading } = useQuery<Settings>({
    queryKey: ["voice-assistant-settings"],
    enabled: isAdmin,
    queryFn: async () => {
      const r = await fetch(`${API}/api/voice-assistant/settings`, { headers });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const { data: log = [] } = useQuery<CommandLogRow[]>({
    queryKey: ["voice-assistant-log"],
    enabled: isAdmin,
    queryFn: async () => {
      const r = await fetch(`${API}/api/voice-assistant/log?limit=50`, { headers });
      if (!r.ok) return [];
      return r.json();
    },
  });

  // Seed local form state from server payload.
  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setAutoActivate(settings.autoActivateOnLogin);
    setLanguage(settings.language ?? "ar-SA");
    setAiModel(settings.aiModel ?? "claude-haiku-4-5");
    setWakeWord(settings.wakeWord ?? "");
    setConfidenceThreshold(settings.confidenceThreshold ?? 50);
    setVoiceBiometricsEnabled(Boolean(settings.voiceBiometricsEnabled));
    setNotes(settings.notes ?? "");
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${API}/api/voice-assistant/settings`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled, autoActivateOnLogin, language, aiModel,
          wakeWord: wakeWord.trim() || null,
          confidenceThreshold, voiceBiometricsEnabled, notes,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "تعذّر الحفظ");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: tr("saved"), description: tr("savedDescription") });
      qc.invalidateQueries({ queryKey: ["voice-assistant-settings"] });
    },
    onError: (e: Error) => toast({
      title: tr("saveFailed"), description: e.message, variant: "destructive",
    }),
  });

  if (!isAdmin) {
    return (
      <div className="container mx-auto p-6">
        <Card><CardContent className="py-10 text-center text-muted-foreground">{tr("adminOnly")}</CardContent></Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 flex items-center justify-center" style={{ minHeight: 360 }}>
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-4" dir={isRtl ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Mic className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">{tr("settingsTitle")}</h1>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate("/")} data-testid="link-back-home">
          <ArrowRight className={`h-4 w-4 ${isRtl ? "rotate-180" : ""} me-1`} />
          {tr("back")}
        </Button>
      </div>

      {/* Browser permissions diagnostic — shown FIRST so users hitting the
          "تم رفض الإذن بالميكروفون" toast can fix it without leaving this page. */}
      <BrowserPermissionsCard />

      {/* Master switches */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4" /> {tr("activationTitle")}</CardTitle>
          <CardDescription>{tr("activationDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="font-medium">{tr("enabledLabel")}</div>
              <div className="text-xs text-muted-foreground">{tr("enabledDesc")}</div>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} data-testid="switch-enabled" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="font-medium">{tr("autoActivateLabel")}</div>
              <div className="text-xs text-muted-foreground">{tr("autoActivateDesc")}</div>
            </div>
            <Switch checked={autoActivateOnLogin} onCheckedChange={setAutoActivate} data-testid="switch-auto-activate" disabled={!enabled} />
          </div>
        </CardContent>
      </Card>

      {/* Recognition + AI */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4" /> {tr("recognitionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{tr("languageLabel")}</label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger data-testid="select-language"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LANGS.map(l => <SelectItem key={l.code} value={l.code}>{isRtl ? l.labelAr : l.labelEn}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{tr("modelLabel")}</label>
            <Select value={aiModel} onValueChange={setAiModel}>
              <SelectTrigger data-testid="select-ai-model"><SelectValue /></SelectTrigger>
              <SelectContent>
                {AI_MODELS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{tr("modelHint")}</p>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <label className="text-sm font-medium">{tr("confidenceLabel")} — {confidenceThreshold}%</label>
            <Slider value={[confidenceThreshold]} min={0} max={100} step={5}
                    onValueChange={(v) => setConfidenceThreshold(v[0] ?? 50)}
                    data-testid="slider-confidence" />
            <p className="text-xs text-muted-foreground">{tr("confidenceHint")}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{tr("wakeWordLabel")}</label>
            <Input value={wakeWord} onChange={(e) => setWakeWord(e.target.value)}
                   placeholder={tr("wakeWordPlaceholder")}
                   data-testid="input-wake-word" />
            <p className="text-xs text-muted-foreground">{tr("wakeWordHint")}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{tr("notesLabel")}</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)}
                      rows={3} data-testid="textarea-notes" />
          </div>
        </CardContent>
      </Card>

      {/* Optional / future: speaker biometrics. The toggle is stored but the
          actual voice-identity verification ships in a later release once a
          vendor (Azure Speaker Recognition or similar) is wired up. The hint
          text below makes that very clear so admins don't think they have
          enabled real protection by flipping this switch. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mic className="h-4 w-4" /> {tr("biometricsTitle")}
            <Badge variant="outline" className="ms-2 text-xs font-normal">{tr("comingSoon")}</Badge>
          </CardTitle>
          <CardDescription>{tr("biometricsDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="font-medium">{tr("biometricsToggleLabel")}</div>
              <div className="text-xs text-muted-foreground">{tr("biometricsToggleDesc")}</div>
            </div>
            {/* Intentionally NOT disabled when the master switch is off — this
                toggle records the company's *future* preference, so admins
                should be able to stage their intent before flipping the
                master switch on. */}
            <Switch
              checked={voiceBiometricsEnabled}
              onCheckedChange={setVoiceBiometricsEnabled}
              data-testid="switch-voice-biometrics"
            />
          </div>
          <div className="rounded-md border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground">
            {tr("biometricsNotice")}
          </div>
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}
                data-testid="button-save">
          {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}
          {tr("save")}
        </Button>
      </div>

      {/* Command log */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><ListMusic className="h-4 w-4" /> {tr("logTitle")}</CardTitle>
          <CardDescription>{tr("logDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {log.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">{tr("logEmpty")}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted-foreground border-b">
                  <tr>
                    <th className="text-start py-2 pe-2">{tr("colTime")}</th>
                    <th className="text-start py-2 pe-2">{tr("colTranscript")}</th>
                    <th className="text-start py-2 pe-2">{tr("colAction")}</th>
                    <th className="text-start py-2 pe-2">{tr("colStatus")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {log.map(row => (
                    <tr key={row.id} className="align-top">
                      <td className="py-2 pe-2 whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(row.createdAt).toLocaleString(isRtl ? "ar-SA" : "en-US")}
                      </td>
                      <td className="py-2 pe-2">{row.transcript}</td>
                      <td className="py-2 pe-2 text-xs">
                        {row.action === "navigate" && row.route ? row.route :
                         row.action.startsWith("verb:") ? row.action.replace("verb:", "") :
                         row.action}
                      </td>
                      <td className="py-2 pe-2">
                        <Badge variant={row.status === "success" ? "default" : row.status === "unrecognized" ? "secondary" : "destructive"}>
                          {row.status === "success" ? tr("statusOk") :
                           row.status === "unrecognized" ? tr("statusUnk") :
                           tr("statusFail")}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
