/**
 * Share links: a frozen report a software house can send to its client.
 *
 *   GET    /orgs/:orgId/report-shares
 *   POST   /orgs/:orgId/report-shares            { scope, id, from, to, expiresInDays } → link token, shown once
 *   DELETE /orgs/:orgId/report-shares/:shareId   revoke
 */
import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { handle, notFound, validate } from "../../lib/http.js";
import { audit, scoped } from "../../lib/context.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { computeReport, resolveScope } from "./compute.js";
import { zReportQuery } from "./period.js";

export const ReportSharesRouter = Router({ mergeParams: true });

const COLUMNS = `id, scope_type as "scopeType", scope_id as "scopeId", scope_name as "scopeName", to_char(period_from, 'YYYY-MM-DD') as "from",
  to_char(period_to, 'YYYY-MM-DD') as "to", expires_at as "expiresAt", revoked_at as "revokedAt", view_count as "viewCount",
  last_viewed_at as "lastViewedAt", created_at as "createdAt", (select name from users u where u.id = created_by) as "createdBy"`;

ReportSharesRouter.get(
  "/",
  auth("owner", "admin"),
  validate({}),
  handle(async (req, res) => {
    const shares = await scoped(req, (q) => q(`select ${COLUMNS} from report_shares order by created_at desc limit 100`));
    res.json({ shares });
  }),
);

ReportSharesRouter.post(
  "/",
  auth("owner", "admin"),
  validate({ body: z.intersection(zReportQuery, z.object({ expiresInDays: z.number().int().min(1).max(90).default(30) })) }),
  handle(async (req, res) => {
    const b = req.body;
    const token = `qar_${randomToken(24)}`;
    const share = await scoped(req, async (q) => {
      const s = await resolveScope(q, req, b.scope, b.id);
      const [o] = await q<{ name: string }>("select name from orgs where id = app_org()");
      const snapshot = await computeReport(q, s, b.from, b.to, o.name);
      const [row] = await q(
        `insert into report_shares (org_id, token_hash, scope_type, scope_id, scope_name, period_from, period_to, snapshot, expires_at, created_by)
         values (app_org(), $1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8), $9) returning ${COLUMNS}`,
        [sha256(token), b.scope, b.id, s.name, b.from, b.to, JSON.stringify(snapshot), b.expiresInDays, req.user!.id],
      );
      await audit(q, req, "report.shared", "report_share", row.id, { scope: b.scope, name: s.name, from: b.from, to: b.to, expiresInDays: b.expiresInDays });
      return row;
    });
    res.status(201).json({ share, token });
  }),
);

ReportSharesRouter.delete(
  "/:shareId",
  auth("owner", "admin"),
  validate({}),
  handle(async (req, res) => {
    await scoped(req, async (q) => {
      const [s] = await q<{ id: string; scope_name: string }>("update report_shares set revoked_at = now() where id = $1 and revoked_at is null returning id, scope_name", [req.params.shareId]);
      if (!s) throw notFound("Share link");
      await audit(q, req, "report.unshared", "report_share", s.id, { name: s.scope_name });
    });
    res.status(204).end();
  }),
);
