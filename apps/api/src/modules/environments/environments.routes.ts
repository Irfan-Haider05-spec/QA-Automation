/**
 * Environments: where tests run (staging API URL, dashboard URLs).
 *
 * Domain verification: no live test may target a domain the customer hasn't
 * proven they control, so the platform can't be used to attack third parties.
 * Proof is either a DNS TXT record or a file under /.well-known/.
 * Only owners/admins may mark an environment disposable (write tests allowed).
 */
import dns from "node:dns/promises";
import { Router, type Request } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { ApiError, forbidden, handle, notFound, validate, zName } from "../../lib/http.js";
import { audit, deps, loadEnvironment, loadProject, scoped } from "../../lib/context.js";
import { randomToken } from "../../lib/crypto.js";

export const EnvironmentsRouter = Router({ mergeParams: true });

const zUrl = z.string().url().max(500).refine((u) => /^https?:\/\//.test(u), "must start with http:// or https://");
const zWebApp = z.object({ name: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/), baseUrl: zUrl, loginPath: z.string().max(200).default("/login"), account: z.string().max(60).optional() });
const zEnvBody = z.object({
  name: zName,
  apiBaseUrl: zUrl.nullable().optional(),
  webApps: z.array(zWebApp).max(10).optional(),
  disposable: z.boolean().optional(),
});

const ENV_COLUMNS = `id, project_id as "projectId", name, api_base_url as "apiBaseUrl", web_apps as "webApps", disposable, domain, verified_at as "verifiedAt", created_at as "createdAt"`;

/** The host (with port) every URL of the environment must share; verification covers exactly this host */
function hostOf(apiBaseUrl?: string | null, webApps?: Array<{ baseUrl: string }>) {
  const first = apiBaseUrl ?? webApps?.[0]?.baseUrl;
  return first ? new URL(first).host.toLowerCase() : null;
}

function assertDisposableAllowed(req: Request, disposable: boolean | undefined) {
  if (disposable && !["owner", "admin"].includes(req.member!.role)) throw forbidden("Only owners and admins can mark an environment disposable");
}

const instructions = (req: Request, env: { domain: string | null; verification_token: string; api_base_url: string | null; web_apps: any[] }) => {
  if (!env.domain) return null;
  const scheme = new URL(env.api_base_url ?? env.web_apps?.[0]?.baseUrl).protocol;
  const hostname = env.domain.split(":")[0];
  return {
    domain: env.domain,
    dns: { type: "TXT", name: `_qa-verify.${hostname}`, value: `qa-verify=${env.verification_token}` },
    file: { url: `${scheme}//${env.domain}/.well-known/qa-verification.txt`, content: env.verification_token },
    httpAllowed: deps(req).config.ALLOW_HTTP_VERIFICATION,
  };
};

EnvironmentsRouter.get(
  "/",
  auth(),
  validate({}),
  handle(async (req, res) => {
    const environments = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      return q(`select ${ENV_COLUMNS} from environments where project_id = $1 order by created_at`, [req.params.projectId]);
    });
    res.json({ environments });
  }),
);

EnvironmentsRouter.post(
  "/",
  auth("owner", "admin", "developer"),
  validate({ body: zEnvBody }),
  handle(async (req, res) => {
    const b = req.body;
    assertDisposableAllowed(req, b.disposable);
    const domain = hostOf(b.apiBaseUrl, b.webApps);
    const hosts = new Set([b.apiBaseUrl, ...(b.webApps ?? []).map((w: any) => w.baseUrl)].filter(Boolean).map((u: string) => new URL(u).host.toLowerCase()));
    if (hosts.size > 1) throw new ApiError(400, "multiple_domains", "All URLs of one environment must share one host so a single verification covers them. Create one environment per host.");
    const environment = await scoped(req, async (q) => {
      await loadProject(q, req, req.params.projectId);
      const [e] = await q(
        `insert into environments (org_id, project_id, name, api_base_url, web_apps, disposable, domain, verification_token) values (app_org(), $1, $2, $3, $4, $5, $6, $7) returning ${ENV_COLUMNS}`,
        [req.params.projectId, b.name, b.apiBaseUrl ?? null, JSON.stringify(b.webApps ?? []), b.disposable ?? false, domain, randomToken(18)],
      );
      await audit(q, req, "environment.created", "environment", e.id, { name: b.name, domain, disposable: b.disposable ?? false });
      return e;
    });
    res.status(201).json({ environment });
  }),
);

