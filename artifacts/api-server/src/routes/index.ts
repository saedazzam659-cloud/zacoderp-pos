import { Router, type IRouter } from "express";
import healthRouter from "./health";
import companiesRouter from "./companies";
import customersRouter from "./customers";
import invoicesRouter from "./invoices";
import dashboardRouter from "./dashboard";
import deviceInfoRouter from "./device-info";
import zatcaRouter from "./zatca";
import authRouter from "./auth";
import superAdminAuthRouter from "./superAdminAuth";
import suppliersRouter from "./suppliers";
import adminRouter from "./admin";
import resellersAdminRouter from "./resellers-admin";
import resellerRouter from "./reseller";
import partnersAdminRouter from "./partners-admin";
import publishRouter from "./publish";
import partnerRouter from "./partner-portal";
import gatewayClientsRouter from "./gatewayClients";
import integrationsRouter, { inboundRouter as integrationsInboundRouter } from "./integrations";
import adminDbStatsRouter from "./admin-db-stats";
import adminSeoRouter from "./admin-seo";
import adminAiControlsRouter from "./admin-ai-controls";
import seoRouter from "./seo";
import reportsRouter from "./reports";
import inventoryRouter from "./inventory";
import accountsRouter from "./accounts";
import taxesRouter from "./taxes";
import branchesRouter from "./branches";
import journalEntriesRouter from "./journalEntries";
import trialBalancesRouter from "./trial-balances";
import currenciesRouter from "./currencies";
import accountingReportsRouter from "./reports-accounting";
import purchasingRouter from "./purchasing";
import goodsReceiptsRouter from "./goodsReceipts";
import goodsDeliveriesRouter from "./goodsDeliveries";
import salesRouter from "./sales";
import postingCenterRouter from "./posting-center";
import salesAnalyticsRouter from "./sales-analytics";
import purchasesAnalyticsRouter from "./purchases-analytics";
import cashBoxesRouter from "./cash-boxes";
import bankAccountsRouter from "./bank-accounts";
import receiptVouchersRouter from "./receipt-vouchers";
import paymentVouchersRouter from "./payment-vouchers";
import cashTransfersRouter from "./cash-transfers";
import cashAnalyticsRouter from "./cash-analytics";
import bankReconciliationRouter from "./bank-reconciliation";
import aiRouter from "./ai";
import usersRouter from "./users";
import fiscalPeriodsRouter from "./fiscal-periods";
import adjustmentsRouter from "./adjustments";
import costCentersRouter from "./cost-centers";
import employeesRouter from "./employees";
import employeeCustodiesRouter from "./employee-custodies";
import hrSettingsRouter from "./hr-settings";
import hrReportsRouter from "./hr-reports";
import storageRouter from "./storage";
import documentArchivesRouter from "./document-archives";
import posSessionsRouter from "./pos-sessions";
import posTerminalsRouter from "./pos-terminals";
import posRestaurantRouter from "./pos-restaurant";
import posRouter from "./pos";
import notificationsRouter from "./notifications";
import supportMessagesRouter from "./support-messages";
import accountingMappingsRouter from "./accounting-mappings";
import backupRouter from "./backup";
import dataIoRouter from "./data-io";
import salesRepsRouter from "./sales-reps";
import auditLogRouter from "./audit-log";
import workSessionsRouter from "./work-sessions";
import workSessionSettingsRouter from "./work-session-settings";
import invoiceFieldPoliciesRouter from "./invoice-field-policies";
import voiceAssistantRouter from "./voice-assistant";
import sessionsRouter from "./sessions";
import sequencesRouter from "./sequences";
import offersRouter from "./offers";
import adminModulesRouter from "./adminModules";
import adminIndustriesRouter from "./adminIndustries";
import adminDataCopyRouter from "./admin-data-copy";
import companyCloningRouter from "./companyCloning";
import productionRouter from "./production";
import safetyRouter from "./safety";
import faceAttendanceRouter from "./faceAttendance";
import fieldServiceRouter from "./fieldService";
import securityEventsRouter from "./security-events";
import surveillanceDevicesRouter from "./surveillance-devices";
import securityAiRouter from "./security-ai";
import securityReportsRouter from "./security-reports";
import inboxRouter from "./inbox";
import aiReportsRouter from "./ai-reports";
import dataDoctorRouter from "./data-doctor";
import printDesignerRouter from "./print-designer";
import contractingRouter from "./contracting";
import contractingAiRouter from "./contracting-ai";
import maintenanceRouter from "./maintenance";
import installmentsRouter from "./installments";
import hotelRouter from "./hotel";
import hotelAiRouter from "./hotel-ai";
import hospitalRouter from "./hospital";
import hospitalAiRouter from "./hospital-ai";
import crmRouter from "./crm";
import crmAiRouter from "./crm-ai";
import fixedAssetsRouter from "./fixed-assets";
import fixedAssetsAiRouter from "./fixed-assets-ai";
import onlineStoreRouter from "./online-store";
import onlineStoreAiRouter from "./online-store-ai";
import posOperationsRouter from "./pos-operations";
import chatRouter from "./chat";
import chatAiRouter from "./chat-ai";
import supportAiRouter from "./support-ai";
import accountingAiRouter from "./accounting-ai";
import cobrowseRouter from "./cobrowse";
import posOperationsAiRouter from "./pos-operations-ai";
import reportInvitationsRouter from "./report-invitations";
import realtimeRouter from "./realtime";
import userTrackingRouter from "./userTracking";
import sisterCompaniesRouter from "./sister-companies";
import accountNotesRouter from "./account-notes";
import deviceLicensesRouter from "./device-licenses";
import posDesktopSyncRouter from "./pos-desktop-sync";
import adminPosDevicesRouter from "./admin-pos-devices";
import adminOfflineLicensesRouter from "./admin-offline-licenses";
import publicDownloadRouter from "./public-download";
import publicOfflineRouter from "./public-offline";
import downloadWizardRouter from "./download-wizard";
import adminDownloadCodesRouter from "./admin-download-codes";
import domainsRouter from "./domains";
import devCloudAdminRouter from "./dev-cloud-admin";
import extensionsRouter from "../extensions/index.js";
import { marketplaceRouter, marketplaceAdminRouter } from "./marketplace.js";
import { resolveDomainCompany } from "../middleware/domainResolver";

