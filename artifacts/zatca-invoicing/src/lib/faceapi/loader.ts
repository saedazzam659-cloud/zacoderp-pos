import * as faceapi from "@vladmandic/face-api";

let _ready: Promise<typeof faceapi> | null = null;

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";

async function initBackend(): Promise<void> {
  const tf: any = (faceapi as any).tf;
  if (!tf) return;
  const candidates = ["webgl", "cpu"];
  for (const backend of candidates) {
    try {
      const ok = await tf.setBackend(backend);
      if (ok !== false) {
        await tf.ready();
        return;
      }
    } catch {
      // try the next backend
    }
  }
  await tf.ready();
}

export function loadFaceApi(): Promise<typeof faceapi> {
  if (_ready) return _ready;
  _ready = (async () => {
    await initBackend();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    return faceapi;
  })().catch((err) => {
    _ready = null;
    throw err;
  });
  return _ready;
}

export type Faceapi = typeof faceapi;
export { faceapi };
