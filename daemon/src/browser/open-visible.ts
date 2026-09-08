import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Opens the agent's Chrome profile as a window the owner can see.
 *
 * Chrome is single-instance per --user-data-dir. When the browser tool already
 * holds the profile headless, a second launch hands its arguments to that
 * instance over IPC and exits; headless Chrome has no windows, so nothing
 * appears (and the spawn "succeeded"). So: if a CDP endpoint answers on the
 * pinned port and reports headless, close it, then launch visible on the same
 * port so the browser tool reconnects to the visible instance. Cookies and
 * logins are shared because it is the same profile.
 *
 * A daemon-spawned app does not get foreground activation on its own; the
 * window is brought to front explicitly afterwards.
 */
export const CDP_PORT = 9222;

export interface OpenVisibleChromeInput {
  readonly chrome: string;
  readonly profile: string;
  readonly logger: { write(level: "info" | "warn", module: string, event: string, fields?: Record<string, unknown>): void };
  /** Test seams. */
  readonly cdp?: CdpProbe;
  readonly spawn?: (args: readonly string[]) => { readonly pid: number };
  readonly activate?: (pid: number) => Promise<boolean>;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CdpProbe {
  /** `Browser` string from /json/version, or undefined when nothing answers. */
  version(): Promise<{ readonly browser: string; readonly webSocketDebuggerUrl: string } | undefined>;
  /** Sends Browser.close; resolves when the socket is gone or the deadline passes. */
  close(webSocketDebuggerUrl: string): Promise<void>;
  /** Pid of the Chrome main process on the given profile, if any. */
  pid(profile: string): Promise<number | undefined>;
}

export interface OpenVisibleChromeResult {
  readonly replacedHeadless: boolean;
  readonly reusedVisible: boolean;
  readonly activated: boolean;
}

export async function openVisibleChrome(input: OpenVisibleChromeInput): Promise<OpenVisibleChromeResult> {
  const cdp = input.cdp ?? liveCdp;
  const spawn = input.spawn ?? liveSpawn;
  const activate = input.activate ?? liveActivate;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const existing = await cdp.version();
  let replacedHeadless = false;
  if (existing !== undefined) {
    if (!/headless/i.test(existing.browser)) {
      // A visible instance already holds the profile. Spawning again would
      // hand `--new-window` to it over IPC and stack windows; bring the one
      // window it has to the front instead.
      const pid = await cdp.pid(input.profile);
      const activated = pid === undefined ? false : await activate(pid);
      return { replacedHeadless: false, reusedVisible: true, activated };
    }
    input.logger.write("info", "browser", "closing_headless_for_owner", { browser: existing.browser });
    await cdp.close(existing.webSocketDebuggerUrl);
    for (let i = 0; i < 40 && (await cdp.version()) !== undefined; i += 1) {
      await sleep(250);
    }
    replacedHeadless = true;
  }
  // A crashed or killed instance leaves stale lock files that make Chrome
  // show "profile in use"; they are safe to remove once nothing answers on CDP.
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(join(input.profile, name), { force: true });
  }
  const proc = spawn(visibleArgs(input.chrome, input.profile));
  let activated = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    if ((await cdp.version()) !== undefined) {
      activated = await activate(proc.pid);
      break;
    }
  }
  return { replacedHeadless, reusedVisible: false, activated };
}

export function visibleArgs(chrome: string, profile: string): string[] {
  return [
    chrome,
    `--user-data-dir=${profile}`,
    "--profile-directory=Default",
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ];
}

const liveCdp: CdpProbe = {
  async version() {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { readonly Browser?: unknown; readonly webSocketDebuggerUrl?: unknown };
      if (typeof body.Browser !== "string" || typeof body.webSocketDebuggerUrl !== "string") return undefined;
      return { browser: body.Browser, webSocketDebuggerUrl: body.webSocketDebuggerUrl };
    } catch {
      return undefined;
    }
  },
  async close(url) {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(url);
      const done = (): void => { try { ws.close(); } catch { /* closed */ } resolve(); };
      const timer = setTimeout(done, 3000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      ws.onmessage = () => { clearTimeout(timer); done(); };
      ws.onerror = () => { clearTimeout(timer); done(); };
      ws.onclose = () => { clearTimeout(timer); resolve(); };
    });
  },
  async pid(profile) {
    // Main process only: helpers carry --type=…; the main one carries the
    // profile flag without it.
    const proc = Bun.spawn(["/usr/bin/pgrep", "-f", `Google Chrome --.*--user-data-dir=${profile}(\\s|$)`], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    const pids = out.split("\n").map((line) => Number(line.trim())).filter((n) => Number.isInteger(n) && n > 0);
    return pids[0];
  },
};

function liveSpawn(args: readonly string[]): { readonly pid: number } {
  const proc = Bun.spawn([...args], { stdout: "ignore", stderr: "ignore" });
  proc.unref();
  return { pid: proc.pid };
}

async function liveActivate(pid: number): Promise<boolean> {
  const script = `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`;
  const proc = Bun.spawn(["/usr/bin/osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}
