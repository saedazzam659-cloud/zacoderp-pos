import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { usersTable, planConfigsTable } from "@workspace/db";
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

async function seedPlanConfigs() {
  try {
    const existing = await db.select().from(planConfigsTable);
    if (existing.length === 0) {
      const defaults = [
        {
          key: "starter",
          nameAr: "مبتدئ",
          nameEn: "Starter",
          monthlyPrice: "99",
          annualPrice: "990",
          maxUsers: 1,
          maxInvoices: 50,
          features: JSON.stringify(["مستخدم واحد", "50 فاتورة شهرياً", "فواتير ضريبية ومبسطة", "دعم بريد إلكتروني"]),
          isRecommended: false,
          isActive: true,
          sortOrder: 1,
        },
        {
          key: "professional",
          nameAr: "احترافي",
          nameEn: "Professional",
          monthlyPrice: "299",
          annualPrice: "2990",
          maxUsers: 5,
          maxInvoices: 500,
          features: JSON.stringify(["5 مستخدمين", "500 فاتورة شهرياً", "تقارير متقدمة", "API مفتوح", "دعم أولوية"]),
          isRecommended: true,
          isActive: true,
          sortOrder: 2,
        },
        {
          key: "enterprise",
          nameAr: "مؤسسي",
          nameEn: "Enterprise",
          monthlyPrice: "899",
          annualPrice: "8990",
          maxUsers: 999,
          maxInvoices: 999999,
          features: JSON.stringify(["مستخدمون غير محدودين", "فواتير غير محدودة", "تقارير مخصصة", "SLA 99.9%", "مدير حساب مخصص"]),
          isRecommended: false,
          isActive: true,
          sortOrder: 3,
        },
      ];
      await db.insert(planConfigsTable).values(defaults);
      logger.info("Default plan configs seeded");
    }
  } catch (err) {
    logger.error({ err }, "Failed to seed plan configs");
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
  seedPlanConfigs();
  // Start automatic-backup scheduler (checks every 15 min; creates snapshot per
  // company on its configured frequency).
  import("./routes/backup.js").then(m => m.startBackupScheduler?.()).catch(() => {});
});
