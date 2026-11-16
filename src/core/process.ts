import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

/** Windows does not implement Unix shebangs. Resolve supported script entry
 * points explicitly without invoking cmd.exe or interpreting shell metacharacters.
 * The executable is trusted local configuration, never a hosted request value. */
export function executableCommand(command: string): string[] {
  if (process.platform !== "win32") return [command];
  const candidates = path.isAbsolute(command) || /[\\/]/.test(command) ? [path.resolve(command)]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const file of candidates) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const fd = fs.openSync(file, "r");
    const data = Buffer.alloc(200);
    let length: number;
    try { length = fs.readSync(fd, data, 0, data.length, 0); } finally { fs.closeSync(fd); }
    const line = data.subarray(0, length).toString("utf8").split(/\r?\n/, 1)[0];
    if (/^#!\s*(?:\/usr\/bin\/env\s+|\/usr\/(?:local\/)?bin\/)node\s*$/.test(line)) return [process.execPath, file];
    if (/^#!\s*(?:\/usr\/bin\/env\s+|\/usr\/(?:local\/)?bin\/)python3?\s*$/.test(line)) return ["python", file];
  }
  return [command];
}

export function spawnToolSync(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) {
  const [exe, ...prefix] = executableCommand(command);
  return spawnSync(exe, [...prefix, ...args], { ...options, shell: false, windowsHide: true });
}
