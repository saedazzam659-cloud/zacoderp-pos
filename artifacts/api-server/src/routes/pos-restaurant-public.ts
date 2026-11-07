import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  itemsTable, posMenuCategoriesTable, posMenuItemsTable, posOrderItemsTable,
  posOrdersTable, posTablesTable,
  posRestaurantDeliveryIntegrationsTable, posRestaurantExternalOrdersTable,
} from "@workspace/db";
import { calculateRestaurantOrderTotals } from "../lib/restaurant-order-pricing.js";
import { validateRestaurantModifierSelection } from "../lib/restaurant-modifier-selection.js";

const router = Router();
const rateWindows = new Map<string, number[]>();

router.use((req, res, next) => {
  if (!req.path.startsWith("/public/")) { next(); return; }
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (rateWindows.get(key) ?? []).filter(stamp => now - stamp < 60_000);
  if (recent.length >= 30) { res.status(429).json({ error: "محاولات كثيرة، حاول بعد دقيقة" }); return; }
  recent.push(now);
  rateWindows.set(key, recent);
  if (rateWindows.size > 10_000) {
    for (const [ip, timestamps] of rateWindows) {
      if (!timestamps.some(stamp => now - stamp < 60_000)) rateWindows.delete(ip);
      if (rateWindows.size <= 8_000) break;
    }
  }
  next();
});

function configuredModifierGroups(attributes: unknown): any[] {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return [];
  const groups = (attributes as Record<string, unknown>)._restaurantModifierGroups;
  return Array.isArray(groups) ? groups : [];
}

router.post("/webhooks/hungerstation/:integrationId", async (req, res): Promise<void> => {
  const integrationId = Number(req.params.integrationId);
  if (!Number.isSafeInteger(integrationId) || integrationId <= 0) {
    res.status(404).json({ error: "Webhook غير معروف" }); return;
  }
  const [integration] = await db.select({
    id: posRestaurantDeliveryIntegrationsTable.id,
    companyId: posRestaurantDeliveryIntegrationsTable.companyId,
    branchId: posRestaurantDeliveryIntegrationsTable.branchId,
    provider: posRestaurantDeliveryIntegrationsTable.provider,
    environment: posRestaurantDeliveryIntegrationsTable.environment,
    isEnabled: posRestaurantDeliveryIntegrationsTable.isEnabled,
    webhookTokenHash: posRestaurantDeliveryIntegrationsTable.webhookTokenHash,
  }).from(posRestaurantDeliveryIntegrationsTable)
    .where(eq(posRestaurantDeliveryIntegrationsTable.id, integrationId)).limit(1);
  if (!integration || integration.provider !== "hungerstation" || !integration.webhookTokenHash) {
    res.status(404).json({ error: "Webhook غير مهيأ" }); return;
  }
  if (integration.environment !== "sandbox" && !integration.isEnabled) {
    res.status(503).json({ error: "استقبال الإنتاج غير مفعّل بعد" }); return;
  }
  const authorization = req.get("authorization") ?? "";
  const expected = Buffer.from(integration.webhookTokenHash, "hex");
  const received = createHash("sha256").update(authorization).digest();
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    res.status(401).json({ error: "مصادقة Webhook غير صالحة" }); return;
  }

  const body = req.body;
  const externalOrderId = typeof body?.external_order_id === "string" && body.external_order_id.trim()
    ? body.external_order_id.trim()
    : typeof body?.order_id === "string" && body.order_id.trim() ? body.order_id.trim() : "";
  const providerStatus = typeof body?.status === "string" ? body.status : "";
  const allowedStatuses = new Set(["RECEIVED", "READY_FOR_PICKUP", "DISPATCHED", "CANCELLED", "CANCELED", "DELIVERED"]);
  if (!externalOrderId || externalOrderId.length > 200 || !allowedStatuses.has(providerStatus) ||
      !Array.isArray(body?.items) || body.items.length > 300) {
    res.status(400).json({ error: "بيانات إشعار الطلب غير صالحة" }); return;
  }
  const customer = body.customer && typeof body.customer === "object" ? body.customer : {};
  const address = customer.delivery_address && typeof customer.delivery_address === "object"
    ? customer.delivery_address
    : {};
  const normalizedPayload = {
    order_id: typeof body.order_id === "string" ? body.order_id : null,
    external_order_id: externalOrderId,
    order_code: typeof body.order_code === "string" ? body.order_code.slice(0, 80) : null,
    status: providerStatus,
    order_type: typeof body.order_type === "string" ? body.order_type : null,
    transport_type: typeof body.transport_type === "string" ? body.transport_type : null,
    comment: typeof body.comment === "string" ? body.comment.slice(0, 1000) : null,
    accepted_for: typeof body.accepted_for === "string" ? body.accepted_for : null,
    promised_for: typeof body.promised_for === "string" ? body.promised_for : null,
    customer: {
      first_name: typeof customer.first_name === "string" ? customer.first_name.slice(0, 100) : null,
      last_name: typeof customer.last_name === "string" ? customer.last_name.slice(0, 100) : null,
      phone_number: typeof customer.phone_number === "string" ? customer.phone_number.slice(0, 80) : null,
      delivery_address: {
        formattedAddress: typeof address.formattedAddress === "string" ? address.formattedAddress.slice(0, 600) : null,
        street: typeof address.street === "string" ? address.street.slice(0, 200) : null,
        suburb: typeof address.suburb === "string" ? address.suburb.slice(0, 120) : null,
        city: typeof address.city === "string" ? address.city.slice(0, 120) : null,
        building: typeof address.building === "string" ? address.building.slice(0, 100) : null,
        instructions: typeof address.instructions === "string" ? address.instructions.slice(0, 500) : null,
      },
    },
    items: body.items,
    payment: body.payment && typeof body.payment === "object" ? body.payment : null,
  };
  const [saved] = await db.insert(posRestaurantExternalOrdersTable).values({
    integrationId: integration.id,
    companyId: integration.companyId,
    branchId: integration.branchId,
    externalOrderId,
    orderCode: normalizedPayload.order_code,
    providerStatus,
    orderPayload: normalizedPayload,
  }).onConflictDoUpdate({
    target: [posRestaurantExternalOrdersTable.integrationId, posRestaurantExternalOrdersTable.externalOrderId],
    set: {
      orderCode: normalizedPayload.order_code,
      providerStatus,
      orderPayload: normalizedPayload,
      updatedAt: new Date(),
    },
  }).returning({ id: posRestaurantExternalOrdersTable.id });
  req.log?.info?.({ integrationId, eventId: saved?.id, providerStatus }, "HungerStation webhook accepted");
  res.status(200).json({ ok: true });
});

