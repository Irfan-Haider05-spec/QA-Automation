import { z } from "zod";

// Profiles are data, never executable code or arbitrary filesystem inputs.
const localPath = z.string().min(1).max(500).refine((s) => s.startsWith("/") && !s.startsWith("//") && !s.includes("\\") && !/[\r\n\0]/.test(s), "Expected a local URL path");
const page = z.object({ app: z.string().min(1).max(60), path: localPath, public: z.boolean().optional() }).strict();
const pages = z.object({ pages: z.array(page).min(1).max(10) }).strict();
const get = z.object({ method: z.literal("GET").default("GET"), path: localPath, account: z.string().min(1).max(100).optional() }).strict();
export const HostedSettingsSchema = z.object({
  "data-exposure": z.object({}).strict().optional(),
  "authz-matrix": z.object({ cases: z.array(get.extend({ expectedStatuses: z.array(z.number().int().min(100).max(599)).min(1).max(10) })).min(1).max(30) }).strict().optional(),
  "web-client-security": pages.optional(),
  "cross-browser": pages.extend({ browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).min(1).max(3).optional(), viewports: z.array(z.object({ width: z.number().int().min(320).max(1920), height: z.number().int().min(400).max(1200) }).strict()).min(1).max(3).optional() }).strict().optional(),
  "links-seo": pages.extend({ maxLinks: z.number().int().min(1).max(30).optional() }).strict().optional(),
  "privacy-consent": pages.extend({ trackerHosts: z.array(z.string().max(253).regex(/^[a-z0-9.-]+$/i)).min(1).max(50), privacyPath: localPath, observeMs: z.number().int().min(100).max(5000).optional() }).strict().optional(),
}).strict();
export type HostedSettings = z.infer<typeof HostedSettingsSchema>;
