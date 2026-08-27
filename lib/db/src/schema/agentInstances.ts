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

  // Optional, fail-safe automatic setup for the MAIN domain only. Disabled by
  // default so every existing/new agent keeps the current manual DNS path
  // unless a central SuperAdmin explicitly opts in and confirms a preview.
  autoDomainSetup: boolean("auto_domain_setup").notNull().default(false),
  autoDomainProxyEnabled: boolean("auto_domain_proxy_enabled").notNull().default(false),
  // disabled | pending | checking | configuring | waiting_dns | verifying | ready | error
  autoDomainStatus: text("auto_domain_status").notNull().default("disabled"),
  autoDomainZoneName: text("auto_domain_zone_name"),
  // Provider identifiers are control-plane metadata, not credentials. They are
  // kept private by publicRow() and re-verified before every mutation.
  autoDomainZoneId: text("auto_domain_zone_id"),
  autoDomainRecordId: text("auto_domain_record_id"),
  autoDomainOriginIp: text("auto_domain_origin_ip"),
  autoDomainLastCheckAt: timestamp("auto_domain_last_check_at"),
  autoDomainLastSuccessAt: timestamp("auto_domain_last_success_at"),
  autoDomainLastError: text("auto_domain_last_error"),
  autoDomainLog: text("auto_domain_log"),
  autoDomainLeaseAt: timestamp("auto_domain_lease_at"),

  // active | suspended
  status:    text("status").notNull().default("active"),
  // frontend_only (React build + central API)  |  full_shell (thin backend shell)
  mode:      text("mode").notNull().default("frontend_only"),
  // central = install the currently published central release
  // external = install a durable, encrypted backend/frontend/database package
  // uploaded for this full-edition instance. Runtime mode deliberately remains
  // "full" so licensing, heartbeats, and manual central updates stay compatible.
  packageSource: text("package_source").notNull().default("central"),
  // Whether a full local edition exposes its own Super Admin control plane.
  // Default true preserves already-installed full agents; non-full modes are
  // normalized to false by the API because the entitlement is meaningless there.
  localSuperadminEnabled: boolean("local_superadmin_enabled").notNull().default(true),
  // Stable identifiers for the Super Admin screens visible in a full local
  // edition. NULL means the compatibility default: all known screens.
  localSuperadminScreens: jsonb("local_superadmin_screens"),
  // Private object paths + integrity metadata. publicRow() must strip paths and
  // signatures before returning an agent to the browser.
  externalPackageMeta: jsonb("external_package_meta"),

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
  // Fencing token for the one active deploy/provision/wipe/domain operation.
  deployLeaseId: text("deploy_lease_id"),
  // Internal operation phase. Provider mutation deadline is used only by the
  // deliberate crash-recovery path and is never returned to the browser.
  deployOperationPhase: text("deploy_operation_phase"),
  deployProviderMutationUntil: timestamp("deploy_provider_mutation_until"),
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

  // ── Invoice-acceleration control state ──────────────────────────────────
  // Central-only feature flag: routes eligible invoice operations through the
  // agent's own external DB pool for measurable latency improvement.
  // off (default) | trial | on
  invoiceAccelerationMode:      text("invoice_acceleration_mode").notNull().default("off"),
  invoiceTrialRemaining:        integer("invoice_trial_remaining"),
  invoiceAccelerationLastError: text("invoice_acceleration_last_error"),
  invoiceAccelerationReason:    text("invoice_acceleration_reason"),
  invoiceAccelerationUpdatedAt: timestamp("invoice_acceleration_updated_at"),
  // Monotonic central fence. Request-start readers take a row-share lock and
  // snapshot this generation; every control transition increments it.
  invoiceAccelerationGeneration: integer("invoice_acceleration_generation").notNull().default(0),
  // Frozen pre-trial latency snapshot. Central control-plane metadata only;
  // external-agent schema reconciliation explicitly excludes this field.
  invoiceAccelerationBaseline:  jsonb("invoice_acceleration_baseline"),

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

// One-time, short-lived hand-off capability issued by a target platform.
// Only a SHA-256 verifier of the capability secret is persisted.
export const agentPlatformLinkInvitesTable = pgTable("agent_platform_link_invites", {
  inviteId: text("invite_id").primaryKey(),
  targetPlatformId: text("target_platform_id").notNull(),
  targetOrigin: text("target_origin").notNull(),
  secretVerifier: text("secret_verifier").notNull(),
  // AES-GCM encrypted capability: enables one-file import while the verifier
  // remains a defence-in-depth check. Never selected for public responses.
  secretEnc: text("secret_enc").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  expiryIdx: index("agent_platform_link_invites_expiry_idx").on(t.expiresAt),
}));

