import { promises as fs } from "node:fs";
import type { NextFunction, Request, Response } from "express";

export type LocalAgentRuntimeConfig = {
  mode?: string;
  domain?: string;
  installationId?: string;
  localSuperadminEnabled?: boolean;
  localSuperadminScreens?: string[];
};

export type LocalAgentRuntimeState = {
  isLocalAgent: boolean;
  localSuperadminEnabled: boolean;
  localSuperadminScreens: string[];
  config: LocalAgentRuntimeConfig | null;
};

export const LOCAL_SUPERADMIN_SCREEN_IDS = [
  "dashboard", "enter_company", "companies", "registration_requests", "trainee_requests",
  "licenses", "pos_devices", "offline_licenses", "download_codes", "domains",
  "agent_servers", "external_databases", "email_channels", "backups", "security_center",
  "superadmin_security", "reports", "subscriptions", "resellers", "partners", "dev_cloud",
  "dev_studio", "marketplace", "plans", "modules", "industries", "company_cloning",
  "menu_permissions", "windows_app_permissions", "gateway_clients", "orphan_stock",
  "database_stats", "ai_company_fix", "data_doctor", "support_inbox", "support_settings",
  "support_call", "seo_dashboard", "seo_ai_studio", "ai_controls", "audit_log",
  "pos_monitoring", "users", "invoice_field_policies",
] as const;

const LOCAL_SUPERADMIN_SCREEN_SET = new Set<string>(LOCAL_SUPERADMIN_SCREEN_IDS);

export function normalizeLocalSuperadminScreens(value: unknown): string[] {
  if (!Array.isArray(value)) return [...LOCAL_SUPERADMIN_SCREEN_IDS];
  const seen = new Set<string>();
  return value.filter((id): id is string =>
    typeof id === "string" && LOCAL_SUPERADMIN_SCREEN_SET.has(id) && !seen.has(id) && (seen.add(id), true),
  );
}

export function validateLocalSuperadminScreenSelection(enabled: boolean, screens: string[]): string | null {
  if (enabled && screens.length === 0) return "اختر شاشة واحدة على الأقل للوحة Super Admin";
  return null;
}

export function effectiveLocalSuperadminEnabled(mode: string, configured: boolean | null | undefined): boolean {
  return mode === "full" && configured !== false;
}

export function validateAgentLocalSuperadmin(input: {
  mode: string;
  enabled: boolean;
  username?: string | null;
  email?: string | null;
  password?: string | null;
  passwordAlreadySet?: boolean;
}): string | null {
  const username = (input.username ?? "").trim().toLowerCase();
  const email = (input.email ?? "").trim().toLowerCase();
  const password = input.password ?? "";

  if (!input.enabled) {
    if (username || email || password) {
      return "لا تُرسل بيانات سوبر أدمن عند اختيار نسخة بدون لوحة Super Admin";
    }
    return null;
  }
  if (input.mode !== "full") return "لوحة Super Admin المحلية متاحة للنسخة الكاملة فقط";
  if (!username) return "اسم مستخدم السوبر أدمن المحلي مطلوب";
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return "اسم مستخدم السوبر أدمن يجب أن يكون 3-32 حرفًا (أحرف إنجليزية صغيرة وأرقام و . _ -)";
  }
  if (!email) return "إيميل استقبال رمز OTP للسوبر أدمن المحلي مطلوب";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "إيميل السوبر أدمن (OTP) غير صالح";
  if (!password && !input.passwordAlreadySet) return "كلمة مرور السوبر أدمن المحلي مطلوبة";
  if (password) {
    if (password.length < 10) return "كلمة مرور السوبر أدمن يجب أن تكون 10 أحرف فأكثر";
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return "كلمة مرور السوبر أدمن يجب أن تحتوي على أحرف وأرقام";
    }
  }
  return null;
}

export function localAgentConfigPath(): string {
  return process.env.ZACOD_AGENT_CONFIG || "/opt/zacod/config.json";
}

/**
 * A missing config means this is the central platform. Once the local config
 * file exists, malformed/non-full content fails closed for Super Admin access.
 * Legacy full-agent configs without the new key remain enabled until rewritten.
 */
export async function readLocalAgentRuntimeState(): Promise<LocalAgentRuntimeState> {
  const filePath = localAgentConfigPath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return { isLocalAgent: false, localSuperadminEnabled: true, localSuperadminScreens: [...LOCAL_SUPERADMIN_SCREEN_IDS], config: null };
    }
    return { isLocalAgent: true, localSuperadminEnabled: false, localSuperadminScreens: [], config: null };
  }

  try {
    const parsed = JSON.parse(raw) as LocalAgentRuntimeConfig;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { isLocalAgent: true, localSuperadminEnabled: false, localSuperadminScreens: [], config: null };
    }
    return {
      isLocalAgent: true,
      localSuperadminEnabled: effectiveLocalSuperadminEnabled(parsed.mode ?? "", parsed.localSuperadminEnabled),
      localSuperadminScreens: normalizeLocalSuperadminScreens(parsed.localSuperadminScreens),
      config: parsed,
    };
  } catch {
    return { isLocalAgent: true, localSuperadminEnabled: false, localSuperadminScreens: [], config: null };
  }
}

export async function isLocalAgentSuperadminDisabled(): Promise<boolean> {
  const state = await readLocalAgentRuntimeState();
  return state.isLocalAgent && !state.localSuperadminEnabled;
}

export async function blockDisabledLocalSuperadmin(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (await isLocalAgentSuperadminDisabled()) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  next();
}