async function resolveSelectedModifiers(companyId: number, baseItem: any, selections: unknown, vatIncluded: boolean) {
  const chosen = validateRestaurantModifierSelection(configuredModifierGroups(baseItem?.variantAttributes), selections);
  const ids = [...new Set(chosen.map(({ option }) => Number(option.itemId)))];
  const linked = ids.length ? await db.select({
    id: itemsTable.id, nameAr: itemsTable.nameAr, status: itemsTable.status,
    itemType: itemsTable.itemType, vatRate: itemsTable.vatRate,
  }).from(itemsTable).where(and(eq(itemsTable.companyId, companyId), inArray(itemsTable.id, ids))) : [];
  const byId = new Map(linked.map(item => [item.id, item]));
  return chosen.map(({ group, option }) => {
    const item = byId.get(Number(option.itemId));
    if (!item || item.status !== "active" || !["stock", "service"].includes(item.itemType)) {
      throw new Error("أحد أصناف الإضافة لم يعد متاحاً");
    }
    return {
      name: group.nameAr, option: item.nameAr, price: Number(option.extraPrice),
      consumptionQtyPerSelection: Number(option.consumptionQtyPerSelection ?? 1),
      groupId: String(group.id), optionId: String(option.id), itemId: item.id,
      itemType: item.itemType as "stock" | "service", vatRate: item.vatRate, vatIncluded,
    };
  });
}