const router: IRouter = Router();

// Multi-Domain Management — best-effort host→company resolution. Sets
// req.domainCompanyId (FALLBACK only; see auth.ts resolveCompanyId). Mounted
// first so it runs for every /api request; it never throws or blocks.
router.use(resolveDomainCompany);

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/auth/superadmin", superAdminAuthRouter);
// MUST be mounted BEFORE zatcaRouter (which is path-less and globally requires
// auth via requireAuthed). The SSE endpoint authenticates via ?token=… query
// param itself and would otherwise be 401-ed by zatca's middleware.
router.use("/realtime", realtimeRouter);
router.use("/reports-invitations", reportInvitationsRouter);
router.use("/admin/modules", adminModulesRouter);
router.use("/admin/industries", adminIndustriesRouter);
router.use("/admin/data-doctor", dataDoctorRouter);
router.use("/admin/data-copy", adminDataCopyRouter);
router.use("/admin/company-cloning", companyCloningRouter);
router.use("/admin/seo", adminSeoRouter);
router.use("/admin/ai-controls", adminAiControlsRouter);
router.use("/admin/db-stats", adminDbStatsRouter);
router.use("/admin/gateway-clients", gatewayClientsRouter);
router.use("/admin/domains", domainsRouter);
// Reseller (Agent) management — Task #237. Both routers MUST be mounted BEFORE
// the path-less zatcaRouter: the reseller portal uses its own bearer token
// (absent from usersTable) and would otherwise be 401-ed by zatca's global
// tenant-auth catch-all. The admin router self-guards with requireSuperAdmin.
router.use("/admin/resellers", resellersAdminRouter);
router.use("/reseller", resellerRouter);
// Developer & Partner Control Center — Phase 1 (additive, SuperAdmin-only).
// Same mount-before-zatcaRouter rationale; self-guards with requireSuperAdmin.
router.use("/admin/partners", partnersAdminRouter);
// Developer Cloud (Workspaces) — Phase 5 (additive, SuperAdmin-only). Same
// mount-before-zatcaRouter rationale; self-guards with requireSuperAdmin.
router.use("/admin/dev-cloud", devCloudAdminRouter);
// Phase 3 Publish Engine. Same mount-before-zatcaRouter rationale; SuperAdmin self-guarded.
router.use("/admin/publish", publishRouter);
// Developer / Partner self-service portal. Same mount-before-zatcaRouter
// rationale as the reseller portal: partner bearer tokens live in
// platform_partners (absent from usersTable) and self-guard via requirePartner.
router.use("/partner", partnerRouter);
// Phase 4 Marketplace Control Center. Same mount-before-zatcaRouter rationale; SuperAdmin self-guarded.
router.use("/admin/marketplace", marketplaceAdminRouter);
router.use("/integrations", integrationsRouter);
router.use("/integrations/inbound", integrationsInboundRouter);
router.use("/admin", adminRouter);
router.use("/seo", seoRouter);
router.use("/companies", companiesRouter);
router.use("/customers", customersRouter);
router.use("/suppliers", suppliersRouter);
router.use("/invoices", invoicesRouter);
router.use("/dashboard", dashboardRouter);
router.use("/reports", reportsRouter);
router.use("/inventory", inventoryRouter);
router.use("/accounts", accountsRouter);
router.use("/taxes", taxesRouter);
router.use("/org", branchesRouter);
router.use("/journal-entries", journalEntriesRouter);
router.use("/trial-balances", trialBalancesRouter);
router.use("/currencies", currenciesRouter);
router.use("/accounting-reports", accountingReportsRouter);
router.use("/purchasing", purchasingRouter);
router.use("/goods-receipts", goodsReceiptsRouter);
router.use("/goods-deliveries", goodsDeliveriesRouter);
router.use("/sales", salesRouter);
router.use("/posting-center", postingCenterRouter);
router.use("/sales-analytics", salesAnalyticsRouter);
router.use("/purchases-analytics", purchasesAnalyticsRouter);
router.use("/cash-boxes",         cashBoxesRouter);
router.use("/bank-accounts",      bankAccountsRouter);
router.use("/receipt-vouchers",   receiptVouchersRouter);
router.use("/payment-vouchers",   paymentVouchersRouter);
router.use("/cash-transfers",     cashTransfersRouter);
router.use("/cash-analytics",     cashAnalyticsRouter);
router.use("/bank-reconciliation", bankReconciliationRouter);
router.use("/ai",                 aiRouter);
router.use("/production",         productionRouter);
router.use("/safety",             safetyRouter);
router.use("/users",              usersRouter);
router.use("/work-sessions",      workSessionsRouter);
router.use("/work-session-settings", workSessionSettingsRouter);
router.use("/invoice-field-policies", invoiceFieldPoliciesRouter);
router.use("/voice-assistant",    voiceAssistantRouter);
router.use("/sessions",           sessionsRouter);
router.use("/fiscal",             fiscalPeriodsRouter);
router.use("/adjustments",        adjustmentsRouter);
router.use("/cost-centers",       costCentersRouter);
router.use("/employees",          employeesRouter);
router.use("/hr/custodies",       employeeCustodiesRouter);
router.use("/hr/settings",        hrSettingsRouter);
router.use("/hr/reports",         hrReportsRouter);
router.use("/hr/face",            faceAttendanceRouter);
router.use("/hr/field",           fieldServiceRouter);
router.use("/user-tracking",      userTrackingRouter);
router.use("/security-events",    securityEventsRouter);
router.use("/surveillance-devices", surveillanceDevicesRouter);
router.use("/security-ai",        securityAiRouter);
router.use("/security-reports",   securityReportsRouter);
router.use(storageRouter);
router.use("/document-archives", documentArchivesRouter);
router.use("/pos-sessions", posSessionsRouter);
router.use("/pos-terminals", posTerminalsRouter);
router.use("/pos-restaurant", posRestaurantRouter);
router.use("/pos", posRouter);
router.use("/notifications", notificationsRouter);
router.use("/inbox", inboxRouter);
router.use("/ai-reports", aiReportsRouter);
router.use("/support-messages", supportMessagesRouter);
router.use("/accounting-mappings", accountingMappingsRouter);
router.use("/backup", backupRouter);
router.use("/data-io", dataIoRouter);
router.use("/sales-reps", salesRepsRouter);
router.use("/audit-log", auditLogRouter);
router.use("/sequences", sequencesRouter);
router.use("/offers", offersRouter);
router.use(deviceInfoRouter);
// ─── Windows Desktop POS (Task #174) — additive only ──────────────────
// MUST be mounted BEFORE path-less zatcaRouter (which applies a catch-all
// auth check on unmatched /api/* requests). All endpoints feature-flag
// gated via companies.enable_offline_pos (default false).
router.use("/public/download", publicDownloadRouter);
router.use("/public/offline", publicOfflineRouter);
router.use("/download-wizard", downloadWizardRouter);
router.use("/device-licenses", deviceLicensesRouter);
router.use("/sync", posDesktopSyncRouter);
router.use("/admin/pos-devices", adminPosDevicesRouter);
router.use("/admin/offline-licenses", adminOfflineLicensesRouter);
router.use("/admin/download-codes", adminDownloadCodesRouter);
// ─── Extension Platform (Phase 0) — additive "outer shell" ────────────────
// MUST be mounted BEFORE the path-less zatcaRouter (its catch-all 401s any
// unmatched /api/* request). The screen/api endpoints authenticate via a
// ?token= query param (sandboxed iframe cannot set headers) handled inside
// the router. Gated by the `extensions_platform` company module (default OFF).
router.use("/ext", extensionsRouter);
// Phase 4 Marketplace — tenant storefront (module-gated; self-guards auth).
router.use("/marketplace", marketplaceRouter);
router.use(zatcaRouter);
router.use("/contracting", contractingRouter);
router.use("/contracting-ai", contractingAiRouter);
router.use("/maintenance", maintenanceRouter);
router.use("/installments", installmentsRouter);
router.use("/hotel", hotelRouter);
router.use("/hotel-ai", hotelAiRouter);
router.use("/hospital", hospitalRouter);
router.use("/hospital-ai", hospitalAiRouter);
router.use("/crm", crmRouter);
router.use("/crm-ai", crmAiRouter);
router.use("/fixed-assets", fixedAssetsRouter);
router.use("/fixed-assets-ai", fixedAssetsAiRouter);
router.use("/online-store", onlineStoreRouter);
router.use("/online-store-ai", onlineStoreAiRouter);
router.use("/pos-operations", posOperationsRouter);
router.use("/pos-operations-ai", posOperationsAiRouter);
router.use("/chat", chatRouter);
router.use("/chat-ai", chatAiRouter);
router.use("/support-ai", supportAiRouter);
router.use("/accounting-ai", accountingAiRouter);
router.use("/cobrowse", cobrowseRouter);
router.use("/print-designer", printDesignerRouter);
router.use("/sister-companies", sisterCompaniesRouter);
router.use("/account-notes", accountNotesRouter);

export default router;
