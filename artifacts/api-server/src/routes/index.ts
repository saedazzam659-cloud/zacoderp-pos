import { Router, type IRouter } from "express";
import healthRouter from "./health";
import companiesRouter from "./companies";
import customersRouter from "./customers";
import invoicesRouter from "./invoices";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/companies", companiesRouter);
router.use("/customers", customersRouter);
router.use("/invoices", invoicesRouter);
router.use("/dashboard", dashboardRouter);

export default router;
