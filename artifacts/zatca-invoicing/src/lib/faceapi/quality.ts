import type * as faceapi from "@vladmandic/face-api";

export interface FaceQualityResult {
  score: number;
  faceCount: number;
  reasons: string[];
  box?: { x: number; y: number; width: number; height: number };
}

export function evaluateFaceQuality(
  detections: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>[],
  videoWidth: number,
  videoHeight: number,
): FaceQualityResult {
  const reasons: string[] = [];
  if (detections.length === 0) {
    return { score: 0, faceCount: 0, reasons: ["لم يتم اكتشاف وجه"] };
  }
  if (detections.length > 1) {
    return { score: 0.1, faceCount: detections.length, reasons: ["أكثر من وجه واحد في الصورة"] };
  }
  const det = detections[0].detection;
  const box = det.box;
  const frameArea = videoWidth * videoHeight;
  const faceArea = box.width * box.height;
  const ratio = faceArea / frameArea;

  let score = 1;
  if (ratio < 0.05) { score -= 0.4; reasons.push("الوجه صغير جداً — اقترب من الكاميرا"); }
  else if (ratio < 0.1) { score -= 0.2; reasons.push("الوجه بعيد قليلاً"); }
  if (ratio > 0.6) { score -= 0.2; reasons.push("الوجه كبير جداً — ابتعد قليلاً"); }

  // Center check
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const offX = Math.abs(cx - videoWidth / 2) / videoWidth;
  const offY = Math.abs(cy - videoHeight / 2) / videoHeight;
  if (offX > 0.2 || offY > 0.2) { score -= 0.15; reasons.push("ضع وجهك في وسط الإطار"); }

  // Detection score boost
  score = score * 0.6 + (det.score ?? 0) * 0.4;
  score = Math.max(0, Math.min(1, score));
  if (reasons.length === 0) reasons.push("جودة جيدة ✓");
  return { score, faceCount: 1, reasons, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
}
