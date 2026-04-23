import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Disable ETag generation to prevent 304 stale responses
app.set("etag", false);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Prevent HTTP caching on all API responses so clients always get fresh data
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  next();
});

app.use("/api", router);

// JSON error handler — must be the LAST middleware so async errors return JSON
// (not Express's default HTML "Internal Server Error" page).
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err, url: req.url, method: req.method }, "unhandled API error");
  if (res.headersSent) return;
  const status = typeof err?.status === "number" ? err.status : 500;
  const message = err?.message || "حدث خطأ غير متوقع في الخادم";
  res.status(status).json({ error: message });
});

export default app;
