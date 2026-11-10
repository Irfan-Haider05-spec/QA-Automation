import express from "express";
import { fileURLToPath } from "node:url";
import app from "./app";
import config from "./config";
import { attachRealtime } from "./realtime";

// Fixture dashboard (test/fixture-web), served from the same origin as the API.
// theme.css is dynamic so the self-test can simulate a visual change (FIXTURE_THEME=shifted).
const shell = express.Router();
shell.get("/theme.css", (_req, res) => {
  const shifted = process.env.FIXTURE_THEME === "shifted";
  res.type("text/css").send(
    `body{font-family:Arial,sans-serif;margin:0;background:${shifted ? "#fde68a" : "#f8fafc"};color:#111}` +
      `nav{padding:12px 20px;background:${shifted ? "#7c2d12" : "#1e3a8a"}}nav a{color:#fff;margin-right:8px}main{padding:20px}`,
  );
});
// planted: a source map for the dashboard bundle
shell.get("/app.js.map", (_req, res) => res.json({ version: 3, file: "app.js", sources: ["src/app.ts"], mappings: "" }));
shell.use(express.static(fileURLToPath(new URL("../../fixture-web", import.meta.url))));
const server = express();
// planted for the passive scan: version in the Server header, a readable .env, a directory listing
server.use((_req, res, next) => { res.setHeader("server", "FixtureServer/1.4.2"); next(); });
server.get("/.env", (_req, res) => res.type("text/plain").send("NODE_ENV=production\nPORT=4011\nLOG_LEVEL=info\n"));
server.get("/uploads/", (_req, res) => res.type("html").send("<html><head><title>Index of /uploads/</title></head><body><a href=\"a.png\">a.png</a></body></html>"));
server.use("/web", shell);
server.use(app);
const http = server.listen(config.port, "127.0.0.1", () => console.log(`fixture api on :${config.port}`));
attachRealtime(http);
