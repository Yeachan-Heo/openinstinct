import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MonitorStore } from "../../src/monitors/store.ts";
import {
  ScriptTrigger,
  WatcherTrigger,
  WebhookServer,
  confinedArgv,
  defaultMonitorRuntimeConfig,
  readMonitorRuntimeConfig,
} from "../../src/monitors/triggers.ts";
import type { MonitorSpec, MonitorTriggerEvent } from "../../src/monitors/types.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { readonly root: string; readonly store: StateStore; readonly monitors: MonitorStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-monitor-trigger-"));
  directories.push(root);
  const store = openStateStore(join(root, "state.db"));
  return { root, store, monitors: new MonitorStore(store, { hostTimeZone: "UTC" }) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for monitor trigger");
    }
    await Bun.sleep(10);
  }
}

describe("monitor ingress triggers", () => {
  test("serves generated webhook tokens only through a loopback server route", async () => {
    const { store, monitors } = createStore();
    const monitor = monitors.create({
      id: "webhook-monitor",
      name: "Webhook",
      trigger: { kind: "webhook" },
      instruction: "Report webhook.",
    });
    const received: Array<{ readonly spec: MonitorSpec; readonly event: MonitorTriggerEvent }> = [];
    const webhook = new WebhookServer({
      monitors,
      port: 0,
      onTrigger: (spec, event) => { received.push({ spec, event }); },
    });

    try {
      await webhook.start();
      expect(webhook.host).toBe("127.0.0.1");
      const response = await fetch(`http://127.0.0.1:${webhook.port}/hook/${(monitor.trigger as { token: string }).token}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-openinstinct-event-id": "event-1" },
        body: JSON.stringify({ status: "ok" }),
      });
      expect(response.status).toBe(202);
      expect(received).toEqual([{
        spec: expect.objectContaining({ id: monitor.id }),
        event: expect.objectContaining({ eventType: "webhook", occurrenceKey: "webhook:event-1", payload: { status: "ok" } }),
      }]);
    } finally {
      await webhook.stop();
      store.close();
    }
  });

  test("debounces watcher events from configured roots", async () => {
    const { root, store, monitors } = createStore();
    const watched = join(root, "watched");
    mkdirSync(watched, { recursive: true });
    monitors.create({
      id: "watcher-monitor",
      name: "Watcher",
      trigger: { kind: "watcher" },
      instruction: "Report changes.",
      eventTypes: ["*"],
    });
    const received: MonitorTriggerEvent[] = [];
    const watcher = new WatcherTrigger({
      monitors,
      watcherRoots: [watched],
      debounceMs: 25,
      onTrigger: (_monitor, event) => { received.push(event); },
    });

    try {
      watcher.start();
      // Native subscription startup is asynchronous on macOS. Observe a separate
      // path before measuring the note.txt burst rather than losing that burst.
      let nextProbeAt = 0;
      await waitFor(() => {
        if (received.some((event) => event.occurrenceKey?.startsWith(`watcher:${watched}:ready.txt:`))) return true;
        if (Date.now() >= nextProbeAt) {
          writeFileSync(join(watched, "ready.txt"), String(Date.now()));
          nextProbeAt = Date.now() + 100;
        }
        return false;
      });
      const noteEvents = () => received.filter((event) => event.occurrenceKey?.startsWith(`watcher:${watched}:note.txt:`));
      writeFileSync(join(watched, "note.txt"), "one");
      writeFileSync(join(watched, "note.txt"), "two");
      await waitFor(() => noteEvents().length > 0);
      await Bun.sleep(100);
      expect(noteEvents()).toHaveLength(1);
      expect(noteEvents()[0]).toMatchObject({
        eventType: expect.stringMatching(/^watcher\./),
        payload: { root: watched, path: "note.txt" },
      });
    } finally {
      watcher.stop();
      store.close();
    }
  });

  test("runs interval scripts only from scriptRoot and rejects escaping executables", async () => {
    const { root, store, monitors } = createStore();
    const scriptRoot = join(root, "scripts");
    mkdirSync(scriptRoot, { recursive: true });
    const script = join(scriptRoot, "emit.sh");
    writeFileSync(script, "#!/bin/sh\nprintf 'monitor-script-ok'\n");
    chmodSync(script, 0o700);
    const monitor = monitors.create({
      id: "script-monitor",
      name: "Script",
      trigger: { kind: "script", argv: ["emit.sh"], intervalMs: 1_000 },
      instruction: "Report script output.",
    });
    const received: MonitorTriggerEvent[] = [];
    const scripts = new ScriptTrigger({
      monitors,
      scriptRoot,
      onTrigger: (_monitor, event) => { received.push(event); },
    });

    try {
      scripts.start();
      await waitFor(() => received.length === 1, 2_500);
      expect(received[0]).toMatchObject({
        eventType: "script",
        payload: expect.objectContaining({ exitCode: 0, stdout: "monitor-script-ok" }),
      });
      expect(() => confinedArgv(scriptRoot, ["../outside.sh"])).toThrow("escapes scriptRoot");
      expect(confinedArgv(scriptRoot, ["emit.sh"])[0]).toBe(script);
    } finally {
      scripts.stop();
      store.close();
    }
  });

  test("defaults match the reader when monitor keys are absent", async () => {
    const { root, store } = createStore();
    const config = join(root, "config.json");
    writeFileSync(config, "{}");

    try {
      await expect(readMonitorRuntimeConfig(config)).resolves.toEqual(defaultMonitorRuntimeConfig());
    } finally {
      store.close();
    }
  });

  test("reads only absolute watcherRoots and scriptRoot from config", async () => {
    const { root, store } = createStore();
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({
      allowlistHandle: "+821012345678",
      watcherRoots: [join(root, "watched")],
      scriptRoot: join(root, "scripts"),
      webhookPort: 0,
    }));

    try {
      await expect(readMonitorRuntimeConfig(config)).resolves.toEqual({
        watcherRoots: [join(root, "watched")],
        scriptRoot: join(root, "scripts"),
        webhookPort: 0,
      });
    } finally {
      store.close();
    }
  });
});
