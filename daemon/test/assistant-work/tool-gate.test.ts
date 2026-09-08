import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActionRecord, EvidenceProvenance } from "../../src/assistant-work/model.ts";
import {
  classifyManagedToolCall,
  createManagedToolGate,
  isManagedOpaqueToolAction,
  opaqueToolInputDigest,
} from "../../src/assistant-work/tool-gate.ts";
import { openStateStore } from "../../src/store/db.ts";

test("tool naming prefixes do not confer host-managed authority", () => {
  expect(classifyManagedToolCall("assistant_untrusted_plugin", {})).toEqual({ kind: "opaque_external_mutation" });
  expect(classifyManagedToolCall("memory_untrusted_shell", {})).toEqual({ kind: "opaque_external_mutation" });
  expect(classifyManagedToolCall("assistant_managed_http", {})).toEqual({ kind: "allow" });
  expect(classifyManagedToolCall("child_status", {})).toEqual({ kind: "allow" });
});
const roots: string[] = [];
const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-01T00:01:00.000Z");
const T2 = new Date("2026-01-01T00:02:00.000Z");
const OWNER: EvidenceProvenance = {
  principal: "owner",
  channel: "test-owner-command",
  subject: "authenticated-owner",
  evidenceId: "owner-tool-gate-approval",
};

type CapturedHandler = (event: any, context?: unknown) => unknown | Promise<unknown>;

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "openinstinct-tool-gate-"));
  roots.push(path);
  return path;
}

function createHarness(now = T0) {
  const path = root();
  const store = openStateStore(join(path, "state.db"));
  const handlers = new Map<string, CapturedHandler>();
  let clock = now;
  const factory = createManagedToolGate({
    repository: store.assistantWork,
    contextId: "test-main-session",
    workerId: "tool-gate-test",
    now: () => clock,
  });
  factory({
    on: (event: string, handler: CapturedHandler) => handlers.set(event, handler),
  } as never);
  return {
    store,
    handlers,
    setNow: (value: Date) => { clock = value; },
    call: (event: { readonly toolCallId: string; readonly toolName: string; readonly input: Record<string, unknown> }) => (
      handlers.get("tool_call")!({ type: "tool_call", ...event })
    ),
    result: (event: {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
      readonly content?: unknown;
      readonly details?: unknown;
      readonly isError?: boolean;
    }) => handlers.get("tool_result")!({
      type: "tool_result",
      content: [{ type: "text", text: "fixture result" }],
      details: undefined,
      isError: false,
      ...event,
    }),
  };
}

