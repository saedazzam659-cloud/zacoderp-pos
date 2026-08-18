/**
 * FaceCapture — camera modal for the employee portal.
 *
 * Runs face-api (TinyFaceDetector + landmarks + recognition net) in the
 * browser, evaluates quality, performs blink liveness, then hands back:
 *   { descriptor: number[128], qualityScore, livenessPassed, imageB64, imageMime }
 * The selfie is sent as RAW base64 + mime (never a data: URL — the prod edge
 * WAF blocks request bodies containing `data:<mime>;base64,`).
 *
 * Used for BOTH first-time enrollment and per-punch live verification —
 * matching itself happens server-side (single source of truth).
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { X, Camera, RefreshCw } from "lucide-react";
import { loadFaceApi, type Faceapi } from "@/lib/faceapi/loader";
import { evaluateFaceQuality } from "@/lib/faceapi/quality";
import { createLivenessTracker, livenessLabel, type LivenessTracker } from "@/lib/faceapi/liveness";

export type FaceCaptureResult = {
  descriptor: number[];
  qualityScore: number;
  livenessPassed: boolean;
  imageB64: string;
  imageMime: string;
};

export default function FaceCapture({
  title,
  requireLiveness,
  minQuality,
  onDone,
  onClose,
}: {
  title: string;
  requireLiveness: boolean;
  minQuality: number;
  onDone: (r: FaceCaptureResult) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const livenessRef = useRef<LivenessTracker | null>(null);
  const doneRef = useRef(false);
  const [phase, setPhase] = useState<"loading" | "scanning" | "error">("loading");
  const [error, setError] = useState<string>("");
  const [hint, setHint] = useState<string>("جارٍ تجهيز الكاميرا…");

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let api: Faceapi | null = null;

    (async () => {
      try {
        const [f, stream] = await Promise.all([
          loadFaceApi(),
          navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false,
          }),
        ]);
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        api = f;
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        livenessRef.current = createLivenessTracker();
        setPhase("scanning");
        loop();
      } catch (e: any) {
        if (cancelled) return;
        setError(
          e?.name === "NotAllowedError"
            ? "يجب السماح باستخدام الكاميرا لإتمام التحقق"
            : (typeof e === "string" ? e : e?.message ?? "تعذّر تشغيل الكاميرا"),
        );
        setPhase("error");
      }
    })();

    function capture(v: HTMLVideoElement): { b64: string; mime: string } {
      const c = document.createElement("canvas");
      const scale = Math.min(1, 480 / v.videoWidth);
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", 0.8);
      return { b64: dataUrl.slice(dataUrl.indexOf(",") + 1), mime: "image/jpeg" };
    }

    async function loop() {
      const v = videoRef.current;
      if (!v || cancelled || !api || doneRef.current) return;
      try {
        const dets = await api
          .detectAllFaces(v, new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 }))
          .withFaceLandmarks();
        if (cancelled || doneRef.current) return;
        const q = evaluateFaceQuality(dets as any, v.videoWidth, v.videoHeight);
        const lv = livenessRef.current!;
        const stage = lv.feed(dets.length === 1 ? (dets[0] as any) : null);
        const livenessPassed = stage === "passed";

        if (stage === "failed") {
          // Auto-retry instead of dead-ending — reset the tracker and keep going.
          setHint("لم يتم رصد الرمشة — نعيد المحاولة، ارمش بعينيك");
          lv.reset();
        } else if (q.faceCount !== 1) setHint(q.reasons[0] ?? "ضع وجهك داخل الإطار");
        else if (q.score < minQuality) setHint(q.reasons[0] ?? "حسّن الإضاءة واقترب من الكاميرا");
        else if (requireLiveness && !livenessPassed) setHint(livenessLabel(stage, lv.blinkCount));
        else {
          // Ready — compute descriptor once, capture the selfie, finish.
          setHint("ثبّت وجهك… جاري الالتقاط");
          const full = await api
            .detectSingleFace(v, new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 }))
            .withFaceLandmarks()
            .withFaceDescriptor();
          if (cancelled || doneRef.current) return;
          if (full?.descriptor?.length === 128) {
            doneRef.current = true;
            const img = capture(v);
            onDone({
              descriptor: Array.from(full.descriptor),
              qualityScore: q.score,
              livenessPassed,
              imageB64: img.b64,
              imageMime: img.mime,
            });
            return;
          }
        }
      } catch {
        /* transient detection error — keep looping */
      }
      raf = requestAnimationFrame(() => { void loop(); });
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [requireLiveness, minQuality, onDone]);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-card rounded-3xl w-full max-w-md overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-bold flex items-center gap-2"><Camera className="w-5 h-5" /> {title}</h3>
          <Button size="icon" variant="ghost" onClick={onClose} data-testid="button-face-close">
            <X className="w-5 h-5" />
          </Button>
        </div>
        <div className="relative aspect-[4/3] bg-black">
          <video ref={videoRef} playsInline muted className="w-full h-full object-cover -scale-x-100" />
          {phase !== "error" && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-52 h-64 rounded-[50%] border-4 border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
          )}
          {phase === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-white text-sm">{error}</p>
              <Button variant="secondary" size="sm" onClick={onClose}>
                <RefreshCw className="w-4 h-4 ms-1" /> إغلاق
              </Button>
            </div>
          )}
        </div>
        <div className="p-4 text-center">
          <p className="text-sm font-medium" data-testid="text-face-hint">
            {phase === "loading" ? "جارٍ تجهيز الكاميرا…" : phase === "scanning" ? hint : ""}
          </p>
          {requireLiveness && phase === "scanning" && (
            <p className="text-xs text-muted-foreground mt-1">ارمش بعينيك للتأكد أنك أمام الكاميرا مباشرة</p>
          )}
        </div>
      </div>
    </div>
  );
}
