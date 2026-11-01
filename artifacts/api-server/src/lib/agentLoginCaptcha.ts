import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { deflateSync } from "node:zlib";
import { db, agentLoginCaptchaChallengesTable } from "@workspace/db";
import { eq, lt } from "drizzle-orm";

const CAPTCHA_COOKIE = "zacod_agent_captcha";
const CAPTCHA_TTL_MS = 3 * 60_000;
const CAPTCHA_MAX_ATTEMPTS = 5;
const CAPTCHA_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CAPTCHA_LENGTH = 6;
const CAPTCHA_FONT: Record<string, string[]> = {
  A:["01110","10001","10001","11111","10001","10001","10001"], B:["11110","10001","10001","11110","10001","10001","11110"],
  C:["01111","10000","10000","10000","10000","10000","01111"], D:["11110","10001","10001","10001","10001","10001","11110"],
  E:["11111","10000","10000","11110","10000","10000","11111"], F:["11111","10000","10000","11110","10000","10000","10000"],
  G:["01111","10000","10000","10111","10001","10001","01111"], H:["10001","10001","10001","11111","10001","10001","10001"],
  J:["00111","00010","00010","00010","10010","10010","01100"], K:["10001","10010","10100","11000","10100","10010","10001"],
  L:["10000","10000","10000","10000","10000","10000","11111"], M:["10001","11011","10101","10101","10001","10001","10001"],
  N:["10001","11001","10101","10011","10001","10001","10001"], P:["11110","10001","10001","11110","10000","10000","10000"],
  Q:["01110","10001","10001","10001","10101","10010","01101"], R:["11110","10001","10001","11110","10100","10010","10001"],
  S:["01111","10000","10000","01110","00001","00001","11110"], T:["11111","00100","00100","00100","00100","00100","00100"],
  U:["10001","10001","10001","10001","10001","10001","01110"], V:["10001","10001","10001","10001","10001","01010","00100"],
  W:["10001","10001","10001","10101","10101","10101","01010"], X:["10001","10001","01010","00100","01010","10001","10001"],
  Y:["10001","10001","01010","00100","00100","00100","00100"], Z:["11111","00001","00010","00100","01000","10000","11111"],
  2:["01110","10001","00001","00010","00100","01000","11111"], 3:["11110","00001","00001","01110","00001","00001","11110"],
  4:["00010","00110","01010","10010","11111","00010","00010"], 5:["11111","10000","10000","11110","00001","00001","11110"],
  6:["01111","10000","10000","11110","10001","10001","01110"], 7:["11111","00001","00010","00100","01000","01000","01000"],
  8:["01110","10001","10001","01110","10001","10001","01110"], 9:["01110","10001","10001","01111","00001","00001","11110"],
};

type CaptchaColors = {
  captchaTextColor?: string | null;
  captchaBackgroundColor?: string | null;
  captchaBorderColor?: string | null;
};

function signingSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET must contain at least 16 characters for login CAPTCHA");
  }
  return secret;
}

function digest(value: string): string {
  return createHmac("sha256", signingSecret()).update(value).digest("hex");
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(value);
}

function safeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function randomCode(): string {
  return Array.from({ length: CAPTCHA_LENGTH }, () => CAPTCHA_ALPHABET[randomInt(CAPTCHA_ALPHABET.length)]).join("");
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type);
  const body = Buffer.concat([typeBuffer, data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, checksum]);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function renderAgentCaptchaPng(code: string, colors: CaptchaColors): Buffer {
  const width = 150, height = 48;
  const pixels = Buffer.alloc(width * height * 4);
  const rgb = (value: unknown, fallback: string): [number, number, number] => {
    const color = safeColor(value, fallback).slice(1);
    return [parseInt(color.slice(0, 2), 16), parseInt(color.slice(2, 4), 16), parseInt(color.slice(4, 6), 16)];
  };
  const bg = rgb(colors.captchaBackgroundColor, "#ffffff");
  const ink = rgb(colors.captchaTextColor, "#0f766e");
  const line = rgb(colors.captchaBorderColor, "#cbd5e1");
  const put = (x: number, y: number, color: number[]) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 4;
    pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, bg);
  const drawLine = (x0: number, y0: number, x1: number, y1: number, color: number[]) => {
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    while (true) {
      put(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * error;
      if (e2 >= dy) { error += dy; x0 += sx; }
      if (e2 <= dx) { error += dx; y0 += sy; }
    }
  };
  for (let x = 1; x < width - 1; x++) { put(x, 1, line); put(x, height - 2, line); }
  for (let y = 1; y < height - 1; y++) { put(1, y, line); put(width - 2, y, line); }
  for (let i = 0; i < 8; i++) drawLine(randomInt(3, 147), randomInt(3, 45), randomInt(3, 147), randomInt(3, 45), line);
  for (let i = 0; i < 28; i++) put(randomInt(3, 147), randomInt(3, 45), line);
  [...code].forEach((character, index) => {
    const glyph = CAPTCHA_FONT[character];
    const x0 = 12 + index * 22;
    const y0 = 12 + randomInt(0, 4);
    const shear = randomInt(-2, 3);
    for (let row = 0; row < glyph.length; row++) for (let col = 0; col < 5; col++) {
      if (glyph[row][col] !== "1") continue;
      const x = x0 + col * 3 + Math.round((row - 3) * shear / 6);
      const y = y0 + row * 3;
      for (let py = 0; py < 3; py++) for (let px = 0; px < 3; px++) put(x + px, y + py, ink);
    }
  });
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) pixels.copy(scanlines, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function sessionHash(sessionId: string): string {
  return digest(`captcha-session|${sessionId}`);
}

export function readAgentCaptchaSessionId(req: { cookies?: Record<string, unknown>; headers?: Record<string, unknown> }): string | null {
  const fromParser = req.cookies?.[CAPTCHA_COOKIE];
  if (validSessionId(fromParser)) return fromParser;
  const rawCookie = req.headers?.cookie;
  if (typeof rawCookie !== "string") return null;
  for (const part of rawCookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === CAPTCHA_COOKIE) {
      const candidate = value.join("=");
      return validSessionId(candidate) ? candidate : null;
    }
  }
  return null;
}

