import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CustomTool } from "@gajae-code/coding-agent";

import {
  IMPORTANT_MONITOR_CRON,
  REGULAR_MONITOR_CRON,
  createServiceMonitorTool,
  serviceMonitorId,
  upsertServiceMonitor,
} from "../../src/assistant-work/monitoring.ts";
import {
  createAssistantObservationTools,
  createAssistantWorkObservationTool,
  createAssistantWorkTools,
} from "../../src/assistant-work/tools.ts";
import {
  SdkInProcessRunner,
  type ChildAgentSession,
  type ChildSessionFactory,
} from "../../src/children/runners/sdk-inprocess.ts";
import { MonitorStore } from "../../src/monitors/store.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const roots: string[] = [];
const NOW = new Date("2026-09-06T00:00:00.000Z");

function harness(): { readonly root: string; readonly store: StateStore; readonly monitors: MonitorStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-assistant-monitoring-"));
  roots.push(root);
  const store = openStateStore(join(root, "state.db"));
  const monitors = new MonitorStore(store, { hostTimeZone: "UTC", now: () => new Date(NOW.getTime()) });
  return { root, store, monitors };
}

async function execute(tool: CustomTool, callId: string, params: Record<string, unknown>) {
  return await tool.execute(callId, params as never, undefined, {} as never);
}

