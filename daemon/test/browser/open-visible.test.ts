import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openVisibleChrome, visibleArgs, CDP_PORT, type CdpProbe } from "../../src/browser/open-visible.ts";

function harness(sequence: Array<{ browser: string; webSocketDebuggerUrl: string } | undefined>) {
  const calls: string[] = [];
  const spawned: string[][] = [];
  const activated: number[] = [];
  let versionCalls = 0;
  const cdp: CdpProbe = {
    async version() {
      const v = sequence[Math.min(versionCalls, sequence.length - 1)];
      versionCalls += 1;
      return v;
    },
    async close(url) {
      calls.push(`close:${url}`);
    },
  };
  const logger = { write: (_l: "info" | "warn", _m: string, event: string) => { calls.push(event); } };
  return {
    calls, spawned, activated,
    input: {
      chrome: "/fake/Chrome",
      profile: mkdtempSync(join(tmpdir(), "oi-chrome-")),
      logger,
      cdp,
      spawn: (args: readonly string[]) => { spawned.push([...args]); return { pid: 4242 }; },
      activate: async (pid: number) => { activated.push(pid); return true; },
      sleep: async () => {},
    },
  };
}

describe("openVisibleChrome", () => {
  test("nothing on CDP: clears stale locks, spawns visible on the pinned port, activates once it answers", async () => {
    const h = harness([undefined, undefined, { browser: "Chrome/152", webSocketDebuggerUrl: "ws://x" }]);
    for (const name of ["SingletonLock", "SingletonSocket"]) writeFileSync(join(h.input.profile, name), "");
    const result = await openVisibleChrome(h.input);
    expect(result).toEqual({ replacedHeadless: false, reusedVisible: false, activated: true });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toEqual(visibleArgs("/fake/Chrome", h.input.profile));
    expect(h.spawned[0]).toContain(`--remote-debugging-port=${CDP_PORT}`);
    expect(h.spawned[0]).not.toContain("--headless=new");
    expect(existsSync(join(h.input.profile, "SingletonLock"))).toBe(false);
    expect(h.activated).toEqual([4242]);
  });

  test("headless instance holds the profile: closes it over CDP, waits for it to go, then spawns visible", async () => {
    const headless = { browser: "HeadlessChrome/152", webSocketDebuggerUrl: "ws://headless" };
    const visible = { browser: "Chrome/152", webSocketDebuggerUrl: "ws://visible" };
    // version(): headless (probe) → headless (still closing) → gone → gone → visible after spawn
    const h = harness([headless, headless, undefined, undefined, visible]);
    const result = await openVisibleChrome(h.input);
    expect(result).toEqual({ replacedHeadless: true, reusedVisible: false, activated: true });
    expect(h.calls).toEqual(["closing_headless_for_owner", "close:ws://headless"]);
    expect(h.spawned).toHaveLength(1);
    expect(h.activated).toEqual([4242]);
  });

  test("visible instance already running: only asks it for a new window and activates", async () => {
    const h = harness([{ browser: "Chrome/152", webSocketDebuggerUrl: "ws://visible" }]);
    const result = await openVisibleChrome(h.input);
    expect(result).toEqual({ replacedHeadless: false, reusedVisible: true, activated: true });
    expect(h.calls).toEqual([]);
    expect(h.spawned).toHaveLength(1);
    expect(h.activated).toEqual([4242]);
  });

  test("Chrome never answers after spawn: reports not activated rather than hanging", async () => {
    const h = harness([undefined]);
    const result = await openVisibleChrome(h.input);
    expect(result).toEqual({ replacedHeadless: false, reusedVisible: false, activated: false });
    expect(h.activated).toEqual([]);
  });
});
