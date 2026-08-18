import { pgTable, serial, integer, text, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────
// Agent Instances — «سيرفرات الوكلاء» (SuperAdmin-only platform module).
//
// Each reseller/agent runs a hosted instance on their OWN domain + server:
//   • their PostgreSQL database (external, connection string encrypted here)
//   • a frontend-only (or thin-shell) build that talks to the CENTRAL API
//   • a signed license bound to domain + installation id, with heartbeat
//   • login-page branding (system name + logo) per agent domain
//   • tamper/security events (fingerprint mismatch, unknown domain/IP, …)
//
// Secrets (SSH credentials, DB connection string) are stored AES-256-GCM
// encrypted (lib/encryption.ts) and are NEVER returned by the API — only
// set/replace + masked status flags.
// ─────────────────────────────────────────────────────────────────────────
export const agentInstancesTable = pgTable("agent_instances", {
  id:        serial("id").primaryKey(),
  name:      text("name").notNull(),                    // اسم الوكيل
  contactPhone: text("contact_phone"),
  contactEmail: text("contact_email"),

  // Normalised main host (lowercase, no scheme/port). Globally unique.
  domain:    text("domain").notNull(),
  // Optional extra domains/subdomains (normalised strings).
  extraDomains: jsonb("extra_domains"),

  // active | suspended
  status:    text("status").notNull().default("active"),
  // frontend_only (React build + central API)  |  full_shell (thin backend shell)
  mode:      text("mode").notNull().default("frontend_only"),

  // Identity & license
  installationId:   text("installation_id").notNull(),  // opaque unique id baked into the instance
  licenseKey:       text("license_key"),                // signed key (HMAC) — shown to SA, verified server-side
  licenseExpiresAt: timestamp("license_expires_at"),
  maxCompanies:     integer("max_companies"),

  // External PostgreSQL (agent's server) — encrypted, write-only via API.
  dbUrlEnc:      text("db_url_enc"),
  dbStatus:      text("db_status").notNull().default("not_configured"), // not_configured | ok | error | initialized
  dbLastCheckAt: timestamp("db_last_check_at"),
  dbLastError:   text("db_last_error"),
  // HMAC fingerprint planted into the agent DB at init; verified on every check.
  dbFingerprint: text("db_fingerprint"),

  // SSH access for future deploys — encrypted, write-only.
  sshHost:      text("ssh_host"),
  sshPort:      integer("ssh_port"),
  sshUser:      text("ssh_user"),
  sshSecretEnc: text("ssh_secret_enc"),                 // key or password
  sshStatus:    text("ssh_status").notNull().default("not_configured"),
  sshLastCheckAt: timestamp("ssh_last_check_at"),

  // Branding shown on the agent-domain login page.
  brandName:    text("brand_name"),
  brandLogoUrl: text("brand_logo_url"),
  brandColor:   text("brand_color"),

  // Runtime health
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  lastSeenIp:      text("last_seen_ip"),
  deployedVersion: text("deployed_version"),

  // SSH deploy engine (phase 3)
  deployStatus: text("deploy_status").notNull().default("never"), // never | deploying | ok | error
  deployLog:    text("deploy_log"),
  lastDeployAt: timestamp("last_deploy_at"),
  // Pinned SSH host-key fingerprint (TOFU on first deploy, verified after).
  sshHostKeyFp: text("ssh_host_key_fp"),
  // High-entropy rotatable per-agent proxy secret (encrypted at rest) — the
  // agent's reverse proxy presents it to prove the original request host.
  proxySecretEnc: text("proxy_secret_enc"),

  // بيانات دخول السوبر أدمن للنسخة الكاملة — تُزرع في قاعدة بيانات الوكيل
  // عند التسطيب (كلمة المرور مشفّرة AES-256-GCM، لا تُعاد أبدًا عبر API).
  saUsername:    text("sa_username"),
  saEmail:       text("sa_email"),          // يستقبل رمز OTP عند الدخول
  saPasswordEnc: text("sa_password_enc"),

  // علامة نبض السيرفر الرئيسي الحالي (تعدد السيرفرات): "" أو NULL = السيرفر
  // القديم بدون علامة؛ بعد «الترقية» تحمل علامة السيرفر المرقّى حتى يُنسب
  // نبضه لصف الوكيل نفسه (انظر agent_servers.hb_marker).
  primaryHbMarker: text("primary_hb_marker"),

  notes:     text("notes"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  domainUniq: uniqueIndex("agent_instances_domain_uniq").on(t.domain),
  installUniq: uniqueIndex("agent_instances_install_uniq").on(t.installationId),
}));

// Tamper / security events per agent instance (or unmatched attempts, agentId null).
export const agentSecurityEventsTable = pgTable("agent_security_events", {
  id:        serial("id").primaryKey(),
  agentId:   integer("agent_id").references(() => agentInstancesTable.id, { onDelete: "cascade" }),
  // e.g. db_fingerprint_mismatch | unknown_domain | license_expired | license_mismatch
  //      | register_blocked | heartbeat_suspended | unknown_installation
  eventType: text("event_type").notNull(),
  detail:    jsonb("detail"),
  host:      text("host"),
  ip:        text("ip"),
  resolved:  boolean("resolved").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  agentIdx: index("agent_security_events_agent_idx").on(t.agentId),
  typeIdx:  index("agent_security_events_type_idx").on(t.eventType),
}));

