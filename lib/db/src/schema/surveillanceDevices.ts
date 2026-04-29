import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";

// ─── Surveillance devices (cameras / DVR / NVR) ──────────────────────
// Per-company catalog of CCTV equipment installed at the company's
// branches. The screen under /security/surveillance lets staff record
// what each device is, where it lives, how to reach it on the network,
// and the live-stream URL so other parts of the app (or external tools
// like VLC) can play the feed.
//
// `parentDeviceId` is a self-reference: an IP camera that hangs off a
// DVR/NVR can point its `parent_device_id` at the recorder so the UI
// can show a tree-like view ("DVR-0001 → 4 cameras"). Nullable for
// standalone devices.
//
// Passwords are stored as-is for now — these are LAN device credentials
// the customer types themselves; we surface them only to authenticated
// users who already pass the `security_events` permission gate. A future
// hardening pass can move them behind a vault helper without changing
// the table layout.
export const surveillanceDevicesTable = pgTable("surveillance_devices", {
  id:               serial("id").primaryKey(),
  companyId:        integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  branchId:         integer("branch_id").references(() => branchesTable.id, { onDelete: "set null" }),

  // Short auto-generated code unique within the company, e.g.
  // CAM-0001 / DVR-0001 / NVR-0001 — prefix follows deviceType.
  code:             text("code").notNull(),

  nameAr:           text("name_ar").notNull(),
  nameEn:           text("name_en"),

  // 'camera_ip' | 'camera_analog' | 'dvr' | 'nvr' | 'hybrid'
  deviceType:       text("device_type").notNull(),

  brand:            text("brand"),                  // Hikvision, Dahua, Axis, …
  model:            text("model"),
  serialNumber:     text("serial_number"),

  location:         text("location"),               // free-text location label

  ipAddress:        text("ip_address"),
  port:             integer("port"),

  username:         text("username"),
  password:         text("password"),

  // 'rtsp' | 'onvif' | 'http' | 'hls'
  streamProtocol:   text("stream_protocol"),
  streamUrl:        text("stream_url"),             // full URL — auto-built or pasted

  channelNumber:    integer("channel_number"),      // for a single camera on a DVR channel
  channelsCount:    integer("channels_count"),      // for a DVR/NVR — how many channels it supports

  parentDeviceId:   integer("parent_device_id"),    // self-FK; cameras can hang off a DVR/NVR

  status:           text("status").notNull().default("active"), // 'active' | 'inactive' | 'maintenance'

  notes:            text("notes"),

  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byCompany: index("surveillance_devices_company_idx").on(t.companyId),
  byBranch:  index("surveillance_devices_branch_idx").on(t.branchId),
  byParent:  index("surveillance_devices_parent_idx").on(t.parentDeviceId),
}));

export type SurveillanceDevice = typeof surveillanceDevicesTable.$inferSelect;
