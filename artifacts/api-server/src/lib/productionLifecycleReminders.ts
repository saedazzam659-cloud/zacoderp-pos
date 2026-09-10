import { db } from "@workspace/db";
import {
  companiesTable,
  notificationsTable,
  productionOrdersTable,
} from "@workspace/db";
import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";

function saudiBusinessDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDateOnlyDays(date: string, days: number): string {
  const ms = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Materializes manufacturing-certificate reminders through the same durable
 * notification/source-key mechanism used by the other reminder families.
 *
 * This intentionally runs when the notification bell is read, rather than
 * inventing a second process-local scheduler. The source key contains the
 * immutable certificate identity and expiry date, so concurrent reads and
 * renewals remain idempotent.
 */
export async function ensureProductionCertificateExpiryNotifications(
  companyId: number | null | undefined,
): Promise<void> {
  if (!companyId) return;

  const [company] = await db
    .select({ thresholds: companiesTable.hrAlertThresholds })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  const thresholdConfig = (company?.thresholds ?? {}) as Record<string, unknown>;
  const configured = Number(
    thresholdConfig.manufacturingCertificate ??
      thresholdConfig.manufacturingCertificateExpiry ??
      thresholdConfig.certificateExpiry,
  );
  const threshold =
    Number.isFinite(configured) && configured >= 1 && configured <= 3650
      ? Math.round(configured)
      : 90;
  const today = saudiBusinessDate();
  const horizon = addDateOnlyDays(today, threshold);

  const orders = await db
    .select({
      id: productionOrdersTable.id,
      orderNumber: productionOrdersTable.orderNumber,
      title: productionOrdersTable.title,
      branchId: productionOrdersTable.branchId,
      meta: productionOrdersTable.meta,
    })
    .from(productionOrdersTable)
    .where(eq(productionOrdersTable.companyId, companyId));

  const rows: Array<{
    companyId: number;
    userId: null;
    title: string;
    body: string;
    severity: string;
    category: string;
    sourceKey: string;
    moduleKey: string;
    branchId: number | null;
  }> = [];

  for (const order of orders) {
    const lifecycle = (order.meta as any)?.commercialLifecycle;
    if (!Array.isArray(lifecycle)) continue;
    for (const record of lifecycle) {
      if (
        !record ||
        record.type !== "certificate" ||
        !["active", "suspended", "expired"].includes(String(record.status))
      ) {
        continue;
      }
      const expiry = String(record.effectiveTo ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) continue;

      const isExpired = expiry < today;
      if (!isExpired && expiry > horizon) continue;
      const category = isExpired
        ? "manufacturing_certificate_expiry"
        : "manufacturing_certificate_renewal";
      const sourceKey = `manufacturing_certificate:${order.id}:${String(
        record.id,
      )}:${expiry}:${isExpired ? "expired" : "renewal"}`;
      const label = String(record.name ?? "شهادة تصنيع");
      const subject = order.orderNumber
        ? `أمر التصنيع ${order.orderNumber}`
        : order.title;
      rows.push({
        companyId,
        userId: null,
        title: isExpired
          ? "انتهت صلاحية شهادة التصنيع"
          : "استحقاق تجديد شهادة التصنيع",
        body: isExpired
          ? `${label} المرتبطة بـ${subject} انتهت في ${expiry}. أنشئ سجل تجديد موثقاً قبل استخدام الشهادة.`
          : `${label} المرتبطة بـ${subject} تنتهي في ${expiry}. ابدأ التجديد قبل الموعد.`,
        severity: isExpired ? "high" : "medium",
        category,
        sourceKey,
        moduleKey: "production",
        branchId: order.branchId,
      });
    }
  }

  const categories = [
    "manufacturing_certificate_expiry",
    "manufacturing_certificate_renewal",
  ];
  const activeSourceKeys = rows.map((row) => row.sourceKey);
  await db.delete(notificationsTable).where(
    and(
      eq(notificationsTable.companyId, companyId),
      inArray(notificationsTable.category, categories),
      isNotNull(notificationsTable.sourceKey),
      ...(activeSourceKeys.length
        ? [notInArray(notificationsTable.sourceKey, activeSourceKeys)]
        : []),
    ),
  );
  if (!rows.length) return;

  await db.insert(notificationsTable).values(rows).onConflictDoNothing();
  // Refresh descriptive text without replacing read/dismiss receipts.
  await Promise.all(
    rows.map((row) =>
      db
        .update(notificationsTable)
        .set({
          title: row.title,
          body: row.body,
          severity: row.severity,
          category: row.category,
           moduleKey: row.moduleKey,
           branchId: row.branchId,
        })
        .where(
          and(
            eq(notificationsTable.companyId, companyId),
            eq(notificationsTable.sourceKey, row.sourceKey),
          ),
        ),
    ),
  );
}