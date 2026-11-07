// The signing page as its own process, for agents whose turn ends before the user gets to the wallet: start it,
// hand the user the link right away, and later read what the page saw from the log it leaves next to the plan.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SignLog {
  state: "waiting" | "mined" | "closed";
  /** mined, succeeded, and the mined to/value/input are what knock handed to the wallet */
  ok: boolean;
  /** what happened on the page, without the banner */
  lines: string[];
}

export function readSignLog(text: string): SignLog {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("knock signing page:") && !l.startsWith("Stops by itself") && !l.startsWith("Ctrl+C"));
  const tx = lines.find((l) => l.startsWith("tx "));
  if (!tx && lines.some((l) => l.startsWith("closed after"))) return { state: "closed", ok: false, lines };
  if (!tx) return { state: "waiting", ok: false, lines };
  return { state: "mined", ok: / success in block /.test(tx) && / match what knock handed/.test(tx) && !/DO NOT match/.test(tx), lines };
}

export const logFor = (planFile: string) => `${resolve(planFile)}.sign.log`;

async function pageAnswers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/plan`)).ok;
  } catch {
    return false;
  }
}

/** Starts `knock sign <plan> --until-mined` on its own and waits until the page answers. */
export async function startDetached(script: string, planFile: string, port: number): Promise<{ ok: boolean; says: string }> {
  if (await pageAnswers(port)) return { ok: false, says: `something already answers on port ${port}; finish or close that page first, or pass --port` };
  const log = logFor(planFile);
  const fd = openSync(log, "w");
  const child = spawn(process.execPath, [script, "sign", planFile, "--port", String(port), "--until-mined"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  closeSync(fd);
  for (let i = 0; i < 60; i++) {
    if (await pageAnswers(port)) return { ok: true, says: log };
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, says: `the page didn't come up:\n${existsSync(log) ? readFileSync(log, "utf8").trim() : "(no log)"}` };
}

/** Waits up to `seconds` for the page to see the payment mined. */
export async function waitSigned(planFile: string, seconds: number): Promise<SignLog | null> {
  const log = logFor(planFile);
  if (!existsSync(log)) return null;
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const r = readSignLog(readFileSync(log, "utf8"));
    if (r.state !== "waiting" || Date.now() >= until) return r;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
