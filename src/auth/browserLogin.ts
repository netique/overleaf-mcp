// Spawn a Chrome window pointed at Overleaf, wait for the user to land on
// the dashboard (any path under /project), then read the session cookie
// straight out of the browser via CDP. Cookie expiry handling is just a
// re-run of the same flow.

import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";

import { logger } from "../util/logger.js";
import { loadConfig } from "../config.js";
import { CdpClient } from "./cdp.js";
import { findChrome } from "./chromeFinder.js";

interface CaptureOpts {
  timeoutMs?: number;
}

interface Cookie {
  name: string;
  value: string;
  domain?: string;
}

function configRoot(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  if (process.platform === "win32") return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

export function profileDir(): string {
  return path.join(configRoot(), "overleaf-mcp", "chrome-profile");
}

async function readDevToolsPort(profile: string, deadline: number): Promise<{ port: number; path: string }> {
  const file = path.join(profile, "DevToolsActivePort");
  while (Date.now() < deadline) {
    try {
      const txt = await fs.readFile(file, "utf8");
      const [portLine, pathLine] = txt.trim().split("\n");
      const port = Number(portLine);
      if (port > 0 && pathLine) return { port, path: pathLine };
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Chrome did not write DevToolsActivePort within timeout");
}

function chromeFlags(profile: string, insecure: boolean): string[] {
  // Note: no URL argument here. We spawn Chrome with about:blank and then
  // drive the single resulting tab via CDP. Passing the Overleaf URL on the
  // command line in addition to a CDP-created target was racing two parallel
  // /login requests through the same session, which Overleaf rejected with a
  // generic "Session error" page.
  const flags = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter",
    "--password-store=basic",
    "--use-mock-keychain",
    "--new-window",
    "--disk-cache-size=10000000",
  ];
  if (insecure) flags.push("--ignore-certificate-errors");
  flags.push("about:blank");
  return flags;
}

async function waitForDashboard(
  cdp: CdpClient,
  sessionId: string,
  baseUrl: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const loginPath = new URL("/project", baseUrl).pathname; // canonical "/project"
  while (Date.now() < deadline) {
    if (child.exitCode !== null || cdp.isClosed()) {
      throw new Error("Chrome window closed before login completed");
    }
    try {
      const res = await cdp.send<{ result: { value?: string } }>(
        "Runtime.evaluate",
        { expression: "location.pathname", returnByValue: true },
        sessionId,
        5_000,
      );
      const pathname = res.result?.value;
      if (typeof pathname === "string" && new RegExp(`^${loginPath}(/|$)`).test(pathname)) {
        return;
      }
    } catch (err) {
      // Page may be mid-navigation; just retry.
      logger.debug(`waitForDashboard: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Login did not complete within ${Math.round(timeoutMs / 1000)}s`);
}

export async function captureCookie(baseUrl: string, opts: CaptureOpts = {}): Promise<string> {
  const config = loadConfig();
  const chromePath = await findChrome(config.browserPath);
  const profile = profileDir();
  await fs.mkdir(profile, { recursive: true });

  // Remove any DevToolsActivePort left behind by a previous Chrome — if we
  // read a stale file, we'd try to connect to a port that nothing is bound
  // to and surface as ECONNREFUSED to the caller. Deleting before spawn
  // means the file's reappearance is a positive signal that the just-
  // spawned Chrome is actually listening.
  await fs.rm(path.join(profile, "DevToolsActivePort"), { force: true });

  const args = chromeFlags(profile, config.insecure);
  logger.info(`launching ${chromePath} (profile=${profile})`);
  const child = spawn(chromePath, args, { stdio: "ignore", detached: false });

  let earlyExitErr: Error | null = null;
  child.once("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      earlyExitErr = new Error(`Chrome exited (code=${code}, signal=${signal ?? "none"})`);
    }
  });

  const portDeadline = Date.now() + 10_000;
  let cdp: CdpClient | null = null;
  try {
    const { port, path: browserWsPath } = await readDevToolsPort(profile, portDeadline);
    if (earlyExitErr) throw earlyExitErr;
    const browserWsUrl = `ws://127.0.0.1:${port}${browserWsPath}`;
    cdp = await CdpClient.connect(browserWsUrl);

    // Reuse the about:blank tab Chrome opened on spawn. Creating a second
    // target makes Overleaf see two concurrent /login requests, which it
    // rejects with a generic "Session error" page.
    const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
      "Target.getTargets",
    );
    const pageTarget = targets.targetInfos.find((t) => t.type === "page");
    if (!pageTarget) throw new Error("Chrome opened without a page target");
    const targetId = pageTarget.targetId;
    const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url: `${baseUrl}/project` }, sessionId);

    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    await waitForDashboard(cdp, sessionId, baseUrl, child, timeoutMs);

    const cookieRes = await cdp.send<{ cookies: Cookie[] }>(
      "Network.getCookies",
      { urls: [baseUrl] },
      sessionId,
    );
    const cookies = cookieRes.cookies ?? [];
    if (!cookies.some((c) => c.name === "overleaf_session2")) {
      throw new Error("captured page but no overleaf_session2 cookie present");
    }
    const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    return header;
  } finally {
    if (cdp) cdp.close();
    // Don't reach into the browser process; let it exit on its own when the
    // user closes the window. The dedicated profile means it doesn't matter
    // if the window lingers after login.
    if (child.exitCode === null) {
      // Gentle close — Chrome handles SIGTERM by saving session and quitting.
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }
}
