import { and, eq, or, sql } from "drizzle-orm";
import { db, fixedAssetsTable, productionResourcesTable } from "@workspace/db";

type ManufacturingAsset = {
  id: number;
  companyId: number;
  branchId: number | null;
  nameAr: string;
};

export async function ensureProductionMachineForAsset(
  tx: any,
  asset: ManufacturingAsset,
): Promise<number> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtext('production-resource-fixed-asset:' || ${asset.companyId}::text || ':' || ${asset.id}::text)
    )
  `);

  const [linked] = await tx.select({
    id: productionResourcesTable.id,
    type: productionResourcesTable.type,
    name: productionResourcesTable.name,
    branchId: productionResourcesTable.branchId,
    meta: productionResourcesTable.meta,
  }).from(productionResourcesTable).where(and(
    eq(productionResourcesTable.companyId, asset.companyId),
    or(
      eq(productionResourcesTable.fixedAssetId, asset.id),
      sql`${productionResourcesTable.meta}->>'fixedAssetId' = ${String(asset.id)}`,
    ),
  )).limit(1);

  if (linked) {
    if (linked.type !== "machine") {
      throw Object.assign(new Error("الأصل المرتبط بمورد إنتاج ليس آلة"), { status: 409 });
    }
    const meta = linked.meta && typeof linked.meta === "object"
      ? linked.meta as Record<string, unknown>
      : {};
    const normalizedMeta = { ...meta, fixedAssetId: asset.id };
    if (meta.autoCreatedFromFixedAsset === true) {
      await tx.update(productionResourcesTable).set({
        name: asset.nameAr,
        branchId: asset.branchId,
        fixedAssetId: asset.id,
        meta: normalizedMeta,
        updatedAt: new Date(),
      }).where(and(
        eq(productionResourcesTable.id, linked.id),
        eq(productionResourcesTable.companyId, asset.companyId),
      ));
    } else if (linked.branchId !== asset.branchId || meta.fixedAssetId !== asset.id) {
      await tx.update(productionResourcesTable).set({
        branchId: asset.branchId,
        fixedAssetId: asset.id,
        meta: normalizedMeta,
        updatedAt: new Date(),
      }).where(and(
        eq(productionResourcesTable.id, linked.id),
        eq(productionResourcesTable.companyId, asset.companyId),
      ));
    }
    return linked.id;
  }

  const [created] = await tx.insert(productionResourcesTable).values({
    companyId: asset.companyId,
    branchId: asset.branchId,
    name: asset.nameAr,
    type: "machine",
    status: "available",
    capacityPerHour: "0",
    fixedAssetId: asset.id,
    electricityEnabled: false,
    electricityKw: null,
    meta: { fixedAssetId: asset.id, autoCreatedFromFixedAsset: true },
  }).returning({ id: productionResourcesTable.id });
  return created.id;
}

export async function backfillProductionMachinesForAssets(
  companyId: number,
  assets: ManufacturingAsset[],
): Promise<void> {
  if (!assets.length) return;
  await db.transaction(async (tx) => {
    for (const asset of assets) {
      await ensureProductionMachineForAsset(tx, { ...asset, companyId });
    }
  });
}

export async function getActiveManufacturingAssets(companyId: number, branchCondition?: any) {
  return db.select({
    id: fixedAssetsTable.id,
    companyId: fixedAssetsTable.companyId,
    branchId: fixedAssetsTable.branchId,
    nameAr: fixedAssetsTable.nameAr,
  }).from(fixedAssetsTable).where(and(
    eq(fixedAssetsTable.companyId, companyId),
    eq(fixedAssetsTable.status, "active"),
    eq(fixedAssetsTable.usedInManufacturing, true),
    ...(branchCondition ? [branchCondition] : []),
  ));
}
