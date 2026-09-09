import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CustomTool } from "@gajae-code/coding-agent";

import { createAssistantWorkTools } from "../../src/assistant-work/tools.ts";
import { composeMainSessionCustomTools } from "../../src/sdk-session/main-session.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const roots: string[] = [];
const NOW = new Date("2026-09-05T12:00:00.000Z");

function createHarness(): {
  readonly root: string;
  readonly store: StateStore;
  readonly tools: readonly CustomTool[];
} {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-assistant-tools-"));
  roots.push(root);
  const store = openStateStore(join(root, "state.db"));
  const tools = createAssistantWorkTools({
    repository: store.assistantWork,
    workerId: "test-main-session",
    now: () => new Date(NOW.getTime()),
  });
  return { root, store, tools };
}

function tool(tools: readonly CustomTool[], name: string): CustomTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

async function invoke(tool: CustomTool, callId: string, params: Record<string, unknown>) {
  return await tool.execute(callId, params as never, undefined, {} as never);
}

function resultText(result: { readonly content: readonly unknown[] }): string {
  const first = result.content[0];
  if (first === null || typeof first !== "object" || (first as { readonly type?: unknown }).type !== "text") {
    throw new Error("tool result did not contain text");
  }
  const text = (first as { readonly text?: unknown }).text;
  if (typeof text !== "string") {
    throw new Error("tool result text was invalid");
  }
  return text;
}

async function observeWork(harness: ReturnType<typeof createHarness>, suffix: string): Promise<string> {
  const result = await invoke(tool(harness.tools, "assistant_work_observe"), `observe-${suffix}`, {
    source: "fixture:message",
    occurrenceKey: `message-${suffix}`,
    workKey: `thread-${suffix}`,
    workTitle: `Fixture work ${suffix}`,
    evidencePrincipal: "third_party",
    evidenceSubject: "sender@example.test",
    evidenceSummary: "A fixture requested a local update.",
    involved: true, important: false, ongoing: true, confidence: "clear",
    unfinishedEvidence: ["The requested local update is pending."],
    evidenceReference: `fixture://${suffix}`,
    observedAt: "2026-09-05T11:59:00.000Z",
  });
  return (result.details.work as { readonly id: string }).id;
}


afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("assistant-work main-session tools", () => {
  test("registers observation, managed local action, and read-only status without an approval tool", async () => {
    const harness = createHarness();
    try {
      expect(harness.tools.map((entry) => entry.name)).toEqual([
        "assistant_work_observe",
        "assistant_response_received",
        "assistant_local_file",
        "assistant_work_status",
      ]);
      expect(harness.tools.some((entry) => /approv|grant/i.test(entry.name))).toBe(false);
      const composed = composeMainSessionCustomTools(
        () => ({ id: "child-fixture" }),
        () => ({ kind: "chat_only" }),
        harness.tools,
      );
      expect(composed.map((entry) => entry.name)).toEqual([
        "delegate_background",
        "send_image",
        "assistant_work_observe",
        "assistant_response_received",
        "assistant_local_file",
        "assistant_work_status",
      ]);
      expect(() => composeMainSessionCustomTools(
        () => ({ id: "child-fixture" }),
        () => ({ kind: "chat_only" }),
        [harness.tools[0]!, harness.tools[0]!],
      )).toThrow("duplicate main-session custom tool");

      const observe = tool(harness.tools, "assistant_work_observe");
      const input = {
        source: "fixture:mail",
        occurrenceKey: "message-1",
        workKey: "thread-1",
        workTitle: "Reply to fixture",
        evidencePrincipal: "third_party",
        evidenceSubject: "sender@example.test",
        evidenceSummary: "Please update a local draft.",
        involved: true, important: false, ongoing: true, confidence: "clear",
        unfinishedEvidence: ["The sender requested a draft update."],
        observedAt: "2026-09-05T11:58:00.000Z",
      };
      const first = await invoke(observe, "observation-1", input);
      const replay = await invoke(observe, "observation-replay", input);

      expect(resultText(first)).toContain("No action was dispatched");
      expect(first.details).toMatchObject({
        created: true,
        observation: {
          provenance: {
            principal: "third_party",
            channel: "main_session_tool",
            subject: "sender@example.test",
          },
        },
        work: { title: "Reply to fixture", state: "open" },
      });
      await expect(invoke(observe, "forged-owner-observation", {
        ...input,
        occurrenceKey: "forged-owner",
        workKey: "forged-owner",
        evidencePrincipal: "owner",
      })).rejects.toThrow("cannot record owner provenance");
      expect(replay.details).toMatchObject({ created: false });
      expect(harness.store.assistantWork.listWorks()).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  test("proposes and executes an ordinary file write through the registered tool with verified status", async () => {
    const harness = createHarness();
    try {
      const workId = await observeWork(harness, "ordinary");
      const target = join(harness.root, "ordinary.txt");
      const local = tool(harness.tools, "assistant_local_file");
      const proposed = await invoke(local, "propose-ordinary", {
        operation: "propose",
        workId,
        semanticKey: "write-ordinary",
        fileOperations: [{ operation: "write_file", path: target, content: "verified content" }],
      });
      const action = proposed.details.action as { readonly id: string; readonly revision: number; readonly digest: string; readonly state: string };

      expect(action.state).toBe("planned");
      expect(resultText(proposed)).toContain("No effect has run");
      expect(existsSync(target)).toBe(false);
      const executed = await invoke(local, "execute-ordinary", {
        operation: "execute",
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
      });

      expect(executed).toMatchObject({
        content: [{ text: expect.stringContaining("read back and verified") }],
        details: {
          kind: "confirmed",
          action: { state: "confirmed" },
          attempt: { state: "confirmed" },
        },
      });
      expect(readFileSync(target, "utf8")).toBe("verified content");

      const status = await invoke(tool(harness.tools, "assistant_work_status"), "status-ordinary", {
        actionId: action.id,
      });
      expect(resultText(status)).toContain(`revision ${action.revision} digest ${action.digest}`);
      expect(status.details).toMatchObject({
        action: { id: action.id, state: "confirmed" },
        attempts: [{ state: "confirmed" }],
      });
      expect(JSON.stringify(status.details)).not.toContain("verified content");
    } finally {
      harness.store.close();
    }
  });

  test("executes an existing-file delete immediately and refuses duplicate execution", async () => {
    const harness = createHarness();
    try {
      const workId = await observeWork(harness, "delete");
      const target = join(harness.root, "delete.txt");
      writeFileSync(target, "remove immediately", "utf8");
      const local = tool(harness.tools, "assistant_local_file");
      const proposed = await invoke(local, "propose-delete", {
        operation: "propose",
        workId,
        semanticKey: "delete-existing",
        fileOperations: [{ operation: "delete_file", path: target }],
      });
      const action = proposed.details.action as { readonly id: string; readonly revision: number; readonly digest: string; readonly state: string };
      expect(action.state).toBe("planned");
      expect(resultText(proposed)).not.toContain("/approve");
      expect(existsSync(target)).toBe(true);
      const params = { operation: "execute", actionId: action.id, revision: action.revision, digest: action.digest };
      expect(await invoke(local, "execute-delete", params)).toMatchObject({
        details: { kind: "confirmed", attempt: { state: "confirmed" } },
      });
      expect(existsSync(target)).toBe(false);
      writeFileSync(target, "new file must survive replay", "utf8");
      expect(await invoke(local, "duplicate-delete", params)).toMatchObject({
        details: { kind: "rejected", reason: "confirmed" },
      });
      expect(readFileSync(target, "utf8")).toBe("new file must survive replay");
      expect(harness.store.assistantWork.listAttempts(action.id)).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  test("rejects stale material and cancellation without executing the file effect", async () => {
    const harness = createHarness();
    try {
      const workId = await observeWork(harness, "stale-and-reject");
      const staleTarget = join(harness.root, "stale.txt");
      writeFileSync(staleTarget, "stale", "utf8");
      const local = tool(harness.tools, "assistant_local_file");
      const firstProposal = await invoke(local, "propose-stale-first", {
        operation: "propose",
        workId,
        semanticKey: "stale-delete",
        fileOperations: [{ operation: "delete_file", path: staleTarget }],
      });
      const first = firstProposal.details.action as { readonly id: string; readonly revision: number; readonly digest: string };
      const revisedProposal = await invoke(local, "propose-stale-revised", {
        operation: "propose",
        workId,
        semanticKey: "stale-delete",
        fileOperations: [{ operation: "write_file", path: staleTarget, content: "new material" }],
      });
      const revised = revisedProposal.details.action as { readonly id: string; readonly revision: number; readonly digest: string };
      expect(revised.revision).toBe(first.revision + 1);

      expect(await invoke(local, "execute-stale-revision", {
        operation: "execute", actionId: first.id, revision: first.revision, digest: first.digest,
      })).toMatchObject({ details: { kind: "rejected", reason: "stale_revision" } });
      expect(await invoke(local, "execute-stale-digest", {
        operation: "execute", actionId: revised.id, revision: revised.revision, digest: first.digest,
      })).toMatchObject({ details: { kind: "rejected", reason: "stale_digest" } });
      expect(harness.store.assistantWork.listAttempts(first.id)).toHaveLength(0);
      expect(readFileSync(staleTarget, "utf8")).toBe("stale");

      const rejectTarget = join(harness.root, "reject.txt");
      writeFileSync(rejectTarget, "do not remove", "utf8");
      const rejectProposal = await invoke(local, "propose-reject", {
        operation: "propose",
        workId,
        semanticKey: "reject-delete",
        fileOperations: [{ operation: "delete_file", path: rejectTarget }],
      });
      const rejected = rejectProposal.details.action as { readonly id: string; readonly revision: number; readonly digest: string };
      harness.store.assistantWork.cancelAction({
        actionId: rejected.id, revision: rejected.revision, digest: rejected.digest, reason: "cancelled fixture",
      }, NOW.toISOString());
      expect(await invoke(local, "execute-cancelled", {
        operation: "execute", actionId: rejected.id, revision: rejected.revision, digest: rejected.digest,
      })).toMatchObject({ details: { kind: "rejected", reason: "cancelled" } });
      expect(harness.store.assistantWork.getAction(rejected.id)).toMatchObject({ state: "cancelled" });
      expect(readFileSync(rejectTarget, "utf8")).toBe("do not remove");
      expect(harness.store.assistantWork.listAttempts(rejected.id)).toHaveLength(0);

      const unsupported = harness.store.assistantWork.proposeAction({
        workId,
        semanticKey: "unsupported-browser-mutation",
        effectClass: "external_mutation",
        action: "submit_browser_form",
        payload: { fixture: true },
      }, NOW.toISOString());
      expect(await invoke(local, "execute-unsupported", {
        operation: "execute", actionId: unsupported.id, revision: unsupported.revision, digest: unsupported.digest,
      })).toMatchObject({ details: { kind: "preflight_rejected" } });
      expect(harness.store.assistantWork.listAttempts(unsupported.id)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });
});

test("reopened status exposes obsolete-state diagnostics independently of live filters", async () => {
  const harness = createHarness();
  const workId = await observeWork(harness, "mixed-state");
  const target = join(harness.root, "obsolete.txt");
  writeFileSync(target, "must survive");
  const local = tool(harness.tools, "assistant_local_file");
  const oldProposal = await invoke(local, "old-proposal", {
    operation: "propose", workId, semanticKey: "old-delete",
    fileOperations: [{ operation: "delete_file", path: target }],
  });
  const old = oldProposal.details.action as { id: string; revision: number; digest: string };
  const healthyProposal = await invoke(local, "healthy-proposal", {
    operation: "propose", workId, semanticKey: "healthy-write",
    fileOperations: [{ operation: "write_file", path: join(harness.root, "healthy.txt"), content: "healthy" }],
  });
  const healthy = healthyProposal.details.action as { id: string };
  harness.store.close();
  const db = new Database(join(harness.root, "state.db"));
  try { db.query("UPDATE assistant_work_actions SET state = 'approval_pending' WHERE id = ?").run(old.id); }
  finally { db.close(); }
  const reopened = openStateStore(join(harness.root, "state.db"));
  try {
    const tools = createAssistantWorkTools({ repository: reopened.assistantWork });
    const diagnostic = { kind: "unsupported_action_state", actionId: old.id, workId, state: "approval_pending", revision: old.revision, digest: old.digest };
    for (const filter of [{}, { state: "planned" }, { state: "confirmed" }]) {
      const status = await invoke(tool(tools, "assistant_work_status"), "mixed-status", { workId, ...filter });
      expect(status.details.unsupportedActions).toEqual([diagnostic]);
      expect(resultText(status)).toContain(old.id);
      expect(resultText(status)).toContain("approval_pending");
      expect(resultText(status)).toContain(old.digest);
      expect(status.details.actions).toEqual(filter.state === "confirmed" ? [] : [expect.objectContaining({ id: healthy.id, state: "planned" })]);
    }
    expect(() => reopened.assistantWork.getAction(old.id)).toThrow("unsupported assistant action state");
    await expect(invoke(tool(tools, "assistant_work_status"), "old-exact-status", { actionId: old.id })).rejects.toThrow("unsupported assistant action state");
    await expect(invoke(tool(tools, "assistant_local_file"), "old-execute", {
      operation: "execute", actionId: old.id, revision: old.revision, digest: old.digest,
    })).rejects.toThrow("unsupported assistant action state");
    expect(readFileSync(target, "utf8")).toBe("must survive");
    expect(reopened.assistantWork.listAttempts(old.id)).toHaveLength(0);
  } finally { reopened.close(); }
});