// Portable controller metadata only. In particular this table must never gain
// an agent DB URL or a raw license key.
export const agentControllerLinksTable = pgTable("agent_controller_links", {
  id: serial("id").primaryKey(),
  linkId: text("link_id").notNull(),
  direction: text("direction").notNull(), // outbound | imported
  localAgentId: integer("local_agent_id").references(() => agentInstancesTable.id, { onDelete: "cascade" }),
  sourcePlatformId: text("source_platform_id").notNull(),
  sourceOrigin: text("source_origin").notNull(),
  targetPlatformId: text("target_platform_id").notNull(),
  targetOrigin: text("target_origin").notNull(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  extraDomains: jsonb("extra_domains"),
  installationId: text("installation_id").notNull(),
  dbFingerprint: text("db_fingerprint"),
  licenseVerifier: text("license_verifier").notNull(),
  controllerTokenVerifier: text("controller_token_verifier").notNull(),
  // Source-side only: encrypted so setup-kit/config resync can provision the
  // linked controller credential without retaining plaintext in the registry.
  controllerTokenEnc: text("controller_token_enc"),
  licenseExpiresAt: timestamp("license_expires_at"),
  maxCompanies: integer("max_companies"),
  agentVersion: text("agent_version"),
  status: text("status").notNull(),
  packageSource: text("package_source").notNull(),
  controllerEpoch: integer("controller_epoch").notNull().default(0),
  activeControllerId: text("active_controller_id").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  lastSeenIp: text("last_seen_ip"),
  deployedVersion: text("deployed_version"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  linkUniq: uniqueIndex("agent_controller_links_link_uniq").on(t.linkId, t.direction),
  installIdx: index("agent_controller_links_install_idx").on(t.installationId),
  domainIdx: index("agent_controller_links_domain_idx").on(t.domain),
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

// ─────────────────────────────────────────────────────────────────────────
// Invoice Performance Samples — central telemetry for acceleration.
//
// Written by the non-blocking recorder in agentInvoiceAcceleration.ts after
// each invoice create/update/post on an agent domain. Never written to the
// agent's own external DB. History is bounded (newest 200 rows per agent).
// ─────────────────────────────────────────────────────────────────────────
export const agentInvoiceSamplesTable = pgTable("agent_invoice_samples", {
  id:          serial("id").primaryKey(),
  agentId:     integer("agent_id").notNull().references(() => agentInstancesTable.id, { onDelete: "cascade" }),
  operation:   text("operation").notNull(),   // create | update | post
  accelerated: boolean("accelerated").notNull().default(false),
  status:      integer("status").notNull(),   // HTTP response status code
  totalMs:     integer("total_ms").notNull(),
  stages:      jsonb("stages"),               // { [stageName]: ms }
  lineCount:   integer("line_count"),
  poolStart:   jsonb("pool_start"),           // pool stats snapshot at request start
  poolEnd:     jsonb("pool_end"),             // pool stats snapshot at request finish
  createdAt:   timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  agentCreatedIdx: index("agent_invoice_samples_agent_created_idx").on(t.agentId, t.createdAt),
  agentOpIdx:      index("agent_invoice_samples_agent_op_idx").on(t.agentId, t.operation, t.accelerated),
  // status=0 rows are live trial reservations. This index keeps admission and
  // stale-claim recovery bounded without touching the agent business DB.
  agentClaimIdx:   index("agent_invoice_samples_agent_claim_idx").on(t.agentId, t.status, t.createdAt),
}));

export type AgentInstance = typeof agentInstancesTable.$inferSelect;
export type AgentSecurityEvent = typeof agentSecurityEventsTable.$inferSelect;
export type AgentPlatformLinkInvite = typeof agentPlatformLinkInvitesTable.$inferSelect;
export type AgentControllerLink = typeof agentControllerLinksTable.$inferSelect;
export type AgentServer = typeof agentServersTable.$inferSelect;
export type AgentInvoiceSample = typeof agentInvoiceSamplesTable.$inferSelect;
