import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dataPaths } from "../src/paths.ts";
import { MODELS_TTL_MS, SettingsService, type AccountRow, type ModelChoice, type SettingsPatch } from "../src/settings/service.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function make(): { service: SettingsService; paths: ReturnType<typeof dataPaths>; soul: string } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-settings-")); dirs.push(root);
  const paths = dataPaths(join(root, "home")); mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ allowlistHandle: "+821012345678", ownerName: "b" }));
  const soul = join(root, "SOUL.md"); writeFileSync(soul, "<!-- soul-version: 3 -->\nYou are Gajae, a gremlin with opinions and a keyboard.");
  return { service: new SettingsService({ paths, soulPath: soul, gjcBinary: "/nonexistent/gjc" }), paths, soul };
}

describe("settings service", () => {
  test("snapshot reflects config, env presence (never values), and soul", async () => {
    const { service, paths } = make();
    writeFileSync(paths.envFile, "OPENAI_API_KEY=sk-secret\n", { mode: 0o600 });
    const snap = await service.snapshot();
    expect(snap.ownerHandle).toBe("+821012345678");
    expect(snap.soulVersion).toBe("3");
    expect(snap.env.find((e) => e.key === "OPENAI_API_KEY")?.set).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("sk-secret");
    expect(snap).toMatchObject({
      childWarmTtlSec: 600,
      childIdleTimeoutSec: 86_400,
      childMaxLive: 16,
      childInterimBatchSec: 3,
      childInterimRatePerMinute: 6,
      childInterimMaxBytes: 1_024,
      childStatusListLimit: 20,
      childStatusTextBytes: 512,
      childToolGuardMs: 50,
    });
  });

  test("apply validates through the boot parser and reports restart/reload scope", async () => {
    const { service, paths, soul } = make();
    await expect(service.apply({ ownerHandle: "garbage" })).rejects.toThrow(/country code/);
    await expect(service.apply({ mainSessionModel: "nope" })).rejects.toThrow(/provider\/model/);
    await expect(service.apply({ mainSessionModel: "opengateway/anthropic/claude-sonnet-4-5" })).resolves.toMatchObject({ needsRestart: true });
    const r1 = await service.apply({ ownerName: "Bellman", mainSessionModel: "anthropic/claude-sonnet-4-5" });
    expect(r1).toEqual({ needsRestart: true, needsReload: true, ownerHandleChanged: false });
    const r2 = await service.apply({ childMaxConcurrent: 2, env: { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "" } });
    expect(r2.needsRestart).toBe(true);
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toMatchObject({ ownerName: "Bellman", mainSessionModel: "anthropic/claude-sonnet-4-5", children: { maxConcurrent: 2 } });
    expect(readFileSync(paths.envFile, "utf8")).toBe("ANTHROPIC_API_KEY=k\n");
    expect(statSync(paths.envFile).mode & 0o777).toBe(0o600);
    const r3 = await service.apply({ soulText: "You are Gajae v4, still a gremlin, still funnier than the CI logs." });
    expect(r3.needsReload).toBe(true);
    expect(readFileSync(soul, "utf8")).toMatch(/soul-version: 4/);
  });

  test("owner handle changes reload settings without requesting a restart", async () => {
    const { service, paths } = make();

    await expect(service.apply({ ownerHandle: "+82 10-5555-1212" })).resolves.toEqual({
      needsRestart: false,
      needsReload: true,
      ownerHandleChanged: true,
    });
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toMatchObject({ allowlistHandle: "+821055551212" });
  });

  test("clearing the owner handle removes it from config", async () => {
    const { service, paths } = make();

    await expect(service.apply({ ownerHandle: "" })).resolves.toEqual({
      needsRestart: false,
      needsReload: true,
      ownerHandleChanged: true,
    });
    expect("allowlistHandle" in JSON.parse(readFileSync(paths.config, "utf8"))).toBe(false);
  });

  test("concurrent first account loads share the in-flight result", async () => {
    const { service } = make();
    const account: AccountRow = {
      id: "account-1",
      provider: "anthropic",
      kind: "oauth",
      identity: "Ada",
      health: "ok",
    };
    let calls = 0;
    const uncached = service as unknown as {
      listAccountsUncached: () => Promise<AccountRow[]>;
    };
    uncached.listAccountsUncached = async () => {
      calls += 1;
      await Bun.sleep(20);
      return [account];
    };

    const [first, second] = await Promise.all([service.listAccounts(), service.listAccounts()]);
    expect(first).toEqual([account]);
    expect(second).toEqual([account]);
    expect(calls).toBe(1);
  });

  test("invalidate forces the next account lookup to reload", async () => {
    const { service } = make();
    let calls = 0;
    const uncached = service as unknown as {
      listAccountsUncached: () => Promise<AccountRow[]>;
    };
    uncached.listAccountsUncached = async () => {
      calls += 1;
      return [];
    };

    await service.listAccounts();
    service.invalidate("accounts");
    await service.listAccounts();
    expect(calls).toBe(2);
  });

  test("model list serves the cache within the TTL and refreshes in the background once stale", async () => {
    const { service } = make();
    let calls = 0;
    const uncached = service as unknown as { listModelsUncached: () => Promise<ModelChoice[]> };
    uncached.listModelsUncached = async () => {
      calls += 1;
      return [{ id: `p/m${calls}`, provider: "p", canonical: `m${calls}` }];
    };
    const cache = (service as unknown as { cache: Map<string, { at: number }> }).cache;

    expect((await service.listModels()).map((m) => m.id)).toEqual(["p/m1"]);
    expect((await service.listModels()).map((m) => m.id)).toEqual(["p/m1"]);
    expect(calls).toBe(1);

    cache.get("models")!.at = Date.now() - MODELS_TTL_MS - 1;
    // Stale: the old list is served immediately while a reload runs behind it.
    expect((await service.listModels()).map((m) => m.id)).toEqual(["p/m1"]);
    expect(calls).toBe(2);
    await Bun.sleep(0);
    expect((await service.listModels()).map((m) => m.id)).toEqual(["p/m2"]);
    expect(calls).toBe(2);
  });

  test("forced model refresh bypasses a fresh cache, awaits the new list, and restarts the TTL", async () => {
    const { service } = make();
    let calls = 0;
    const uncached = service as unknown as { listModelsUncached: () => Promise<ModelChoice[]> };
    uncached.listModelsUncached = async () => {
      calls += 1;
      await Bun.sleep(10);
      return [{ id: `p/m${calls}`, provider: "p", canonical: `m${calls}` }];
    };
    const cache = (service as unknown as { cache: Map<string, { at: number }> }).cache;

    await service.listModels();
    cache.get("models")!.at = Date.now() - 5_000;

    const [forced, passive] = await Promise.all([service.listModels({ refresh: true }), service.listModels()]);
    expect(forced.map((m) => m.id)).toEqual(["p/m2"]);
    // A passive caller during a forced reload still gets the instant (old) list.
    expect(passive.map((m) => m.id)).toEqual(["p/m1"]);
    expect((await service.listModels()).map((m) => m.id)).toEqual(["p/m2"]);
    expect(calls).toBe(2);
    expect(Date.now() - cache.get("models")!.at).toBeLessThan(1_000);
  });

  test("a failed model load is not cached, so the next caller retries", async () => {
    const { service } = make();
    let calls = 0;
    const uncached = service as unknown as { listModelsUncached: () => Promise<ModelChoice[]> };
    uncached.listModelsUncached = async () => {
      calls += 1;
      if (calls === 1) throw new Error("gjc exploded");
      return [{ id: "p/m", provider: "p", canonical: "m" }];
    };

    await expect(service.listModels()).rejects.toThrow("gjc exploded");
    expect((await service.listModels()).map((m) => m.id)).toEqual(["p/m"]);
    expect(calls).toBe(2);

    // A failed forced refresh surfaces the error but keeps the last good list.
    uncached.listModelsUncached = async () => { calls += 1; throw new Error("gjc exploded again"); };
    await expect(service.listModels({ refresh: true })).rejects.toThrow("gjc exploded again");
    expect((await service.listModels()).map((m) => m.id)).toEqual(["p/m"]);
    expect(calls).toBe(3);
  });

  test("round-trips child lifetime, interim, status, and tool limits as restart-scoped config", async () => {
    const { service, paths } = make();
    const patches: readonly SettingsPatch[] = [
      { childWarmTtlSec: 120 },
      { childIdleTimeoutSec: 900 },
      { childMaxLive: 12 },
      { childInterimBatchSec: 7 },
      { childInterimRatePerMinute: 9 },
      { childInterimMaxBytes: 2_048 },
      { childStatusListLimit: 25 },
      { childStatusTextBytes: 1_024 },
      { childToolGuardMs: 75 },
    ];
    for (const patch of patches) {
      await expect(service.apply(patch)).resolves.toEqual({ needsRestart: true, needsReload: false, ownerHandleChanged: false });
    }
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toMatchObject({
      children: {
        warmTtlMs: 120_000,
        idleTimeoutMs: 900_000,
        maxLive: 12,
        interimBatchMs: 7_000,
        interimRatePerMinute: 9,
        interimMaxBytes: 2_048,
        statusListLimit: 25,
        statusTextMaxBytes: 1_024,
        toolLatencyGuardMs: 75,
      },
    });
    await expect(service.snapshot()).resolves.toMatchObject({
      childWarmTtlSec: 120,
      childIdleTimeoutSec: 900,
      childMaxLive: 12,
      childInterimBatchSec: 7,
      childInterimRatePerMinute: 9,
      childInterimMaxBytes: 2_048,
      childStatusListLimit: 25,
      childStatusTextBytes: 1_024,
      childToolGuardMs: 75,
    });
  });

  test("rejects every child limit outside its supported range", async () => {
    const { service } = make();
    const cases: readonly [SettingsPatch, string][] = [
      [{ childWarmTtlSec: 59 }, "Keep finished tasks warm must be between 60 seconds and 24 hours"],
      [{ childWarmTtlSec: 86_401 }, "Keep finished tasks warm must be between 60 seconds and 24 hours"],
      [{ childIdleTimeoutSec: 299 }, "Forget idle tasks must be between 300 seconds and 24 hours"],
      [{ childIdleTimeoutSec: 86_401 }, "Forget idle tasks must be between 300 seconds and 24 hours"],
      [{ childMaxLive: 0 }, "Live background tasks must be 1–64"],
      [{ childMaxLive: 65 }, "Live background tasks must be 1–64"],
      [{ childInterimBatchSec: 0 }, "Bundle task updates must be 1–60 seconds"],
      [{ childInterimBatchSec: 61 }, "Bundle task updates must be 1–60 seconds"],
      [{ childInterimRatePerMinute: 0 }, "Updates per task per minute must be 1–60"],
      [{ childInterimRatePerMinute: 61 }, "Updates per task per minute must be 1–60"],
      [{ childInterimMaxBytes: 127 }, "Progress update size must be 128–8192 bytes"],
      [{ childInterimMaxBytes: 8_193 }, "Progress update size must be 128–8192 bytes"],
      [{ childStatusListLimit: 0 }, "Background task status list limit must be 1–100"],
      [{ childStatusListLimit: 101 }, "Background task status list limit must be 1–100"],
      [{ childStatusTextBytes: 127 }, "Background task status text must be 128–8192 bytes"],
      [{ childStatusTextBytes: 8_193 }, "Background task status text must be 128–8192 bytes"],
      [{ childToolGuardMs: 4 }, "Background task latency alert threshold must be 5–1000 ms"],
      [{ childToolGuardMs: 1_001 }, "Background task latency alert threshold must be 5–1000 ms"],
    ];
    for (const [patch, message] of cases) {
      await expect(service.apply(patch)).rejects.toThrow(message);
    }
    await expect(service.apply({ childMaxConcurrent: 8, childMaxLive: 7 })).rejects
      .toThrow("Live background tasks must be greater than or equal to background tasks at once");
  });
});
