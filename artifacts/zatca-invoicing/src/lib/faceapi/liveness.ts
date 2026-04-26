import type * as faceapi from "@vladmandic/face-api";

export type LivenessStage = "idle" | "wait_blink" | "wait_motion" | "passed" | "failed";

export interface LivenessTracker {
  stage: LivenessStage;
  baselineEAR?: number;
  blinkCount: number;
  positions: Array<{ cx: number; cy: number; t: number }>;
  startedAt: number;
  reset: () => void;
  feed: (det: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }> | null) => LivenessStage;
}

function eyeAspectRatio(eye: faceapi.Point[]): number {
  const dist = (a: faceapi.Point, b: faceapi.Point) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const v1 = dist(eye[1], eye[5]);
  const v2 = dist(eye[2], eye[4]);
  const h = dist(eye[0], eye[3]);
  return (v1 + v2) / (2 * h);
}

export function createLivenessTracker(): LivenessTracker {
  const t: LivenessTracker = {
    stage: "wait_blink",
    blinkCount: 0,
    positions: [],
    startedAt: Date.now(),
    reset() {
      t.stage = "wait_blink";
      t.blinkCount = 0;
      t.positions = [];
      t.baselineEAR = undefined;
      t.startedAt = Date.now();
    },
    feed(det) {
      if (Date.now() - t.startedAt > 15000 && t.stage !== "passed") {
        t.stage = "failed";
        return t.stage;
      }
      if (!det) return t.stage;
      const lm = det.landmarks;
      const leftEye = lm.getLeftEye();
      const rightEye = lm.getRightEye();
      const ear = (eyeAspectRatio(leftEye) + eyeAspectRatio(rightEye)) / 2;
      if (t.baselineEAR == null) t.baselineEAR = ear;
      else t.baselineEAR = t.baselineEAR * 0.9 + ear * 0.1;

      // blink detection
      if (t.stage === "wait_blink") {
        if (ear < 0.18) {
          t.blinkCount += 1;
          if (t.blinkCount >= 1) t.stage = "wait_motion";
        }
      }
      // motion detection — track nose tip
      const nose = lm.getNose()[3];
      const now = Date.now();
      t.positions.push({ cx: nose.x, cy: nose.y, t: now });
      t.positions = t.positions.filter((p) => now - p.t < 5000);
      if (t.stage === "wait_motion" && t.positions.length > 6) {
        const xs = t.positions.map((p) => p.cx);
        const ys = t.positions.map((p) => p.cy);
        const dx = Math.max(...xs) - Math.min(...xs);
        const dy = Math.max(...ys) - Math.min(...ys);
        if (dx > 8 || dy > 8) t.stage = "passed";
      }
      return t.stage;
    },
  };
  return t;
}

export function livenessLabel(stage: LivenessStage, blinks: number): string {
  switch (stage) {
    case "wait_blink": return blinks === 0 ? "ارمش بعينيك" : "تحرك قليلاً";
    case "wait_motion": return "حرّك رأسك يميناً ويساراً";
    case "passed": return "تم التحقق ✓";
    case "failed": return "فشل الكشف الحي — أعد المحاولة";
    default: return "...";
  }
}
