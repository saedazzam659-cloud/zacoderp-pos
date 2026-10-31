import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle, ArrowDownRight, ArrowLeft, Check, Circle, Crop, FileVideo2,
  Image as ImageIcon, LockKeyhole, Monitor, MousePointer2, Pause,
  Pen, Play, RotateCcw, Save, ScreenShare, ShieldCheck, Square, Type, Undo2,
  Video, X, ZoomIn, ZoomOut, Highlighter,
} from "lucide-react";
import "./ScreenRecorder.css";

type Phase = "ready" | "recording" | "paused" | "preview" | "error";
type Tool = "select" | "rectangle" | "ellipse" | "pen" | "arrow" | "text" | "marker";
type QualityPreset = "low" | "balanced" | "high";
type Mark = { tool: Exclude<Tool, "select">; points: { x: number; y: number }[]; text?: string; color?: string };
type GuidePoint = { x: number; y: number };
type ResizeHandle = "nw" | "ne" | "sw" | "se";
type GuideGesture =
  | { mode: "move"; index: number; anchor: GuidePoint; original: GuidePoint[] }
  | { mode: "resize"; index: number; handle: ResizeHandle; fixed: GuidePoint };
type SavePickerOptions = { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] };
type SaveFileHandle = { createWritable: () => Promise<{ write: (blob: Blob) => Promise<void>; close: () => Promise<void> }> };
declare global { interface Window { showSaveFilePicker?: (options: SavePickerOptions) => Promise<SaveFileHandle> } }

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=h264,aac",
  "video/mp4",
];

