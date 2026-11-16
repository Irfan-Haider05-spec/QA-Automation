import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { executableCommand } from "./process.js";

/** Trusted local executable; never a shell command or remotely supplied job field. */
export async function runBoundedProcess(options: { command: string; args: string[]; cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) {
  const [command, ...prefix] = executableCommand(options.command);
  const child = spawn(command, [...prefix, ...options.args], { cwd: options.cwd, env: options.env,
    shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: "timeout" | "cancelled" | undefined;
  const kill = () => {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === "win32") {
      try { execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 }); } catch { child.kill(); }
    } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  };
  const cancel = () => { stopped = "cancelled"; kill(); };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", () => reject(new Error("Executable could not start")));
      child.once("close", (code, signal) => signal || code === null ? reject(new Error("Process terminated")) : resolve(code));
      timer = setTimeout(() => { stopped = "timeout"; kill(); }, options.timeoutMs);
    });
    if (stopped) throw new Error("Process interrupted");
    return code;
  } catch {
    throw new Error(stopped === "timeout" ? "Execution exceeded the configured timeout; no report accepted" : stopped === "cancelled" ? "Execution cancelled; no report accepted" : "Executable failed to start or terminated unexpectedly");
  } finally { clearTimeout(timer); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
