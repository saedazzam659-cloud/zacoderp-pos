import { Router } from "express";
import { db } from "@workspace/db";
import { surveillanceDevicesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

// ─── Surveillance devices CRUD ───────────────────────────────────────
// Gated under the existing `security_events` permission so the same
// users who manage events / alert rules also manage the camera/DVR
// inventory. A future split into a dedicated `surveillance_devices`
// permission is a one-line change here when the customer asks for it.
const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("security_events"));
router.use(moduleAudit("security_events"));

const VALID_TYPES   = new Set(["camera_ip", "camera_analog", "dvr", "nvr", "hybrid"]);
const VALID_STATUS  = new Set(["active", "inactive", "maintenance"]);
const VALID_PROTOS  = new Set(["rtsp", "onvif", "http", "hls"]);

const toInt = (v: any) => (v === "" || v === null || v === undefined ? null : parseInt(v));
const toStr = (v: any) => (v === "" || v === null || v === undefined ? null : String(v));

// Code prefix per device type so the auto-generated codes stay
// scannable (CAM-0001 for cameras, DVR-0001 for DVRs, …).
function prefixFor(type: string): string {
  switch (type) {
    case "dvr":           return "DVR";
    case "nvr":           return "NVR";
    case "hybrid":        return "HYB";
    case "camera_analog": return "CAM";
    case "camera_ip":
    default:              return "CAM";
  }
}

