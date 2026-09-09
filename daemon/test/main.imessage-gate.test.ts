import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BootstrapProbes } from "../src/bootstrap/states.ts";
import { startDaemon } from "../src/main.ts";
import { dataPaths } from "../src/paths.ts";
import type { MainSessionFactory } from "../src/sdk-session/main-session.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("main iMessage gate", () => {
  test("boots the core without config while keeping the iMessage lane inactive", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-main-gate-"));
    directories.push(root);
    const home = join(root, "home");
    const chatDbPath = join(home, "Library", "Messages", "chat.db");
    let fdaCalls = 0;
    const probes: BootstrapProbes = {
      config: async () => ({ status: "missing", reason: "config.json is missing" }),
      credentials: async () => ({ status: "passed" }),
      fda: async () => {
        fdaCalls += 1;
        return { status: "passed" };
      },
      accessibility: async () => ({ status: "passed" }),
      messages: async () => ({ status: "passed" }),
    };

    const runtime = await startDaemon({
      paths: dataPaths(home),
      probes,
      chatDbPath,
      mainSessionFactory: {
        create: async () => ({
          sessionFile: "/tmp/main-gate.jsonl",
          sessionId: "main-gate",
          prompt: async () => {},
        }),
      } satisfies MainSessionFactory,
      reprobeIntervalMs: 60_000,
    });
    try {
      expect(runtime.status()).toMatchObject({ state: "running", probes: { fda: { status: "passed" } } });

      expect(fdaCalls).toBeGreaterThan(0);
      expect(runtime.store.getChatCursor()).toBeUndefined();
      expect(existsSync(chatDbPath)).toBe(false);
    } finally {
      await runtime.stop();
    }
  });
});
