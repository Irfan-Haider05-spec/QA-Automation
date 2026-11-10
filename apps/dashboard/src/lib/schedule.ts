/**
 * Schedules in plain words: the dashboard offers a few frequencies and turns
 * them into cron; anything else is a custom cron expression.
 */
export type Frequency =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "hours"; every: 6 | 12 }
  | { kind: "custom"; cron: string };

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const hm = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return { h: h || 0, m: m || 0 };
};
const pad = (n: number) => String(n).padStart(2, "0");

export function toCron(f: Frequency): string {
  switch (f.kind) {
    case "daily": { const { h, m } = hm(f.time); return `${m} ${h} * * *`; }
    case "weekdays": { const { h, m } = hm(f.time); return `${m} ${h} * * 1-5`; }
    case "weekly": { const { h, m } = hm(f.time); return `${m} ${h} * * ${f.day}`; }
    case "hours": return `0 */${f.every} * * *`;
    case "custom": return f.cron.trim();
  }
}

/** The preset a cron came from, so editing shows the friendly form again */
export function fromCron(cron: string): Frequency {
  const c = cron.trim().split(/\s+/);
  const time = (m: string, h: string) => `${pad(Number(h))}:${pad(Number(m))}`;
  const num = (s: string) => /^\d{1,2}$/.test(s);
  if (c.length === 5 && num(c[0]) && num(c[1]) && c[2] === "*" && c[3] === "*") {
    if (c[4] === "*") return { kind: "daily", time: time(c[0], c[1]) };
    if (c[4] === "1-5") return { kind: "weekdays", time: time(c[0], c[1]) };
    if (/^[0-6]$/.test(c[4])) return { kind: "weekly", day: Number(c[4]), time: time(c[0], c[1]) };
  }
  if (c.length === 5 && c[0] === "0" && (c[1] === "*/6" || c[1] === "*/12") && c.slice(2).every((x) => x === "*")) return { kind: "hours", every: c[1] === "*/6" ? 6 : 12 };
  return { kind: "custom", cron };
}

export function describe(cron: string): string {
  const f = fromCron(cron);
  switch (f.kind) {
    case "daily": return `Every day at ${f.time}`;
    case "weekdays": return `Weekdays at ${f.time}`;
    case "weekly": return `Every ${DAYS[f.day]} at ${f.time}`;
    case "hours": return `Every ${f.every} hours`;
    case "custom": return `Cron ${f.cron}`;
  }
}

export const browserTimezone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};

export const timezones = (): string[] => {
  try {
    const list = (Intl as any).supportedValuesOf?.("timeZone") as string[] | undefined;
    if (list?.length) return list.includes("UTC") ? list : ["UTC", ...list];
  } catch { /* old browser */ }
  return ["UTC", "Asia/Karachi", "Asia/Dubai", "Europe/London", "America/New_York"];
};

/** "Sat 7 Nov, 02:41" in the schedule's own time zone */
export function fmtInZone(iso: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}
