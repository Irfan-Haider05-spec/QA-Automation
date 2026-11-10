/**
 * All configuration comes from environment variables, validated once at boot.
 * A missing or malformed value stops the server with a clear message instead of
 * failing later at request time.
 */
import { z } from "zod";

const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 random bytes, base64-encoded (openssl rand -base64 32)");

/** "true"/"1"/"yes" → true, "false"/"0"/"no"/"" → false. (z.coerce.boolean() would turn "false" into true.) */
/** Optional settings: an empty value (common in .env files and hosting panels) means "not set" */
const optional = <T extends z.ZodTypeAny>(t: T) => z.preprocess((v) => (v === "" ? undefined : v), t.optional());

const envBool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return fallback;
      const s = v.trim().toLowerCase();
      if (["true", "1", "yes"].includes(s)) return true;
      if (["false", "0", "no"].includes(s)) return false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be true or false" });
      return z.NEVER;
    });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4100),
  /**
   * postgres://qa_app:...@host:5432/qa_platform  → real PostgreSQL (staging/production)
   * pglite://./.data/pg                         → embedded PostgreSQL in a folder (local dev)
   * pglite://memory                             → in-memory (tests)
   */
  DATABASE_URL: z.string().default("pglite://./.data/pg"),
  /** Owner connection used only to run migrations; defaults to DATABASE_URL */
  MIGRATION_DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(30),
  /** Master key for the credentials vault (envelope encryption) */
  VAULT_MASTER_KEY: base64Key,
  /** Comma-separated dashboard origins allowed by CORS */
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  /** Allow http:// (not just https://) when verifying domain ownership; dev and test only */
  ALLOW_HTTP_VERIFICATION: envBool(false),
  /** Proxies in front of the API in production (Caddy → nginx → API = 2). Client IPs for rate limits come from X-Forwarded-For. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** open: anyone can create an account. invite: only the very first account, then people with an invite link. */
  SIGNUP_MODE: z.enum(["open", "invite"]).default("open"),
  INVITE_TTL_DAYS: z.coerce.number().int().positive().default(7),
  /** Shared secret of the hosted runners (≥ 32 chars). Unset = hosted runs disabled (jobs stay queued). */
  RUNNER_TOKEN: optional(z.string().min(32)),
  /** Run the scheduler (due schedules → jobs, stale-job cleanup) inside this API process */
  SCHEDULER_ENABLED: envBool(true),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
  /** A running job without a heartbeat for this long is retried once, then failed */
  JOB_STALE_SECONDS: z.coerce.number().int().min(30).default(180),
  /** Shortest allowed gap between two runs of a schedule */
  SCHEDULE_MIN_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(60),
  /** Outgoing mail for email notifications, e.g. smtp://user:pass@smtp.example.com:587. Unset = email channels can't be added. */
  SMTP_URL: optional(z.string().url()),
  MAIL_FROM: z.string().default("QA Platform <qa@localhost>"),
  /** Let webhooks/Slack point at private or plain-http addresses (dev and tests only; refused in production) */
  ALLOW_PRIVATE_WEBHOOKS: envBool(false),
  NOTIFY_INTERVAL_MS: z.coerce.number().int().min(500).default(10000),
  /** Request logs: json (one JSON object per line), text, or off. Default: json in production, off in tests, text otherwise */
  LOG_FORMAT: z.enum(["json", "text", "off"]).optional(),
  /** Bearer token for GET /metrics (Prometheus). Unset = /metrics is off. */
  METRICS_TOKEN: optional(z.string().min(16)),
  /** Public dashboard URL, e.g. https://qa.example.com. Used for links in PR comments and commit statuses. */
  APP_URL: optional(z.string().url()).transform((u) => (u as string | undefined)?.replace(/\/+$/, "")),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const c = parsed.data;
  c.LOG_FORMAT ??= c.NODE_ENV === "production" ? "json" : c.NODE_ENV === "test" ? "off" : "text";
  if (c.NODE_ENV === "production" && c.DATABASE_URL.startsWith("pglite://")) {
    throw new Error("Invalid configuration:\n  DATABASE_URL: production needs a real PostgreSQL URL, not pglite://");
  }
  if (c.NODE_ENV === "production" && c.ALLOW_HTTP_VERIFICATION) {
    throw new Error("Invalid configuration:\n  ALLOW_HTTP_VERIFICATION: must be false in production");
  }
  if (c.NODE_ENV === "production" && c.ALLOW_PRIVATE_WEBHOOKS) {
    throw new Error("Invalid configuration:\n  ALLOW_PRIVATE_WEBHOOKS: must be false in production");
  }
  return c;
}
