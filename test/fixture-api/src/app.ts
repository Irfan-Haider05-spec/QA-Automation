import express from "express";
import router from "./app/routes";
import config from "./config";
const app = express(); // planted: x-powered-by left on
const allowed = [config.client_url, "http://localhost:3000", `http://127.0.0.1:${config.port}`].filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (!allowed.includes(origin)) return next(new Error(`Origin ${origin} not allowed by CORS`)); // → 500, like the real backend
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json());
app.get("/health", (_req, res) => res.json({ success: true, uptime: process.uptime() }));
app.use("/api/v1", router);
// planted: a malformed JSON body returns the stack trace
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ success: false, message: err.message, ...(err.type === "entity.parse.failed" ? { stack: err.stack } : {}) }));
app.use((req, res) => res.status(404).json({ success: false, message: "Not Found", errorMessages: [{ path: req.originalUrl, message: "API DOESN'T EXIST" }] }));
export default app;
