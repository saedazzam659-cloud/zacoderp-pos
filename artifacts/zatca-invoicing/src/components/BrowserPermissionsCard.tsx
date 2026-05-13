// Browser permissions diagnostic + helper card.
//
// Shows real-time microphone (and optionally camera) permission state,
// lets the user re-trigger the browser prompt with one click, and — when
// permission is "denied" — explains exactly how to re-enable it for the
// detected browser, with a one-click "نسخ الرابط" for chrome://settings
// pages that JS isn't allowed to open programmatically.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Mic, Camera, ShieldCheck, ShieldAlert, ShieldX, RefreshCw,
  Copy, ExternalLink, Settings2, Lock, Info,
} from "lucide-react";

type PermState = "granted" | "denied" | "prompt" | "unknown" | "unsupported";

interface BrowserInfo {
  id: "chrome" | "edge" | "firefox" | "safari" | "opera" | "brave" | "other";
  name: string;
  micUrl: string | null;       // copyable settings URL
  cameraUrl: string | null;
  steps: string[];             // localized step-by-step instructions
}

function detectBrowser(): BrowserInfo {
  const ua = navigator.userAgent.toLowerCase();
  // Order matters — Edge contains "chrome", Brave contains "chrome", etc.
  if (ua.includes("edg/")) {
    return {
      id: "edge", name: "Microsoft Edge",
      micUrl: "edge://settings/content/microphone",
      cameraUrl: "edge://settings/content/camera",
      steps: [
        "افتح إعدادات الموقع من القائمة (⋯) → الإعدادات → ملفات تعريف الارتباط وأذونات الموقع.",
        "اختر الميكروفون (أو الكاميرا) من القائمة.",
        "ابحث عن نطاق الموقع وغيّره من «حظر» إلى «السماح».",
        "ارجع لهذه الصفحة وأعِد تحميلها.",
      ],
    };
  }
  if (ua.includes("opr/") || ua.includes("opera")) {
    return {
      id: "opera", name: "Opera",
      micUrl: "opera://settings/content/microphone",
      cameraUrl: "opera://settings/content/camera",
      steps: [
        "افتح القائمة → الإعدادات → خصوصية وأمان → إعدادات الموقع.",
        "اختر الميكروفون → عدّل الإذن للموقع الحالي.",
        "أعِد تحميل الصفحة.",
      ],
    };
  }
  if (ua.includes("firefox") || ua.includes("fxios")) {
    return {
      id: "firefox", name: "Firefox",
      micUrl: null, cameraUrl: null,
      steps: [
        "اضغط على أيقونة القفل 🔒 في شريط العنوان بجوار رابط الموقع.",
        "تحت «الأذونات»، ابحث عن «استخدام الميكروفون» وأزل الـ X بجانبها.",
        "أعِد تحميل الصفحة وامنح الإذن لما يطلبه المتصفح.",
      ],
    };
  }
  if (ua.includes("safari") && !ua.includes("chrome")) {
    return {
      id: "safari", name: "Safari",
      micUrl: null, cameraUrl: null,
      steps: [
        "من شريط القوائم: Safari → الإعدادات (Preferences) → المواقع (Websites).",
        "اختر «الميكروفون» من العمود الأيسر.",
        "ابحث عن النطاق الحالي في القائمة وغيّره إلى «السماح» (Allow).",
        "أعِد تحميل الصفحة.",
      ],
    };
  }
  if ((navigator as any).brave?.isBrave || ua.includes("brave")) {
    return {
      id: "brave", name: "Brave",
      micUrl: "brave://settings/content/microphone",
      cameraUrl: "brave://settings/content/camera",
      steps: [
        "انسخ الرابط أعلاه وألصقه في شريط العنوان بنفسه.",
        "ابحث عن نطاق الموقع تحت «الحظر» وغيّره إلى «السماح».",
        "أعِد تحميل الصفحة.",
      ],
    };
  }
  if (ua.includes("chrome")) {
    return {
      id: "chrome", name: "Google Chrome",
      micUrl: "chrome://settings/content/microphone",
      cameraUrl: "chrome://settings/content/camera",
      steps: [
        "اضغط على أيقونة القفل 🔒 في شريط العنوان بجوار رابط الموقع.",
        "اختر «أذونات الموقع» (Site settings).",
        "غيّر «الميكروفون» (أو الكاميرا) من «حظر» إلى «السماح».",
        "ارجع وأعِد تحميل هذه الصفحة.",
      ],
    };
  }
  return {
    id: "other", name: "متصفح آخر",
    micUrl: null, cameraUrl: null,
    steps: [
      "افتح إعدادات أذونات الموقع من شريط العنوان (أيقونة القفل عادةً).",
      "ابحث عن «الميكروفون» أو «الكاميرا» وامنح الإذن لهذا الموقع.",
      "أعِد تحميل الصفحة.",
    ],
  };
}