const arabic = {
  title: "مسجّل الشاشة", subtitle: "وثّق خطوات العمل وشارك الدليل من جهازك مباشرة.",
  local: "محلي على جهازك", private: "تسجيلاتك لا تُرفع إلى خوادم زاكود",
  preview: "معاينة التسجيل", idle: "جاهز لبدء التوثيق", idleHint: "اختر شاشة أو نافذة أو علامة تبويب من المتصفح لبدء المعاينة.",
  source: "وضع الالتقاط", sourceHint: "الاختيار النهائي للمصدر من نافذة المتصفح.",
  desktopMode: "شاشة أو نافذة Windows", desktopModeDesc: "يمكن أن يستمر التسجيل عند الانتقال إلى تطبيقات Windows الأخرى، ضمن المصدر الذي تسمح به صلاحية المتصفح.",
  tabMode: "علامة تبويب المتصفح فقط", tabModeDesc: "يسجل التبويب المختار دون بقية البرامج والتبويبات. التنقل داخل التبويب نفسه سيظهر في التسجيل؛ لعزل الصفحة أبقها في تبويب مستقل.",
  screen: "الشاشة بالكامل", screenDesc: "التقط سطح المكتب بالكامل", window: "نافذة تطبيق", windowDesc: "وثّق نافذة محددة", tab: "علامة تبويب", tabDesc: "التقط تبويب المتصفح الحالي",
  browserNote: "يتم اختيار المصدر من نافذة المتصفح. لا يمكن للصفحة قراءة النوافذ المتاحة أو تجاوز صلاحية المشاركة.",
  settings: "إعدادات التسجيل", format: "صيغة الفيديو", fit: "ملاءمة المعاينة", zoom: "تكبير المعاينة فقط",
  audio: "الصوت والفحص السريع", systemAudio: "طلب صوت النظام / التبويب", microphone: "إضافة الميكروفون", audioLimit: "يعتمد التقاط الصوت على المتصفح ونظام التشغيل والمصدر المختار. قد لا يتوفر صوت النظام أو قد يتأثر بالجودة والإعدادات؛ تحقق من مقطع قصير قبل التوثيق المهم.",
  audioPreflight: "فحص سريع: اختر مصدراً يسمح بالصوت، تحقق من مؤشر مستوى الصوت في النظام، ثم سجّل بضع ثوانٍ وأعد تشغيلها قبل التسجيل الكامل.",
  audioTrackPresent: "تم توفير مسار صوت من المصدر المختار. تحقق من الصوت بعد التسجيل التجريبي.",
  audioTrackMissing: "لم يوفر المصدر الحالي مسار صوت نظام. قد يكون الصوت غير مدعوم أو لم يتم اختياره في نافذة المتصفح.",
  preflightSource: "مصدر الالتقاط", preflightAudio: "صوت المصدر", preflightMic: "الميكروفون",
  preflightChoose: "لم يُختر بعد", preflightRequested: "سيُطلب عند التسجيل", preflightOff: "غير مفعّل",
  quality: "جودة وحجم الملف", qualityLow: "منخفض", qualityBalanced: "متوازن", qualityHigh: "مرتفع",
  estimate: "الحجم التقريبي لمدة 60 دقيقة", estimateVaries: "تقدير تقريبي؛ يختلف حسب المتصفح ومحتوى الشاشة. خفض معدل البت يقلل وضوح النص والتفاصيل.",
  requestedBitrate: "معدل البت المطلوب", audioTab: "طلب صوت علامة التبويب", audioSystem: "طلب صوت النظام / النافذة",
  browserCaptureLimits: "يعرض المتصفح وأنظمة التشغيل مصادر مختلفة. قد لا يظهر خيار الشاشة أو النافذة الأصلية؛ إن لم يظهر، استخدم وضع علامة تبويب المتصفح. اختيار المصدر النهائي والصوت المتاح يخضعان للمتصفح والنظام.",
  sourceUnavailable: "لم يتوفر مصدر مشاركة مناسب في المتصفح أو النظام. جرّب وضع علامة تبويب المتصفح أو تحقق من إعدادات المشاركة.",
  switchingNote: "قد يستمر وضع الشاشة أو النافذة عند الانتقال بين تطبيقات Windows، لكن المتصفح يلتقط المصدر المحدد فقط. لا يمكن ضمان الاستمرار إذا أوقفت المشاركة أو غيّر النظام الصلاحية.",
  annotate: "أدوات التوضيح", annotationHelp: "طبقة إرشادية للمعاينة فقط؛ لا تدخل في تركيب الفيديو أو الصورة. إذا سجلت الشاشة أو التبويب الذي تظهر فيه واجهة المسجّل، قد يلتقط المصدر عناصر الواجهة نفسها؛ استخدم نافذة أو تبويب الهدف منفصلًا.", undo: "تراجع", clear: "مسح العلامات",
  noMarks: "اختر أداة ثم ابدأ الرسم على المعاينة.",
  choose: "اختيار مصدر", start: "بدء التسجيل", pause: "إيقاف مؤقت", resume: "استئناف", stop: "إنهاء التسجيل",
  screenshot: "التقاط صورة", crop: "تحديد منطقة", cropActive: "اسحب لتحديد المنطقة", cancelCrop: "إلغاء التحديد", save: "حفظ الملف", discard: "حذف المعاينة",
  recording: "جارٍ التسجيل", paused: "متوقف مؤقتاً", previewState: "معاينة جاهزة", noRecording: "لا يوجد تسجيل بعد", noRecordingHint: "بعد الإيقاف، ستظهر هنا معاينة محلية قبل الحفظ.",
  savedLocally: "يُحفظ الملف على جهازك فقط. لا يتم إرسال أي بيانات إلى ERP.",
  denied: "لم يُسمح بمشاركة الشاشة. تحقق من صلاحية المتصفح ثم أعد المحاولة.", unsupported: "المتصفح لا يدعم مشاركة الشاشة أو تسجيل الفيديو. استخدم إصداراً حديثاً من Chrome أو Edge أو Firefox.",
  saveFallback: "تم تنزيل الملف عبر المتصفح.", saveError: "تعذر حفظ الملف. جرّب التنزيل المعتاد.", screenshotSaved: "تم تنزيل الصورة.",
  sourceName: "مصدر مشترك", videoType: "فيديو", imageType: "صورة", useFileSystem: "استخدام نافذة الحفظ عند توفرها",
  canvasCrop: "المنطقة المحددة", fullFrame: "الإطار الكامل", toolSelect: "تحديد وتحريك وتغيير الحجم", toolRectangle: "مستطيل", toolEllipse: "دائرة أو شكل بيضاوي", toolPen: "قلم", toolArrow: "سهم", toolText: "نص", toolMarker: "تمييز",
  guideColors: "لون الأداة", guideLayerOnly: "أدوات مساعدة للشرح فقط — لا تدخل في تركيب الملف المحفوظ.",
  screenshotRegion: "التقاط المنطقة", keyboard: "تلميح: أوقف التسجيل من هذه الصفحة أو من شريط مشاركة المتصفح.",
};
const english: typeof arabic = {
  title: "Screen recorder", subtitle: "Document a workflow and capture evidence, right on your device.",
  local: "On this device", private: "Your recordings are never uploaded to Zacode servers",
  preview: "Recording preview", idle: "Ready to document", idleHint: "Choose a screen, window, or browser tab to start the preview.",
  source: "Capture mode", sourceHint: "The browser picker grants the final source.",
  desktopMode: "Windows display or window", desktopModeDesc: "Recording may continue as you switch Windows apps, limited to the display or window the browser grants.",
  tabMode: "Browser tab only", tabModeDesc: "Captures the selected tab, not other apps or tabs. Navigating within that same tab is still captured; keep the target page in a separate tab to isolate it.",
  screen: "Entire screen", screenDesc: "Capture the full desktop", window: "Application window", windowDesc: "Document a selected window", tab: "Browser tab", tabDesc: "Capture a browser tab",
  browserNote: "Choose the source in the browser picker. This page cannot inspect available windows or bypass sharing permission.",
  settings: "Recording settings", format: "Video format", fit: "Preview fit", zoom: "Preview zoom only",
  audio: "Audio & quick check", systemAudio: "Request system / tab audio", microphone: "Include microphone", audioLimit: "Audio capture depends on the browser, operating system, and selected source. System audio may be unavailable or affected by quality and settings; test a short clip before important documentation.",
  audioPreflight: "Quick check: choose a source that allows audio, check your system’s audio meter, then record and replay a few seconds before the full capture.",
  audioTrackPresent: "An audio track was provided by the selected source. Verify the result with a short test recording.",
  audioTrackMissing: "The current source did not provide system audio. It may be unsupported or was not selected in the browser picker.",
  preflightSource: "Capture source", preflightAudio: "Source audio", preflightMic: "Microphone",
  preflightChoose: "Not selected", preflightRequested: "Permission asked on record", preflightOff: "Off",
  quality: "Quality & file size", qualityLow: "Low", qualityBalanced: "Balanced", qualityHigh: "High",
  estimate: "Approximate size for 60 minutes", estimateVaries: "Approximate only; browser and screen content affect size. Lower bitrate reduces text and detail clarity.",
  requestedBitrate: "Requested bitrate", audioTab: "Request browser-tab audio", audioSystem: "Request system / window audio",
  browserCaptureLimits: "Browsers and operating systems expose different sources. The native display or window option may not be listed; if unavailable, use browser-tab mode. The browser and OS control the final source and available audio.",
  sourceUnavailable: "No suitable capture source was available in the browser or OS. Try browser-tab mode or check sharing settings.",
  switchingNote: "Display or window mode may continue while switching Windows apps, but the browser captures only the granted source. Sharing can still stop if you end it or the OS changes permission.",
  annotate: "On-screen guides", annotationHelp: "Guides are preview-only and are not composited into the video or still. If you record the same screen or tab showing the recorder, the capture source may include its UI; use a separate target window or tab.", undo: "Undo", clear: "Clear guides",
  noMarks: "Choose a tool, then draw over the preview.",
  choose: "Choose source", start: "Start recording", pause: "Pause", resume: "Resume", stop: "Stop recording",
  screenshot: "Capture still", crop: "Select region", cropActive: "Drag to select a region", cancelCrop: "Cancel selection", save: "Save file", discard: "Discard preview",
  recording: "Recording", paused: "Paused", previewState: "Preview ready", noRecording: "No recording yet", noRecordingHint: "After you stop, a local preview will appear here before saving.",
  savedLocally: "Saved on your device only. No media is sent to ERP.",
  denied: "Screen sharing was not allowed. Check browser permissions and try again.", unsupported: "This browser does not support screen sharing or video recording. Try a recent version of Chrome, Edge, or Firefox.",
  saveFallback: "Downloaded through your browser.", saveError: "Could not save the file. Try the standard download.", screenshotSaved: "Image downloaded.",
  sourceName: "Shared source", videoType: "Video", imageType: "Image", useFileSystem: "Use save dialog when available",
  canvasCrop: "Selected region", fullFrame: "Full frame", toolSelect: "Select, move, and resize", toolRectangle: "Rectangle", toolEllipse: "Circle or ellipse", toolPen: "Pen", toolArrow: "Arrow", toolText: "Text", toolMarker: "Highlight",
  guideColors: "Tool color", guideLayerOnly: "Helper guides only — excluded from the saved file composition.",
  screenshotRegion: "Capture region", keyboard: "Tip: stop from this page or the browser’s screen-sharing bar.",
};

