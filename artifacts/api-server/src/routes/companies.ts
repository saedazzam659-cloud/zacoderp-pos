import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateCompanyBody, UpdateCompanyBody } from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  const companies = await db.select().from(companiesTable).orderBy(companiesTable.createdAt);
  res.json(companies);
});

router.post("/", async (req, res) => {
  const parsed = CreateCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  const [company] = await db.insert(companiesTable).values({
    nameAr: data.nameAr,
    nameEn: data.nameEn,
    vatNumber: data.vatNumber,
    crNumber: data.crNumber,
    city: data.city,
    district: data.district,
    street: data.street,
    buildingNumber: data.buildingNumber,
    postalCode: data.postalCode,
    additionalNumber: data.additionalNumber,
    country: data.country ?? "SA",
    industryName: data.industryName,
    invoiceType: data.invoiceType ?? "both",
    isSandbox: data.isSandbox ?? false,
    serialNumber: data.serialNumber,
    deviceSerial1: data.deviceSerial1,
    deviceSerial2: data.deviceSerial2,
    deviceSerial3: data.deviceSerial3,
    zatcaCsid: data.zatcaCsid,
    zatcaPcsid: data.zatcaPcsid,
  }).returning();
  res.status(201).json(company);
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, id));
  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  res.json(company);
});

router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const parsed = UpdateCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  const [company] = await db.update(companiesTable).set({
    ...data,
    updatedAt: new Date(),
  }).where(eq(companiesTable.id, id)).returning();
  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  res.json(company);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  await db.delete(companiesTable).where(eq(companiesTable.id, id));
  res.status(204).send();
});

export default router;