router.get("/public/tables/:token/menu", async (req, res) => {
  const token = String(req.params.token ?? "");
  if (token.length < 40 || token.length > 64) { res.status(404).json({ error: "الرابط غير صالح" }); return; }
  const [table] = await db.select({
    id: posTablesTable.id, companyId: posTablesTable.companyId,
    branchId: posTablesTable.branchId, nameAr: posTablesTable.nameAr,
  }).from(posTablesTable).where(and(
    eq(posTablesTable.publicOrderToken, token), eq(posTablesTable.isActive, true),
  )).limit(1);
  if (!table) { res.status(404).json({ error: "قائمة الطاولة غير متاحة" }); return; }

  const categories = await db.select().from(posMenuCategoriesTable).where(and(
    eq(posMenuCategoriesTable.companyId, table.companyId),
    eq(posMenuCategoriesTable.isActive, true),
    or(isNull(posMenuCategoriesTable.branchId), eq(posMenuCategoriesTable.branchId, table.branchId)),
  )).orderBy(asc(posMenuCategoriesTable.displayOrder));
  const rows = await db.select({
    menuItem: posMenuItemsTable,
    linkedAttributes: itemsTable.variantAttributes,
    linkedShowInPos: itemsTable.showInPos,
    linkedStatus: itemsTable.status,
  }).from(posMenuItemsTable).leftJoin(itemsTable, and(
    eq(itemsTable.id, posMenuItemsTable.itemId), eq(itemsTable.companyId, table.companyId),
  )).where(and(
    eq(posMenuItemsTable.companyId, table.companyId),
    eq(posMenuItemsTable.isActive, true),
    inArray(posMenuItemsTable.categoryId, categories.map(category => category.id).length
      ? categories.map(category => category.id) : [-1]),
  )).orderBy(asc(posMenuItemsTable.nameAr));
  const eligibleRows = rows.filter(row =>
    row.menuItem.itemId && row.linkedShowInPos !== false && row.linkedStatus === "active",
  );
  const groups = eligibleRows.flatMap(row => configuredModifierGroups(row.linkedAttributes));
  const optionIds = [...new Set(groups.flatMap(group => (group.options ?? [])
    .map((option: any) => Number(option.itemId)).filter(Number.isSafeInteger)))];
  const optionItems = optionIds.length ? await db.select({
    id: itemsTable.id, nameAr: itemsTable.nameAr, nameEn: itemsTable.nameEn, code: itemsTable.code,
    status: itemsTable.status,
  }).from(itemsTable).where(and(
    eq(itemsTable.companyId, table.companyId), eq(itemsTable.status, "active"), inArray(itemsTable.id, optionIds),
  )) : [];
  const optionById = new Map(optionItems.map(item => [item.id, item]));
  const items = eligibleRows.map(row => ({
      ...row.menuItem,
      showInPos: true,
      modifierGroups: configuredModifierGroups(row.linkedAttributes).map(group => ({
        ...group,
        options: (group.options ?? []).flatMap((option: any) => {
          const linked = optionById.get(Number(option.itemId));
          return linked ? [{ ...option, nameAr: linked.nameAr, nameEn: linked.nameEn, code: linked.code }] : [];
        }),
      })),
  }));
  res.setHeader("Cache-Control", "no-store");
  res.json({ table: { nameAr: table.nameAr, branchId: table.branchId }, categories, items });
});

