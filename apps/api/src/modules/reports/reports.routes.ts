/**
 *   GET /orgs/:orgId/reports?scope=project|client&id=…&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import { handle, query, validate } from "../../lib/http.js";
import { scoped } from "../../lib/context.js";
import { computeReport, resolveScope } from "./compute.js";
import { zReportQuery } from "./period.js";

export const ReportsRouter = Router({ mergeParams: true });

ReportsRouter.get(
  "/",
  auth(),
  validate({ query: zReportQuery }),
  handle(async (req, res) => {
    const v = query<{ scope: "project" | "client"; id: string; from: string; to: string }>(req);
    const report = await scoped(req, async (q) => {
      const s = await resolveScope(q, req, v.scope, v.id);
      const [o] = await q<{ name: string }>("select name from orgs where id = app_org()");
      return computeReport(q, s, v.from, v.to, o.name);
    });
    res.json({ report });
  }),
);
