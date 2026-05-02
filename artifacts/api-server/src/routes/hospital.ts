// ─────────────────────────────────────────────────────────────────────────
// Hospital / Clinic ERP — multi-company facility management.
// Hospitals, doctors, patients, appointments / encounters, invoices,
// invoice items, insurance claims (NPHIES blueprint).
// Multi-tenant (companyId scoped). RBAC gate: module key "hospital".
// SuperAdmin bypasses.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  hospitalsTable,
  hospitalDoctorsTable,
  hospitalPatientsTable,
  hospitalAppointmentsTable,
  hospitalInvoicesTable,
  hospitalInvoiceItemsTable,
  hospitalClaimsTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("hospital"));
router.use(moduleAudit("hospital"));
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function requireCid(req: any, res: any): number | null {
  const raw = req.query.companyId ? Number(req.query.companyId) : undefined;
  const cid = resolveCompanyId(req, raw);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

async function ownsRow(table: any, id: number, cid: number): Promise<boolean> {
  if (!Number.isFinite(id) || id <= 0) return false;
  const [r] = await db.select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.companyId, cid)));
  return !!r;
}
async function assertOwn(
  res: any, table: any, id: number, cid: number, label: string,
): Promise<boolean> {
  const ok = await ownsRow(table, id, cid);
  if (!ok) { res.status(404).json({ error: `${label} غير موجود` }); return false; }
  return true;
}

