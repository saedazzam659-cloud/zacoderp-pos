import { Router } from "express";
import { db } from "@workspace/db";
import { customersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { CreateCustomerBody, UpdateCustomerBody, ListCustomersQueryParams } from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  const params = ListCustomersQueryParams.safeParse(req.query);
  const companyId = params.success && params.data.companyId ? params.data.companyId : undefined;
  
  const customers = companyId
    ? await db.select().from(customersTable).where(eq(customersTable.companyId, companyId))
    : await db.select().from(customersTable);
  
  res.json(customers);
});

router.post("/", async (req, res) => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  const [customer] = await db.insert(customersTable).values({
    companyId: data.companyId,
    nameAr: data.nameAr,
    nameEn: data.nameEn,
    vatNumber: data.vatNumber,
    crNumber: data.crNumber,
    email: data.email,
    phone: data.phone,
    city: data.city,
    district: data.district,
    street: data.street,
    buildingNumber: data.buildingNumber,
    postalCode: data.postalCode,
    country: data.country ?? "SA",
  }).returning();
  res.status(201).json(customer);
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, id));
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.json(customer);
});

router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const parsed = UpdateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const [customer] = await db.update(customersTable).set(parsed.data).where(eq(customersTable.id, id)).returning();
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.json(customer);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  await db.delete(customersTable).where(eq(customersTable.id, id));
  res.status(204).send();
});

export default router;
