import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../../src/store/db.ts";
import { preflightLocalFileAction } from "../../src/assistant-work/local-effects.ts";
import { AssistantWorkRuntime } from "../../src/assistant-work/runtime.ts";

test("daemon recovery resumes a claimed pre-effect local action using its real executor", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-runtime-recover-"));
  const store = StateStore.open(join(root, "state.db"));
  const path = join(root, "note.txt");
  writeFileSync(path, "before");
  const now = new Date().toISOString();
  const work = store.assistantWork.admitObservation({ source: "fixture", occurrenceKey: "1", workKey: "work", workTitle: "Recover file edit", observedAt: now, evidence: { pending: true }, provenance: { principal: "system", channel: "fixture", subject: "work", evidenceId: "1" } }, now).work;
  const preflight = await preflightLocalFileAction({ workId: work.id, semanticKey: "edit", operations: [{ operation: "write_file", path, content: "after" }] });
  const action = store.assistantWork.proposeAction(preflight.proposal, now);
  store.assistantWork.claimForDispatch({ actionId: action.id, revision: action.revision, digest: action.digest, attemptId: "original-attempt", workerId: "old-worker" }, now);
  const errors: unknown[] = [];
  const runtime = new AssistantWorkRuntime({ store, isPaused: () => false, report: async () => true, onError: (error) => errors.push(error) });
  try {
    runtime.start();
    await runtime.drain();
    expect(readFileSync(path, "utf8")).toBe("after");
    expect(store.assistantWork.getAttempt("original-attempt")?.state).toBe("confirmed");
    expect(store.assistantWork.listAttempts(action.id)).toHaveLength(1);
    await runtime.drain();
    expect(store.assistantWork.listAttempts(action.id)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { await runtime.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("runtime never repeats an effect that started before a crash", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-runtime-ambiguous-"));
  const store = StateStore.open(join(root, "state.db"));
  const path = join(root, "note.txt");
  writeFileSync(path, "before");
  const now = new Date().toISOString();
  const work = store.assistantWork.admitObservation({ source: "fixture", occurrenceKey: "2", workKey: "work", workTitle: "Unknown edit", observedAt: now, evidence: {}, provenance: { principal: "system", channel: "fixture", subject: "work", evidenceId: "2" } }, now).work;
  const preflight = await preflightLocalFileAction({ workId: work.id, semanticKey: "edit", operations: [{ operation: "write_file", path, content: "must not run" }] });
  const action = store.assistantWork.proposeAction(preflight.proposal, now);
  store.assistantWork.claimForDispatch({ actionId: action.id, revision: action.revision, digest: action.digest, attemptId: "started-attempt", workerId: "old-worker" }, now);
  store.assistantWork.markEffectStarted({ attemptId: "started-attempt", workerId: "old-worker" }, now);
  const reports: string[] = [];
  const runtime = new AssistantWorkRuntime({ store, isPaused: () => false, report: async (report) => { reports.push(report.code); return true; }, onError: () => {} });
  try {
    runtime.start();
    await runtime.drain();
    expect(readFileSync(path, "utf8")).toBe("before");
    expect(store.assistantWork.getAttempt("started-attempt")?.state).toBe("ambiguous");
    expect(reports).toEqual(["attempt_reconcile_only"]);
    await runtime.drain();
    expect(reports).toHaveLength(1);
  } finally { await runtime.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("runtime independently verifies an already-applied edit after crash without another attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-runtime-verify-"));
  const store = StateStore.open(join(root, "state.db"));
  const path = join(root, "note.txt");
  writeFileSync(path, "before");
  const now = new Date().toISOString();
  const work = store.assistantWork.admitObservation({ source: "fixture", occurrenceKey: "verified", workKey: "work", workTitle: "Verify edit", observedAt: now, evidence: {}, provenance: { principal: "system", channel: "fixture", subject: "work", evidenceId: "verified" } }, now).work;
  const preflight = await preflightLocalFileAction({ workId: work.id, semanticKey: "edit", operations: [{ operation: "write_file", path, content: "already applied" }] });
  const action = store.assistantWork.proposeAction(preflight.proposal, now);
  store.assistantWork.claimForDispatch({ actionId: action.id, revision: action.revision, digest: action.digest, attemptId: "applied-attempt", workerId: "old-worker" }, now);
  store.assistantWork.markEffectStarted({ attemptId: "applied-attempt", workerId: "old-worker" }, now);
  writeFileSync(path, "already applied");
  const errors: unknown[] = [];
  const runtime = new AssistantWorkRuntime({ store, isPaused: () => false, report: async () => true, onError: (error) => errors.push(error) });
  try {
    runtime.start();
    await runtime.drain();
    expect(store.assistantWork.getAttempt("applied-attempt")?.state).toBe("confirmed");
    expect(store.assistantWork.listAttempts(action.id)).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("already applied");
    expect(errors).toEqual([]);
  } finally { await runtime.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