async function nextCode(
  cid: number, table: any, prefix: string, field: "code" | "docNumber",
): Promise<string> {
  const col = field === "docNumber" ? table.docNumber : table.code;
  const rows = await db.select({ v: col }).from(table).where(eq(table.companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(String(r.v).trim());
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > max) max = n; }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

const HOSPITAL_TYPES        = ["hospital","clinic","dispensary","medical_center","polyclinic"] as const;
const HOSPITAL_STATUSES     = ["active","inactive","under_renovation"] as const;
const ID_TYPES              = ["national_id","iqama","passport","gcc_id","other"] as const;
const GENDERS               = ["male","female"] as const;
const APPT_STATUSES         = ["scheduled","checked_in","in_progress","completed","cancelled","no_show"] as const;
const VISIT_TYPES           = ["consultation","follow_up","emergency","procedure","lab","imaging"] as const;
const INV_STATUSES          = ["draft","issued","partial","paid","cancelled"] as const;
const CLAIM_STATUSES        = ["draft","queued","sent","approved","rejected","pending_info","cancelled"] as const;

// ════════════════════════════════════════════════════════════════════════
// HOSPITALS / FACILITIES
// ════════════════════════════════════════════════════════════════════════
router.get("/hospitals", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(hospitalsTable)
      .where(eq(hospitalsTable.companyId, cid))
      .orderBy(desc(hospitalsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/hospitals", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const nameAr = String(b.nameAr ?? "").trim();
    if (!nameAr) { res.status(400).json({ error: "اسم المنشأة مطلوب" }); return; }
    const code = String(b.code ?? "").trim() || await nextCode(cid, hospitalsTable, "HOS", "code");
    const type = (HOSPITAL_TYPES as readonly string[]).includes(b.type) ? b.type : "clinic";
    const status = (HOSPITAL_STATUSES as readonly string[]).includes(b.status) ? b.status : "active";
    const [row] = await db.insert(hospitalsTable).values({
      companyId: cid,
      branchId: b.branchId ? Number(b.branchId) : null,
      code, nameAr,
      nameEn: b.nameEn || null,
      type: type as any,
      crNumber: b.crNumber || null,
      licenseNo: b.licenseNo || null,
      beds: Number(b.beds || 0),
      address: b.address || null,
      city: b.city || null,
      contactPhone: b.contactPhone || null,
      contactEmail: b.contactEmail || null,
      status: status as any,
      notes: b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/hospitals/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalsTable, id, cid, "المنشأة")) return;
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    for (const k of ["code","nameAr","nameEn","crNumber","licenseNo","address","city","contactPhone","contactEmail","notes"]) {
      if (b[k] !== undefined) patch[k] = b[k] || null;
    }
    if (b.beds !== undefined) patch.beds = Number(b.beds || 0);
    if (b.branchId !== undefined) patch.branchId = b.branchId ? Number(b.branchId) : null;
    if ((HOSPITAL_TYPES as readonly string[]).includes(b.type)) patch.type = b.type;
    if ((HOSPITAL_STATUSES as readonly string[]).includes(b.status)) patch.status = b.status;
    const [row] = await db.update(hospitalsTable).set(patch)
      .where(and(eq(hospitalsTable.id, id), eq(hospitalsTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/hospitals/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalsTable, id, cid, "المنشأة")) return;
    await db.delete(hospitalsTable).where(and(eq(hospitalsTable.id, id), eq(hospitalsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// DOCTORS
// ════════════════════════════════════════════════════════════════════════
router.get("/doctors", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(hospitalDoctorsTable)
      .where(eq(hospitalDoctorsTable.companyId, cid))
      .orderBy(desc(hospitalDoctorsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/doctors", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const nameAr = String(b.nameAr ?? "").trim();
    if (!nameAr) { res.status(400).json({ error: "اسم الطبيب مطلوب" }); return; }
    if (b.hospitalId) {
      if (!await ownsRow(hospitalsTable, Number(b.hospitalId), cid)) {
        res.status(400).json({ error: "المنشأة غير موجودة" }); return;
      }
    }
    const code = String(b.code ?? "").trim() || await nextCode(cid, hospitalDoctorsTable, "DR", "code");
    const [row] = await db.insert(hospitalDoctorsTable).values({
      companyId: cid,
      hospitalId: b.hospitalId ? Number(b.hospitalId) : null,
      code, nameAr,
      nameEn: b.nameEn || null,
      specialty: b.specialty || null,
      licenseNo: b.licenseNo || null,
      phone: b.phone || null,
      email: b.email || null,
      consultationFee: String(b.consultationFee ?? "0"),
      isActive: b.isActive !== false,
      notes: b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/doctors/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalDoctorsTable, id, cid, "الطبيب")) return;
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    for (const k of ["code","nameAr","nameEn","specialty","licenseNo","phone","email","notes"]) {
      if (b[k] !== undefined) patch[k] = b[k] || null;
    }
    if (b.consultationFee !== undefined) patch.consultationFee = String(b.consultationFee || "0");
    if (b.isActive !== undefined) patch.isActive = !!b.isActive;
    if (b.hospitalId !== undefined) {
      if (b.hospitalId && !await ownsRow(hospitalsTable, Number(b.hospitalId), cid)) {
        res.status(400).json({ error: "المنشأة غير موجودة" }); return;
      }
      patch.hospitalId = b.hospitalId ? Number(b.hospitalId) : null;
    }
    const [row] = await db.update(hospitalDoctorsTable).set(patch)
      .where(and(eq(hospitalDoctorsTable.id, id), eq(hospitalDoctorsTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/doctors/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalDoctorsTable, id, cid, "الطبيب")) return;
    await db.delete(hospitalDoctorsTable).where(and(eq(hospitalDoctorsTable.id, id), eq(hospitalDoctorsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// PATIENTS
// ════════════════════════════════════════════════════════════════════════
router.get("/patients", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(hospitalPatientsTable)
      .where(eq(hospitalPatientsTable.companyId, cid))
      .orderBy(desc(hospitalPatientsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/patients", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const fullNameAr = String(b.fullNameAr ?? "").trim();
    if (!fullNameAr) { res.status(400).json({ error: "اسم المريض مطلوب" }); return; }
    const code = String(b.code ?? "").trim() || await nextCode(cid, hospitalPatientsTable, "PT", "code");
    const idType = (ID_TYPES as readonly string[]).includes(b.idType) ? b.idType : "national_id";
    const gender = (GENDERS as readonly string[]).includes(b.gender) ? b.gender : "male";
    const [row] = await db.insert(hospitalPatientsTable).values({
      companyId: cid,
      code, fullNameAr,
      fullNameEn: b.fullNameEn || null,
      nationalId: b.nationalId || null,
      idType: idType as any,
      dob: b.dob || null,
      gender: gender as any,
      phone: b.phone || null,
      email: b.email || null,
      bloodType: b.bloodType || null,
      address: b.address || null,
      city: b.city || null,
      insurerName: b.insurerName || null,
      policyNo: b.policyNo || null,
      policyExpires: b.policyExpires || null,
      coveragePct: String(b.coveragePct ?? "0"),
      customerId: b.customerId ? Number(b.customerId) : null,
      notes: b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/patients/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalPatientsTable, id, cid, "المريض")) return;
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    for (const k of ["code","fullNameAr","fullNameEn","nationalId","phone","email","bloodType","address","city","insurerName","policyNo","notes"]) {
      if (b[k] !== undefined) patch[k] = b[k] || null;
    }
    if (b.dob !== undefined) patch.dob = b.dob || null;
    if (b.policyExpires !== undefined) patch.policyExpires = b.policyExpires || null;
    if (b.coveragePct !== undefined) patch.coveragePct = String(b.coveragePct || "0");
    if (b.customerId !== undefined) patch.customerId = b.customerId ? Number(b.customerId) : null;
    if ((ID_TYPES as readonly string[]).includes(b.idType)) patch.idType = b.idType;
    if ((GENDERS as readonly string[]).includes(b.gender)) patch.gender = b.gender;
    const [row] = await db.update(hospitalPatientsTable).set(patch)
      .where(and(eq(hospitalPatientsTable.id, id), eq(hospitalPatientsTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/patients/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalPatientsTable, id, cid, "المريض")) return;
    await db.delete(hospitalPatientsTable).where(and(eq(hospitalPatientsTable.id, id), eq(hospitalPatientsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// APPOINTMENTS / ENCOUNTERS
// ════════════════════════════════════════════════════════════════════════
router.get("/appointments", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(hospitalAppointmentsTable)
      .where(eq(hospitalAppointmentsTable.companyId, cid))
      .orderBy(desc(hospitalAppointmentsTable.scheduledAt));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/appointments/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(hospitalAppointmentsTable)
      .where(and(eq(hospitalAppointmentsTable.id, id), eq(hospitalAppointmentsTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "الموعد غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/appointments", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.patientId) { res.status(400).json({ error: "المريض مطلوب" }); return; }
    if (!b.doctorId)  { res.status(400).json({ error: "الطبيب مطلوب" }); return; }
    if (!b.scheduledAt) { res.status(400).json({ error: "تاريخ الموعد مطلوب" }); return; }
    if (!await ownsRow(hospitalPatientsTable, Number(b.patientId), cid)) {
      res.status(400).json({ error: "المريض غير موجود" }); return;
    }
    if (!await ownsRow(hospitalDoctorsTable, Number(b.doctorId), cid)) {
      res.status(400).json({ error: "الطبيب غير موجود" }); return;
    }
    if (b.hospitalId && !await ownsRow(hospitalsTable, Number(b.hospitalId), cid)) {
      res.status(400).json({ error: "المنشأة غير موجودة" }); return;
    }
    const docNumber = String(b.docNumber ?? "").trim() || await nextCode(cid, hospitalAppointmentsTable, "APT", "docNumber");
    const status    = (APPT_STATUSES as readonly string[]).includes(b.status) ? b.status : "scheduled";
    const visitType = (VISIT_TYPES   as readonly string[]).includes(b.visitType) ? b.visitType : "consultation";
    const [row] = await db.insert(hospitalAppointmentsTable).values({
      companyId: cid,
      hospitalId: b.hospitalId ? Number(b.hospitalId) : null,
      docNumber,
      patientId: Number(b.patientId),
      doctorId: Number(b.doctorId),
      scheduledAt: new Date(b.scheduledAt),
      status: status as any,
      visitType: visitType as any,
      chiefComplaint: b.chiefComplaint || null,
      diagnosis: b.diagnosis || null,
      icd10Code: b.icd10Code || null,
      treatment: b.treatment || null,
      prescriptions: b.prescriptions || null,
      vitals: b.vitals || null,
      estimatedCost: String(b.estimatedCost ?? "0"),
      notes: b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/appointments/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalAppointmentsTable, id, cid, "الموعد")) return;
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    for (const k of ["docNumber","chiefComplaint","diagnosis","icd10Code","treatment","prescriptions","vitals","notes"]) {
      if (b[k] !== undefined) patch[k] = b[k] || null;
    }
    if (b.scheduledAt) patch.scheduledAt = new Date(b.scheduledAt);
    if (b.estimatedCost !== undefined) patch.estimatedCost = String(b.estimatedCost || "0");
    if ((APPT_STATUSES as readonly string[]).includes(b.status)) patch.status = b.status;
    if ((VISIT_TYPES   as readonly string[]).includes(b.visitType)) patch.visitType = b.visitType;
    if (b.patientId !== undefined) {
      if (!await ownsRow(hospitalPatientsTable, Number(b.patientId), cid)) {
        res.status(400).json({ error: "المريض غير موجود" }); return;
      }
      patch.patientId = Number(b.patientId);
    }
    if (b.doctorId !== undefined) {
      if (!await ownsRow(hospitalDoctorsTable, Number(b.doctorId), cid)) {
        res.status(400).json({ error: "الطبيب غير موجود" }); return;
      }
      patch.doctorId = Number(b.doctorId);
    }
    if (b.hospitalId !== undefined) {
      if (b.hospitalId && !await ownsRow(hospitalsTable, Number(b.hospitalId), cid)) {
        res.status(400).json({ error: "المنشأة غير موجودة" }); return;
      }
      patch.hospitalId = b.hospitalId ? Number(b.hospitalId) : null;
    }
    const [row] = await db.update(hospitalAppointmentsTable).set(patch)
      .where(and(eq(hospitalAppointmentsTable.id, id), eq(hospitalAppointmentsTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/appointments/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalAppointmentsTable, id, cid, "الموعد")) return;
    await db.delete(hospitalAppointmentsTable).where(and(eq(hospitalAppointmentsTable.id, id), eq(hospitalAppointmentsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// INVOICES + ITEMS
// ════════════════════════════════════════════════════════════════════════
router.get("/invoices", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(hospitalInvoicesTable)
      .where(eq(hospitalInvoicesTable.companyId, cid))
      .orderBy(desc(hospitalInvoicesTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/invoices/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [inv] = await db.select().from(hospitalInvoicesTable)
      .where(and(eq(hospitalInvoicesTable.id, id), eq(hospitalInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    const items = await db.select().from(hospitalInvoiceItemsTable)
      .where(eq(hospitalInvoiceItemsTable.invoiceId, id));
    res.json({ ...inv, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/invoices", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.patientId) { res.status(400).json({ error: "المريض مطلوب" }); return; }
    if (!await ownsRow(hospitalPatientsTable, Number(b.patientId), cid)) {
      res.status(400).json({ error: "المريض غير موجود" }); return;
    }
    if (b.doctorId && !await ownsRow(hospitalDoctorsTable, Number(b.doctorId), cid)) {
      res.status(400).json({ error: "الطبيب غير موجود" }); return;
    }
    if (b.appointmentId && !await ownsRow(hospitalAppointmentsTable, Number(b.appointmentId), cid)) {
      res.status(400).json({ error: "الموعد غير موجود" }); return;
    }
    if (b.hospitalId && !await ownsRow(hospitalsTable, Number(b.hospitalId), cid)) {
      res.status(400).json({ error: "المنشأة غير موجودة" }); return;
    }
    const docNumber = String(b.docNumber ?? "").trim() || await nextCode(cid, hospitalInvoicesTable, "HINV", "docNumber");
    const status = (INV_STATUSES as readonly string[]).includes(b.status) ? b.status : "draft";

    const items = Array.isArray(b.items) ? b.items : [];
    let computed = 0;
    for (const it of items) {
      const qty = Number(it.qty || 1);
      const price = Number(it.unitPrice || 0);
      computed += qty * price;
    }
    const totalAmount = b.totalAmount !== undefined ? Number(b.totalAmount) : computed;
    const insuranceCoverage = Number(b.insuranceCoverage || 0);
    const patientShare = b.patientShare !== undefined ? Number(b.patientShare) : Math.max(0, totalAmount - insuranceCoverage);

    const [inv] = await db.insert(hospitalInvoicesTable).values({
      companyId: cid,
      docNumber,
      appointmentId: b.appointmentId ? Number(b.appointmentId) : null,
      patientId: Number(b.patientId),
      doctorId: b.doctorId ? Number(b.doctorId) : null,
      hospitalId: b.hospitalId ? Number(b.hospitalId) : null,
      totalAmount: String(totalAmount),
      insuranceCoverage: String(insuranceCoverage),
      patientShare: String(patientShare),
      paidAmount: String(b.paidAmount || 0),
      status: status as any,
      issuedAt: status === "issued" ? new Date() : (b.issuedAt ? new Date(b.issuedAt) : null),
      notes: b.notes || null,
    }).returning();

    if (items.length > 0) {
      await db.insert(hospitalInvoiceItemsTable).values(items.map((it: any) => {
        const qty = Number(it.qty || 1);
        const price = Number(it.unitPrice || 0);
        return {
          invoiceId: inv.id,
          description: String(it.description || "خدمة طبية"),
          serviceCode: it.serviceCode || null,
          qty: String(qty),
          unitPrice: String(price),
          total: String(qty * price),
        };
      }));
    }
    res.status(201).json(inv);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalInvoicesTable, id, cid, "الفاتورة")) return;
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    for (const k of ["docNumber","notes"]) {
      if (b[k] !== undefined) patch[k] = b[k] || null;
    }
    for (const k of ["totalAmount","insuranceCoverage","patientShare","paidAmount"]) {
      if (b[k] !== undefined) patch[k] = String(b[k] || 0);
    }
    if ((INV_STATUSES as readonly string[]).includes(b.status)) {
      patch.status = b.status;
      if (b.status === "issued") patch.issuedAt = new Date();
    }

    if (Array.isArray(b.items)) {
      await db.delete(hospitalInvoiceItemsTable).where(eq(hospitalInvoiceItemsTable.invoiceId, id));
      if (b.items.length > 0) {
        await db.insert(hospitalInvoiceItemsTable).values(b.items.map((it: any) => {
          const qty = Number(it.qty || 1);
          const price = Number(it.unitPrice || 0);
          return {
            invoiceId: id,
            description: String(it.description || "خدمة طبية"),
            serviceCode: it.serviceCode || null,
            qty: String(qty),
            unitPrice: String(price),
            total: String(qty * price),
          };
        }));
      }
      const computed = b.items.reduce((s: number, it: any) =>
        s + Number(it.qty || 1) * Number(it.unitPrice || 0), 0);
      if (patch.totalAmount === undefined) patch.totalAmount = String(computed);
    }

    const [inv] = await db.update(hospitalInvoicesTable).set(patch)
      .where(and(eq(hospitalInvoicesTable.id, id), eq(hospitalInvoicesTable.companyId, cid))).returning();
    res.json(inv);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalInvoicesTable, id, cid, "الفاتورة")) return;
    await db.delete(hospitalInvoicesTable).where(and(eq(hospitalInvoicesTable.id, id), eq(hospitalInvoicesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// INSURANCE CLAIMS (NPHIES blueprint storage — sending requires CCHI cert)
// ════════════════════════════════════════════════════════════════════════
router.get("/claims", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(hospitalClaimsTable)
      .where(eq(hospitalClaimsTable.companyId, cid))
      .orderBy(desc(hospitalClaimsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/claims", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.invoiceId) { res.status(400).json({ error: "الفاتورة مطلوبة" }); return; }
    if (!await ownsRow(hospitalInvoicesTable, Number(b.invoiceId), cid)) {
      res.status(400).json({ error: "الفاتورة غير موجودة" }); return;
    }
    const claimNumber = String(b.claimNumber ?? "").trim() ||
      `CLM-${Date.now().toString(36).toUpperCase()}`;
    const status = (CLAIM_STATUSES as readonly string[]).includes(b.status) ? b.status : "draft";
    const [row] = await db.insert(hospitalClaimsTable).values({
      companyId: cid,
      invoiceId: Number(b.invoiceId),
      payerName: String(b.payerName || "غير محدد"),
      policyNo: b.policyNo || null,
      claimNumber,
      status: status as any,
      totalAmount: String(b.totalAmount || 0),
      approvedAmount: String(b.approvedAmount || 0),
      rejectionReason: b.rejectionReason || null,
      fhirPayload: b.fhirPayload ? (typeof b.fhirPayload === "string" ? b.fhirPayload : JSON.stringify(b.fhirPayload)) : null,
      responsePayload: null,
      sentAt: null,
      respondedAt: null,
      notes: b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/claims/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalClaimsTable, id, cid, "المطالبة")) return;
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    for (const k of ["payerName","policyNo","claimNumber","rejectionReason","notes"]) {
      if (b[k] !== undefined) patch[k] = b[k] || null;
    }
    for (const k of ["totalAmount","approvedAmount"]) {
      if (b[k] !== undefined) patch[k] = String(b[k] || 0);
    }
    if ((CLAIM_STATUSES as readonly string[]).includes(b.status)) patch.status = b.status;
    const [row] = await db.update(hospitalClaimsTable).set(patch)
      .where(and(eq(hospitalClaimsTable.id, id), eq(hospitalClaimsTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/claims/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, hospitalClaimsTable, id, cid, "المطالبة")) return;
    await db.delete(hospitalClaimsTable).where(and(eq(hospitalClaimsTable.id, id), eq(hospitalClaimsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// SUMMARY (used by HospitalHub tile)
// ════════════════════════════════════════════════════════════════════════
router.get("/summary", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const [{ hospitals }] = await db.select({ hospitals: sql<number>`count(*)::int` })
      .from(hospitalsTable).where(eq(hospitalsTable.companyId, cid));
    const [{ doctors }] = await db.select({ doctors: sql<number>`count(*)::int` })
      .from(hospitalDoctorsTable).where(eq(hospitalDoctorsTable.companyId, cid));
    const [{ patients }] = await db.select({ patients: sql<number>`count(*)::int` })
      .from(hospitalPatientsTable).where(eq(hospitalPatientsTable.companyId, cid));
    const [{ appointments }] = await db.select({ appointments: sql<number>`count(*)::int` })
      .from(hospitalAppointmentsTable).where(eq(hospitalAppointmentsTable.companyId, cid));
    const [{ invoices }] = await db.select({ invoices: sql<number>`count(*)::int` })
      .from(hospitalInvoicesTable).where(eq(hospitalInvoicesTable.companyId, cid));
    const [{ claims }] = await db.select({ claims: sql<number>`count(*)::int` })
      .from(hospitalClaimsTable).where(eq(hospitalClaimsTable.companyId, cid));
    res.json({ hospitals, doctors, patients, appointments, invoices, claims });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
