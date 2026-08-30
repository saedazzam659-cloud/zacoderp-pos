import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { normalizeHttpsOrigin, platformId } from "./agentControllerLinks.js";

export type HandoffBlocker = { code: string; message: string };
export type HandoffTokenPayload = {
  v: 1; agentId: number; targetPlatformId: string; targetOrigin: string;
  runtimeMode: "preserve" | "target_release"; controllerEpoch: number; exp: number;
};

function handoffSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required");
  return secret;
}
function signature(encoded: string): Buffer {
  return createHmac("sha256", `zacod-controller-handoff-v1:${handoffSecret()}`)
    .update(encoded).digest();
}

/** A compact, server-only capability; callers must still fence on its epoch. */
export function mintHandoffToken(payload: Omit<HandoffTokenPayload, "v" | "exp">, now = Date.now(), ttlMs = 10 * 60_000): string {
  const body: HandoffTokenPayload = { ...payload, v: 1, exp: now + Math.min(Math.max(ttlMs, 1_000), 15 * 60_000) };
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${encoded}.${signature(encoded).toString("base64url")}`;
}
export function verifyHandoffToken(token: unknown, now = Date.now(), allowExpired = false): HandoffTokenPayload {
  if (typeof token !== "string") throw new Error("handoff_token_invalid");
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new Error("handoff_token_invalid");
  const actual = Buffer.from(parts[1], "base64url");
  const expected = signature(parts[0]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("handoff_token_invalid");
  let value: HandoffTokenPayload;
  try { value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { throw new Error("handoff_token_invalid"); }
  if (value?.v !== 1 || !Number.isSafeInteger(value.agentId) || value.agentId <= 0 ||
      !Number.isSafeInteger(value.controllerEpoch) || value.controllerEpoch < 0 ||
      !Number.isFinite(value.exp) || !["preserve", "target_release"].includes(value.runtimeMode)) throw new Error("handoff_token_invalid");
  if (!allowExpired && value.exp <= now) throw new Error("handoff_token_expired");
  return { ...value, targetPlatformId: platformId(value.targetPlatformId), targetOrigin: normalizeHttpsOrigin(value.targetOrigin) };
}

export function handoffEligibility(agent: any, runtimeMode: "preserve" | "target_release", now = Date.now()): HandoffBlocker[] {
  const blockers: HandoffBlocker[] = [];
  const add = (code: string, message: string) => blockers.push({ code, message });
  if (!agent) return [{ code: "AGENT_NOT_FOUND", message: "الوكيل غير موجود" }];
  if (agent.status !== "active") add("AGENT_INACTIVE", "الوكيل غير نشط");
  if (!agent.licenseKey || (agent.licenseExpiresAt && new Date(agent.licenseExpiresAt).getTime() <= now)) add("LICENSE_INVALID", "ترخيص الوكيل غير صالح أو منتهي");
  if (!agent.lastHeartbeatAt || now - new Date(agent.lastHeartbeatAt).getTime() >= 5 * 60_000) add("HEARTBEAT_STALE", "نبض الوكيل غير حديث");
  if (agent.dbStatus !== "initialized") add("DB_NOT_INITIALIZED", "قاعدة بيانات الوكيل غير مهيأة");
  if (!agent.sshHost || !agent.sshUser || !agent.sshSecretEnc || agent.sshStatus !== "ok" || !agent.sshHostKeyFp) add("SSH_NOT_READY", "اتصال SSH غير مهيأ أو غير مختبر أو غير مثبّت");
  if (agent.deployStatus === "deploying") add("DEPLOY_IN_PROGRESS", "يوجد نشر قيد التنفيذ");
  if (runtimeMode === "target_release" && (agent.mode !== "full" || agent.packageSource !== "central")) add("TARGET_RELEASE_INELIGIBLE", "إصدار المنصة الهدف يتطلب وكيلًا كاملاً بمصدر حزم مركزي");
  return blockers;
}

/** Deliberately excludes every non-public address class before a controller
 * token can be sent over the network. */
export function isPublicControllerAddress(ip: string): boolean {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicControllerAddress(mapped[1]);
  const kind = isIP(value);
  if (kind === 4) {
    const n = value.split(".").reduce((v, x) => (v * 256 + Number(x)) >>> 0, 0);
    const inCidr = (base: string, bits: number) => {
      const b = base.split(".").reduce((v, x) => (v * 256 + Number(x)) >>> 0, 0);
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === (b & mask);
    };
    const denied: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24],
      ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15],
      ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !denied.some(([base, bits]) => inCidr(base, bits));
  }
  if (kind !== 6) return false;
  // Expand only the prefix groups needed by the global-unicast policy.
  const [left, right = ""] = value.split("::");
  const l = left ? left.split(":") : [];
  const r = right ? right.split(":") : [];
  const groups = [...l, ...Array(Math.max(0, 8 - l.length - r.length)).fill("0"), ...r].map(x => parseInt(x || "0", 16));
  const [a, b, c, d] = groups;
  if (groups.slice(0, 5).every(x => x === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    return isPublicControllerAddress(v4);
  }
  if (a < 0x2000 || a > 0x3fff) return false; // only IPv6 global unicast 2000::/3
  if (a === 0x2001 && b <= 0x01ff) return false; // IETF special-use 2001::/23
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2002) return false; // 6to4
  if (a === 0x3fff && b < 0x1000) return false; // documentation 3fff::/20
  if (a === 0x2620 && b === 0x004f && c === 0x8000) return false; // AS112 direct delegation
  // NAT64 well-known and local-use prefixes.
  if (a === 0x0064 && b === 0xff9b && (c === 0 || c === 1)) return false;
  // Kept explicit even though outside 2000::/3, documenting discard-only.
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return false;
  return true;
}