import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** A direct node invocation of the letta CLI — never goes through a shell. */
export interface CliInvocation {
  command: string;
  args: string[];
}

let cached: CliInvocation | null | undefined;

/**
 * Resolve the letta CLI once per adapter process.
 *
 * LETTA_ACP_CLI (path to the CLI's JS entry) overrides everything — this is
 * the seam tests and pinned-version installs use.
 *
 * Otherwise `where`/`which letta` and, on Windows, parse the npm .cmd shim to
 * find the real JS entry so the prompt text never passes through a shell.
 */
export function resolveCli(): CliInvocation | null {
  if (cached !== undefined) return cached;
  cached = resolve();
  return cached;
}

function resolve(): CliInvocation | null {
  const override = process.env.LETTA_ACP_CLI;
  if (override) return { command: process.execPath, args: [override] };

  const finder = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(finder, ["letta"], { encoding: "utf8" });
  if (found.error || found.status !== 0 || !found.stdout) return null;
  const lines = found.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (process.platform === "win32") {
    const cmd = lines.find((l) => /\.(cmd|bat)$/i.test(l));
    if (cmd) return parseCmdShim(cmd);
    const ps1 = lines.find((l) => /\.ps1$/i.test(l));
    if (ps1) return parsePs1Shim(ps1);
  }
  const js = lines.find((l) => /\.(m?js)$/i.test(l));
  if (js) return { command: process.execPath, args: [js] };
  return null;
}

/** npm .cmd shims invoke: node "%~dp0%\node_modules\...\bin\letta.js" %* */
function parseCmdShim(shimPath: string): CliInvocation | null {
  let text: string;
  try {
    text = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const match =
    text.match(/node(?:\.exe)?\s+"([^"]+\.m?js)"/i) ||
    text.match(/node(?:\.exe)?\s+(\S+\.m?js)/i);
  if (!match) return null;
  // %~dp0% is the shim's own directory, with a trailing backslash.
  const entry = match[1].replace(/^%~dp0%\\?/i, path.dirname(shimPath) + path.sep);
  return { command: process.execPath, args: [entry] };
}

/** npm .ps1 shims invoke: node "$basedir/node_modules/.../bin/letta.js" $args */
function parsePs1Shim(shimPath: string): CliInvocation | null {
  let text: string;
  try {
    text = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const match = text.match(/node(?:\.exe)?\s+"?\$basedir[\/\\]([^"\s]+\.m?js)/i);
  if (!match) return null;
  return { command: process.execPath, args: [path.join(path.dirname(shimPath), match[1])] };
}
