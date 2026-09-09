import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { accessibilityProbeResult, probeMessagesIdentity, type ConfigProbeResult } from "../src/bootstrap/probes.ts";
import {
  BootstrapMachine,
  type BootstrapProbes,
  type ProbeResult,
} from "../src/bootstrap/states.ts";

function probe(status: ProbeResult["status"], reason?: string): ProbeResult {
  return reason === undefined ? { status } : { status, reason };
}

function configProbe(
  status: ProbeResult["status"],
  reason?: string,
  allowlistHandle?: string,
): ConfigProbeResult {
  return {
    ...probe(status, reason),
    ...(allowlistHandle === undefined ? {} : { allowlistHandle }),
  };
}

function probesFor(
  config: ConfigProbeResult,
  credentials: ProbeResult = probe("passed"),
  fda: () => Promise<ProbeResult> = async () => probe("passed"),
  accessibility: () => Promise<ProbeResult> = async () => probe("passed"),
): BootstrapProbes {
  return {
    config: async () => config,
    credentials: async () => credentials,
    fda,
    accessibility,
  };
}

describe("BootstrapMachine", () => {
  test("blocks only when credentials are missing and skips iMessage probes", async () => {
    let fdaCalls = 0;
    let accessibilityCalls = 0;
    const machine = new BootstrapMachine(probesFor(
      configProbe("passed"),
      probe("missing", "credentials are required"),
      async () => {
        fdaCalls += 1;
        return probe("passed");
      },
      async () => {
        accessibilityCalls += 1;
        return probe("passed");
      },
    ));


    expect(machine.snapshot.state).toBe("starting");
    await expect(machine.evaluate()).resolves.toMatchObject({
      state: "credentials_blocked",
      probes: {
        config: { status: "passed" },
        credentials: { status: "missing" },
        fda: { status: "passed" },
      },
      reason: "credentials are required",
    });
    expect(fdaCalls).toBe(1);
    expect(accessibilityCalls).toBe(0);
  });

  test("checks baseline FDA without an owner handle and skips iMessage probes", async () => {
    let fdaCalls = 0;
    let accessibilityCalls = 0;
    const machine = new BootstrapMachine(probesFor(
      configProbe("passed"),
      probe("passed"),
      async () => {
        fdaCalls += 1;
        return probe("passed");
      },
      async () => {
        accessibilityCalls += 1;
        return probe("passed");
      },
    ));

    const snapshot = await machine.evaluate();
    expect(snapshot).toMatchObject({
      state: "running",
      probes: { config: { status: "passed" }, credentials: { status: "passed" } },
    });
    expect(snapshot.imessageHandle).toBeUndefined();
    expect(snapshot.probes.fda).toEqual({ status: "passed" });
    expect(snapshot.probes.accessibility).toBeUndefined();
    expect(fdaCalls).toBe(1);
    expect(accessibilityCalls).toBe(0);
  });

  test("keeps running when FDA is denied and publishes the configured handle", async () => {
    const machine = new BootstrapMachine(probesFor(
      configProbe("passed", undefined, "+821012345678"),
      probe("passed"),
      async () => probe("denied", "Full Disk Access is required"),
      async () => probe("passed"),
    ));

    const snapshot = await machine.evaluate();
    expect(snapshot).toMatchObject({
      state: "running",
      imessageHandle: "+821012345678",
      probes: { fda: { status: "denied" } },
      reason: expect.stringContaining("OS capabilities are limited"),
    });
  });

  test("surfaces config diagnostics without blocking the core", async () => {
    let fdaCalls = 0;
    let accessibilityCalls = 0;
    const makeMachine = (config: ConfigProbeResult) => new BootstrapMachine(probesFor(
      config,
      probe("passed"),
      async () => {
        fdaCalls += 1;
        return probe("passed");
      },
      async () => {
        accessibilityCalls += 1;
        return probe("passed");
      },
    ));

    await expect(makeMachine(configProbe("missing", "config.json is missing; defaults apply")).evaluate()).resolves.toMatchObject({
      state: "running",
      reason: "config.json is missing; defaults apply",
    });
    await expect(makeMachine(configProbe("invalid", "config.json is not valid JSON")).evaluate()).resolves.toMatchObject({
      state: "running",
      reason: "config.json is not valid JSON",
    });
    expect(fdaCalls).toBe(2);
    expect(accessibilityCalls).toBe(0);
  });

  for (const status of ["denied", "unknown", "error"] as const) {
    test(`chat-only runtime keeps running with truthful ${status} FDA diagnostics`, async () => {
      const machine = new BootstrapMachine(probesFor(
        configProbe("passed"),
        probe("passed"),
        async () => probe(status),
      ));
      await expect(machine.evaluate()).resolves.toMatchObject({
        state: "running",
        probes: { fda: { status } },
        reason: expect.stringContaining(`not verified (${status})`),
      });
    });
  }

  test("a failed FDA recheck replaces prior success without stopping Chat", async () => {
    let fail = false;
    const machine = new BootstrapMachine(probesFor(
      configProbe("passed"),
      probe("passed"),
      async () => {
        if (fail) throw new Error("access probe unavailable");
        return probe("passed");
      },
    ));
    expect((await machine.evaluate()).probes.fda?.status).toBe("passed");
    fail = true;
    await expect(machine.evaluate()).resolves.toMatchObject({
      state: "running",
      probes: { fda: { status: "error", reason: "access probe unavailable" } },
      reason: expect.stringContaining("not verified (error)"),
    });
  });

  test("records a degraded state when a probe throws", async () => {
    const machine = new BootstrapMachine({
      config: async () => {
        throw new Error("filesystem unavailable");
      },
      messages: async () => probe("passed"),
      credentials: async () => probe("passed"),
      fda: async () => probe("passed"),
      accessibility: async () => probe("passed"),
    });

    await expect(machine.evaluate()).resolves.toMatchObject({
      state: "degraded",
      reason: "filesystem unavailable",
    });
  });
});