function prettySize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatTime(seconds: number) {
  const mm = Math.floor(seconds / 60).toString().padStart(2, "0");
  const ss = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function ScreenRecorder() {
  const { i18n } = useTranslation();
  const isArabic = (i18n.language || "ar").toLowerCase().startsWith("ar");
  const copy = isArabic ? arabic : english;
  const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";
  const [phase, setPhase] = useState<Phase>("ready");
  const [errorMessage, setErrorMessage] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewKind, setPreviewKind] = useState<"video" | "image">("video");
  const [mime, setMime] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool>("select");
  const [marks, setMarks] = useState<Mark[]>([]);
  const [selectedMarkIndex, setSelectedMarkIndex] = useState<number | null>(null);
  const [guideColor, setGuideColor] = useState("#ff5c7a");
  const [isDrawing, setIsDrawing] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [usePicker, setUsePicker] = useState(true);
  const [captureMode, setCaptureMode] = useState<"desktop" | "tab">("desktop");
  const [includeSystemAudio, setIncludeSystemAudio] = useState(true);
  const [includeMicrophone, setIncludeMicrophone] = useState(false);
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>("balanced");
  const [notice, setNotice] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const compositeRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const compositeRafRef = useRef<number | null>(null);
  const startAtRef = useRef(0);
  const elapsedRef = useRef(0);
  const objectUrlRef = useRef("");
  const marksRef = useRef(marks);
  const guideGestureRef = useRef<GuideGesture | null>(null);
  marksRef.current = marks;

  const formats = useMemo(() => typeof MediaRecorder === "undefined" ? [] : MIME_CANDIDATES.filter((type) => MediaRecorder.isTypeSupported(type)), []);
  const selectedMime = formats.includes(mime) ? mime : (formats.find((type) => type.includes("webm;codecs=vp9")) || formats.find((type) => type.startsWith("video/webm")) || formats[0] || "");
  const isActive = phase === "recording" || phase === "paused";
  const bitrateProfiles: Record<QualityPreset, { video: number; audio: number }> = {
    low: { video: 900_000, audio: 96_000 },
    balanced: { video: 2_400_000, audio: 128_000 },
    high: { video: 5_000_000, audio: 192_000 },
  };
  const selectedProfile = bitrateProfiles[qualityPreset];
  const audioEstimated = ((includeSystemAudio && (!stream || stream.getAudioTracks().length > 0)) || includeMicrophone) ? selectedProfile.audio : 0;
  const estimatedBytesPerHour = ((selectedProfile.video + audioEstimated) * 60 * 60) / 8;
  const formatEstimate = (bytes: number) => bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;

  const setVideoSource = useCallback((mediaStream: MediaStream | null, url = "") => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.srcObject = mediaStream;
    video.src = url;
    if (mediaStream) {
      video.muted = true;
      void video.play().catch(() => {});
    } else if (url) {
      video.muted = false;
      video.controls = true;
      void video.play().catch(() => {});
    }
  }, []);

  const stopTracks = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (compositeRafRef.current !== null) cancelAnimationFrame(compositeRafRef.current);
    rafRef.current = null;
    compositeRafRef.current = null;
    const current = streamRef.current;
    current?.getTracks().forEach((track) => track.stop());
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    microphoneRef.current = null;
    streamRef.current = null;
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setStream(null);
  }, []);

  const drawMarks = useCallback(() => {
    const canvas = overlayRef.current;
    const media = previewKind === "image" && phase === "preview" ? imageRef.current : videoRef.current;
    if (!canvas || !media) return;
    const width = Math.max(1, ("videoWidth" in media ? media.videoWidth : media.naturalWidth) || canvas.clientWidth);
    const height = Math.max(1, ("videoHeight" in media ? media.videoHeight : media.naturalHeight) || canvas.clientHeight);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    marksRef.current.forEach((mark, markIndex) => {
      if (mark.tool === "text") {
        const point = mark.points[0];
        if (!point) return;
        ctx.font = `${Math.max(22, width * .026)}px Cairo, sans-serif`;
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#16352d";
        ctx.fillStyle = mark.color || "#ffe091";
        ctx.strokeText(mark.text || "", point.x * width, point.y * height);
        ctx.fillText(mark.text || "", point.x * width, point.y * height);
        return;
      }
      if (!mark.points.length) return;
      ctx.beginPath();
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.lineWidth = mark.tool === "marker" ? Math.max(18, width * .022) : Math.max(4, width * .005);
      ctx.strokeStyle = mark.tool === "marker" ? `${mark.color || "#f2cc57"}66` : mark.color || "#f2f7e9";
      if ((mark.tool === "rectangle" || mark.tool === "ellipse") && mark.points.length > 1) {
        const first = mark.points[0], last = mark.points[mark.points.length - 1];
        const x = Math.min(first.x, last.x) * width, y = Math.min(first.y, last.y) * height;
        const w = Math.abs(last.x - first.x) * width, h = Math.abs(last.y - first.y) * height;
        if (mark.tool === "rectangle") ctx.rect(x, y, w, h);
        else ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
      } else {
        ctx.moveTo(mark.points[0].x * width, mark.points[0].y * height);
        mark.points.slice(1).forEach((point) => ctx.lineTo(point.x * width, point.y * height));
      }
      if (mark.tool === "arrow" && mark.points.length > 1) {
        const from = mark.points[0], to = mark.points[mark.points.length - 1];
        const x1 = from.x * width, y1 = from.y * height, x2 = to.x * width, y2 = to.y * height;
        const angle = Math.atan2(y2 - y1, x2 - x1), head = Math.max(14, width * .018);
        ctx.moveTo(x2, y2); ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(x2, y2); ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
      }
      ctx.stroke();
      if (selectedMarkIndex === markIndex && (mark.tool === "rectangle" || mark.tool === "ellipse") && mark.points.length > 1) {
        const first = mark.points[0], last = mark.points[mark.points.length - 1];
        const left = Math.min(first.x, last.x) * width, right = Math.max(first.x, last.x) * width;
        const top = Math.min(first.y, last.y) * height, bottom = Math.max(first.y, last.y) * height;
        [[left, top], [right, top], [left, bottom], [right, bottom]].forEach(([x, y]) => {
          ctx.beginPath(); ctx.fillStyle = "#fff"; ctx.strokeStyle = mark.color || "#ff5c7a"; ctx.lineWidth = 2;
          ctx.rect(x - 5, y - 5, 10, 10); ctx.fill(); ctx.stroke();
        });
      }
    });
  }, [previewKind, phase, selectedMarkIndex]);

  useEffect(() => { drawMarks(); }, [marks, drawMarks, phase, stream, previewUrl]);

  useEffect(() => {
    if (phase !== "recording") return;
    const tick = () => {
      const base = elapsedRef.current;
      setElapsed(base + Math.floor((Date.now() - startAtRef.current) / 1000));
      rafRef.current = requestAnimationFrame(tick);
    };
    startAtRef.current = Date.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); rafRef.current = null; };
  }, [phase]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (compositeRafRef.current !== null) cancelAnimationFrame(compositeRafRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    if (audioContextRef.current) void audioContextRef.current.close().catch(() => {});
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const sourceError = (error: unknown) => {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      setErrorMessage(copy.denied);
    } else if (name === "NotFoundError") {
      setErrorMessage(copy.sourceUnavailable);
    } else if (name === "NotSupportedError" || name === "TypeError") {
      setErrorMessage(copy.unsupported);
    } else {
      setErrorMessage(copy.denied);
    }
    setPhase("error");
  };

  const chooseSource = async (requestedMode: "desktop" | "tab" = captureMode) => {
    setNotice("");
    setErrorMessage("");
    if (!supported) { setErrorMessage(copy.unsupported); setPhase("error"); return; }
    try {
      const nextStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: includeSystemAudio,
        preferCurrentTab: requestedMode === "tab",
      } as DisplayMediaStreamOptions & { preferCurrentTab?: boolean });
      const previousStream = streamRef.current;
      previousStream?.getTracks().forEach((track) => track.stop());
      microphoneRef.current?.getTracks().forEach((track) => track.stop());
      microphoneRef.current = null;
      streamRef.current = nextStream;
      setStream(nextStream);
      setPreviewBlob(null);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = "";
      setPreviewUrl("");
      setCropRect(null);
      setMarks([]);
      setPhase("ready");
      setVideoSource(nextStream);
      nextStream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (recorderRef.current?.state === "recording" || recorderRef.current?.state === "paused") stopRecording();
        else { stopTracks(); setPhase("ready"); }
      }, { once: true });
    } catch (error) { sourceError(error); }
  };

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  };
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!stream && !previewUrl) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    if (cropMode) { setSelectionDraft({ x: point.x, y: point.y, w: 0, h: 0 }); setIsDrawing(true); return; }
    if (tool === "select") {
      const selected = selectedMarkIndex === null ? null : marks[selectedMarkIndex];
      if (selected && (selected.tool === "rectangle" || selected.tool === "ellipse") && selected.points.length > 1) {
        const first = selected.points[0], last = selected.points[selected.points.length - 1];
        const left = Math.min(first.x, last.x), right = Math.max(first.x, last.x);
        const top = Math.min(first.y, last.y), bottom = Math.max(first.y, last.y);
        const handles: { id: ResizeHandle; point: GuidePoint; fixed: GuidePoint }[] = [
          { id: "nw", point: { x: left, y: top }, fixed: { x: right, y: bottom } },
          { id: "ne", point: { x: right, y: top }, fixed: { x: left, y: bottom } },
          { id: "sw", point: { x: left, y: bottom }, fixed: { x: right, y: top } },
          { id: "se", point: { x: right, y: bottom }, fixed: { x: left, y: top } },
        ];
        const handle = handles.find((item) => Math.hypot(item.point.x - point.x, item.point.y - point.y) < .035);
        if (handle) {
          guideGestureRef.current = { mode: "resize", index: selectedMarkIndex!, handle: handle.id, fixed: handle.fixed };
          setIsDrawing(true);
          return;
        }
      }
      const hitIndex = [...marks.keys()].reverse().find((index) => {
        const mark = marks[index], points = mark.points;
        if (!points.length) return false;
        const left = Math.min(...points.map((item) => item.x)) - .02;
        const right = Math.max(...points.map((item) => item.x)) + .02;
        const top = Math.min(...points.map((item) => item.y)) - .02;
        const bottom = Math.max(...points.map((item) => item.y)) + .02;
        return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
      });
      setSelectedMarkIndex(hitIndex ?? null);
      if (hitIndex !== undefined) {
        guideGestureRef.current = { mode: "move", index: hitIndex, anchor: point, original: marks[hitIndex].points };
        setIsDrawing(true);
      }
      return;
    }
    if (tool === "text") {
      const text = window.prompt(isArabic ? "اكتب النص التوضيحي" : "Enter annotation text");
      if (text?.trim()) {
        setMarks((current) => [...current, { tool, points: [point], text: text.trim(), color: guideColor }]);
        setSelectedMarkIndex(null);
      }
      return;
    }
    setMarks((current) => [...current, { tool, points: [point, point], color: guideColor }]);
    setSelectedMarkIndex(marks.length);
    guideGestureRef.current = null;
    setIsDrawing(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const point = pointFromEvent(event);
    const gesture = guideGestureRef.current;
    if (gesture?.mode === "resize") {
      const resized = gesture.handle === "nw" || gesture.handle === "se"
        ? [gesture.fixed, point]
        : [gesture.fixed, point];
      setMarks((current) => current.map((mark, index) => index === gesture.index ? { ...mark, points: resized } : mark));
      return;
    }
    if (gesture?.mode === "move") {
      const dx = point.x - gesture.anchor.x, dy = point.y - gesture.anchor.y;
      const moved = gesture.original.map((item) => ({ x: Math.max(0, Math.min(1, item.x + dx)), y: Math.max(0, Math.min(1, item.y + dy)) }));
      setMarks((current) => current.map((mark, index) => index === gesture.index ? { ...mark, points: moved } : mark));
      return;
    }
    setMarks((current) => current.map((mark, index) => {
      if (index !== current.length - 1) return mark;
      if (mark.tool === "rectangle" || mark.tool === "ellipse" || mark.tool === "arrow") return { ...mark, points: [mark.points[0], point] };
      return { ...mark, points: [...mark.points, point] };
    }));
  };
  const onPointerUp = () => {
    setIsDrawing(false);
    guideGestureRef.current = null;
    if (cropMode && selectionDraft) {
      const rect = { x: selectionDraft.x, y: selectionDraft.y, w: selectionDraft.w, h: selectionDraft.h };
      if (rect.w > .025 && rect.h > .025) setCropRect(rect);
      setSelectionDraft(null);
      setCropMode(false);
    }
  };

  const cropBounds = useCallback((width: number, height: number) => {
    if (!cropRect) return { sx: 0, sy: 0, sw: width, sh: height };
    return { sx: Math.round(cropRect.x * width), sy: Math.round(cropRect.y * height), sw: Math.max(1, Math.round(cropRect.w * width)), sh: Math.max(1, Math.round(cropRect.h * height)) };
  }, [cropRect]);

  const captureStill = async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const canvas = document.createElement("canvas");
    const { sx, sy, sw, sh } = cropBounds(video.videoWidth, video.videoHeight);
    canvas.width = sw; canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(blob);
    objectUrlRef.current = url;
    setPreviewBlob(blob); setPreviewKind("image"); setPreviewUrl(url); setPhase("preview");
    setMarks([]);
    setSelectedMarkIndex(null);
  };

  const drawComposite = useCallback(() => {
    const video = videoRef.current;
    const canvas = compositeRef.current;
    if (!video || !canvas || video.readyState < 2) return;
    const { sx, sy, sw, sh } = cropBounds(video.videoWidth, video.videoHeight);
    if (canvas.width !== sw || canvas.height !== sh) { canvas.width = sw; canvas.height = sh; }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    compositeRafRef.current = requestAnimationFrame(drawComposite);
  }, [cropBounds]);

  const startRecording = async () => {
    if (!streamRef.current) return;
    try {
      chunksRef.current = [];
      if (includeMicrophone) {
        try {
          microphoneRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
          setNotice(isArabic ? "تعذر الوصول إلى الميكروفون؛ سيستمر التسجيل دون صوت الميكروفون." : "Microphone access was unavailable; recording will continue without microphone audio.");
        }
      }
      const video = videoRef.current;
      if (!video) return;
      const { sx, sy, sw, sh } = cropBounds(video.videoWidth, video.videoHeight);
      const composite = document.createElement("canvas");
      composite.width = sw; composite.height = sh;
      compositeRef.current = composite;
      drawComposite();
    const composedStream = composite.captureStream(30);
    const audioTracks = [
      ...streamRef.current.getAudioTracks(),
      ...(microphoneRef.current?.getAudioTracks() ?? []),
    ];
    if (audioTracks.length === 1) {
      composedStream.addTrack(audioTracks[0]);
    } else if (audioTracks.length > 1) {
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      await audioContext.resume();
      const destination = audioContext.createMediaStreamDestination();
      audioTracks.forEach((track) => {
        audioContext.createMediaStreamSource(new MediaStream([track])).connect(destination);
      });
      destination.stream.getAudioTracks().forEach((track) => composedStream.addTrack(track));
    }
      const hasAudio = composedStream.getAudioTracks().length > 0;
      const recorderOptions: MediaRecorderOptions = {
        ...(selectedMime ? { mimeType: selectedMime } : {}),
        videoBitsPerSecond: selectedProfile.video,
        ...(hasAudio ? { audioBitsPerSecond: selectedProfile.audio } : {}),
      };
      const recorder = new MediaRecorder(composedStream, recorderOptions);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = () => { setErrorMessage(copy.saveError); setPhase("error"); stopTracks(); };
      recorder.onstop = () => {
        if (compositeRafRef.current !== null) cancelAnimationFrame(compositeRafRef.current);
        compositeRafRef.current = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || selectedMime || "video/webm" });
        const url = URL.createObjectURL(blob);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        setPreviewBlob(blob); setPreviewKind("video"); setPreviewUrl(url); setPhase("preview");
        setVideoSource(null, url);
        composedStream.getVideoTracks().forEach((track) => track.stop());
        stopTracks();
      };
      recorder.start(250);
      setElapsed(0); elapsedRef.current = 0; setPhase("recording");
    } catch { setErrorMessage(copy.unsupported); setPhase("error"); stopTracks(); }
  };

  const pauseResume = () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      elapsedRef.current += Math.floor((Date.now() - startAtRef.current) / 1000);
      recorder.pause(); setPhase("paused");
    } else if (recorder.state === "paused") {
      recorder.resume(); setPhase("recording");
    }
  };
  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  const saveBlob = async (blob: Blob, kind: "video" | "image") => {
    const extension = kind === "image" ? "png" : blob.type.includes("mp4") ? "mp4" : "webm";
    const name = `zacode-capture-${new Date().toISOString().slice(0, 10)}.${extension}`;
    if (usePicker && window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: kind === "image" ? "PNG image" : "Video recording", accept: { [blob.type || "application/octet-stream"]: [`.${extension}`] } }] });
        const writable = await handle.createWritable(); await writable.write(blob); await writable.close();
        setNotice(isArabic ? "تم حفظ الملف على جهازك." : "File saved on this device.");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    setNotice(kind === "image" ? copy.screenshotSaved : copy.saveFallback);
  };

  const downloadStill = async () => {
    if (!previewBlob) return;
    await saveBlob(previewBlob, previewKind);
  };
  const resetPreview = () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = "";
    setPreviewBlob(null); setPreviewUrl(""); setMarks([]); setSelectedMarkIndex(null); setCropRect(null); setElapsed(0); elapsedRef.current = 0; setPhase("ready");
    setVideoSource(streamRef.current);
  };

  const setCropFromDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!cropMode || !selectionDraft) return;
    const point = pointFromEvent(event);
    // Compute rectangle from a remembered drag origin held in the canvas dataset.
    const originX = Number(event.currentTarget.dataset.originX || selectionDraft.x);
    const originY = Number(event.currentTarget.dataset.originY || selectionDraft.y);
    setSelectionDraft({ x: Math.min(originX, point.x), y: Math.min(originY, point.y), w: Math.abs(point.x - originX), h: Math.abs(point.y - originY) });
  };

  const toolOptions: { id: Tool; label: string; icon: typeof Pen }[] = [
    { id: "select", label: copy.toolSelect, icon: MousePointer2 },
    { id: "rectangle", label: copy.toolRectangle, icon: Square },
    { id: "ellipse", label: copy.toolEllipse, icon: Circle },
    { id: "pen", label: copy.toolPen, icon: Pen },
    { id: "arrow", label: copy.toolArrow, icon: ArrowDownRight },
    { id: "text", label: copy.toolText, icon: Type },
    { id: "marker", label: copy.toolMarker, icon: Highlighter },
  ];
  const guideColors = ["#ff5c7a", "#f6b73c", "#22c7a9", "#4c8dff", "#bb78ff", "#ffffff"];

  return (
    <main className="sr-page" dir={isArabic ? "rtl" : "ltr"}>
      <div className="sr-shell">
        <header className="sr-topline">
          <div className="sr-brand">
            <div className="sr-brand-mark"><ScreenShare size={20} /></div>
            <div><span className="sr-brand-name">ZACODE ERP</span><span className="sr-brand-sub">{copy.local}</span></div>
          </div>
          <div className="sr-private-pill" data-testid="status-privacy"><LockKeyhole size={14} />{copy.private}</div>
        </header>
        <section className="sr-heading">
          <div><div className="sr-heading-kicker">WORKFLOW EVIDENCE / 01</div><h1>{copy.title}</h1><p>{copy.subtitle}</p></div>
        </section>

        {!supported ? (
          <section className="sr-panel sr-unsupported" data-testid="state-unsupported">
            <AlertTriangle size={30} color="#b9674e" />
            <h2>{copy.unsupported}</h2>
            <p>{copy.browserNote}</p>
          </section>
        ) : (
          <>
            <div className="sr-workspace">
              <section className="sr-panel sr-preview-panel">
                <div className="sr-panel-head">
                  <div className="sr-panel-title"><Video size={17} className="sr-panel-title-icon" />{copy.preview}</div>
                  <div className={`sr-live-state ${phase === "recording" ? "is-recording" : phase === "paused" ? "is-paused" : ""}`} data-testid="status-recorder">
                    <i className="sr-live-dot" />{phase === "recording" ? copy.recording : phase === "paused" ? copy.paused : phase === "preview" ? copy.previewState : copy.local}
                  </div>
                </div>
                {phase === "error" && <div className="sr-alert" role="alert" data-testid="state-permission-error"><AlertTriangle size={17} />{errorMessage || copy.denied}<button className="sr-control-btn icon-only" aria-label={isArabic ? "إغلاق التنبيه" : "Dismiss alert"} onClick={() => { setPhase("ready"); setErrorMessage(""); }} data-testid="button-dismiss-error"><X size={15} /></button></div>}
                <div className={`sr-preview-stage ${stream || previewUrl ? "has-media" : ""}`} ref={stageRef} data-testid="preview-stage">
                  {(stream || previewUrl) ? (
                    <>
                      {previewKind === "image" && phase === "preview"
                        ? <img ref={imageRef} src={previewUrl} className="sr-preview-video" style={{ transform: `scale(${zoom})` }} onLoad={drawMarks} alt={isArabic ? "معاينة الصورة الملتقطة" : "Captured image preview"} data-testid="image-preview" />
                        : <video ref={videoRef} className="sr-preview-video" playsInline controls={!!previewUrl} onLoadedMetadata={drawMarks} style={{ transform: `scale(${zoom})` }} data-testid="video-preview" />}
                      {(stream || previewUrl) && <canvas ref={overlayRef} className="sr-draw-layer" style={{ cursor: cropMode ? "crosshair" : tool === "select" ? "default" : "crosshair", transform: `scale(${zoom})` }} onPointerDown={(event) => {
                        if (cropMode) { const p = pointFromEvent(event); event.currentTarget.dataset.originX = String(p.x); event.currentTarget.dataset.originY = String(p.y); setSelectionDraft({ x: p.x, y: p.y, w: 0, h: 0 }); setIsDrawing(true); }
                        else onPointerDown(event);
                      }} onPointerMove={(event) => cropMode ? setCropFromDrag(event) : onPointerMove(event)} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} data-testid="canvas-annotations" />}
                      {cropRect && !cropMode && <div className="sr-selection" style={{ left: `${cropRect.x * 100}%`, top: `${cropRect.y * 100}%`, width: `${cropRect.w * 100}%`, height: `${cropRect.h * 100}%` }} />}
                      {selectionDraft && <div className="sr-selection" style={{ left: `${selectionDraft.x * 100}%`, top: `${selectionDraft.y * 100}%`, width: `${selectionDraft.w * 100}%`, height: `${selectionDraft.h * 100}%` }} />}
                      {isActive && <div className="sr-preview-zoom">
                        <button onClick={() => setZoom((z) => Math.max(.7, +(z - .1).toFixed(1)))} aria-label={isArabic ? "تصغير المعاينة" : "Zoom out"} data-testid="button-zoom-out"><ZoomOut size={15} /></button>
                        <span>{Math.round(zoom * 100)}%</span>
                        <button onClick={() => setZoom((z) => Math.min(1.6, +(z + .1).toFixed(1)))} aria-label={isArabic ? "تكبير المعاينة" : "Zoom in"} data-testid="button-zoom-in"><ZoomIn size={15} /></button>
                      </div>}
                      {cropMode && <div className="sr-stage-hint">{copy.cropActive}</div>}
                    </>
                  ) : (
                    <div className="sr-empty-state" data-testid="state-empty-preview">
                      <div className="sr-empty-illustration"><Monitor size={30} /></div><h2>{copy.idle}</h2><p>{copy.idleHint}</p>
                    </div>
                  )}
                </div>
                <div className="sr-transport">
                  <div className="sr-transport-main">
                    <span className="sr-timer" data-testid="text-recording-timer">{formatTime(elapsed)}</span>
                    {!stream && phase !== "preview" ? <button className="sr-control-btn primary" onClick={() => void chooseSource()} data-testid="button-choose-source"><ScreenShare size={15} />{copy.choose}</button> :
                      stream && !isActive ? <button className="sr-control-btn primary" onClick={startRecording} data-testid="button-start-recording"><Circle size={13} fill="currentColor" />{copy.start}</button> : null}
                    {phase === "recording" && <button className="sr-control-btn" onClick={pauseResume} data-testid="button-pause-recording"><Pause size={15} />{copy.pause}</button>}
                    {phase === "paused" && <button className="sr-control-btn primary" onClick={pauseResume} data-testid="button-resume-recording"><Play size={15} />{copy.resume}</button>}
                    {isActive && <button className="sr-control-btn danger" onClick={stopRecording} data-testid="button-stop-recording"><Square size={13} fill="currentColor" />{copy.stop}</button>}
                    {stream && !isActive && phase !== "preview" && <button className="sr-control-btn icon-only" onClick={captureStill} aria-label={copy.screenshot} title={copy.screenshot} data-testid="button-capture-still"><ImageIcon size={16} /></button>}
                    {previewBlob && phase === "preview" && <button className="sr-control-btn icon-only" onClick={resetPreview} aria-label={copy.discard} title={copy.discard} data-testid="button-discard-preview"><RotateCcw size={15} /></button>}
                  </div>
                  <div className="sr-transport-tools">
                    {stream && !isActive && phase !== "preview" && <button className="sr-control-btn" onClick={() => { setCropMode((v) => !v); setSelectionDraft(null); }} data-testid="button-select-region"><Crop size={15} />{cropMode ? copy.cancelCrop : cropRect ? copy.screenshotRegion : copy.crop}</button>}
                    {cropRect && <button className="sr-control-btn icon-only" onClick={() => setCropRect(null)} title={copy.fullFrame} aria-label={copy.fullFrame} data-testid="button-clear-crop"><X size={15} /></button>}
                    {stream && <button className="sr-control-btn icon-only" onClick={() => void chooseSource()} title={copy.choose} aria-label={copy.choose} data-testid="button-change-source"><Monitor size={15} /></button>}
                  </div>
                </div>
                {isActive && <div className="sr-recording-strip"><strong><i className="sr-live-dot" />{phase === "paused" ? copy.paused : copy.recording}</strong><span>{copy.keyboard}</span></div>}
                {phase === "preview" && previewBlob && <div className="sr-preview-file">
                  <div className="sr-file-meta"><span className="sr-file-name">{previewKind === "image" ? copy.imageType : copy.videoType} · zacode-capture.{previewKind === "image" ? "png" : previewBlob.type.includes("mp4") ? "mp4" : "webm"}</span><span className="sr-file-size">{prettySize(previewBlob.size)} · {copy.savedLocally}</span></div>
                  <div className="sr-file-actions"><button className="sr-control-btn primary" onClick={downloadStill} data-testid="button-save-recording"><Save size={15} />{copy.save}</button></div>
                </div>}
                {notice && <div className="sr-recording-strip" role="status" data-testid="status-save">{notice}<Check size={15} /></div>}
              </section>

              <aside className="sr-side">
                <section className="sr-panel">
                  <div className="sr-card-body">
                    <div className="sr-section-heading"><h2>{copy.source}</h2><span>{copy.sourceHint}</span></div>
                    <div className="sr-capture-options">
                      {[
                        { id: "desktop" as const, title: copy.desktopMode, desc: copy.desktopModeDesc, icon: Monitor },
                        { id: "tab" as const, title: copy.tabMode, desc: copy.tabModeDesc, icon: FileVideo2 },
                      ].map(({ id, title, desc, icon: Icon }) => <button key={id} className={`sr-source-button ${captureMode === id ? "selected" : ""}`} onClick={() => { setCaptureMode(id); void chooseSource(id); }} disabled={isActive} data-testid={`button-mode-${id}`}>
                        <span className="sr-source-icon"><Icon size={18} /></span><span><span className="sr-source-title">{title}</span><span className="sr-source-desc">{desc}</span></span>{captureMode === id ? <Check className="sr-source-chevron" size={16} /> : <ArrowLeft className="sr-source-chevron" size={15} />}
                      </button>)}
                    </div>
                    <div className="sr-info-note"><ShieldCheck size={15} /><span>{copy.browserNote}</span></div>
                    <div className="sr-tool-note">{captureMode === "desktop" ? copy.switchingNote : copy.tabModeDesc}</div>
                    <div className="sr-info-note"><Monitor size={14} /><span>{copy.browserCaptureLimits}</span></div>
                  </div>
                </section>

                <section className="sr-panel">
                  <div className="sr-card-body">
                    <div className="sr-section-heading"><h2>{copy.settings}</h2><span>{formats.length} {isArabic ? "صيغ متاحة" : "formats available"}</span></div>
                    <div className="sr-settings">
                      <div className="sr-field"><label htmlFor="sr-format">{copy.format}</label><select id="sr-format" value={selectedMime} onChange={(event) => setMime(event.target.value)} disabled={isActive || formats.length === 0} data-testid="select-video-format">
                        {formats.map((format) => <option key={format} value={format}>{format.includes("mp4") ? "MP4 · H.264" : format.includes("vp9") ? "WebM · VP9" : format.includes("vp8") ? "WebM · VP8" : "WebM"}</option>)}
                        {!formats.length && <option value="">{isArabic ? "غير مدعوم" : "Not supported"}</option>}
                      </select></div>
                      <label className="sr-check-line"><input type="checkbox" checked={usePicker} onChange={(event) => setUsePicker(event.target.checked)} data-testid="checkbox-save-dialog" />{copy.useFileSystem}</label>
                      <div className="sr-info-note"><LockKeyhole size={14} /><span>{copy.savedLocally}</span></div>
                    </div>
                  </div>
                </section>

                <section className="sr-panel">
                  <div className="sr-card-body">
                    <div className="sr-section-heading"><h2>{copy.quality}</h2><span>{copy.requestedBitrate}</span></div>
                    <div className="sr-field"><label htmlFor="sr-quality">{copy.quality}</label><select id="sr-quality" value={qualityPreset} disabled={isActive} onChange={(event) => setQualityPreset(event.target.value as QualityPreset)} data-testid="select-quality-preset">
                      <option value="low">{copy.qualityLow} · 0.9 Mbps</option>
                      <option value="balanced">{copy.qualityBalanced} · 2.4 Mbps</option>
                      <option value="high">{copy.qualityHigh} · 5 Mbps</option>
                    </select></div>
                    <div className="sr-estimate" data-testid="text-size-estimate">
                      <div><span>{copy.estimate}</span><strong>{formatEstimate(estimatedBytesPerHour)}</strong></div>
                      <small>{copy.estimateVaries}</small>
                      <small>{(selectedProfile.video / 1_000_000).toFixed(1)} Mbps video · {audioEstimated ? `${Math.round(audioEstimated / 1000)} kbps audio` : (isArabic ? "بدون صوت محدد" : "no selected audio")}</small>
                    </div>
                  </div>
                </section>

                <section className="sr-panel">
                  <div className="sr-card-body">
                    <div className="sr-section-heading"><h2>{copy.audio}</h2><span>{isArabic ? "اختياري" : "Optional"}</span></div>
                    <div className="sr-settings">
                      <label className="sr-check-line"><input type="checkbox" checked={includeSystemAudio} onChange={(event) => setIncludeSystemAudio(event.target.checked)} disabled={!!stream || isActive} data-testid="checkbox-system-audio" />{captureMode === "tab" ? copy.audioTab : copy.audioSystem}</label>
                      <label className="sr-check-line"><input type="checkbox" checked={includeMicrophone} onChange={(event) => setIncludeMicrophone(event.target.checked)} disabled={isActive} data-testid="checkbox-microphone" />{copy.microphone}</label>
                      {stream && <div className="sr-tool-note" role="status" data-testid="status-source-audio">{stream.getAudioTracks().length ? copy.audioTrackPresent : copy.audioTrackMissing}</div>}
                      <div className="sr-info-note"><AlertTriangle size={14} /><span>{copy.audioLimit}</span></div>
                      <div className="sr-preflight" role="status" data-testid="status-audio-preflight">
                        <div><i className={stream ? "is-ready" : ""} /><span>{copy.preflightSource}</span><b>{stream ? (isArabic ? "جاهز" : "Ready") : copy.preflightChoose}</b></div>
                        <div><i className={stream?.getAudioTracks().length ? "is-ready" : ""} /><span>{copy.preflightAudio}</span><b>{stream ? (stream.getAudioTracks().length ? (isArabic ? "مسار متاح" : "Track available") : copy.preflightOff) : includeSystemAudio ? copy.preflightRequested : copy.preflightOff}</b></div>
                        <div><i className={includeMicrophone ? "is-pending" : ""} /><span>{copy.preflightMic}</span><b>{includeMicrophone ? copy.preflightRequested : copy.preflightOff}</b></div>
                      </div>
                      <div className="sr-tool-note">{copy.audioPreflight}</div>
                    </div>
                  </div>
                </section>

                <section className="sr-panel">
                  <div className="sr-card-body">
                    <div className="sr-section-heading"><h2>{copy.annotate}</h2><span>{marks.length} {isArabic ? "علامة" : "marks"}</span></div>
                    <div className="sr-tool-row" role="toolbar" aria-label={copy.annotate}>
                      {toolOptions.map(({ id, label, icon: Icon }) => <button key={id} className={`sr-tool-button ${tool === id ? "active" : ""}`} aria-label={label} title={label} onClick={() => { setTool(id); setCropMode(false); }} disabled={!stream && !previewUrl} data-testid={`button-tool-${id}`}><Icon size={16} /></button>)}
                    </div>
                    <div className="sr-guide-colors" role="group" aria-label={copy.guideColors}>
                      <span>{copy.guideColors}</span>
                      {guideColors.map((color) => <button key={color} className={`sr-color-swatch ${guideColor === color ? "active" : ""}`} type="button" style={{ "--sr-swatch": color } as React.CSSProperties} onClick={() => setGuideColor(color)} aria-label={color} aria-pressed={guideColor === color} data-testid={`button-guide-color-${color.slice(1)}`} />)}
                    </div>
                    <div className="sr-tool-note sr-guide-note">{copy.guideLayerOnly}</div>
                    <div className="sr-tool-note">{copy.annotationHelp}</div>
                    <div className="sr-tool-actions">
                      <button className="sr-control-btn" onClick={() => { setMarks((current) => current.slice(0, -1)); setSelectedMarkIndex(null); }} disabled={!marks.length} data-testid="button-undo-annotation"><Undo2 size={13} />{copy.undo}</button>
                      <button className="sr-control-btn" onClick={() => { setMarks([]); setSelectedMarkIndex(null); }} disabled={!marks.length} data-testid="button-clear-annotations"><X size={13} />{copy.clear}</button>
                    </div>
                  </div>
                </section>
              </aside>
            </div>
            <div className="sr-footnote"><ShieldCheck size={14} />{copy.savedLocally}</div>
          </>
        )}
      </div>
    </main>
  );
}
