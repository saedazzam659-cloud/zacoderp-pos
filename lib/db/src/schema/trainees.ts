import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// ─── Trainee registration requests (طلبات المتدربين) ─────────────────────
// Fully additive module: a visitor from any Arab country can request a
// TRAINING account (no company code). The request sits in `pending` until
// a SuperAdmin approves it from /admin/trainee-requests — choosing the
// training duration, the environment mode (shared training company vs a
// dedicated per-trainee company) and the allowed modules — which creates
// the actual `users` row (flagged is_trainee) and sends the activation
// email. Rejection keeps the row for audit with the reason.
export const traineeRequestsTable = pgTable("trainee_requests", {
  id: serial("id").primaryKey(),
  // ── Form fields ──
  fullName:        text("full_name").notNull(),
  email:           text("email").notNull(),          // doubles as the login username
  phone:           text("phone").notNull(),
  phoneCountryKey: text("phone_country_key").notNull(), // e.g. "+966"
  country:         text("country").notNull(),        // ISO-2 code (SA, EG, AE…)
  city:            text("city"),                     // optional
  companyName:     text("company_name"),             // optional
  jobTitle:        text("job_title").notNull(),
  industry:        text("industry").notNull(),
  experienceYears: integer("experience_years").notNull().default(0),
  passwordHash:    text("password_hash").notNull(),
  termsAccepted:   boolean("terms_accepted").notNull().default(false),
  // ── Workflow ──
  status:       text("status").notNull().default("pending"), // pending | approved | rejected
  decidedBy:    integer("decided_by").references(() => usersTable.id, { onDelete: "set null" }),
  decidedAt:    timestamp("decided_at"),
  rejectReason: text("reject_reason"),
  // ── Approval outcome ──
  durationDays:   integer("duration_days"),
  envMode:        text("env_mode"),                  // shared | separate
  companyId:      integer("company_id").references(() => companiesTable.id, { onDelete: "set null" }),
  allowedModules: jsonb("allowed_modules"),          // string[] of high-level module keys
  userId:         integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  activationEmailSentAt: timestamp("activation_email_sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type TraineeRequest = typeof traineeRequestsTable.$inferSelect;
