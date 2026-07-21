import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";

// ─── LiveKit helper — the ONE place tokens are minted ─────────────────────
// Grants are enforced server-side by LiveKit itself: a trainee token simply
// CANNOT publish, no client-side hack can bypass it.

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} غير مضبوط — لا يمكن تشغيل البث المباشر`);
  return v;
}

export function livekitConfigured(): boolean {
  return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

export function livekitWsUrl(): string {
  return env("LIVEKIT_URL");
}

function httpUrl(): string {
  return env("LIVEKIT_URL").replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

let roomService: RoomServiceClient | null = null;
export function getRoomService(): RoomServiceClient {
  if (!roomService) {
    roomService = new RoomServiceClient(httpUrl(), env("LIVEKIT_API_KEY"), env("LIVEKIT_API_SECRET"));
  }
  return roomService;
}

export type LivekitRole = "publisher" | "subscriber";

export async function mintToken(opts: {
  room: string;
  identity: string;
  name: string;
  role: LivekitRole;
  /** subscriber may still send data messages (chat / raise-hand) */
  canPublishData?: boolean;
  /** extra: allow mic only (raise-hand grant) */
  micOnly?: boolean;
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
}): Promise<string> {
  const at = new AccessToken(env("LIVEKIT_API_KEY"), env("LIVEKIT_API_SECRET"), {
    identity: opts.identity,
    name: opts.name,
    ttl: opts.ttlSeconds ?? 60 * 60 * 6,
    metadata: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
  });
  at.addGrant({
    roomJoin: true,
    room: opts.room,
    canPublish: opts.role === "publisher" || !!opts.micOnly,
    ...(opts.micOnly && opts.role !== "publisher"
      ? { canPublishSources: [TrackSource.MICROPHONE] }
      : {}),
    canSubscribe: true,
    canPublishData: opts.role === "publisher" ? true : (opts.canPublishData ?? true),
  });
  return await at.toJwt();
}

/** Grant / revoke a temporary mic to a raised-hand trainee (server-enforced). */
export async function setParticipantMic(room: string, identity: string, allow: boolean): Promise<void> {
  await getRoomService().updateParticipant(room, identity, undefined, {
    canPublish: allow,
    canPublishSources: allow ? [TrackSource.MICROPHONE] : [],
    canSubscribe: true,
    canPublishData: true,
  });
}

export async function deleteRoom(room: string): Promise<void> {
  try { await getRoomService().deleteRoom(room); } catch { /* room may not exist */ }
}
