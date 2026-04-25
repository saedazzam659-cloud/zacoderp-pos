export function turnstileEnabled(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

export interface TurnstileResult {
  ok: boolean;
  reason?: string;
}

export async function verifyTurnstile(token: string | undefined | null, ip: string | null): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, reason: "turnstile_disabled" };
  if (!token) return { ok: false, reason: "missing_token" };
  try {
    const params = new URLSearchParams();
    params.set("secret", secret);
    params.set("response", token);
    if (ip) params.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: params,
    });
    const j = (await r.json()) as { success?: boolean; "error-codes"?: string[] };
    if (j.success) return { ok: true };
    return { ok: false, reason: (j["error-codes"] ?? ["verification_failed"]).join(",") };
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? "verify_error" };
  }
}