// ─────────────────────────────────────────────────────────────────────────
// Agent Servers — سيرفرات إضافية (احتياطية) لكل وكيل.
// السيرفر «الرئيسي» يبقى على أعمدة agent_instances نفسها (كل الكود القائم
// يعتمد عليها: النشر، فك الحظر، الإنقاذ…). هذا الجدول يحمل السيرفرات
// الاحتياطية فقط؛ «الترقية» تبادل الحقول بين الصفّين ذرّيًا.
// ─────────────────────────────────────────────────────────────────────────
export const agentServersTable = pgTable("agent_servers", {
  id:        serial("id").primaryKey(),
  agentId:   integer("agent_id").notNull().references(() => agentInstancesTable.id, { onDelete: "cascade" }),
  label:     text("label").notNull(),                   // اسم وصفي (مثال: سيرفر فرانكفورت الاحتياطي)
  role:      text("role").notNull().default("standby"), // standby فقط حاليًا

  // SSH — نفس نموذج أعمدة agent_instances (السر مشفّر write-only).
  sshHost:      text("ssh_host"),
  sshPort:      integer("ssh_port"),
  sshUser:      text("ssh_user"),
  sshSecretEnc: text("ssh_secret_enc"),
  sshStatus:    text("ssh_status").notNull().default("not_configured"),
  sshLastCheckAt: timestamp("ssh_last_check_at"),
  sshHostKeyFp: text("ssh_host_key_fp"),

  // نشر بوابة الدخول على هذا السيرفر.
  deployStatus: text("deploy_status").notNull().default("never"), // never | deploying | ok | error
  deployLog:    text("deploy_log"),
  lastDeployAt: timestamp("last_deploy_at"),

  // نبض هذا السيرفر تحديدًا — تميّزه علامة hb_marker المزروعة في config.json
  // أثناء التسطيب ("" = يلتقط النبضات القديمة بلا علامة بعد التبادل).
  hbMarker:        text("hb_marker").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  lastSeenIp:      text("last_seen_ip"),
  deployedVersion: text("deployed_version"),

  notes:     text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  agentIdx: index("agent_servers_agent_idx").on(t.agentId),
  markerIdx: index("agent_servers_marker_idx").on(t.agentId, t.hbMarker),
}));

export type AgentInstance = typeof agentInstancesTable.$inferSelect;
export type AgentSecurityEvent = typeof agentSecurityEventsTable.$inferSelect;
export type AgentServer = typeof agentServersTable.$inferSelect;
