// Focused browser regression for task #451.
//
// The browser drives the production SPA and API. Database access is used only
// to create an isolated tenant plus commercial/report fixtures that have no
// unrelated UI prerequisite, and to remove that exact tenant afterwards.
//
// Required setup:
//   E2E_BASE_URL=<running zatca-invoicing URL>
//   DATABASE_URL=<the database used by that running API>
//   E2E_CONTRACTING_ISOLATED=1
//
// Run only this regression:
//   pnpm --filter @workspace/api-server exec playwright test \
//     --config=playwright.config.ts contracting-project-boundaries.spec.ts

import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  branchesTable,
  companiesTable,
  contractingContractBoqLinesTable,
  contractingOwnerContractsTable,
  contractingProgressBillsTable,
  contractingProjectsTable,
  contractingWorkItemsTable,
  db,
  sequencesTable,
  usersTable,
} from "@workspace/db";

const armed = process.env.E2E_CONTRACTING_ISOLATED === "1";
const suffix = randomBytes(5).toString("hex");
const tag = `e2e451_${suffix}`;
const companyCode = `E451${suffix}`.toUpperCase();
const sessionToken = `${tag}_token_${randomBytes(12).toString("hex")}`;
const sessionId = `${tag}_session`;
const parentName = `${tag} المشروع الرئيسي`;
const childName = `${tag} المشروع الفرعي`;
const parentContractNumber = `${tag}-PARENT`;
const childContractA = `${tag}-CHILD-A`;
const childContractB = `${tag}-CHILD-B`;
const concreteItem = `${tag} خرسانة`;
const steelItem = `${tag} حديد`;

let companyId: number | null = null;
let branchId: number | null = null;
let userId: number | null = null;
let parentProjectId: number | null = null;
let childProjectId: number | null = null;

test.skip(!armed, "Set E2E_CONTRACTING_ISOLATED=1 to allow creation of the disposable tenant.");
test.describe.configure({ mode: "serial" });

async function installTenantSession(page: Page) {
  await page.addInitScript(({ token, sid }) => {
    localStorage.setItem("zatca_token", token);
    localStorage.setItem("zatca_session", sid);
  }, { token: sessionToken, sid: sessionId });
}

async function choose(page: Page, testId: string, optionText: string) {
  const picker = page.getByTestId(testId);
  await picker.click();
  await picker.fill(optionText);
  await page.locator("[data-idx]").filter({ hasText: optionText }).click();
}

async function createProject(page: Page, name: string, parent?: string) {
  await page.getByRole("button", { name: "مشروع جديد" }).click();
  await page.getByTestId("input-project-name-ar").fill(name);
  await choose(page, "project-branch-picker", tag);
  if (parent) await choose(page, "project-parent-picker", parent);
  // FormPanel renders the footer outside the heading's immediate card
  // subtree; the open form has one visible exact "حفظ" control.
  await page.getByRole("button", { name: /^حفظ$/ }).click();
  await expect(page.getByText("تم إنشاء المشروع", { exact: true }).first()).toBeVisible();
  // The responsive list renders a hidden mobile card before the desktop row.
  await expect(page.getByText(name, { exact: true }).last()).toBeVisible();
}

test.beforeAll(async () => {
  const [company] = await db.insert(companiesTable).values({
    nameAr: `${tag} شركة اختبار معزولة`,
    nameEn: `${tag} isolated test tenant`,
    code: companyCode,
    vatNumber: `3${randomBytes(7).toString("hex").replace(/[a-f]/g, "0").slice(0, 13)}1`,
    crNumber: tag,
    city: "Riyadh",
    street: "Playwright",
    buildingNumber: "451",
    postalCode: "12345",
    isSandbox: true,
  }).returning({ id: companiesTable.id });
  companyId = company.id;

  const [branch] = await db.insert(branchesTable).values({
    companyId,
    code: `${tag}-BR`,
    nameAr: `${tag} فرع الاختبار`,
    nameEn: `${tag} test branch`,
    city: "Riyadh",
    isMain: true,
    status: "active",
  }).returning({ id: branchesTable.id });
  branchId = branch.id;

  const [user] = await db.insert(usersTable).values({
    companyId,
    username: `${tag}_admin`,
    passwordHash: "browser-session-fixture-not-password-login",
    role: "admin",
    nameAr: `${tag} مسؤول الاختبار`,
    sessionToken,
    sessionId,
    sessionChannel: "web",
    isActive: true,
    viewAllBranches: true,
    securityNoticeExempt: true,
  }).returning({ id: usersTable.id });
  userId = user.id;

  await db.insert(sequencesTable).values({
    companyId,
    code: `${tag}-PROJECT`,
    nameAr: `${tag} مسلسل المشاريع`,
    prefix: "E451-",
    currentNumber: 1,
    startNumber: 1,
    endNumber: 9999,
    padLength: 4,
    transactionTypes: ["contracting_project"],
    branchIds: [branchId],
  });
});

