import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { employeesApi } from "@/lib/employeesApi";
import { faceApi } from "@/lib/faceAttendanceApi";
import { loadFaceApi } from "@/lib/faceapi/loader";
import { evaluateFaceQuality, type FaceQualityResult } from "@/lib/faceapi/quality";
import { createLivenessTracker, livenessLabel, type LivenessTracker } from "@/lib/faceapi/liveness";
import { useToast } from "@/hooks/use-toast";
import { parseError } from "@/lib/parseError";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Camera as CameraIcon, ScanFace, Trash2, CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";

export default function FaceEnrollment() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const livenessRef = useRef<LivenessTracker | null>(null);
  const loopRef = useRef<number | null>(null);
  const apiRef = useRef<any>(null);

  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState<string>("");
  const [pose, setPose] = useState<string>("frontal");
  const [quality, setQuality] = useState<FaceQualityResult>({ score: 0, faceCount: 0, reasons: ["جاري التهيئة..."] });
  const [livenessStage, setLivenessStage] = useState<string>("wait_blink");
  const [blinkCount, setBlinkCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const { data: employees = [] } = useQuery<any[]>({ queryKey: ["employees"], queryFn: () => employeesApi.list() });
  const { data: enrollments = [], refetch } = useQuery({
    queryKey: ["face-enrollments", employeeId],
    queryFn: () => faceApi.enrollments(employeeId ? Number(employeeId) : undefined),
    enabled: true,
  });

  // load model
  useEffect(() => {
    let cancelled = false;
    loadFaceApi()
      .then((api) => { if (!cancelled) { apiRef.current = api; setModelLoading(false); } })
      .catch((e) => { if (!cancelled) { setModelError(String(e?.message ?? e)); setModelLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  // start webcam
  useEffect(() => {
    if (modelLoading || modelError) return;
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
        startLoop();
      } catch (e: any) {
        toast({ title: "تعذر فتح الكاميرا", description: e?.message ?? "تأكد من السماح بالوصول للكاميرا", variant: "destructive" });
      }
    })();
    return () => {
      cancelled = true;
      if (loopRef.current) cancelAnimationFrame(loopRef.current);
      if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelLoading, modelError]);

  function startLoop() {
    const tick = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const api = apiRef.current;
      if (!video || !canvas || !api || video.readyState < 2) {
        loopRef.current = requestAnimationFrame(tick);
        return;
      }
      try {
        const opts = new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
        const detections = await api.detectAllFaces(video, opts).withFaceLandmarks();
        const q = evaluateFaceQuality(detections, video.videoWidth, video.videoHeight);
        setQuality(q);
        // liveness
        if (livenessRef.current) {
          const stage = livenessRef.current.feed(detections[0] ?? null);
          setLivenessStage(stage);
          setBlinkCount(livenessRef.current.blinkCount);
        }
        // overlay
        const ctx = canvas.getContext("2d")!;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (q.box) {
          ctx.strokeStyle = q.score > 0.7 ? "#10b981" : q.score > 0.4 ? "#f59e0b" : "#ef4444";
          ctx.lineWidth = 3;
          ctx.strokeRect(q.box.x, q.box.y, q.box.width, q.box.height);
        }
      } catch {}
      loopRef.current = requestAnimationFrame(tick);
    };
    loopRef.current = requestAnimationFrame(tick);
  }

  async function captureAndEnroll() {
    const video = videoRef.current;
    const api = apiRef.current;
    if (!employeeId) { toast({ title: "اختر موظفاً أولاً", variant: "destructive" }); return; }
    if (!video || !api) return;
    if (quality.score < 0.5) {
      toast({ title: "جودة الصورة منخفضة", description: quality.reasons.join("، "), variant: "destructive" });
      return;
    }
    if (livenessStage !== "passed") {
      toast({ title: "أكمل الكشف الحي أولاً", description: livenessLabel(livenessStage as any, blinkCount), variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const opts = new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.6 });
      const result = await api
        .detectSingleFace(video, opts)
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!result?.descriptor) {
        toast({ title: "فشل استخراج بصمة الوجه", description: "حاول مرة أخرى", variant: "destructive" });
        setBusy(false);
        return;
      }
      const descriptor: number[] = Array.from(result.descriptor as Float32Array);
      await faceApi.enroll({
        employeeId: Number(employeeId),
        descriptor,
        qualityScore: quality.score,
        pose,
        livenessPassed: true,
      });
      toast({ title: "تم تسجيل الوجه بنجاح ✓", description: "البصمة جاهزة للاستخدام" });
      livenessRef.current?.reset();
      setLivenessStage("wait_blink");
      setBlinkCount(0);
      qc.invalidateQueries({ queryKey: ["face-enrollments"] });
      refetch();
    } catch (e: any) {
      toast({ title: "فشل الحفظ", description: parseError(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const removeMut = useMutation({
    mutationFn: (id: number) => faceApi.deleteEnrollment(id),
    onSuccess: () => {
      toast({ title: "تم الحذف" });
      qc.invalidateQueries({ queryKey: ["face-enrollments"] });
      refetch();
    },
    onError: (e: any) => toast({ title: "فشل الحذف", description: parseError(e), variant: "destructive" }),
  });

  return (
    <div className="p-6 space-y-6" data-testid="page-face-enrollment">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ScanFace className="h-6 w-6 text-primary" />
            تسجيل بصمة الوجه
          </h1>
          <p className="text-sm text-muted-foreground mt-1">سجّل وجوه الموظفين لاستخدامها في الحضور الذكي</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Card className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium mb-1 block">الموظف</label>
              <Select value={employeeId} onValueChange={setEmployeeId}>
                <SelectTrigger data-testid="select-employee"><SelectValue placeholder="اختر موظفاً" /></SelectTrigger>
                <SelectContent>
                  {employees.map((e: any) => (
                    <SelectItem key={e.id} value={String(e.id)}>{e.code} — {e.nameAr}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">الزاوية</label>
              <Select value={pose} onValueChange={setPose}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="frontal">أمامي</SelectItem>
                  <SelectItem value="left">يسار</SelectItem>
                  <SelectItem value="right">يمين</SelectItem>
                  <SelectItem value="up">أعلى</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
            {modelLoading && (
              <div className="absolute inset-0 flex items-center justify-center text-white">
                <Loader2 className="h-8 w-8 animate-spin mr-2" /> جاري تحميل نماذج الذكاء الاصطناعي...
              </div>
            )}
            {modelError && (
              <div className="absolute inset-0 flex items-center justify-center text-rose-300 p-4 text-center text-sm">
                <AlertTriangle className="h-6 w-6 mr-2" /> {modelError}
              </div>
            )}
            <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">جودة الصورة</span>
              <Badge variant={quality.score > 0.7 ? "default" : quality.score > 0.4 ? "secondary" : "destructive"}>
                {(quality.score * 100).toFixed(0)}%
              </Badge>
            </div>
            <div className="h-2 bg-muted rounded overflow-hidden">
              <div className={`h-full transition-all ${quality.score > 0.7 ? "bg-emerald-500" : quality.score > 0.4 ? "bg-amber-500" : "bg-rose-500"}`}
                style={{ width: `${quality.score * 100}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">{quality.reasons.join("، ")}</p>
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4 text-primary" />
              <span>الكشف الحي:</span>
              <span className="font-medium">{livenessLabel(livenessStage as any, blinkCount)}</span>
            </div>
            {livenessStage === "passed" && <CheckCircle2 className="h-5 w-5 text-emerald-500" />}
          </div>

          <Button
            className="w-full"
            size="lg"
            onClick={captureAndEnroll}
            disabled={busy || modelLoading || !employeeId || quality.score < 0.5 || livenessStage !== "passed"}
            data-testid="btn-capture-enroll"
          >
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CameraIcon className="h-4 w-4 mr-2" />}
            التقاط وتسجيل البصمة
          </Button>
        </Card>

        <Card className="p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <ScanFace className="h-4 w-4" /> البصمات المسجلة {employeeId ? `(للموظف المحدد)` : `(جميع الموظفين)`}
          </h2>
          <div className="space-y-2 max-h-[600px] overflow-y-auto">
            {enrollments.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">لا توجد بصمات بعد</p>
            )}
            {enrollments.map((e) => (
              <div key={e.id} className="flex items-center justify-between p-3 rounded-lg border bg-card">
                <div className="text-sm">
                  <div className="font-medium">{e.employeeName ?? "—"} <span className="text-muted-foreground">({e.employeeCode})</span></div>
                  <div className="text-xs text-muted-foreground mt-0.5 flex gap-2 items-center">
                    <Badge variant="outline" className="text-xs">{e.pose}</Badge>
                    <span>جودة: {(Number(e.qualityScore) * 100).toFixed(0)}%</span>
                    {e.livenessPassed && <Badge variant="secondary" className="text-xs">حي ✓</Badge>}
                    {e.isPrimary && <Badge className="text-xs">رئيسي</Badge>}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeMut.mutate(e.id)}
                  data-testid={`btn-delete-enrollment-${e.id}`}
                >
                  <Trash2 className="h-4 w-4 text-rose-500" />
                </Button>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
