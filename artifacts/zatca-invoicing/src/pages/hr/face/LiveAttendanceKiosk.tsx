import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { faceApi, type Camera, type RecognizeResult } from "@/lib/faceAttendanceApi";
import { loadFaceApi } from "@/lib/faceapi/loader";
import { evaluateFaceQuality } from "@/lib/faceapi/quality";
import { createLivenessTracker, type LivenessTracker } from "@/lib/faceapi/liveness";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Loader2, ScanFace, CheckCircle2, XCircle, AlertTriangle, Sparkles, Clock, Users } from "lucide-react";

interface RecentMatch {
  at: number;
  employeeName: string | null;
  employeeCode: string | null;
  confidence: number;
  action: string;
  status: "ok" | "unknown" | "low" | "cooldown" | "spoof";
}

export default function LiveAttendanceKiosk() {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const livenessRef = useRef<LivenessTracker | null>(null);
  const apiRef = useRef<any>(null);
  const intervalRef = useRef<number | null>(null);
  const lastEmployeeRef = useRef<{ id: number; at: number } | null>(null);

  const [modelLoading, setModelLoading] = useState(true);
  const [cameraId, setCameraId] = useState<string>("");
  const [scanning, setScanning] = useState(true);
  const [lastMatch, setLastMatch] = useState<RecognizeResult | null>(null);
  const [matches, setMatches] = useState<RecentMatch[]>([]);
  const [livenessOk, setLivenessOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const { data: cameras = [] } = useQuery<Camera[]>({ queryKey: ["face-cameras"], queryFn: () => faceApi.cameras() });

  // clock tick
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // load model
  useEffect(() => {
    loadFaceApi()
      .then((api) => { apiRef.current = api; setModelLoading(false); })
      .catch((e: any) => {
        setModelLoading(false);
        toast({ title: "تعذر تحميل نماذج التعرّف", description: e?.message ?? "تأكد من الاتصال بالإنترنت", variant: "destructive" });
      });
  }, []);

  // pick first webcam if available
  useEffect(() => {
    if (cameras.length > 0 && !cameraId) {
      const wc = cameras.find((c) => c.kind === "webcam") ?? cameras[0];
      if (wc) setCameraId(String(wc.id));
    }
  }, [cameras, cameraId]);

  // start webcam + recognition loop
  useEffect(() => {
    if (modelLoading) return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        livenessRef.current = createLivenessTracker();
        startScanLoop();
      } catch (e: any) {
        toast({ title: "تعذر فتح الكاميرا", description: e?.message ?? "", variant: "destructive" });
      }
    })();
    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelLoading]);

  function pushMatch(m: RecentMatch) {
    setMatches((prev) => [m, ...prev].slice(0, 12));
  }

  function startScanLoop() {
    intervalRef.current = window.setInterval(async () => {
      if (busy || !scanning) return;
      const video = videoRef.current;
      const api = apiRef.current;
      if (!video || !api || video.readyState < 2) return;
      try {
        const opts = new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
        const detection = await api.detectSingleFace(video, opts).withFaceLandmarks();
        const q = evaluateFaceQuality(detection ? [detection] : [], video.videoWidth, video.videoHeight);
        // overlay
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d")!;
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          if (q.box) {
            ctx.strokeStyle = q.score > 0.7 ? "#10b981" : "#f59e0b";
            ctx.lineWidth = 3;
            ctx.strokeRect(q.box.x, q.box.y, q.box.width, q.box.height);
          }
        }
        // liveness tracker
        if (livenessRef.current) {
          const stage = livenessRef.current.feed(detection ?? null);
          setLivenessOk(stage === "passed");
          if (stage === "failed") livenessRef.current.reset();
        }
        if (q.score < 0.55 || !detection) return;

        // proceed to descriptor + recognize
        setBusy(true);
        const full = await api
          .detectSingleFace(video, opts)
          .withFaceLandmarks()
          .withFaceDescriptor();
        if (!full?.descriptor) { setBusy(false); return; }
        const descriptor = Array.from(full.descriptor) as number[];
        const camId = cameraId ? Number(cameraId) : null;
        const rec = await faceApi.recognize(descriptor, camId, livenessOk);
        setLastMatch(rec);
        if (!rec.matched || !rec.employeeId || !rec.ticket) {
          pushMatch({ at: Date.now(), employeeName: null, employeeCode: null, confidence: rec.confidence ?? 0, action: "unknown", status: "unknown" });
          setBusy(false);
          return;
        }
        // dedupe within 8 seconds for same person
        const last = lastEmployeeRef.current;
        if (last && last.id === rec.employeeId && Date.now() - last.at < 8000) {
          setBusy(false);
          return;
        }
        lastEmployeeRef.current = { id: rec.employeeId, at: Date.now() };

        const checkRes = await faceApi.check({
          ticket: rec.ticket,
          deviceInfo: navigator.userAgent.slice(0, 120),
        });
        if (checkRes.ok) {
          pushMatch({
            at: Date.now(),
            employeeName: rec.employeeName,
            employeeCode: rec.employeeCode,
            confidence: rec.confidence ?? 0,
            action: checkRes.action ?? "auto",
            status: "ok",
          });
        } else {
          pushMatch({
            at: Date.now(),
            employeeName: rec.employeeName,
            employeeCode: rec.employeeCode,
            confidence: rec.confidence ?? 0,
            action: checkRes.reason ?? "skipped",
            status: checkRes.reason === "cooldown" ? "cooldown" : "low",
          });
        }
      } catch (e: any) {
        // silent — keep scanning
      } finally {
        setBusy(false);
      }
    }, 1500);
  }

  const fmtTime = (d: Date) => d.toTimeString().slice(0, 8);
  const fmtRelative = (ts: number) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s} ث`;
    if (s < 3600) return `${Math.floor(s / 60)} د`;
    return new Date(ts).toTimeString().slice(0, 5);
  };

  return (
    <div className="min-h-screen p-4 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white" data-testid="page-live-kiosk">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ScanFace className="h-7 w-7 text-emerald-400" />
            الحضور الذكي بالتعرف على الوجه
          </h1>
          <div className="flex items-center gap-3">
            <div className="text-3xl font-mono">{fmtTime(now)}</div>
            <div className="flex items-center gap-2">
              <Switch checked={scanning} onCheckedChange={setScanning} data-testid="switch-scanning" />
              <span className="text-sm">{scanning ? "نشط" : "متوقف"}</span>
            </div>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2 p-4 bg-slate-800/60 border-slate-700">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-sm">
                <Select value={cameraId} onValueChange={setCameraId}>
                  <SelectTrigger className="w-64 bg-slate-900 border-slate-700"><SelectValue placeholder="اختر كاميرا" /></SelectTrigger>
                  <SelectContent>
                    {cameras.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name} {c.location ? `— ${c.location}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Badge variant={livenessOk ? "default" : "secondary"} className={livenessOk ? "bg-emerald-600" : ""}>
                <Sparkles className="h-3 w-3 mr-1" /> الكشف الحي: {livenessOk ? "✓" : "..."}
              </Badge>
            </div>

            <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
              {modelLoading && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin mr-2" /> جاري التهيئة...
                </div>
              )}
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
              {lastMatch && (
                <div className={`absolute bottom-0 left-0 right-0 p-3 backdrop-blur-md ${lastMatch.matched ? "bg-emerald-500/40" : "bg-rose-500/40"}`}>
                  <div className="flex items-center gap-3">
                    {lastMatch.matched ? <CheckCircle2 className="h-8 w-8" /> : <XCircle className="h-8 w-8" />}
                    <div className="flex-1">
                      <div className="font-bold text-lg">
                        {lastMatch.matched ? lastMatch.employeeName : "وجه غير معروف"}
                      </div>
                      {lastMatch.matched && (
                        <div className="text-xs opacity-90">{lastMatch.employeeCode} — تطابق {((lastMatch.confidence ?? 0) * 100).toFixed(1)}%</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Card>

          <Card className="p-4 bg-slate-800/60 border-slate-700">
            <div className="flex items-center gap-2 mb-3 font-semibold">
              <Users className="h-4 w-4" /> آخر الحضور
            </div>
            <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
              {matches.length === 0 && (
                <p className="text-sm text-slate-400 text-center py-8">في انتظار وجوه...</p>
              )}
              {matches.map((m, i) => (
                <div key={i} className={`p-3 rounded-lg border text-sm ${
                  m.status === "ok" ? "bg-emerald-900/30 border-emerald-700/50" :
                  m.status === "cooldown" ? "bg-amber-900/30 border-amber-700/50" :
                  m.status === "spoof" ? "bg-rose-900/30 border-rose-700/50" :
                  "bg-slate-900/40 border-slate-700"
                }`}>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-medium">{m.employeeName ?? "غير معروف"}</div>
                      <div className="text-xs opacity-70">{m.employeeCode ?? "—"}</div>
                    </div>
                    <div className="text-xs opacity-70 flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {fmtRelative(m.at)}
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    {m.status === "ok" && (
                      <Badge className="bg-emerald-600">{m.action === "check_in" ? "حضور" : m.action === "check_out" ? "انصراف" : m.action}</Badge>
                    )}
                    {m.status === "cooldown" && <Badge variant="secondary">فترة انتظار</Badge>}
                    {m.status === "unknown" && <Badge variant="destructive">غير معروف</Badge>}
                    {m.status === "low" && <Badge variant="secondary">{m.action}</Badge>}
                    <span className="opacity-70">{(m.confidence * 100).toFixed(0)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {!livenessOk && (
          <div className="text-center p-3 rounded-lg bg-amber-900/30 border border-amber-700/50 text-amber-200 text-sm flex items-center justify-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            للتفعيل الكامل: ارمش بعينيك وحرّك رأسك قليلاً (الكشف الحي)
          </div>
        )}
      </div>
    </div>
  );
}
