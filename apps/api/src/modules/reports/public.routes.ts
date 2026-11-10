/**
 * The only endpoint without login: a shared report, by link token.
 *
 *   GET /public/reports/:token
 *
 * Expired, revoked and unknown links all answer the same 404, and the token's
 * hash is what the database looks up.
 */
import { Router } from "express";
import { handle, notFound } from "../../lib/http.js";
import { deps } from "../../lib/context.js";
import { withContext } from "../../db/index.js";
import { sha256 } from "../../lib/crypto.js";

export const PublicReportsRouter = Router();

PublicReportsRouter.get(
  "/reports/:token",
  handle(async (req, res) => {
    const token = req.params.token;
    if (!/^qar_[\w-]{20,80}$/.test(token)) throw notFound("Report");
    const [row] = await withContext(deps(req).db, {}, (q) => q<{ snapshot: unknown; expires_at: Date }>("select * from qa_open_report($1)", [sha256(token)]));
    if (!row) throw notFound("Report");
    res.set({ "cache-control": "no-store", "x-robots-tag": "noindex" }).json({ report: row.snapshot, expiresAt: row.expires_at });
  }),
);