// Generate the next "<PREFIX>-NNNN" code for a given (company, type)
// pair. Pads to four digits and never reuses a number even if older
// rows were deleted in between (max+1 strategy).
async function nextDeviceCode(cid: number, type: string): Promise<string> {
  const prefix = prefixFor(type);
  const rows = await db
    .select({ code: surveillanceDevicesTable.code })
    .from(surveillanceDevicesTable)
    .where(eq(surveillanceDevicesTable.companyId, cid));
  const re = new RegExp(`^${prefix}-(\\d+)$`, "i");
  let max = 0;
  for (const r of rows) {
    const m = re.exec(r.code ?? "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

// GET /api/surveillance-devices?companyId=X[&branchId=Y][&type=Z]
router.get("/", async (req, res) => {
  const cid = resolveCompanyId(req, req.query.companyId ? parseInt(req.query.companyId as string) : undefined);
  if (!cid) { res.json([]); return; }

  const conditions = [eq(surveillanceDevicesTable.companyId, cid)];
  if (req.query.branchId) conditions.push(eq(surveillanceDevicesTable.branchId, parseInt(req.query.branchId as string)));
  if (req.query.type)     conditions.push(eq(surveillanceDevicesTable.deviceType, String(req.query.type)));

  const rows = await db
    .select()
    .from(surveillanceDevicesTable)
    .where(and(...conditions))
    .orderBy(surveillanceDevicesTable.code);
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [row] = await db.select().from(surveillanceDevicesTable).where(eq(surveillanceDevicesTable.id, id));
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(row);
});

router.post("/", async (req, res) => {
  const d = req.body ?? {};
  const cid = resolveCompanyId(req, d.companyId ? parseInt(d.companyId) : undefined);
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  if (!d.nameAr || !String(d.nameAr).trim()) {
    res.status(400).json({ error: "الاسم بالعربية مطلوب" }); return;
  }
  const deviceType = String(d.deviceType ?? "camera_ip");
  if (!VALID_TYPES.has(deviceType)) {
    res.status(400).json({ error: "نوع الجهاز غير صحيح" }); return;
  }
  const status = d.status ? String(d.status) : "active";
  if (!VALID_STATUS.has(status)) {
    res.status(400).json({ error: "الحالة غير صحيحة" }); return;
  }
  const streamProtocol = d.streamProtocol ? String(d.streamProtocol) : null;
  if (streamProtocol && !VALID_PROTOS.has(streamProtocol)) {
    res.status(400).json({ error: "بروتوكول البث غير صحيح" }); return;
  }

  // Code: user-supplied (after uniqueness check) or auto-generated.
  const givenCode = d.code && String(d.code).trim() ? String(d.code).trim() : null;
  const code = givenCode ?? await nextDeviceCode(cid, deviceType);
  const dupes = await db.select({ id: surveillanceDevicesTable.id })
    .from(surveillanceDevicesTable)
    .where(and(eq(surveillanceDevicesTable.companyId, cid), eq(surveillanceDevicesTable.code, code)));
  if (dupes.length > 0) {
    res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لجهاز آخر` }); return;
  }

  const [row] = await db.insert(surveillanceDevicesTable).values({
    companyId:      cid,
    branchId:       toInt(d.branchId),
    code,
    nameAr:         String(d.nameAr).trim(),
    nameEn:         toStr(d.nameEn),
    deviceType,
    brand:          toStr(d.brand),
    model:          toStr(d.model),
    serialNumber:   toStr(d.serialNumber),
    location:       toStr(d.location),
    ipAddress:      toStr(d.ipAddress),
    port:           toInt(d.port),
    username:       toStr(d.username),
    password:       toStr(d.password),
    streamProtocol,
    streamUrl:      toStr(d.streamUrl),
    channelNumber:  toInt(d.channelNumber),
    channelsCount:  toInt(d.channelsCount),
    parentDeviceId: toInt(d.parentDeviceId),
    status,
    notes:          toStr(d.notes),
  }).returning();
  res.status(201).json(row);
});

router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const d = req.body ?? {};
  const [current] = await db.select().from(surveillanceDevicesTable).where(eq(surveillanceDevicesTable.id, id));
  if (!current) { res.status(404).json({ error: "غير موجود" }); return; }

  const deviceType = d.deviceType ? String(d.deviceType) : current.deviceType;
  if (!VALID_TYPES.has(deviceType)) {
    res.status(400).json({ error: "نوع الجهاز غير صحيح" }); return;
  }
  const status = d.status ? String(d.status) : current.status;
  if (!VALID_STATUS.has(status)) {
    res.status(400).json({ error: "الحالة غير صحيحة" }); return;
  }
  const streamProtocol = d.streamProtocol === undefined ? current.streamProtocol : (d.streamProtocol ? String(d.streamProtocol) : null);
  if (streamProtocol && !VALID_PROTOS.has(streamProtocol)) {
    res.status(400).json({ error: "بروتوكول البث غير صحيح" }); return;
  }

  // If the user changes the code, re-check uniqueness.
  let code = current.code;
  if (d.code !== undefined && String(d.code).trim() && String(d.code).trim() !== current.code) {
    code = String(d.code).trim();
    const dupes = await db.select({ id: surveillanceDevicesTable.id })
      .from(surveillanceDevicesTable)
      .where(and(eq(surveillanceDevicesTable.companyId, current.companyId), eq(surveillanceDevicesTable.code, code)));
    if (dupes.some(r => r.id !== id)) {
      res.status(409).json({ error: `الكود "${code}" مستخدم بالفعل لجهاز آخر` }); return;
    }
  }

  const [row] = await db.update(surveillanceDevicesTable).set({
    branchId:       d.branchId       === undefined ? current.branchId       : toInt(d.branchId),
    code,
    nameAr:         d.nameAr ? String(d.nameAr).trim() : current.nameAr,
    nameEn:         d.nameEn         === undefined ? current.nameEn         : toStr(d.nameEn),
    deviceType,
    brand:          d.brand          === undefined ? current.brand          : toStr(d.brand),
    model:          d.model          === undefined ? current.model          : toStr(d.model),
    serialNumber:   d.serialNumber   === undefined ? current.serialNumber   : toStr(d.serialNumber),
    location:       d.location       === undefined ? current.location       : toStr(d.location),
    ipAddress:      d.ipAddress      === undefined ? current.ipAddress      : toStr(d.ipAddress),
    port:           d.port           === undefined ? current.port           : toInt(d.port),
    username:       d.username       === undefined ? current.username       : toStr(d.username),
    password:       d.password       === undefined ? current.password       : toStr(d.password),
    streamProtocol,
    streamUrl:      d.streamUrl      === undefined ? current.streamUrl      : toStr(d.streamUrl),
    channelNumber:  d.channelNumber  === undefined ? current.channelNumber  : toInt(d.channelNumber),
    channelsCount:  d.channelsCount  === undefined ? current.channelsCount  : toInt(d.channelsCount),
    parentDeviceId: d.parentDeviceId === undefined ? current.parentDeviceId : toInt(d.parentDeviceId),
    status,
    notes:          d.notes          === undefined ? current.notes          : toStr(d.notes),
    updatedAt:      new Date(),
  }).where(eq(surveillanceDevicesTable.id, id)).returning();
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [row] = await db.delete(surveillanceDevicesTable).where(eq(surveillanceDevicesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json({ ok: true });
});

export default router;
