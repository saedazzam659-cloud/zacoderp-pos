import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";
import {
  createExternalDb,
  db,
  pool,
  runWithExternalDb,
  agentInstancesTable,
  companiesTable,
  invoicesTable,
  usersTable,
} from "@workspace/db";
import app from "../src/app.ts";
import { encryptSecret } from "../src/lib/encryption.ts";
import { evictAgentDb } from "../src/lib/agentDb.ts";

const databaseUrl = process.env.DATABASE_URL;

test("agent ZATCA setup reads and writes only the matching agent tenant", {
  skip: !databaseUrl,
}, async () => {
  const tag = `tt_zatca_agent_${randomBytes(5).toString("hex")}`;
  const schema = `zatca_agent_${randomBytes(6).toString("hex")}`;
  const apiToken = `${tag}_superadmin_token`;
  let server: Server | undefined;
  let agentSeedDb: ReturnType<typeof createExternalDb> | undefined;
  let agentId: number | undefined;
  let companyId: number | undefined;
  let userId: number | undefined;
  let schemaCreated = false;

  try {
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const agentDatabaseUrl = url.toString();

    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await pool.query(`CREATE TABLE "${schema}".companies (LIKE public.companies INCLUDING ALL)`);
    await pool.query(`CREATE TABLE "${schema}".invoices (LIKE public.invoices INCLUDING ALL)`);
    agentSeedDb = createExternalDb(agentDatabaseUrl, { max: 2 });

    const [centralCompany] = await db.insert(companiesTable).values({
      nameAr: `${tag} central`,
      nameEn: `${tag}_CENTRAL`,
      vatNumber: `VAT_${tag}`,
      crNumber: `CR_${tag}`,
      city: "Riyadh",
      street: "Test St",
      buildingNumber: "1",
      postalCode: "12345",
      country: "SA",
      invoiceType: "both",
      status: "active",
      serialNumber: `${tag}_CENTRAL_SERIAL`,
      zatcaCsr: `${tag}_CENTRAL_CSR`,
      zatcaPrivateKey: `${tag}_CENTRAL_PRIVATE`,
      zatcaCsidToken: `${tag}_CENTRAL_CSID`,
      zatcaPcsidToken: `${tag}_CENTRAL_PCSID`,
    }).returning();
    companyId = centralCompany.id;

    const [agent] = await db.insert(agentInstancesTable).values({
      name: `${tag} agent`,
      domain: `${tag}.example.test`,
      installationId: `${tag}_installation`,
      status: "active",
      dbStatus: "initialized",
      dbUrlEnc: encryptSecret(agentDatabaseUrl),
    }).returning({ id: agentInstancesTable.id });
    agentId = agent.id;

    await runWithExternalDb(agentSeedDb, async () => {
      await db.insert(companiesTable).values({
        ...centralCompany,
        id: centralCompany.id,
        nameAr: `${tag} agent`,
        nameEn: `${tag}_AGENT`,
        serialNumber: `${tag}_AGENT_SERIAL`,
        zatcaCsr: `${tag}_AGENT_CSR`,
        zatcaPrivateKey: `${tag}_AGENT_PRIVATE`,
        zatcaCsidToken: `${tag}_AGENT_CSID`,
        zatcaPcsidToken: `${tag}_AGENT_PCSID`,
      });
      await db.insert(invoicesTable).values([
        {
          id: 91001,
          companyId: centralCompany.id,
          invoiceNumber: `${tag}_DRAFT`,
          issueDate: "2026-10-06",
          status: "draft",
        },
        {
          id: 91002,
          companyId: centralCompany.id,
          invoiceNumber: `${tag}_ISSUED`,
          issueDate: "2026-10-06",
          status: "issued",
        },
        {
          id: 91003,
          companyId: centralCompany.id,
          invoiceNumber: `${tag}_CANCELLED`,
          issueDate: "2026-10-06",
          status: "cancelled",
        },
      ]);
    });

    const [superadmin] = await db.insert(usersTable).values({
      username: `${tag}_sa`,
      passwordHash: await bcrypt.hash("unused-test-password", 4),
      role: "superadmin",
      isActive: true,
      sessionToken: apiToken,
      sessionId: `${tag}_session`,
      companyId: null,
    }).returning({ id: usersTable.id });
    userId = superadmin.id;

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("API test server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    async function request(path: string, method = "GET", body?: unknown) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) as Record<string, any> : null,
      };
    }

    const config = await request(
      `/api/admin/companies/${companyId}/zatca-config?agent=${agentId}`,
    );
    assert.equal(config.status, 200);
    assert.equal(config.body.company.nameEn, `${tag}_AGENT`, "colliding company ID must resolve in the agent DB");
    assert.equal(config.body.company.hasCsr, true);
    assert.equal(config.body.company.hasCsid, true);
    assert.equal(config.body.company.hasPcsid, true);
    for (const secretField of ["zatcaCsr", "zatcaPrivateKey", "zatcaCsidToken", "zatcaPcsidToken"]) {
      assert.equal(secretField in config.body.company, false, `${secretField} must not reach the browser`);
    }
    assert.doesNotMatch(JSON.stringify(config.body), /_AGENT_(?:CSR|PRIVATE|CSID|PCSID)/);

    const saved = await request(
      `/api/companies/${companyId}/zatca-settings?agent=${agentId}`,
      "PATCH",
      { serialNumber: `${tag}_UPDATED_AGENT`, zatcaEnvironment: "production" },
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.serialNumber, `${tag}_UPDATED_AGENT`);
    assert.equal("zatcaPrivateKey" in saved.body, false);

    const picker = await request(
      `/api/admin/companies/${companyId}/zatca-invoices?agent=${agentId}`,
    );
    assert.equal(picker.status, 200);
    assert.deepEqual(
      picker.body.map((invoice: { invoiceNumber: string }) => invoice.invoiceNumber).sort(),
      [`${tag}_DRAFT`, `${tag}_ISSUED`].sort(),
    );

    const [unchangedCentral] = await db.select().from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    assert.equal(unchangedCentral.nameEn, `${tag}_CENTRAL`);
    assert.equal(unchangedCentral.serialNumber, `${tag}_CENTRAL_SERIAL`);
    assert.equal(unchangedCentral.zatcaPrivateKey, `${tag}_CENTRAL_PRIVATE`);
    assert.equal(unchangedCentral.zatcaCsidToken, `${tag}_CENTRAL_CSID`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (agentId) {
      evictAgentDb(agentId);
      await db.delete(agentInstancesTable).where(eq(agentInstancesTable.id, agentId));
    }
    if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
    if (companyId) await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
    if (agentSeedDb) await agentSeedDb.pool.end().catch(() => {});
    if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end().catch(() => {});
  }
});
