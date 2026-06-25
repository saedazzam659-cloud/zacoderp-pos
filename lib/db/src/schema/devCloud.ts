import {
  pgTable, serial, text, integer, timestamp, boolean, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

// ─────────────────────────────────────────────────────────────────────────
// Developer Cloud (Workspaces) — Phase 5 (additive only; SuperAdmin-only).
//
// A Replit-like cloud for partner teams: each partner COMPANY gets ONE isolated
// workspace that bundles a sandbox, a git repository, object storage, and a test
// environment — all provisioned on a MANAGED PaaS/sandbox provider (default
// "replit"), never raw infrastructure we run ourselves.
//
// Hard security boundary (enforced by the API, modelled here):
//   • No server credentials, SSH, RDP, or direct DB access are EVER stored or
//     exposed. We only keep opaque provider *references* (external IDs / URLs).
//   • The ONLY deployment path is the Publish engine: every deployment is a row
//     in `dev_deployments` with method fixed to 'publish_engine'.
//
// 100% additive: new tables only. Touches no existing company/user data.
// ─────────────────────────────────────────────────────────────────────────

// Managed providers we can target. The platform stores only opaque references
// (external workspace/sandbox IDs, git/storage/test URLs) — never credentials.
export const DEV_CLOUD_PROVIDERS = ["replit", "codesandbox", "gitpod", "github_codespaces"] as const;
export type DevCloudProvider = (typeof DEV_CLOUD_PROVIDERS)[number];

// Workspace lifecycle:
//   pending       — created in the registry, not yet provisioned on the provider
//   provisioning  — provider provisioning in progress
//   active        — fully provisioned (sandbox + git + storage + test env ready)
//   suspended     — temporarily disabled by the head office
//   archived      — decommissioned (references retained for audit)
//   error         — last provider operation failed (see lastError)
export const DEV_WORKSPACE_STATUSES = [
  "pending", "provisioning", "active", "suspended", "archived", "error",
] as const;
export type DevWorkspaceStatus = (typeof DEV_WORKSPACE_STATUSES)[number];

// Developer seat roles. Each maps to a least-privilege default permission set
// (see DEV_ROLE_DEFAULT_PERMISSIONS). PM/QA never get code/publish by default.
export const DEV_SEAT_ROLES = ["pm", "backend", "frontend", "mobile", "qa", "devops"] as const;
export type DevSeatRole = (typeof DEV_SEAT_ROLES)[number];

// Granular, least-privilege seat capabilities. Missing key ⇒ false (denied).
// NOTHING here grants SSH/RDP/DB/server access — those are not capabilities the
// platform offers at all. `trigger_publish` is the ONLY deployment lever.
export const DEV_SEAT_PERMISSION_KEYS = [
  "edit_code",       // edit files in the sandbox
  "run_sandbox",     // start/stop the sandbox & run the app
  "manage_git",      // push/pull/branch in the workspace git repo
  "manage_storage",  // read/write the workspace object storage
  "run_tests",       // run the test environment / test suites
  "trigger_publish", // request a deployment via the Publish engine (no other path)
  "manage_seats",    // invite / change / remove other seats
  "view_logs",       // read build/run/test logs
] as const;
export type DevSeatPermissionKey = (typeof DEV_SEAT_PERMISSION_KEYS)[number];
export type DevSeatPermissions = Partial<Record<DevSeatPermissionKey, boolean>>;

// Least-privilege defaults per role. Operators can still toggle per seat.
export const DEV_ROLE_DEFAULT_PERMISSIONS: Record<DevSeatRole, DevSeatPermissionKey[]> = {
  pm:       ["view_logs", "run_tests"],
  backend:  ["edit_code", "run_sandbox", "manage_git", "run_tests", "view_logs"],
  frontend: ["edit_code", "run_sandbox", "manage_git", "run_tests", "view_logs"],
  mobile:   ["edit_code", "run_sandbox", "manage_git", "run_tests", "view_logs"],
  qa:       ["run_sandbox", "run_tests", "view_logs"],
  devops:   ["run_sandbox", "manage_git", "manage_storage", "run_tests", "trigger_publish", "manage_seats", "view_logs"],
};

export const DEV_SEAT_STATUSES = ["active", "suspended"] as const;
export type DevSeatStatus = (typeof DEV_SEAT_STATUSES)[number];

// Deployment targets. The test env is internal to the workspace; production is
// the live publish target. BOTH go exclusively through the Publish engine.
export const DEV_DEPLOY_ENVIRONMENTS = ["test", "production"] as const;
export type DevDeployEnvironment = (typeof DEV_DEPLOY_ENVIRONMENTS)[number];

export const DEV_DEPLOY_STATUSES = ["queued", "building", "published", "failed"] as const;
export type DevDeployStatus = (typeof DEV_DEPLOY_STATUSES)[number];

// ─── One workspace per partner company ──────────────────────────────────────
export const devWorkspacesTable = pgTable("dev_workspaces", {
  id:                  serial("id").primaryKey(),
  companyId:           integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  provider:            text("provider").notNull().default("replit"),
  // Opaque provider references — NEVER credentials. Filled on provisioning.
  externalWorkspaceId: text("external_workspace_id"),
  sandboxId:           text("sandbox_id"),
  gitRepoUrl:          text("git_repo_url"),
  storageBucket:       text("storage_bucket"),
  testEnvUrl:          text("test_env_url"),
  region:              text("region"),
  tier:                text("tier").notNull().default("standard"),
  status:              text("status").notNull().default("pending"),
  provisionedAt:       timestamp("provisioned_at"),
  lastError:           text("last_error"),
  notes:               text("notes"),
  isActive:            boolean("is_active").notNull().default(true),
  createdAt:           timestamp("created_at").defaultNow().notNull(),
  updatedAt:           timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // Exactly one workspace per company.
  companyUniq: uniqueIndex("dev_workspaces_company_uniq").on(t.companyId),
  statusIdx:   index("dev_workspaces_status_idx").on(t.status),
}));

