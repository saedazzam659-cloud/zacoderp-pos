import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, Camera, CheckCircle2, CircleHelp, Clock3, RefreshCw, ScanFace, ShieldCheck, UserRoundCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useGetSchoolStudentFaceEnrollmentStatus, useEnrollSchoolStudentFace, useRecognizeSchoolStudentFace, useRemoveSchoolStudentFaceEnrollment, getGetSchoolStudentFaceEnrollmentStatusQueryKey } from "@workspace/api-client-react";
import type { SchoolStudentFaceRecognitionResult } from "@workspace/api-client-react";
import { loadFaceApi } from "@/lib/faceapi/loader";
import { evaluateFaceQuality, type FaceQualityResult } from "@/lib/faceapi/quality";
import { createLivenessTracker, livenessLabel, type LivenessTracker } from "@/lib/faceapi/liveness";
import { parseError } from "@/lib/parseError";

export default function FaceAttendance() {
  const qc = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef<LivenessTracker | null>(null);
  const apiRef = useRef<any>(null);
  const loopRef = useRef<number | null>(null);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [selectedId, setSelectedId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("studentId") ?? "");
  const [quality, setQuality] = useState<FaceQualityResult>({ score: 0, faceCount: 0, reasons: ["بانتظار تشغيل الكاميرا"] });
  const [liveness, setLiveness] = useState("wait_blink");
  const [blinkCount, setBlinkCount] = useState(0);
  const [busyMode, setBusyMode] = useState<"enroll" | "recognize" | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SchoolStudentFaceRecognitionResult | null>(null);
  const status = useGetSchoolStudentFaceEnrollmentStatus();
  const enroll = useEnrollSchoolStudentFace();
  const remove = useRemoveSchoolStudentFaceEnrollment();
  const recognize = useRecognizeSchoolStudentFace();
  const selected = status.data?.find(row => String(row.studentId) === selectedId);

  useEffect(() => {
    let cancelled = false;
    loadFaceApi().then(api => {
      if (!cancelled) { apiRef.current = api; setModelLoading(false); }
    }).catch(e => {
      if (!cancelled) { setModelError(parseError(e)); setModelLoading(false); }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (modelLoading || modelError) return;
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("هذا المتصفح لا يدعم فتح الكاميرا.");
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        trackerRef.current = createLivenessTracker();
        scanLoop();
      } catch (e) { if (!cancelled) setCameraError(parseError(e)); }
    })();
    return () => {
      cancelled = true;
      if (loopRef.current !== null) cancelAnimationFrame(loopRef.current);
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    };
  // scanLoop is intentionally stable for this camera session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelLoading, modelError]);

  function scanLoop() {
    const tick = async () => {
      const video = videoRef.current, api = apiRef.current;
      if (video && api && video.readyState >= 2) {
        try {
          const detections = await api.detectAllFaces(video, new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })).withFaceLandmarks();
          const q = evaluateFaceQuality(detections, video.videoWidth, video.videoHeight);
          setQuality(q);
          const stage = trackerRef.current?.feed(detections[0] ?? null) ?? "wait_blink";
          setLiveness(stage);
          setBlinkCount(trackerRef.current?.blinkCount ?? 0);
          const canvas = canvasRef.current;
          if (canvas) {
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d");
            ctx?.clearRect(0, 0, canvas.width, canvas.height);
            if (q.box && ctx) {
              ctx.strokeStyle = q.score >= 0.55 ? "#4bd6b2" : "#f0b54a";
              ctx.lineWidth = 3; ctx.strokeRect(q.box.x, q.box.y, q.box.width, q.box.height);
            }
          }
        } catch { /* transient camera/model frame; keep the live preview running */ }
      }
      loopRef.current = requestAnimationFrame(tick);
    };
    loopRef.current = requestAnimationFrame(tick);
  }

  async function captureDescriptor() {
    const video = videoRef.current, api = apiRef.current;
    if (!video || !api || video.readyState < 2) throw new Error("الكاميرا غير جاهزة بعد.");
    if (quality.score < 0.55) throw new Error(quality.reasons.join("، ") || "جودة الصورة غير كافية.");
    if (liveness !== "passed") throw new Error("أكمل اختبار الحركة الحية أولاً: " + livenessLabel(liveness as any, blinkCount));
    const full = await api.detectSingleFace(video, new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.6 })).withFaceLandmarks().withFaceDescriptor();
    if (!full?.descriptor) throw new Error("لم نتمكن من استخراج بيانات الوجه. حاول مرة أخرى.");
    const descriptor: number[] = Array.from(full.descriptor as Float32Array);
    if (descriptor.length !== 128) throw new Error("تعذر قراءة إطار الوجه. أعد المحاولة.");
    return descriptor;
  }

  async function enrollSelected() {
    if (!selected) { setError("اختر طالباً أولاً."); return; }
    if (!selected.consentActive) { setError("لا يمكن التسجيل قبل وجود موافقة نشطة من ولي الأمر."); return; }
    setBusyMode("enroll"); setError(""); setResult(null);
    try {
      const descriptor = await captureDescriptor();
      await enroll.mutateAsync({ studentId: selected.studentId, data: { descriptor, qualityScore: quality.score, livenessPassed: true } });
      await qc.invalidateQueries({ queryKey: getGetSchoolStudentFaceEnrollmentStatusQueryKey() });
      trackerRef.current?.reset(); setLiveness("wait_blink"); setBlinkCount(0);
    } catch (e) { setError(parseError(e)); }
    finally { setBusyMode(null); }
  }
  async function removeEnrollment() {
    if (!selected || !window.confirm(`إزالة تسجيل الوجه للطالب ${selected.fullNameAr}؟`)) return;
    setError("");
    try {
      await remove.mutateAsync({ studentId: selected.studentId });
      await qc.invalidateQueries({ queryKey: getGetSchoolStudentFaceEnrollmentStatusQueryKey() });
    } catch (e) { setError(parseError(e)); }
  }
  async function recognizeArrival() {
    setBusyMode("recognize"); setError(""); setResult(null);
    try {
      const descriptor = await captureDescriptor();
      const match = await recognize.mutateAsync({ data: { descriptor, livenessPassed: true } });
      setResult(match);
      if (match.matched) {
        await qc.invalidateQueries({ queryKey: ["school"] });
        await qc.invalidateQueries({ queryKey: getGetSchoolStudentFaceEnrollmentStatusQueryKey() });
      }
      trackerRef.current?.reset(); setLiveness("wait_blink"); setBlinkCount(0);
    } catch (e) { setError(parseError(e)); }
    finally { setBusyMode(null); }
  }

  const enrolledCount = status.data?.filter(s => s.enrolled).length ?? 0;
  const consentCount = status.data?.filter(s => s.consentActive).length ?? 0;
  return <main dir="rtl" className="mx-auto min-h-[100dvh] max-w-7xl space-y-6 p-4 sm:p-6" data-testid="page-school-face-attendance">
    <header className="rounded-2xl border bg-[#eaf4f0] p-5 sm:p-7">
      <Link href="/school/students" className="inline-flex items-center gap-2 text-sm font-semibold text-teal-900/75 hover:text-teal-900"><ArrowRight className="h-4 w-4" />العودة إلى سجل الطلاب</Link>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-xs font-bold tracking-[.16em] text-teal-800">حضور الطلاب</p><h1 className="mt-2 text-3xl font-extrabold tracking-tight text-[#183b34]">الحضور بالتعرّف على الوجه</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-teal-950/65">تسجيل محلي عبر الكاميرا الحالية، مع فحص الجودة والحركة الحية قبل إرسال الطلب.</p></div>
        <Link href="/school/attendance" className="inline-flex h-9 items-center rounded-md border border-teal-900/20 bg-white/70 px-3 text-sm font-semibold text-teal-950 hover:bg-white">فتح التحضير اليدوي</Link>
      </div>
      <div className="mt-6 grid max-w-xl grid-cols-2 gap-3"><div className="rounded-xl border border-teal-900/10 bg-white/60 p-3"><p className="text-xs text-teal-950/60">موافقات نشطة</p><p className="mt-1 font-mono text-2xl font-bold text-teal-950">{status.isLoading ? "—" : consentCount}</p></div><div className="rounded-xl border border-teal-900/10 bg-white/60 p-3"><p className="text-xs text-teal-950/60">طلاب مسجلون</p><p className="mt-1 font-mono text-2xl font-bold text-teal-950">{status.isLoading ? "—" : enrolledCount}</p></div></div>
    </header>
    {status.isError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><span>تعذر تحميل حالات الموافقة والتسجيل: {parseError(status.error)}</span><Button size="sm" variant="outline" onClick={() => status.refetch()}>إعادة المحاولة</Button></div>}
    {status.isLoading ? <div className="grid gap-5 lg:grid-cols-[1.1fr_.9fr]"><div className="h-[440px] animate-pulse rounded-2xl bg-muted" /><div className="h-[440px] animate-pulse rounded-2xl bg-muted" /></div> : status.data && <div className="grid items-start gap-5 lg:grid-cols-[1.1fr_.9fr]">
      <section className="overflow-hidden rounded-2xl border bg-card">
        <div className="flex items-center justify-between border-b p-4"><div><h2 className="font-bold">محطة الكاميرا</h2><p className="mt-1 text-xs text-muted-foreground">مطلوب إضاءة واضحة، وجه واحد، ورمش مع حركة بسيطة للرأس.</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${liveness === "passed" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{liveness === "passed" ? "اجتاز فحص الحضور" : livenessLabel(liveness as any, blinkCount)}</span></div>
        <div className="relative aspect-video min-h-60 overflow-hidden bg-[#162d29]">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
          {(modelLoading || modelError || cameraError) && <div className="absolute inset-0 flex items-center justify-center bg-[#162d29]/90 p-6 text-center text-sm text-white">
            {modelLoading ? "جارٍ تجهيز نظام التعرّف..." : modelError ? `تعذر تحميل نظام التعرّف: ${modelError}` : <span>{cameraError}<br /><button className="mt-3 underline" onClick={() => window.location.reload()}>إعادة تهيئة الكاميرا</button></span>}
          </div>}
          {result && <div className={`absolute inset-x-0 bottom-0 flex items-center gap-3 p-4 text-white ${result.matched ? "bg-emerald-800/90" : "bg-rose-800/90"}`}>
            {result.matched ? <CheckCircle2 className="h-7 w-7 shrink-0" /> : <XCircle className="h-7 w-7 shrink-0" />}
            <div><p className="font-bold">{result.matched ? result.studentNameAr : "لم يتم التعرّف على الطالب"}</p><p className="text-sm opacity-90">{result.message}</p></div>
          </div>}
        </div>
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold">جودة الإطار <span dir="ltr" className="font-mono">{Math.round(quality.score * 100)}%</span></p><p className="mt-1 text-xs text-muted-foreground">{quality.reasons.join("، ")}</p></div><Badge variant={quality.score >= .55 ? "default" : "secondary"}>{quality.faceCount === 1 ? "وجه واحد" : quality.faceCount === 0 ? "لا يوجد وجه" : `${quality.faceCount} وجوه`}</Badge></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={`h-full transition-[width] ${quality.score >= .65 ? "bg-teal-600" : quality.score >= .45 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${Math.round(quality.score * 100)}%` }} /></div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button onClick={recognizeArrival} disabled={!!busyMode || modelLoading || !!modelError || !!cameraError || liveness !== "passed" || quality.score < .55} data-testid="button-recognize-student"><ScanFace className="ms-2 h-4 w-4" />{busyMode === "recognize" ? "جارٍ التعرّف..." : "التعرّف وتسجيل الحركة"}</Button>
            <Button variant="outline" onClick={() => { trackerRef.current?.reset(); setLiveness("wait_blink"); setBlinkCount(0); setResult(null); }} disabled={!!busyMode} data-testid="button-restart-liveness"><RefreshCw className="ms-2 h-4 w-4" />إعادة فحص الحركة الحية</Button>
          </div>
          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />لا يتم عرض أو حفظ بيانات الوصف الحيوي في هذه الشاشة. تستخدم الواجهة نتيجة الخادم فقط.</p>
        </div>
      </section>
      <section className="space-y-4">
        <article className="rounded-2xl border bg-card p-4 sm:p-5">
          <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 text-teal-800"><UserRoundCheck className="h-5 w-5" /></span><div><h2 className="font-bold">تسجيل وجه الطالب</h2><p className="mt-1 text-xs text-muted-foreground">يظهر في القائمة من لديه موافقة فعالة فقط.</p></div></div>
          <label className="mt-5 block space-y-2 text-sm font-semibold">الطالب
            <select value={selectedId} onChange={e => { setSelectedId(e.target.value); setError(""); }} className="h-10 w-full rounded-md border border-input bg-background px-3 font-normal" data-testid="select-face-student">
              <option value="">اختر طالباً لديه موافقة</option>
              {status.data.filter(s => s.consentActive).map(s => <option key={s.studentId} value={String(s.studentId)}>{s.fullNameAr} — {s.studentNumber}{s.enrolled ? " · مسجل" : ""}</option>)}
            </select>
          </label>
          {selected && <div className="mt-3 flex items-center justify-between rounded-lg bg-muted/40 p-3 text-sm"><span>{selected.enrolled ? "مسجل مسبقاً" : "غير مسجل"}{selected.enrolledAt ? ` · ${new Date(selected.enrolledAt).toLocaleDateString("ar-SA")}` : ""}</span><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${selected.consentActive ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{selected.consentActive ? "موافقة فعالة" : "لا توجد موافقة"}</span></div>}
          {selected && !selected.consentActive && <p className="mt-3 flex gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900"><AlertCircle className="h-4 w-4 shrink-0" />تسجيل الوجه غير متاح دون موافقة ولي الأمر.</p>}
          <Button className="mt-4 w-full" variant={selected?.enrolled ? "outline" : "default"} onClick={enrollSelected} disabled={!selected?.consentActive || !!busyMode || modelLoading || !!modelError || !!cameraError || quality.score < .55 || liveness !== "passed"} data-testid="button-enroll-student-face"><Camera className="ms-2 h-4 w-4" />{busyMode === "enroll" ? "جارٍ تسجيل الوجه..." : selected?.enrolled ? "تحديث تسجيل الوجه" : "تسجيل الوجه بعد التحقق"}</Button>
          {selected?.enrolled && <Button className="mt-2 w-full" variant="ghost" onClick={removeEnrollment} disabled={remove.isPending} data-testid="button-remove-student-face">{remove.isPending ? "جارٍ الإزالة..." : "إزالة تسجيل الوجه"}</Button>}
        </article>
        <article className="rounded-2xl border bg-card p-4 sm:p-5"><div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-teal-700" /><h2 className="font-bold">سجل التسجيل والموافقة</h2></div>
          <div className="mt-3 max-h-[360px] divide-y overflow-y-auto">{status.data.map(s => <div key={s.studentId} className="flex items-center justify-between gap-3 py-3 text-sm" data-testid={`status-face-student-${s.studentId}`}><div className="min-w-0"><p className="truncate font-medium">{s.fullNameAr}</p><p dir="ltr" className="mt-0.5 text-start font-mono text-xs text-muted-foreground">{s.studentNumber}</p></div><div className="flex shrink-0 flex-col items-end gap-1"><span className={`text-xs font-semibold ${s.consentActive ? "text-emerald-700" : "text-stone-500"}`}>{s.consentActive ? "موافقة نشطة" : "لا توجد موافقة"}</span><span className="text-xs text-muted-foreground">{s.enrolled ? "وجه مسجل" : "غير مسجل"}</span></div></div>)}</div>
          {!status.data.length && <div className="py-8 text-center text-sm text-muted-foreground"><CircleHelp className="mx-auto mb-2 h-5 w-5" />لا توجد سجلات طلاب متاحة.</div>}
        </article>
      </section>
    </div>}
    {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
    {result?.matched && <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-sm text-teal-950" role="status"><div className="flex flex-wrap items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4" />{result.eventType === "arrival" ? "تم تسجيل الوصول" : result.eventType === "departure" ? "تم تسجيل الانصراف" : "تم تسجيل الحركة"} · {result.attendanceStatus === "late" ? "متأخر" : result.attendanceStatus === "present" ? "حاضر" : ""}</div><p className="mt-1">{result.message}{result.occurredAt ? ` · ${new Date(result.occurredAt).toLocaleTimeString("ar-SA")}` : ""}</p></div>}
  </main>;
}
