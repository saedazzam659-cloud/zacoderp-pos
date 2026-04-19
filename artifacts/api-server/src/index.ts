import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

async function seedSuperAdmin() {
  try {
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.role, "superadmin"));
    if (!existing) {
      const passwordHash = await bcrypt.hash("SuperAdmin@2026", 12);
      await db.insert(usersTable).values({
        username: "superadmin",
        email: null,
        passwordHash,
        companyId: null,
        role: "superadmin",
        isActive: true,
      });
      logger.info("Superadmin created successfully");
    }
  } catch (err) {
    logger.error({ err }, "Failed to seed superadmin");
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  seedSuperAdmin();
});