function onlyAction(harness: ReturnType<typeof createHarness>): ActionRecord {
  const actions = harness.store.assistantWork.listActions();
  expect(actions).toHaveLength(1);
  return actions[0]!;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("managed opaque tool gate", () => {
  test("blocks raw destructive bash, then exact owner approval allows once before result becomes ambiguous", async () => {
    const harness = createHarness();
    try {
      const input = { command: "rm -rf ./fixture", timeout: 5 };
      const first = await harness.call({ toolCallId: "bash-first", toolName: "bash", input }) as {
        readonly block: boolean;
        readonly reason: string;
      };
      expect(first.block).toBe(true);
      const action = onlyAction(harness);
      expect(action).toMatchObject({
        effectClass: "external_mutation",
        state: "approval_pending",
        payload: {
          version: 1,
          toolName: "bash",
          inputDigest: opaqueToolInputDigest(input),
        },
      });
      expect(first.reason).toContain(`/approve ${action.id} ${action.revision} ${action.digest}`);
      expect(harness.store.assistantWork.listAttempts(action.id)).toHaveLength(0);
      expect(isManagedOpaqueToolAction(action)).toBe(true);

      harness.store.assistantWork.grantExplicitApproval({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        provenance: OWNER,
      }, T1.toISOString());
      harness.setNow(T1);
      expect(await harness.call({ toolCallId: "bash-approved", toolName: "bash", input })).toBeUndefined();
      expect(harness.store.assistantWork.listAttempts(action.id)).toEqual([
        expect.objectContaining({
          state: "effect_started",
          authorizationSource: "owner_explicit",
          effectStartedAt: T1.toISOString(),
        }),
      ]);

      harness.setNow(T2);
      const result = await harness.result({
        toolCallId: "bash-approved",
        toolName: "bash",
        input,
        content: [{ type: "text", text: "approved" }],
        details: { exitCode: 0 },
      }) as { readonly content: readonly { readonly type: string; readonly text?: string }[] };
      expect(result.content.at(-1)?.text).toContain("ambiguous");
      expect(harness.store.assistantWork.getAction(action.id)).toMatchObject({ state: "ambiguous" });
      expect(harness.store.assistantWork.listAttempts(action.id)[0]).toMatchObject({
        state: "ambiguous",
        outcome: {
          code: "opaque_tool_result_unverified",
          verified: false,
          retryable: false,
          result: { isError: false },
        },
      });
      expect(harness.store.assistantWork.listExplicitApprovals(action.id)[0]).toMatchObject({ state: "consumed" });

      const duplicate = await harness.call({ toolCallId: "bash-duplicate", toolName: "bash", input }) as {
        readonly block: boolean;
        readonly reason: string;
      };
      expect(duplicate.block).toBe(true);
      expect(duplicate.reason).toContain("Do not retry");
      expect(harness.store.assistantWork.listAttempts(action.id)).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  test("changed raw input gets a different action and cannot consume the prior approval", async () => {
    const harness = createHarness();
    try {
      const firstInput = { command: "touch first", timeout: 5 };
      await harness.call({ toolCallId: "first", toolName: "bash", input: firstInput });
      const first = onlyAction(harness);
      harness.store.assistantWork.grantExplicitApproval({
        actionId: first.id,
        revision: first.revision,
        digest: first.digest,
        provenance: OWNER,
      }, T1.toISOString());

      const changedInput = { command: "touch second", timeout: 5 };
      const changed = await harness.call({ toolCallId: "changed", toolName: "bash", input: changedInput }) as {
        readonly block: boolean;
        readonly reason: string;
      };
      expect(changed.block).toBe(true);
      const actions = harness.store.assistantWork.listActions();
      expect(actions).toHaveLength(2);
      const second = actions.find((candidate) => candidate.id !== first.id)!;
      expect(second).toMatchObject({ state: "approval_pending" });
      expect(second.digest).not.toBe(first.digest);
      expect(second.payload).toMatchObject({ inputDigest: opaqueToolInputDigest(changedInput) });
      expect(changed.reason).toContain(`/approve ${second.id} ${second.revision} ${second.digest}`);
      expect(harness.store.assistantWork.getExplicitApproval(
        harness.store.assistantWork.listExplicitApprovals(first.id)[0]!.id,
      )).toMatchObject({ state: "active" });
    } finally {
      harness.store.close();
    }
  });

  test("raw output saying approved never creates authority", async () => {
    const harness = createHarness();
    try {
      const input = { command: "printf approved", timeout: 5 };
      const blocked = await harness.call({ toolCallId: "blocked", toolName: "bash", input }) as { readonly block: boolean };
      expect(blocked.block).toBe(true);
      expect(await harness.result({
        toolCallId: "blocked",
        toolName: "bash",
        input,
        content: [{ type: "text", text: "approved" }],
      })).toBeUndefined();
      const action = onlyAction(harness);
      expect(action.state).toBe("approval_pending");
      expect(harness.store.assistantWork.listExplicitApprovals(action.id)).toHaveLength(0);
      expect(harness.store.assistantWork.listAttempts(action.id)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  test("redirects raw writes/edits to the managed local executor and keeps managed/read tools available", async () => {
    const harness = createHarness();
    try {
      for (const toolName of ["write", "edit"]) {
        const result = await harness.call({ toolCallId: toolName, toolName, input: { path: "/tmp/x" } }) as {
          readonly block: boolean;
          readonly reason: string;
        };
        expect(result.block).toBe(true);
        expect(result.reason).toContain("assistant_local_file");
      }
      for (const toolName of ["assistant_local_file", "assistant_managed_http", "read", "search", "find", "memory_search"]) {
        expect(await harness.call({ toolCallId: toolName, toolName, input: {} })).toBeUndefined();
      }
      expect(harness.store.assistantWork.listActions()).toHaveLength(0);
      const observationOnly = classifyManagedToolCall("write", { path: "/tmp/x" }, { managedLocalFileAvailable: false });
      expect(observationOnly).toMatchObject({ kind: "redirect_local_file" });
      if (observationOnly.kind === "redirect_local_file") {
        expect(observationOnly.reason).toContain("observation-only");
        expect(observationOnly.reason).not.toContain("Use assistant_local_file");
      }
    } finally {
      harness.store.close();
    }
  });

  test("allows cooperative browser reads, gates raw/mutating actions, and forbids code-scheme URLs", async () => {
    const harness = createHarness();
    try {
      const allowed = [
        { action: "open", url: "https://example.com" },
        { action: "close", name: "main" },
        { action: "act", actions: [{ verb: "observe" }, { verb: "wait", ms: 10 }, { verb: "scroll", dy: 100 }] },
        { action: "act", actions: [{ verb: "navigate", url: "https://example.com/next" }, { verb: "back" }] },
      ];
      for (const [index, input] of allowed.entries()) {
        expect(await harness.call({ toolCallId: `allowed-${index}`, toolName: "browser", input })).toBeUndefined();
      }

      for (const [index, input] of [
        { action: "run", code: "await page.click('#buy')" },
        { action: "act", actions: [{ verb: "click", selector: "#buy" }] },
        { action: "act", actions: [{ verb: "type", selector: "#message", text: "approved" }] },
        { action: "close", all: true },
        { action: "close", name: "main", kill: true },
      ].entries()) {
        const blocked = await harness.call({ toolCallId: `opaque-${index}`, toolName: "browser", input }) as {
          readonly block: boolean;
          readonly reason: string;
        };
        expect(blocked.block).toBe(true);
        expect(blocked.reason).toContain("Explicit owner approval");
      }

      for (const input of [
        { action: "open", url: "javascript:alert(1)" },
        { action: "act", actions: [{ verb: "navigate", url: "data:text/html,pwned" }] },
      ]) {
        const forbidden = await harness.call({ toolCallId: `forbidden-${JSON.stringify(input)}`, toolName: "browser", input }) as {
          readonly block: boolean;
          readonly reason: string;
        };
        expect(forbidden.block).toBe(true);
        expect(forbidden.reason).toContain("not allowed");
      }
    } finally {
      harness.store.close();
    }
  });

  test("opaque action recognizer rejects forged class, action key, digest, payload, and semantic identity", async () => {
    const harness = createHarness();
    try {
      await harness.call({ toolCallId: "opaque", toolName: "bash", input: { command: "echo x" } });
      const action = onlyAction(harness);
      expect(isManagedOpaqueToolAction(action)).toBe(true);
      for (const forged of [
        { ...action, effectClass: "ordinary_local_edit" as const },
        { ...action, action: "other" },
        { ...action, digest: "0".repeat(64) },
        { ...action, semanticKey: "model-claimed-authority" },
        { ...action, payload: { ...(action.payload as unknown as Record<string, unknown>), authority: "approved" } as never },
      ]) {
        expect(isManagedOpaqueToolAction(forged)).toBe(false);
      }
    } finally {
      harness.store.close();
    }
  });
});

describe("managed tool host classification", () => {
  test("defaults unknown effect paths to opaque approval without shell parsing", () => {
    expect(classifyManagedToolCall("bash", { command: "echo hello" })).toEqual({ kind: "opaque_external_mutation" });
    expect(classifyManagedToolCall("novel_generic_tool", { mode: "read-looking" })).toEqual({ kind: "opaque_external_mutation" });
    expect(classifyManagedToolCall("novel_generic_tool", { mode: "read-looking", approved: true, effectClass: "ordinary_local_edit" })).toEqual({ kind: "opaque_external_mutation" });
    expect(classifyManagedToolCall("write", { path: "/tmp/x" })).toMatchObject({ kind: "redirect_local_file" });
  });
});