describe("Messages identity probe", () => {
  test("checks the configured owner and reports account state", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-messages-probe-"));
    const configPath = join(root, "config.json");
    try {
      writeFileSync(configPath, JSON.stringify({ allowlistHandle: "+15550000001" }));

      await expect(probeMessagesIdentity(configPath, () => ["+1 (555) 000-0001"])).resolves.toEqual({
        status: "invalid",
        aliases: ["+1 (555) 000-0001"],
        reason: "Messages on this Mac is signed in as you (+1 (555) 000-0001). Gajae would reply inside your own conversations. Sign Messages out and back in with a separate Apple ID made for Gajae.",
      });
      await expect(probeMessagesIdentity(configPath, () => ["gajae@example.com"])).resolves.toEqual({
        status: "passed",
        aliases: ["gajae@example.com"],
      });
      await expect(probeMessagesIdentity(configPath, () => [])).resolves.toEqual({
        status: "missing",
        reason: "Messages on this Mac isn't signed in to iMessage. Sign it in with Gajae's own Apple ID (not yours).",
      });
      await expect(probeMessagesIdentity(configPath, () => undefined)).resolves.toEqual({
        status: "unknown",
        reason: "Couldn't read which account Messages is signed in as.",
      });

      rmSync(configPath);
      await expect(probeMessagesIdentity(configPath, () => ["x@y.z"])).resolves.toEqual({
        status: "passed",
        aliases: ["x@y.z"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
describe("Accessibility probe result", () => {
  test("maps the native trust decision without requiring host TCC state in tests", () => {
    expect(accessibilityProbeResult(() => true)).toEqual({ status: "passed" });
    expect(accessibilityProbeResult(() => false)).toEqual(expect.objectContaining({ status: "denied" }));
    expect(accessibilityProbeResult(() => {
      throw new Error("ffi unavailable");
    })).toEqual(expect.objectContaining({ status: "error", reason: expect.stringContaining("ffi unavailable") }));
  });
});