EnvironmentsRouter.patch(
  "/:environmentId",
  auth("owner", "admin", "developer"),
  validate({ body: zEnvBody.partial() }),
  handle(async (req, res) => {
    const b = req.body;
    assertDisposableAllowed(req, b.disposable);
    const environment = await scoped(req, async (q) => {
      const cur = await loadEnvironment(q, req, req.params.projectId, req.params.environmentId);
      const apiBaseUrl = b.apiBaseUrl !== undefined ? b.apiBaseUrl : cur.api_base_url;
      const webApps = b.webApps ?? cur.web_apps;
      const hosts = new Set([apiBaseUrl, ...webApps.map((w: any) => w.baseUrl)].filter(Boolean).map((u: string) => new URL(u).host.toLowerCase()));
      if (hosts.size > 1) throw new ApiError(400, "multiple_domains", "All URLs of one environment must share one host");
      const domain = hostOf(apiBaseUrl, webApps);
      const domainChanged = domain !== cur.domain;
      const [e] = await q(
        `update environments set name = coalesce($2, name), api_base_url = $3, web_apps = $4, disposable = coalesce($5, disposable), domain = $6,
           verified_at = case when $7::boolean then null else verified_at end,
           verification_token = case when $7::boolean then $8 else verification_token end
         where id = $1 returning ${ENV_COLUMNS}`,
        [cur.id, b.name ?? null, apiBaseUrl, JSON.stringify(webApps), b.disposable ?? null, domain, domainChanged, randomToken(18)],
      );
      await audit(q, req, "environment.updated", "environment", cur.id, { ...b, domainChanged });
      return e;
    });
    res.json({ environment });
  }),
);

EnvironmentsRouter.delete(
  "/:environmentId",
  auth("owner", "admin"),
  validate({}),
  handle(async (req, res) => {
    await scoped(req, async (q) => {
      const e = await loadEnvironment(q, req, req.params.projectId, req.params.environmentId);
      await q("delete from environments where id = $1", [e.id]);
      await audit(q, req, "environment.deleted", "environment", e.id, { name: e.name });
    });
    res.status(204).end();
  }),
);

EnvironmentsRouter.get(
  "/:environmentId/verification",
  auth("owner", "admin", "developer"),
  validate({}),
  handle(async (req, res) => {
    const out = await scoped(req, async (q) => {
      const e = await loadEnvironment(q, req, req.params.projectId, req.params.environmentId);
      return { verified: !!e.verified_at, verifiedAt: e.verified_at, instructions: instructions(req, e) };
    });
    res.json(out);
  }),
);

async function checkDns(hostname: string, token: string) {
  try {
    const records = await dns.resolveTxt(`_qa-verify.${hostname}`);
    return records.some((parts) => parts.join("").trim() === `qa-verify=${token}`);
  } catch {
    return false;
  }
}

async function checkFile(url: string, token: string) {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000) });
    if (!r.ok) return false;
    return (await r.text()).trim() === token;
  } catch {
    return false;
  }
}

EnvironmentsRouter.post(
  "/:environmentId/verify",
  auth("owner", "admin", "developer"),
  validate({}),
  handle(async (req, res) => {
    const e = await scoped(req, (q) => loadEnvironment(q, req, req.params.projectId, req.params.environmentId));
    const ins = instructions(req, e);
    if (!ins) throw new ApiError(400, "no_domain", "Add an API or dashboard URL to this environment first");
    if (e.verified_at) return res.json({ verified: true, method: "already", verifiedAt: e.verified_at });
    const isHttp = ins.file.url.startsWith("http://");
    const viaDns = await checkDns(ins.domain.split(":")[0], e.verification_token);
    const viaFile = !viaDns && (!isHttp || deps(req).config.ALLOW_HTTP_VERIFICATION) ? await checkFile(ins.file.url, e.verification_token) : false;
    if (!viaDns && !viaFile) {
      return res.status(422).json({
        error: { code: "not_verified", message: `Couldn't find the verification record. Add the DNS TXT record or serve the file, then try again.${isHttp && !deps(req).config.ALLOW_HTTP_VERIFICATION ? " File verification needs https://." : ""}` },
        instructions: ins,
      });
    }
    const method = viaDns ? "dns" : "file";
    const updated = await scoped(req, async (q) => {
      const [u] = await q("update environments set verified_at = now() where id = $1 returning verified_at as \"verifiedAt\"", [e.id]);
      if (!u) throw notFound("Environment");
      await audit(q, req, "environment.verified", "environment", e.id, { method, domain: ins.domain });
      return u;
    });
    res.json({ verified: true, method, verifiedAt: updated.verifiedAt });
  }),
);
