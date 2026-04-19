import { Router, type IRouter } from "express";
import healthRouter from "./health";
import companiesRouter from "./companies";
import customersRouter from "./customers";
import invoicesRouter from "./invoices";
import dashboardRouter from "./dashboard";
import deviceInfoRouter from "./device-info";
import zatcaRouter from "./zatca";
import authRouter from "./auth";
import suppliersRouter from "./suppliers";
import adminRouter from "./admin";
import reportsRouter from "./reports";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/admin", adminRouter);
router.use("/companies", companiesRouter);
router.use("/customers", customersRouter);
router.use("/suppliers", suppliersRouter);
router.use("/invoices", invoicesRouter);
router.use("/dashboard", dashboardRouter);
router.use("/reports", reportsRouter);
router.use(deviceInfoRouter);
router.use(zatcaRouter);

export default router;
