import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { Vault } from "./lib/crypto.js";
import { errorHandler } from "./lib/http.js";
import router from "./routes/index.js";
import { metricsHandler, requestObserver } from "./lib/observe.js";

export function createApp(db: Db, config: Config) {
  const app = express();
  app.locals.deps = { db, config, vault: new Vault(config.VAULT_MASTER_KEY) };
  app.disable("x-powered-by");
  if (config.NODE_ENV === "production") app.set("trust proxy", config.TRUST_PROXY);

  app.use(requestObserver(config));
  app.use(helmet());
  const origins = config.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  // Unknown origins get no CORS headers (the browser blocks them) instead of an error response
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || origins.includes(origin)), credentials: true }));
  app.use(express.json({ limit: "10mb" }));

  if (config.NODE_ENV !== "test") {
    app.use("/api/v1", rateLimit({ windowMs: 60_000, limit: config.RATE_LIMIT_PER_MINUTE, standardHeaders: "draft-7", legacyHeaders: false }));
    app.use(["/api/v1/auth/login", "/api/v1/auth/signup", "/api/v1/auth/refresh", "/api/v1/auth/forgot-password", "/api/v1/auth/reset-password", "/api/v1/auth/verify-email"], rateLimit({ windowMs: 60_000, limit: config.AUTH_RATE_LIMIT_PER_MINUTE, standardHeaders: "draft-7", legacyHeaders: false }));
  }

  app.get("/health", async (_req, res) => {
    try {
      await db.raw("select 1");
      res.json({ ok: true, uptime: process.uptime() });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.get("/metrics", metricsHandler(db, config));
  app.use("/api/v1", router);
  app.use((req, res) => res.status(404).json({ error: { code: "not_found", message: `No route for ${req.method} ${req.path}` } }));
  app.use(errorHandler);
  return app;
}