export type DevWorkspace       = typeof devWorkspacesTable.$inferSelect;
export type InsertDevWorkspace = typeof devWorkspacesTable.$inferInsert;

// ─── Developer seats (multi-role team per workspace) ────────────────────────
export const devWorkspaceSeatsTable = pgTable("dev_workspace_seats", {
  id:          serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => devWorkspacesTable.id, { onDelete: "cascade" }),
  name:        text("name").notNull(),
  email:       text("email").notNull(),
  role:        text("role").notNull().default("backend"),
  permissions: jsonb("permissions").$type<DevSeatPermissions>().notNull().default({}),
  status:      text("status").notNull().default("active"),
  invitedAt:   timestamp("invited_at").defaultNow().notNull(),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
  updatedAt:   timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // One seat per email within a workspace.
  emailUniq:   uniqueIndex("dev_workspace_seats_ws_email_uniq").on(t.workspaceId, t.email),
  workspaceIdx: index("dev_workspace_seats_workspace_idx").on(t.workspaceId),
}));

export type DevWorkspaceSeat       = typeof devWorkspaceSeatsTable.$inferSelect;
export type InsertDevWorkspaceSeat = typeof devWorkspaceSeatsTable.$inferInsert;

// ─── Deployments — the ONLY deployment path is the Publish engine ───────────
export const devDeploymentsTable = pgTable("dev_deployments", {
  id:             serial("id").primaryKey(),
  workspaceId:    integer("workspace_id").notNull().references(() => devWorkspacesTable.id, { onDelete: "cascade" }),
  environment:    text("environment").notNull().default("test"),
  ref:            text("ref"),
  status:         text("status").notNull().default("queued"),
  // Fixed to 'publish_engine'. No direct/SSH/manual deployment is possible.
  method:         text("method").notNull().default("publish_engine"),
  triggeredBySeatId: integer("triggered_by_seat_id").references(() => devWorkspaceSeatsTable.id, { onDelete: "set null" }),
  notes:          text("notes"),
  lastError:      text("last_error"),
  publishedAt:    timestamp("published_at"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index("dev_deployments_workspace_idx").on(t.workspaceId),
  statusIdx:    index("dev_deployments_status_idx").on(t.status),
}));

export type DevDeployment       = typeof devDeploymentsTable.$inferSelect;
export type InsertDevDeployment = typeof devDeploymentsTable.$inferInsert;
