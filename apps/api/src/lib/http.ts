/**
 * HTTP helpers: typed errors, async handlers, zod validation, uuid params.
 */
import type { NextFunction, Request, Response, RequestHandler } from "express";
import { z, ZodError, type ZodTypeAny } from "zod";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);
export const forbidden = (msg = "You don't have permission to do this") => new ApiError(403, "forbidden", msg);
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, "bad_request", msg, details);
export const conflict = (msg: string) => new ApiError(409, "conflict", msg);
export const unprocessable = (msg: string) => new ApiError(422, "unprocessable", msg);

/** Wrap an async route handler so rejections reach the error handler */
export const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/**
 * Validate params/query/body with zod. Route params ending in "Id" must be UUIDs;
 * a malformed id answers 404 (not 400 or 500) so ids can't be probed.
 */
export const validate =
  (schemas: { body?: ZodTypeAny; query?: ZodTypeAny }): RequestHandler =>
  (req, _res, next) => {
    try {
      for (const [k, v] of Object.entries(req.params)) {
        if (k.endsWith("Id") && !isUuid(v)) throw notFound();
      }
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      if (schemas.query) (req as any).validQuery = schemas.query.parse(req.query);
      next();
    } catch (e) {
      next(e);
    }
  };

export const query = <T>(req: Request): T => (req as any).validQuery as T;

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: "validation_error", message: "Request validation failed", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } });
  }
  if ((err as any)?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "bad_json", message: "Request body is not valid JSON" } });
  }
  if ((err as any)?.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "too_large", message: "Request body is too large" } });
  }
  // Unique violation from Postgres → 409
  if ((err as any)?.code === "23505") {
    return res.status(409).json({ error: { code: "conflict", message: "A record with these values already exists" } });
  }
  const requestId = res.locals.requestId as string | undefined;
  console.error(`[api] unhandled error on ${req.method} ${req.originalUrl.split("?")[0]} (request ${requestId}):`, err);
  return res.status(500).json({ error: { code: "internal", message: "Internal server error", requestId } });
}

export const zEmail = z.string().trim().toLowerCase().email().max(254);
export const zName = z.string().trim().min(1).max(120);