export function setAgentCaptchaSessionCookie(
  req: { secure?: boolean; headers?: Record<string, unknown> },
  res: { append: (name: string, value: string) => unknown },
  sessionId: string,
): void {
  const forwardedProto = req.headers?.["x-forwarded-proto"];
  const proxyProto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.toString().split(",")[0].trim();
  const secure = req.secure === true || proxyProto === "https";
  const attributes = [
    `${CAPTCHA_COOKIE}=${sessionId}`,
    "Path=/api",
    `Max-Age=${Math.floor(CAPTCHA_TTL_MS / 1000)}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ];
  res.append("Set-Cookie", attributes.join("; "));
}

export function issueAgentLoginCaptcha(
  host: string,
  colors: CaptchaColors,
  existingSessionId: string | null,
): Promise<{ sessionId: string; image: string }> {
  const sessionId = validSessionId(existingSessionId)
    ? existingSessionId
    : randomBytes(32).toString("base64url");
  const code = randomCode();
  const nonce = randomBytes(16).toString("hex");
  const image = renderAgentCaptchaPng(code, colors);
  const hash = sessionHash(sessionId);
  const expiresAt = new Date(Date.now() + CAPTCHA_TTL_MS);
  return db.transaction(async (tx) => {
    await tx.delete(agentLoginCaptchaChallengesTable).where(lt(agentLoginCaptchaChallengesTable.expiresAt, new Date()));
    await tx.insert(agentLoginCaptchaChallengesTable).values({
      sessionHash: hash,
      host,
      nonce,
      answerDigest: digest(`${sessionId}|${host}|${nonce}|${code}`),
      expiresAt,
      attempts: 0,
    }).onConflictDoUpdate({
      target: agentLoginCaptchaChallengesTable.sessionHash,
      set: { host, nonce, answerDigest: digest(`${sessionId}|${host}|${nonce}|${code}`), expiresAt, attempts: 0, createdAt: new Date() },
    });
    return { sessionId, image: `data:image/png;base64,${image.toString("base64")}` };
  });
}

export async function consumeAgentLoginCaptcha(
  sessionId: string | null,
  host: string,
  answer: unknown,
): Promise<"valid" | "invalid" | "expired"> {
  if (!validSessionId(sessionId)) return "invalid";
  return db.transaction(async (tx) => {
    const [challenge] = await tx.select().from(agentLoginCaptchaChallengesTable)
      .where(eq(agentLoginCaptchaChallengesTable.sessionHash, sessionHash(sessionId)))
      .for("update");
    if (!challenge || challenge.host !== host) return "invalid";
    if (challenge.expiresAt.getTime() <= Date.now()) {
      await tx.delete(agentLoginCaptchaChallengesTable).where(eq(agentLoginCaptchaChallengesTable.sessionHash, challenge.sessionHash));
      return "expired";
    }
    const supplied = typeof answer === "string" && /^[A-Za-z0-9]{6}$/.test(answer.trim())
      ? Buffer.from(digest(`${sessionId}|${host}|${challenge.nonce}|${answer.trim().toUpperCase()}`))
      : Buffer.alloc(0);
    const expected = Buffer.from(challenge.answerDigest);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      await tx.delete(agentLoginCaptchaChallengesTable).where(eq(agentLoginCaptchaChallengesTable.sessionHash, challenge.sessionHash));
      return "valid";
    }
    const attempts = challenge.attempts + 1;
    if (attempts >= CAPTCHA_MAX_ATTEMPTS) {
      await tx.delete(agentLoginCaptchaChallengesTable).where(eq(agentLoginCaptchaChallengesTable.sessionHash, challenge.sessionHash));
    } else {
      await tx.update(agentLoginCaptchaChallengesTable).set({ attempts })
        .where(eq(agentLoginCaptchaChallengesTable.sessionHash, challenge.sessionHash));
    }
    return "invalid";
  });
}
