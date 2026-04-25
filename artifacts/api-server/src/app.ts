import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Disable ETag generation to prevent 304 stale responses
app.set("etag", false);

// Trust the first proxy hop (Replit's edge proxy) so `req.ip` reflects the
// real client IP from X-Forwarded-For instead of the proxy's loopback
// address. SuperAdmin rate-limiting and risk-scoring rely on this — without
// it, every request looks like it comes from 127.0.0.1 and an attacker can
// trivially defeat per-IP throttles by spoofing the header. With trust=1,
// Express only uses the *last* X-Forwarded-For entry (set by the trusted
// proxy) and ignores client-injected leftmost values.
app.set("trust proxy", 1);

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
// Bumped from 100kb default so the Settings → Data Import/Export wizard
// can post realistic Excel/CSV payloads (5k–20k rows ≈ several MB of JSON).
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

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
