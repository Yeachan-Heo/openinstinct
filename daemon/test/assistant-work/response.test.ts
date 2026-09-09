import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStore } from "../../src/store/db.ts";
import { createResponseCompletionTool } from "../../src/assistant-work/response.ts";

test("response evidence must match a confirmed action and uncertain responses cannot close work", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-response-"));
  const store = openStateStore(join(root, "state.db"));
  const then = "2026-01-01T00:00:00.000Z";
  try {
    const work = store.assistantWork.admitObservation({ source: "fixture:mail", occurrenceKey: "request", workKey: "thread", workTitle: "Question", observedAt: then, evidence: { question: "When?" }, provenance: { principal: "third_party", channel: "fixture", subject: "sender", evidenceId: "request" } }, then).work;
    const action = store.assistantWork.proposeAction({ workId: work.id, semanticKey: "reply", effectClass: "external_message", recipient: "sender", topic: "schedule", action: "reply", payload: { body: "Friday?" } }, then);
    expect(action.state).toBe("planned");
    store.assistantWork.claimForDispatch({ actionId: action.id, revision: action.revision, digest: action.digest, attemptId: "sent", workerId: "fixture" }, then);
    store.assistantWork.markEffectStarted({ attemptId: "sent", workerId: "fixture" }, then);
    store.assistantWork.confirmAttempt({ attemptId: "sent", workerId: "fixture", outcome: { remoteReceipt: "message-1" } }, then);
    const tool = createResponseCompletionTool(store.assistantWork);
    const input = { workId: work.id, responseToActionId: action.id, source: "fixture:mail", observedWorkKey: work.stableKey, occurrenceKey: "response-1", reference: "fixture://thread/response-1", summary: "Friday is confirmed", observedAt: "2026-01-01T00:01:00.000Z", confidence: "uncertain", satisfiesOutstandingRequest: true };
    await tool.execute("uncertain", input as never, undefined, {} as never);
    expect(store.assistantWork.getWork(work.id)?.state).toBe("open");
    await expect(tool.execute("wrong-thread", { ...input, observedWorkKey: "different-thread", reference: "fixture://different-thread/reply", confidence: "clear" } as never, undefined, {} as never)).rejects.toThrow("conversation key");
    expect(store.assistantWork.getWork(work.id)?.state).toBe("open");
    await expect(tool.execute("wrong-source", { ...input, source: "unrelated", occurrenceKey: "response-2", confidence: "clear" } as never, undefined, {} as never)).rejects.toThrow("source");
    await expect(tool.execute("old-response", { ...input, occurrenceKey: "response-old", observedAt: "2025-12-31T23:00:00.000Z", confidence: "clear" } as never, undefined, {} as never)).rejects.toThrow("predates");
    await tool.execute("clear", { ...input, occurrenceKey: "response-confirmed", confidence: "clear" } as never, undefined, {} as never);
    expect(store.assistantWork.getWork(work.id)?.state).toBe("completed");
    expect(store.assistantWork.listAttempts(action.id)).toHaveLength(1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