function textOf(result: { readonly content: readonly unknown[] }): string {
  const first = result.content[0];
  if (first === null || typeof first !== "object" || (first as { readonly type?: unknown }).type !== "text") {
    throw new Error("expected text result");
  }
  const text = (first as { readonly text?: unknown }).text;
  if (typeof text !== "string") throw new Error("invalid text result");
  return text;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("service-neutral assistant monitoring", () => {
  test("creates and replays a stable important monitor without a service catalog", async () => {
    const h = harness();
    let refreshes = 0;
    try {
      const input = {
        serviceReference: "https://novel.example.test/tenant/acme",
        accountReference: "workspace:account-42",
        observationInstruction: "Read the current renewal status and report whether a reply is still outstanding.",
        involved: true,
        important: true,
        ongoing: false,
        confidence: "clear" as const,
        unfinishedEvidence: ["The owner is waiting for a response."],
      };
      const first = await upsertServiceMonitor(h.monitors, input, () => { refreshes += 1; });
      const replay = await upsertServiceMonitor(h.monitors, { ...input, expectedRevision: first.monitor!.revision }, () => { refreshes += 1; });

      expect(first).toMatchObject({
        disposition: "track",
        operation: "created",
        changed: true,
        decision: { intervalMs: 300_000 },
        monitor: {
          id: serviceMonitorId(input.serviceReference, input.accountReference),
          trigger: { kind: "cron", expression: IMPORTANT_MONITOR_CRON },
          revision: 1,
        },
      });
      expect(first.monitor?.instruction).toContain("Observe only");
      expect(first.monitor?.instruction).toContain(input.serviceReference);
      expect(first.monitor?.instruction).toContain(input.accountReference);
      expect(first.monitor?.instruction).toContain("Use available runtime tools as needed");
      expect(first.monitor?.instruction).not.toContain("approval");
      expect(first.monitor?.instruction).toContain("assistant_service_observation");
      expect(replay).toMatchObject({ disposition: "track", operation: "replayed", changed: false, monitor: { revision: 1 } });
      expect(first.monitor?.enabled).toBe(true);
      expect(h.monitors.list()).toHaveLength(1);
      expect(refreshes).toBe(1);
    } finally {
      h.store.close();
    }
  });

  test("updates the same monitor and recomputes regular versus ongoing cadence", async () => {
    const h = harness();
    let refreshes = 0;
    try {
      const base = {
        serviceReference: "service://calendar-provider",
        accountReference: "account://owner-secondary",
        observationInstruction: "Read upcoming scheduling conflicts.",
        involved: true,
        important: false,
        ongoing: false,
        confidence: "clear" as const,
        unfinishedEvidence: ["A scheduling decision is unfinished."],
      };
      const regular = await upsertServiceMonitor(h.monitors, base, () => { refreshes += 1; });
      expect(regular).toMatchObject({
        operation: "created",
        decision: { intervalMs: 1_800_000 },
        monitor: { trigger: { expression: REGULAR_MONITOR_CRON }, revision: 1 },
      });
      expect(await upsertServiceMonitor(h.monitors, {
        ...base,
      })).toMatchObject({ operation: "replayed", changed: false, monitor: { revision: 1 } });

      const ongoing = await upsertServiceMonitor(h.monitors, {
        ...base,
        ongoing: true,
        observationInstruction: "Read upcoming scheduling conflicts and active changes.",
        expectedRevision: regular.monitor!.revision,
      }, () => { refreshes += 1; });
      expect(ongoing).toMatchObject({
        operation: "updated",
        decision: { intervalMs: 300_000 },
        monitor: { id: regular.monitor!.id, trigger: { expression: IMPORTANT_MONITOR_CRON }, revision: 2 },
      });
      expect(ongoing.monitor?.enabled).toBe(true);
      expect(refreshes).toBe(2);
      expect(() => h.monitors.update(ongoing.monitor!.id, 1, { enabled: false })).toThrow();
      await expect(upsertServiceMonitor(h.monitors, {
        ...base,
        observationInstruction: "Read upcoming scheduling conflicts and active changes again.",
        expectedRevision: 1,
      })).rejects.toThrow("revision conflict");
    } finally {
      h.store.close();
    }
  });

  test("keeps uncertain and irrelevant assessments as non-executing proposals or ignores", async () => {
    const h = harness();
    try {
      const tool = createServiceMonitorTool({ monitors: h.monitors });
      const uncertain = await execute(tool, "uncertain", {
        serviceReference: "unknown-service",
        accountReference: "unknown-account",
        observationInstruction: "Read whether a follow-up is needed.",
        involved: true,
        important: true,
        ongoing: false,
        confidence: "uncertain",
        unfinishedEvidence: ["The message may imply unfinished work."],
      });
      expect(uncertain.details).toMatchObject({ disposition: "propose", changed: false, decision: { intervalMs: 300_000 } });
      expect(textOf(uncertain)).toContain("No monitor was created or updated");
      expect(h.monitors.list()).toHaveLength(0);
      await expect(execute(tool, "mutation-instruction", {
        serviceReference: "unknown-service",
        accountReference: "unknown-account",
        observationInstruction: "Send a reply to the account.",
        involved: true,
        important: true,
        ongoing: false,
        confidence: "clear",
        unfinishedEvidence: ["A reply is unfinished."],
      })).rejects.toThrow("must describe read-only observation");
      expect(h.monitors.list()).toHaveLength(0);

      const ignored = await execute(tool, "ignored", {
        serviceReference: "other-service",
        accountReference: "other-account",
        observationInstruction: "Read current state.",
        involved: false,
        important: false,
        ongoing: false,
        confidence: "clear",
        unfinishedEvidence: [],
      });
      expect(ignored.details).toMatchObject({ disposition: "ignore", changed: false });
      expect(h.monitors.list()).toHaveLength(0);
    } finally {
      h.store.close();
    }
  });

  test("work observation persists the host assessment and never auto-schedules uncertainty", async () => {
    const h = harness();
    try {
      const observation = createAssistantWorkObservationTool({
        repository: h.store.assistantWork,
        now: () => new Date(NOW.getTime()),
        observationChannel: "monitor_child_tool",
      });
      const result = await execute(observation, "observe-uncertain", {
        source: "fixture:remote",
        occurrenceKey: "remote-1",
        workKey: "work-1",
        workTitle: "Uncertain remote follow-up",
        evidencePrincipal: "third_party",
        evidenceSubject: "sender@example.test",
        evidenceSummary: "Possibly needs a reply.",
        involved: true,
        important: false,
        ongoing: false,
        confidence: "uncertain",
        unfinishedEvidence: ["Wording is ambiguous."],
      });
      expect(result.details).toMatchObject({
        decision: { disposition: "propose", intervalMs: 1_800_000 },
        observation: { provenance: { principal: "third_party" } },
      });
      expect(textOf(result)).toContain("uncertain proposal only");
      expect(h.monitors.list()).toHaveLength(0);
      expect(h.store.assistantWork.listActions()).toEqual({ actions: [], unsupported: [] });
      expect(h.store.assistantWork.listObservations()).toMatchObject([{
        provenance: { channel: "monitor_child_tool", principal: "third_party" },
        evidence: { decision: { disposition: "propose", intervalMs: 1_800_000 } },
      }]);
      const ignored = await execute(observation, "observe-ignored", {
        source: "fixture:remote",
        occurrenceKey: "remote-ignored",
        workKey: "work-ignored",
        workTitle: "Irrelevant remote item",
        evidencePrincipal: "third_party",
        evidenceSubject: "sender@example.test",
        evidenceSummary: "No owner involvement.",
        involved: false,
        important: false,
        ongoing: false,
        confidence: "clear",
        unfinishedEvidence: [],
      });
      expect(ignored.details).toMatchObject({ created: false, decision: { disposition: "ignore" } });
      expect(h.store.assistantWork.listWorks()).toHaveLength(1);
    } finally {
      h.store.close();
    }
  });

  test("registers only observation and monitor tools on daemon child sessions", async () => {
    const h = harness();
    const calls: Array<Parameters<ChildSessionFactory["create"]>[0]> = [];
    const session: ChildAgentSession = { async prompt() {} };
    const factory: ChildSessionFactory = {
      create: async (input) => {
        calls.push(input);
        return session;
      },
    };
    try {
      const childTools = createAssistantObservationTools({ repository: h.store.assistantWork, monitors: h.monitors });
      const runner = new SdkInProcessRunner({ root: h.root, factory, customTools: childTools });
      await runner.run({ childId: "monitor-child", title: "Monitor fixture", prompt: "Observe only." }, new AbortController().signal);

      expect(childTools.map((tool) => tool.name)).toEqual(["assistant_work_observe", "assistant_response_received", "assistant_service_monitor"]);
      expect(childTools.some((tool) => /approve|grant|execute|local_file|install|http/i.test(tool.name))).toBe(false);
      const mainTools = createAssistantWorkTools({ repository: h.store.assistantWork, monitors: h.monitors });
      expect(mainTools.map((tool) => tool.name)).toEqual([
        "assistant_work_observe",
        "assistant_response_received",
        "assistant_local_file",
        "assistant_work_status",
        "assistant_service_monitor",
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        conversational: false,
        customTools: [
          expect.objectContaining({ name: "assistant_work_observe" }),
          expect.objectContaining({ name: "assistant_response_received" }),
          expect.objectContaining({ name: "assistant_service_monitor" }),
        ],
      });
    } finally {
      h.store.close();
    }
  });
});
