import { z } from "zod";

const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "Not a date");

/** Report scope and period, at most a year, not in the future */
export const zReportQuery = z.object({
  scope: z.enum(["project", "client"]),
  id: z.string().uuid(),
  from: zDay,
  to: zDay,
}).refine((v) => v.from <= v.to, { message: "The start date is after the end date", path: ["from"] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, { message: "A report covers at most one year", path: ["to"] });