test.afterAll(async () => {
  if (!companyId) return;
  // Re-discover the exact generated projects in case the UI write succeeded
  // immediately before an assertion/ID capture failed. Never clean by a
  // non-tenant-scoped name or by IDs from any other company.
  const ownedProjects = await db.select({ id: contractingProjectsTable.id })
    .from(contractingProjectsTable)
    .where(and(
      eq(contractingProjectsTable.companyId, companyId),
      inArray(contractingProjectsTable.nameAr, [parentName, childName]),
    ));
  const projectIds = [...new Set([
    ...ownedProjects.map(row => row.id),
    ...(parentProjectId ? [parentProjectId] : []),
    ...(childProjectId ? [childProjectId] : []),
  ])];
  if (projectIds.length) {
    const ownedContracts = await db.select({ id: contractingOwnerContractsTable.id })
      .from(contractingOwnerContractsTable)
      .where(and(
        eq(contractingOwnerContractsTable.companyId, companyId),
        inArray(contractingOwnerContractsTable.projectId, projectIds),
      ));
    const contractIds = ownedContracts.map(row => row.id);
    await db.delete(contractingProgressBillsTable).where(and(
      eq(contractingProgressBillsTable.companyId, companyId),
      inArray(contractingProgressBillsTable.projectId, projectIds),
    ));
    await db.delete(contractingContractBoqLinesTable).where(and(
      eq(contractingContractBoqLinesTable.companyId, companyId),
      inArray(contractingContractBoqLinesTable.projectId, projectIds),
    ));
    if (contractIds.length) {
      await db.delete(contractingOwnerContractsTable).where(and(
        eq(contractingOwnerContractsTable.companyId, companyId),
        inArray(contractingOwnerContractsTable.id, contractIds),
      ));
    }
    await db.delete(contractingWorkItemsTable).where(and(
      eq(contractingWorkItemsTable.companyId, companyId),
      inArray(contractingWorkItemsTable.projectId, projectIds),
    ));
    // Child first because the hierarchy intentionally restricts deleting a
    // referenced parent. Prefer the captured ID, otherwise use the exact
    // tenant-scoped name lookup above.
    const childOwnedId = childProjectId
      ?? (await db.select({ id: contractingProjectsTable.id })
        .from(contractingProjectsTable)
        .where(and(
          eq(contractingProjectsTable.companyId, companyId),
          eq(contractingProjectsTable.nameAr, childName),
        )))[0]?.id;
    if (childOwnedId) {
      await db.delete(contractingProjectsTable).where(and(
        eq(contractingProjectsTable.companyId, companyId),
        eq(contractingProjectsTable.id, childOwnedId),
      ));
    }
    await db.delete(contractingProjectsTable).where(and(
      eq(contractingProjectsTable.companyId, companyId),
      inArray(contractingProjectsTable.id, projectIds),
    ));
  }
  // Authenticated project writes are audited by the real API middleware.
  // Those audit rows are part of this fixture too and are tenant-scoped.
  await db.delete(auditLogTable).where(eq(auditLogTable.companyId, companyId));
  await db.delete(sequencesTable).where(eq(sequencesTable.companyId, companyId));
  if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
  if (branchId) await db.delete(branchesTable).where(eq(branchesTable.id, branchId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
});

test("project hierarchy, child contract BOQ reload, contract switch reset, and explicit rollup", async ({ page }) => {
  await installTenantSession(page);
  await page.goto("/contracting/projects", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "مشاريع المقاولات" })).toBeVisible();

  // Both hierarchy records are created through the real authenticated UI.
  await createProject(page, parentName);
  [parentProjectId] = (await db.select({ id: contractingProjectsTable.id })
    .from(contractingProjectsTable)
    .where(and(
      eq(contractingProjectsTable.companyId, companyId!),
      eq(contractingProjectsTable.nameAr, parentName),
    ))).map(row => row.id);
  expect(parentProjectId).toBeGreaterThan(0);

  // The create form's parent catalogue is loaded on page mount. Refresh after
  // the first UI write so the newly-created parent is an available control
  // option for the second UI write (without creating it through the API).
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "مشاريع المقاولات" })).toBeVisible();
  await createProject(page, childName, parentName);
  [childProjectId] = (await db.select({ id: contractingProjectsTable.id })
    .from(contractingProjectsTable)
    .where(and(
      eq(contractingProjectsTable.companyId, companyId!),
      eq(contractingProjectsTable.nameAr, childName),
    ))).map(row => row.id);
  expect(childProjectId).toBeGreaterThan(0);

  const [parentContract] = await db.insert(contractingOwnerContractsTable).values({
    companyId: companyId!, projectId: parentProjectId!, contractNumber: parentContractNumber,
    contractDate: "2026-01-01", value: "1000", status: "active",
    retentionEnabled: false, vatPercent: "0",
  }).returning();
  const [contractA, contractB] = await db.insert(contractingOwnerContractsTable).values([
    {
      companyId: companyId!, projectId: childProjectId!, contractNumber: childContractA,
      contractDate: "2026-01-02", value: "2000", status: "active",
      retentionEnabled: false, vatPercent: "0",
    },
    {
      companyId: companyId!, projectId: childProjectId!, contractNumber: childContractB,
      contractDate: "2026-01-03", value: "3000", status: "active",
      retentionEnabled: false, vatPercent: "0",
    },
  ]).returning();
  const [workA, workB] = await db.insert(contractingWorkItemsTable).values([
    { companyId: companyId!, projectId: childProjectId!, code: "C451", nameAr: concreteItem, unit: "m3", plannedQty: "10" },
    { companyId: companyId!, projectId: childProjectId!, code: "S451", nameAr: steelItem, unit: "kg", plannedQty: "20" },
  ]).returning();
  const [boqA] = await db.insert(contractingContractBoqLinesTable).values({
    companyId: companyId!, projectId: childProjectId!, workItemId: workA.id,
    direction: "owner", ownerContractId: contractA.id, lineCode: "C451",
    description: concreteItem, unit: "m3", quantity: "10", unitPrice: "20", totalAmount: "200",
  }).returning();
  const [boqB] = await db.insert(contractingContractBoqLinesTable).values({
    companyId: companyId!, projectId: childProjectId!, workItemId: workB.id,
    direction: "owner", ownerContractId: contractB.id, lineCode: "S451",
    description: steelItem, unit: "kg", quantity: "20", unitPrice: "15", totalAmount: "300",
  }).returning();

  // Distinguishable, non-zero report fixtures: parent local=110, child=220,
  // therefore the explicit recursive parent scope must be 330.
  await db.insert(contractingProgressBillsTable).values([
    {
      companyId: companyId!, projectId: parentProjectId!, direction: "outgoing",
      ownerContractId: parentContract.id, billNumber: `${tag}-PB`, billDate: "2026-02-01",
      progressPercent: "11", grossAmount: "110", dueAmount: "110", netAmount: "110",
      retentionEnabled: false, vatPercent: "0", status: "approved",
      approvedByUserId: userId!, approvedAt: new Date("2026-02-01T12:00:00Z"),
    },
    {
      companyId: companyId!, projectId: childProjectId!, direction: "outgoing",
      ownerContractId: contractA.id, billNumber: `${tag}-CB`, billDate: "2026-02-02",
      progressPercent: "11", grossAmount: "220", dueAmount: "220", netAmount: "220",
      retentionEnabled: false, vatPercent: "0", status: "approved",
      approvedByUserId: userId!, approvedAt: new Date("2026-02-02T12:00:00Z"),
    },
  ]);

  await page.goto(`/contracting/projects/${childProjectId}?tab=bills&direction=outgoing&createBill=1`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("input-bill-project-name")).toHaveValue(childName);

  // The child form lists only contracts owned by the child project.
  await page.getByTestId("bill-owner-contract-picker").click();
  await expect(page.locator("[data-idx]").filter({ hasText: childContractA })).toBeVisible();
  await expect(page.locator("[data-idx]").filter({ hasText: childContractB })).toBeVisible();
  await expect(page.getByText(parentContractNumber, { exact: false })).toHaveCount(0);
  await page.locator("[data-idx]").filter({ hasText: childContractA }).click();

  const qtyA = page.getByTestId(`execution-qty-${boqA.id}`);
  await expect(qtyA).toHaveCount(1);
  await expect(page.getByText(concreteItem, { exact: false })).toHaveCount(1);
  await qtyA.fill("4");

  // Switching contracts must synchronously discard A's stale selection/line,
  // then render only B's authoritative BOQ.
  await choose(page, "bill-owner-contract-picker", childContractB);
  await expect(qtyA).toHaveCount(0);
  const qtyB = page.getByTestId(`execution-qty-${boqB.id}`);
  await expect(qtyB).toHaveCount(1);
  // Zero is represented by the input's placeholder; the actual value must be
  // empty so switching contracts cannot carry A's entered quantity into B.
  await expect(qtyB).toHaveValue("");
  await expect(page.getByText(concreteItem, { exact: false })).toHaveCount(0);

  // Load A again: one line, never an appended duplicate, and old input is gone.
  await choose(page, "bill-owner-contract-picker", childContractA);
  await expect(qtyA).toHaveCount(1);
  await expect(qtyA).toHaveValue("");
  await expect(page.getByText(concreteItem, { exact: false })).toHaveCount(1);

  await page.goto(`/contracting/projects/${parentProjectId}`, { waitUntil: "domcontentloaded" });
  // The metric value is a sibling row below the label, so scope to the card
  // rather than the label's immediate flex row.
  const localDashboard = page.getByText("إجمالي الأعمال المنفذة").locator("..").locator("..");
  await expect(localDashboard).toContainText("110");
  await page.getByTestId("toggle-project-descendants").first().click();
  const localScope = page.getByTestId("project-report-scope-local").first();
  const rollupScope = page.getByTestId("project-report-scope-rollup").first();
  await expect(localScope).toContainText("110");
  await expect(rollupScope).toContainText("330");
  await expect(rollupScope).toContainText("إجمالي المشروع مع الفروع (2 مشاريع)");
  const hierarchy = page.getByTestId("project-hierarchy-rollup");
  await expect(hierarchy).toContainText(parentName);
  await expect(hierarchy).toContainText(childName);
});