import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CreateEstimatedManufacturingCostPoolTemplateBody,
  UpdateEstimatedManufacturingCostPoolTemplateBody,
} from "@workspace/api-zod";

const validTemplate = {
  code: "PACKAGING_OVERHEAD",
  nameAr: "تكلفة التعبئة",
  description: "تكاليف تعبئة غير مباشرة",
  allocationBasis: "production_quantity",
  actualExpenseAccountId: 101,
  absorbedAccountId: 202,
  varianceAccountId: 303,
};

test("estimated pool template contracts validate reusable company settings", () => {
  assert.equal(CreateEstimatedManufacturingCostPoolTemplateBody.safeParse(validTemplate).success, true);
  assert.equal(UpdateEstimatedManufacturingCostPoolTemplateBody.safeParse(validTemplate).success, true);
  assert.equal(
    CreateEstimatedManufacturingCostPoolTemplateBody.safeParse({
      ...validTemplate,
      code: "bad code",
    }).success,
    false,
  );
  assert.equal(
    CreateEstimatedManufacturingCostPoolTemplateBody.safeParse({
      ...validTemplate,
      allocationBasis: "unknown",
    }).success,
    false,
  );
});

test("estimated pool template CRUD stays company-scoped and does not mutate monthly pools", async () => {
  const [routes, ui, schema] = await Promise.all([
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../../zatca-invoicing/src/pages/simple-manufacturing/EstimatedCostPoolsPanel.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../lib/db/src/schema/production.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(routes, /get\("\/estimated-costing\/pool-templates"/);
  assert.match(routes, /post\("\/estimated-costing\/pool-templates"/);
  assert.match(routes, /put\("\/estimated-costing\/pool-templates\/:id"/);
  assert.match(routes, /delete\("\/estimated-costing\/pool-templates\/:id"/);
  assert.match(routes, /eq\(productionEstimatedCostPoolTemplatesTable\.companyId, cid\)/);
  assert.match(routes, /validateEstimatedCostPoolTemplateAccounts/);

  assert.match(ui, /method: isEditing \? "PUT" : "POST"/);
  assert.match(ui, /method: "DELETE"/);
  assert.match(ui, /القوالب الجاهزة ثابتة/);
  assert.match(ui, /custom:\$\{template\.id\}/);

  assert.match(schema, /production_estimated_cost_pool_templates/);
  assert.match(schema, /companyCodeUnique: uniqueIndex\("prod_est_cost_pool_template_company_code_uniq"\)/);
});
