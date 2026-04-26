import * as faceapi from "@vladmandic/face-api";

let _ready: Promise<typeof faceapi> | null = null;

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";

export function loadFaceApi(): Promise<typeof faceapi> {
  if (_ready) return _ready;
  _ready = (async () => {
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
