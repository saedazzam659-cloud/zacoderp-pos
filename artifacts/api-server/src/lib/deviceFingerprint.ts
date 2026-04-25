import { createHash } from "crypto";
import type { Request } from "express";

export function clientIpFrom(req: Request): string | null {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim().slice(0, 64);
  if (Array.isArray(xf) && xf.length) return String(xf[0]).slice(0, 64);
  return (req.socket?.remoteAddress ?? null)?.slice(0, 64) ?? null;
}

function ipClass(ip: string | null): string {
  if (!ip) return "none";
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":");
  const parts = ip.split(".");
  if (parts.length === 4) return parts.slice(0, 2).join(".");
  return ip.slice(0, 16);
}

export function computeFingerprint(req: Request): string {
  const ua = req.headers["user-agent"]?.toString() ?? "";
  const acceptLang = req.headers["accept-language"]?.toString() ?? "";
  const acceptEnc = req.headers["accept-encoding"]?.toString() ?? "";
  const explicit = req.headers["x-device-id"]?.toString() ?? "";
  const ip = clientIpFrom(req);
  const seed = [explicit, ua, acceptLang, acceptEnc, ipClass(ip)].join("|");
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

export function describeDevice(req: Request): string {
  const ua = req.headers["user-agent"]?.toString() ?? "";
  const m = ua.match(/(Chrome|Firefox|Safari|Edge|Edg|Opera|OPR)\/[\d.]+/);
  const browser = m ? m[1].replace("OPR", "Opera").replace("Edg", "Edge") : "Browser";
  const os =
    /Windows NT/.test(ua) ? "Windows" :
    /Mac OS X/.test(ua) ? "macOS" :
    /Android/.test(ua) ? "Android" :
    /iPhone|iPad|iOS/.test(ua) ? "iOS" :
    /Linux/.test(ua) ? "Linux" : "Unknown OS";
  return `${browser} on ${os}`;
}