function isSecureContextOk(): boolean {
  if (typeof window === "undefined") return false;
  return window.isSecureContext || location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

async function queryPerm(name: PermissionName): Promise<PermState> {
  if (!("permissions" in navigator)) return "unsupported";
  try {
    const status = await navigator.permissions.query({ name } as any);
    return status.state as PermState;
  } catch {
    return "unknown";
  }
}

interface RowProps {
  kind: "microphone" | "camera";
  state: PermState;
  onRequest: () => Promise<void>;
  busy: boolean;
  browser: BrowserInfo;
}

function PermissionRow({ kind, state, onRequest, busy, browser }: RowProps) {
  const { toast } = useToast();
  const Icon = kind === "microphone" ? Mic : Camera;
  const labelAr = kind === "microphone" ? "الميكروفون" : "الكاميرا";
  const url = kind === "microphone" ? browser.micUrl : browser.cameraUrl;

  const meta: Record<PermState, { label: string; klass: string; Icon: typeof ShieldCheck }> = {
    granted: { label: "مسموح", klass: "border-emerald-300 bg-emerald-50 text-emerald-700", Icon: ShieldCheck },
    denied: { label: "محظور", klass: "border-red-300 bg-red-50 text-red-700", Icon: ShieldX },
    prompt: { label: "بانتظار السؤال", klass: "border-amber-300 bg-amber-50 text-amber-700", Icon: ShieldAlert },
    unknown: { label: "غير معروف", klass: "border-gray-300 bg-gray-50 text-gray-700", Icon: ShieldAlert },
    unsupported: { label: "غير مدعوم", klass: "border-gray-300 bg-gray-50 text-gray-700", Icon: ShieldAlert },
  };
  const m = meta[state];
  const StateIcon = m.Icon;

  function copyUrl() {
    if (!url) return;
    navigator.clipboard.writeText(url).then(
      () => toast({ title: "تم النسخ", description: `الصق الرابط في شريط عنوان ${browser.name}` }),
      () => toast({ title: "تعذّر النسخ", description: url, variant: "destructive" }),
    );
  }

  return (
    <div className="rounded-lg border-2 p-4 space-y-3">
      <div className="flex items-center gap-3">
        <Icon className="h-5 w-5 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm">{labelAr}</div>
          <div className="text-[11px] text-muted-foreground">
            مطلوب لـ{kind === "microphone" ? "المساعد الصوتي والمكالمات الداخلية" : "أرشفة المستندات وقراءة الباركود"}
          </div>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${m.klass}`}>
          <StateIcon className="h-3.5 w-3.5" />
          {m.label}
        </span>
      </div>

      {state === "granted" && (
        <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50/70 rounded-md p-2">
          <ShieldCheck className="h-4 w-4" />
          الإذن ممنوح. يمكنك استخدام {labelAr} مباشرةً.
        </div>
      )}

      {(state === "prompt" || state === "unknown" || state === "unsupported") && (
        <Button
          type="button" size="sm" className="w-full gap-2"
          onClick={onRequest} disabled={busy}
        >
          <Icon className="h-4 w-4" />
          {busy ? "بانتظار رد المتصفح…" : `طلب إذن ${labelAr}`}
        </Button>
      )}

      {state === "denied" && (
        <div className="space-y-3 rounded-md border border-red-200 bg-red-50/50 p-3">
          <div className="flex items-start gap-2 text-sm text-red-800">
            <Lock className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              تم حظر {labelAr} لهذا الموقع. لا يمكن للتطبيق إعادة طلب الإذن إلا بعد رفع
              الحظر يدوياً من إعدادات {browser.name}.
            </div>
          </div>

          {url && (
            <div className="flex items-center gap-2 bg-background border rounded-md p-2 font-mono text-[11px]" dir="ltr">
              <span className="flex-1 truncate select-all">{url}</span>
              <Button type="button" size="sm" variant="ghost" className="h-7 gap-1" onClick={copyUrl}>
                <Copy className="h-3.5 w-3.5" />
                نسخ
              </Button>
            </div>
          )}

          <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
            {browser.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>

          <Button
            type="button" size="sm" variant="outline" className="w-full gap-2"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            أعد تحميل الصفحة بعد ضبط الإذن
          </Button>
        </div>
      )}
    </div>
  );
}

export function BrowserPermissionsCard() {
  const { toast } = useToast();
  const [browser] = useState<BrowserInfo>(() => detectBrowser());
  const [micState, setMicState] = useState<PermState>("unknown");
  const [camState, setCamState] = useState<PermState>("unknown");
  const [busyMic, setBusyMic] = useState(false);
  const [busyCam, setBusyCam] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const secure = isSecureContextOk();

  // Initial + reactive permission read.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [m, c] = await Promise.all([
        queryPerm("microphone" as PermissionName),
        queryPerm("camera" as PermissionName),
      ]);
      if (cancelled) return;
      setMicState(m); setCamState(c);
    })();

    // Live updates: PermissionStatus exposes onchange in Chromium.
    let micWatcher: PermissionStatus | null = null;
    let camWatcher: PermissionStatus | null = null;
    if ("permissions" in navigator) {
      navigator.permissions.query({ name: "microphone" as PermissionName } as any)
        .then((s) => { micWatcher = s; s.onchange = () => setMicState(s.state as PermState); })
        .catch(() => {});
      navigator.permissions.query({ name: "camera" as PermissionName } as any)
        .then((s) => { camWatcher = s; s.onchange = () => setCamState(s.state as PermState); })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      if (micWatcher) micWatcher.onchange = null;
      if (camWatcher) camWatcher.onchange = null;
    };
  }, [refreshKey]);

  async function requestMic() {
    setBusyMic(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      toast({ title: "تم منح إذن الميكروفون" });
      setMicState("granted");
    } catch (e: any) {
      const denied = e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError";
      setMicState(denied ? "denied" : "unknown");
      toast({
        title: denied ? "رُفض إذن الميكروفون" : "تعذّر طلب الإذن",
        description: e?.message ?? "",
        variant: "destructive",
      });
    } finally { setBusyMic(false); }
  }

  async function requestCamera() {
    setBusyCam(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      toast({ title: "تم منح إذن الكاميرا" });
      setCamState("granted");
    } catch (e: any) {
      const denied = e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError";
      setCamState(denied ? "denied" : "unknown");
      toast({
        title: denied ? "رُفض إذن الكاميرا" : "تعذّر طلب الإذن",
        description: e?.message ?? "",
        variant: "destructive",
      });
    } finally { setBusyCam(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Settings2 className="h-4 w-4" /> أذونات المتصفح
        </CardTitle>
        <CardDescription>
          تشخيص حالة أذونات الميكروفون والكاميرا في متصفحك ({browser.name}) وإعادة ضبطها بسرعة.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!secure && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            <Info className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              المتصفح يُلزم استخدام HTTPS لمنح أذونات الميكروفون/الكاميرا. تأكّد أن العنوان
              يبدأ بـ <code dir="ltr">https://</code>.
            </div>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <PermissionRow kind="microphone" state={micState} onRequest={requestMic} busy={busyMic} browser={browser} />
          <PermissionRow kind="camera" state={camState} onRequest={requestCamera} busy={busyCam} browser={browser} />
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <Info className="h-3 w-3" />
            تكشف الأذونات لحظياً عند تغييرها من إعدادات المتصفح.
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => setRefreshKey((k) => k + 1)}>
              <RefreshCw className="h-3.5 w-3.5" />
              إعادة الفحص
            </Button>
            {browser.micUrl && (
              <Button
                type="button" size="sm" variant="outline" className="h-7 text-xs gap-1"
                onClick={() => {
                  navigator.clipboard.writeText(browser.micUrl!).then(
                    () => toast({ title: "تم نسخ رابط الإعدادات", description: `الصقه في شريط عنوان ${browser.name}` }),
                  );
                }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                نسخ رابط إعدادات المتصفح
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
