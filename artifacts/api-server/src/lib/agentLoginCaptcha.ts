import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { centralDb, agentLoginCaptchaChallengesTable } from "@workspace/db";
import { eq, lt } from "drizzle-orm";
import { Resvg } from "@resvg/resvg-js";

const CAPTCHA_COOKIE = "zacod_agent_captcha";
const CAPTCHA_TTL_MS = 3 * 60_000;
const CAPTCHA_MAX_ATTEMPTS = 5;
const CAPTCHA_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CAPTCHA_LENGTH = 6;

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

function createSvg(code: string, colors: CaptchaColors): string {
  const text = safeColor(colors.captchaTextColor, "#0f766e");
  const background = safeColor(colors.captchaBackgroundColor, "#ffffff");
  const border = safeColor(colors.captchaBorderColor, "#cbd5e1");
  const noise = Array.from({ length: 9 }, () => {
    const x1 = randomInt(4, 146);
    const y1 = randomInt(4, 44);
    const x2 = randomInt(4, 146);
    const y2 = randomInt(4, 44);
    return `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${border}" stroke-width="${randomInt(1, 3)}" opacity=".55"/>`;
  }).join("");
  const dots = Array.from({ length: 22 }, () =>
    `<circle cx="${randomInt(4, 146)}" cy="${randomInt(4, 44)}" r="${randomInt(1, 3)}" fill="${border}" opacity=".55"/>`,
  ).join("");
  const characters = [...code].map((character, index) => {
    const x = 27 + index * 20;
    const y = randomInt(27, 37);
    const rotation = randomInt(-18, 19);
    return `<text x="${x}" y="${y}" transform="rotate(${rotation} ${x} ${y})" text-anchor="middle" font-family="monospace" font-size="25" font-weight="700" fill="${text}">${character}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="48" viewBox="0 0 150 48"><rect x="1" y="1" width="148" height="46" rx="7" fill="${background}" stroke="${border}" stroke-width="2"/>${noise}${dots}${characters}</svg>`;
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
  const svg = createSvg(code, colors);
  const image = new Resvg(svg, { fitTo: { mode: "original" } }).render().asPng();
  const hash = sessionHash(sessionId);
  const expiresAt = new Date(Date.now() + CAPTCHA_TTL_MS);
  return centralDb.transaction(async (tx) => {
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
    return { sessionId, image: `data:image/png;base64,${Buffer.from(image).toString("base64")}` };
  });
}

export async function consumeAgentLoginCaptcha(
  sessionId: string | null,
  host: string,
  answer: unknown,
): Promise<"valid" | "invalid" | "expired"> {
  if (!validSessionId(sessionId)) return "invalid";
  return centralDb.transaction(async (tx) => {
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
