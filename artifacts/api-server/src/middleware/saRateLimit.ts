import type { Request, Response, NextFunction } from "express";
import { clientIpFrom } from "../lib/deviceFingerprint.js";

interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
}, 60_000).unref?.();

export interface RateLimitOpts {
  windowMs: number;
  max: number;
  keyFn: (req: Request) => string;
  message?: string;
}

export function rateLimit(opts: RateLimitOpts) {
  return function rateLimitMw(req: Request, res: Response, next: NextFunction) {
    const key = opts.keyFn(req);
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next(); return;
    }
    b.count += 1;
    if (b.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: opts.message ?? "تجاوزت عدد المحاولات المسموح بها. حاول لاحقًا.",
        retryAfterSec: retryAfter,
      });
      return;
    }
    next();
  };
}

export const saLoginIpLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  keyFn: (req) => `sa_login_ip:${clientIpFrom(req) ?? "unknown"}`,
  message: "تم رصد محاولات دخول كثيرة من عنوانك. حاول بعد 15 دقيقة.",
});

export const saLoginUsernameLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 8,
  keyFn: (req) => `sa_login_user:${(req.body?.username ?? "").toString().toLowerCase().slice(0, 80)}`,
  message: "تم رصد محاولات دخول كثيرة لهذا المستخدم. حاول بعد 15 دقيقة.",
});

export const saOtpLimit = rateLimit({
  windowMs: 5 * 60_000,
  max: 10,
  keyFn: (req) => `sa_otp:${clientIpFrom(req) ?? "unknown"}`,
  message: "تم رصد محاولات OTP كثيرة. حاول بعد 5 دقائق.",
});

export const saRecoveryLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 5,
  keyFn: (req) => `sa_recovery:${clientIpFrom(req) ?? "unknown"}`,
  message: "تم رصد طلبات استرجاع كثيرة. حاول بعد ساعة.",
});

// Strict per-actor + per-IP limit on creating new SuperAdmins
export const saUserCreateLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 5,
  keyFn: (req) => {
    const actorId = (req as any).saCtx?.user?.id ?? "anon";
    return `sa_user_create:${actorId}:${clientIpFrom(req) ?? "unknown"}`;
  },
  message: "تم تجاوز الحد الأقصى لإنشاء حسابات السوبر أدمن. حاول بعد ساعة.",
});
