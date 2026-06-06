// Client-side event bus bridging WebRTC call signaling from the single
// app-wide SSE stream (owned by AuthContext) to the CallProvider.
//
// AuthContext is the ONLY EventSource in the app; it forwards every `call_*`
// server event here via emitCall(). CallProvider subscribes via onCall().
// This avoids opening a second SSE connection just for calls.

export type CallMedia = "audio" | "video";

export type CallSignalKind = "offer" | "answer" | "ice" | "accept" | "reject" | "join";

export interface CallSignalPayload {
  kind: CallSignalKind;
  sdp?: string;
  candidate?: unknown;
  name?: string;
}

export interface CallInviteEvent {
  callId: string;
  conversationId: number;
  fromUserId: number;
  fromName: string;
  media: CallMedia;
}

export interface CallSignalEvent {
  callId: string;
  conversationId: number;
  fromUserId: number;
  signal: CallSignalPayload;
}

export interface CallEndEvent {
  callId: string;
  conversationId: number;
  fromUserId: number;
  reason?: string | null;
}

interface CallBusMap {
  invite: CallInviteEvent;
  signal: CallSignalEvent;
  end: CallEndEvent;
}

const target = new EventTarget();

export function emitCall<K extends keyof CallBusMap>(type: K, detail: CallBusMap[K]): void {
  target.dispatchEvent(new CustomEvent(`call:${type}`, { detail }));
}

export function onCall<K extends keyof CallBusMap>(
  type: K,
  handler: (detail: CallBusMap[K]) => void,
): () => void {
  const listener = (e: Event) => handler((e as CustomEvent).detail as CallBusMap[K]);
  target.addEventListener(`call:${type}`, listener);
  return () => target.removeEventListener(`call:${type}`, listener);
}