router.post("/public/tables/:token/orders", async (req, res) => {
  const token = String(req.params.token ?? "");
  const rawLines = req.body?.items;
  if (token.length < 40 || token.length > 64 || !Array.isArray(rawLines) || rawLines.length < 1 || rawLines.length > 30) {
    res.status(400).json({ error: "بيانات الطلب غير صالحة" }); return;
  }
  const [table] = await db.select().from(posTablesTable).where(and(
    eq(posTablesTable.publicOrderToken, token), eq(posTablesTable.isActive, true),
  )).limit(1);
  if (!table) { res.status(404).json({ error: "رابط الطاولة غير متاح" }); return; }

  const prepared: Array<{ item: any; qty: number; modifiers: any[]; total: string }> = [];
  try {
    for (const raw of rawLines) {
      const menuItemId = Number(raw?.menuItemId);
      const qty = Number(raw?.qty);
      if (!Number.isSafeInteger(menuItemId) || menuItemId <= 0 || !Number.isFinite(qty) || qty <= 0 || qty > 20 || Math.round(qty * 1000) !== qty * 1000) {
        throw new Error("الصنف أو الكمية غير صالحة");
      }
      const [item] = await db.select({
        menuItem: posMenuItemsTable,
        baseItem: itemsTable,
        category: posMenuCategoriesTable,
      }).from(posMenuItemsTable).leftJoin(itemsTable, and(
        eq(itemsTable.id, posMenuItemsTable.itemId), eq(itemsTable.companyId, table.companyId),
      )).innerJoin(posMenuCategoriesTable, and(
        eq(posMenuCategoriesTable.id, posMenuItemsTable.categoryId),
        eq(posMenuCategoriesTable.companyId, table.companyId),
        eq(posMenuCategoriesTable.isActive, true),
      )).where(and(
        eq(posMenuItemsTable.id, menuItemId),
        eq(posMenuItemsTable.companyId, table.companyId),
        eq(posMenuItemsTable.isActive, true),
        or(isNull(posMenuCategoriesTable.branchId), eq(posMenuCategoriesTable.branchId, table.branchId)),
      )).limit(1);
      if (!item?.menuItem.itemId || item.baseItem?.status !== "active" || item.baseItem.showInPos === false) {
        throw new Error("أحد الأصناف لم يعد متاحاً");
      }
      const modifiers = await resolveSelectedModifiers(table.companyId, item.baseItem, raw.modifiers, item.menuItem.vatIncluded);
      const total = calculateRestaurantOrderTotals([{
        menuItemId, erpItemId: item.menuItem.itemId, qty,
        price: item.menuItem.price, vatIncluded: item.menuItem.vatIncluded,
        vatRate: item.baseItem.vatRate, modifiers,
      }]).total;
      prepared.push({ item: item.menuItem, qty, modifiers, total });
    }
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "تعذر التحقق من الطلب" }); return;
  }

  try {
    const createdOrder = await db.transaction(async tx => {
      const [locked] = await tx.select().from(posTablesTable).where(and(
        eq(posTablesTable.id, table.id), eq(posTablesTable.publicOrderToken, token),
        eq(posTablesTable.isActive, true),
      )).for("update").limit(1);
      if (!locked) throw Object.assign(new Error("رابط الطاولة غير متاح"), { status: 404 });
      let orderId = locked.currentOrderId;
      let number: string;
      if (orderId) {
        const [existing] = await tx.select().from(posOrdersTable).where(and(
          eq(posOrdersTable.id, orderId), eq(posOrdersTable.companyId, locked.companyId),
        )).limit(1);
        if (!existing || existing.status !== "open") {
          throw Object.assign(new Error("الطاولة قيد الخدمة، اطلب مساعدة الموظف"), { status: 409 });
        }
        number = existing.orderNumber;
      } else {
        const dateKey = new Date().toISOString().slice(0, 10).replaceAll("-", "");
        const numberPattern = `QR-${dateKey}-%`;
        const [{ count }] = await tx.select({ count: sql<number>`COUNT(*)::int` })
          .from(posOrdersTable).where(and(
            eq(posOrdersTable.companyId, locked.companyId),
            sql`${posOrdersTable.orderNumber} LIKE ${numberPattern}`,
          ));
        number = `QR-${dateKey}-${String(Number(count) + 1).padStart(5, "0")}`;
        const [created] = await tx.insert(posOrdersTable).values({
          companyId: locked.companyId, branchId: locked.branchId, tableId: locked.id,
          orderNumber: number, channel: "dine_in", status: "open", guestCount: 1,
          notes: "طلب ذاتي عبر QR - بانتظار تأكيد الموظف",
        }).returning({ id: posOrdersTable.id });
        orderId = created.id;
        await tx.update(posTablesTable).set({ status: "occupied", currentOrderId: orderId, updatedAt: new Date() })
          .where(eq(posTablesTable.id, locked.id));
      }
      await tx.insert(posOrderItemsTable).values(prepared.map(({ item, qty, modifiers, total }) => ({
        orderId: orderId!, menuItemId: item.id, nameSnapshot: item.nameAr,
        qty: String(qty), price: item.price, total, modifiers,
        kitchenStation: item.kitchenStation, status: "pending" as const,
      })));
      return { orderNumber: number, orderId };
    });
    const totalsLines = await db.select({
      menuItemId: posOrderItemsTable.menuItemId,
      erpItemId: posMenuItemsTable.itemId,
      qty: posOrderItemsTable.qty, price: posOrderItemsTable.price,
      modifiers: posOrderItemsTable.modifiers,
      vatIncluded: posMenuItemsTable.vatIncluded, vatRate: itemsTable.vatRate,
    }).from(posOrderItemsTable)
      .leftJoin(posMenuItemsTable, and(
        eq(posMenuItemsTable.id, posOrderItemsTable.menuItemId),
        eq(posMenuItemsTable.companyId, table.companyId),
      ))
      .leftJoin(itemsTable, and(
        eq(itemsTable.id, posMenuItemsTable.itemId), eq(itemsTable.companyId, table.companyId),
      )).where(eq(posOrderItemsTable.orderId, createdOrder.orderId));
    const totals = calculateRestaurantOrderTotals(totalsLines);
    await db.update(posOrdersTable).set({ ...totals, updatedAt: new Date() })
      .where(and(eq(posOrdersTable.id, createdOrder.orderId), eq(posOrdersTable.companyId, table.companyId)));
    res.status(201).json({ orderNumber: createdOrder.orderNumber });
  } catch (error: any) {
    res.status(error?.status ?? 500).json({ error: error?.status ? error.message : "تعذر إنشاء الطلب" });
  }
});

export default router;
