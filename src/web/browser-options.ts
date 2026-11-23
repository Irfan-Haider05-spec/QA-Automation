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

/**
 * Wait for a browser operation at most `ms`; resolve undefined on timeout or error.
 * Playwright calls such as page.close() and page.evaluate() have no timeout of their
 * own and can hang (for example while a page is still loading an error response).
 */
export async function bounded<T>(operation: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    operation.catch(() => {}); // a late rejection must not become an unhandled one
  }
}
