import type { LaunchOptions } from "playwright";

export function chromiumLaunchOptions(env: NodeJS.ProcessEnv = process.env): Pick<LaunchOptions, "executablePath" | "args" | "chromiumSandbox"> {
  const raw = env.QA_CHROMIUM_SANDBOX;
  if (raw !== undefined && raw !== "true" && raw !== "false") throw new Error("QA_CHROMIUM_SANDBOX must be exactly 'true' or 'false'");
  const args = env.QA_CHROMIUM_ARGS?.split(/\s+/).filter(Boolean) ?? [];
  if (raw === "true" && args.some((arg) => /^--no-sandbox(?:=|$)/i.test(arg))) {
    throw new Error("QA_CHROMIUM_SANDBOX=true conflicts with --no-sandbox in QA_CHROMIUM_ARGS");
  }
  return {
    executablePath: env.QA_CHROMIUM_PATH || undefined,
    args: args.length ? args : undefined,
    ...(raw === undefined ? {} : { chromiumSandbox: raw === "true" }),
  };
}
