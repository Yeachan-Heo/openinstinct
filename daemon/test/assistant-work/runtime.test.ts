import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../../src/store/db.ts";
import { preflightLocalFileAction } from "../../src/assistant-work/local-effects.ts";
import { AssistantWorkRuntime } from "../../src/assistant-work/runtime.ts";
import { executeManagedLocalFileAction } from "../../src/assistant-work/execution.ts";

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

test("reopened runtime isolates obsolete due policies and report failures while healthy work progresses", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-runtime-mixed-state-"));
  const dbPath = join(root, "state.db");
  const initial = StateStore.open(dbPath);
  const at = "2026-01-01T00:00:00.000Z";
  const later = "2026-01-01T00:01:00.000Z";
  async function seed(suffix: string, timestamp: string) {
    const path = join(root, `${suffix}.txt`);
    writeFileSync(path, "before");
    const work = initial.assistantWork.admitObservation({
      source: "fixture", occurrenceKey: suffix, workKey: suffix, workTitle: suffix, observedAt: timestamp,
      evidence: {}, provenance: { principal: "system", channel: "fixture", subject: suffix, evidenceId: suffix },
    }, timestamp).work;
    const preflight = await preflightLocalFileAction({
      workId: work.id, semanticKey: "repeat-edit", operations: [{ operation: "write_file", path, content: "after" }],
    });
    const action = initial.assistantWork.proposeAction(preflight.proposal, timestamp);
    expect(await executeManagedLocalFileAction({
      repository: initial.assistantWork, actionId: action.id, revision: action.revision, digest: action.digest,
      attemptId: `original-${suffix}`, workerId: "fixture", now: () => timestamp,
    })).toMatchObject({ kind: "confirmed" });
    initial.assistantWork.setFollowupPolicy({
      workId: work.id, actionId: action.id, enabled: true, intervalMs: 60_000, maxAttempts: 1,
      provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: suffix },
    }, timestamp);
    writeFileSync(path, "before");
    return { work, action, path };
  }
  const obsolete = await seed("obsolete", at);
  const healthy = await seed("healthy", later);
  const obsoleteDispatch = initial.assistantWork.claimDueFollowup(obsolete.work.id, "old-runtime", later);
  if (obsoleteDispatch.kind !== "claimed") throw new Error("expected claimed obsolete fixture");
  const standalone = [];
  for (const state of ["claimed_pre_effect", "effect_started"] as const) {
    const path = join(root, `${state}.txt`);
    writeFileSync(path, "before");
    const work = initial.assistantWork.admitObservation({ source: "fixture", occurrenceKey: state, workKey: state,
      workTitle: state, observedAt: at, evidence: {}, provenance: { principal: "system", channel: "fixture", subject: state, evidenceId: state } }, at).work;
    const preflight = await preflightLocalFileAction({ workId: work.id, semanticKey: state, operations: [{ operation: "write_file", path, content: "after" }] });
    const action = initial.assistantWork.proposeAction(preflight.proposal, at);
    initial.assistantWork.claimForDispatch({ actionId: action.id, revision: action.revision, digest: action.digest, attemptId: state, workerId: "old-runtime" }, at);
    if (state === "effect_started") initial.assistantWork.markEffectStarted({ attemptId: state, workerId: "old-runtime" }, at);
    standalone.push({ state, path, action });
  }
  initial.assistantWork.admitFollowupReport({ id: "bad-report", code: "fixture_bad", detail: {} }, at);
  initial.assistantWork.admitFollowupReport({ id: "healthy-report", code: "fixture_healthy", detail: {} }, later);
  initial.close();
  const db = new Database(dbPath);
  try { db.query("UPDATE assistant_work_actions SET state = 'approval_pending' WHERE id = ?").run(obsoleteDispatch.action.id); }
  finally { db.close(); }
  const store = StateStore.open(dbPath);
  const errors: unknown[] = [];
  const delivered: string[] = [];
  const deliveryFailure = new Error("fixture report unavailable");
  const runtime = new AssistantWorkRuntime({
    store, isPaused: () => false,
    report: async (_report, key) => {
      if (key === "bad-report") throw deliveryFailure;
      delivered.push(key);
      return true;
    },
    onError: (error) => errors.push(error),
  });
  try {
    expect(store.assistantWork.listFollowupPolicies().map((policy) => policy.workId)).toEqual([obsolete.work.id, healthy.work.id]);
    runtime.start();
    await runtime.drain();
    expect(readFileSync(obsolete.path, "utf8")).toBe("before");
    expect(readFileSync(healthy.path, "utf8")).toBe("after");
    expect(store.assistantWork.getFollowupDispatch(obsoleteDispatch.dispatch.id)).toEqual(obsoleteDispatch.dispatch);
    expect(store.assistantWork.listAttempts(obsoleteDispatch.action.id)).toHaveLength(0);
    for (const entry of standalone) {
      expect(readFileSync(entry.path, "utf8")).toBe(entry.state === "claimed_pre_effect" ? "after" : "before");
      expect(store.assistantWork.getAttempt(entry.state)?.state).toBe(entry.state === "claimed_pre_effect" ? "confirmed" : "ambiguous");
      expect(store.assistantWork.listAttempts(entry.action.id)).toHaveLength(1);
    }
    expect(store.assistantWork.listAttempts(obsolete.action.id)).toHaveLength(1);
    const recoveryError = errors.find((error) => error instanceof Error && error.message.includes(`dispatch ${obsoleteDispatch.dispatch.id}`));
    expect(recoveryError).toBeInstanceOf(Error);
    expect(String((recoveryError as Error).cause)).toContain("unsupported assistant action state");
    expect(delivered.some((id) => store.assistantWork.getFollowupReport(id)?.code === "attempt_reconcile_only")).toBe(true);
    const deliveredBefore = [...delivered];
    await runtime.drain();
    expect(delivered).toEqual(deliveredBefore);
    for (const entry of standalone) {
      expect(store.assistantWork.listAttempts(entry.action.id)).toHaveLength(1);
      expect(readFileSync(entry.path, "utf8")).toBe(entry.state === "claimed_pre_effect" ? "after" : "before");
    }
    const preserved = new Database(dbPath, { readonly: true });
    try {
      expect(preserved.query("SELECT state, current_digest FROM assistant_work_actions WHERE id = ?").get(obsoleteDispatch.action.id))
        .toEqual({ state: "approval_pending", current_digest: obsoleteDispatch.action.digest });
    } finally { preserved.close(); }
    const dispatches = store.assistantWork.listFollowupDispatches(healthy.work.id);
    expect(dispatches).toMatchObject([{ state: "completed", outcome: { kind: "confirmed" } }]);
    expect(store.assistantWork.listAttempts(dispatches[0]!.actionId)).toMatchObject([{ state: "confirmed" }]);
    expect(store.assistantWork.getFollowupReport("healthy-report")).toMatchObject({ state: "admitted" });
    expect(store.assistantWork.getFollowupReport("bad-report")).toMatchObject({ state: "pending" });
    expect(delivered).toContain("healthy-report");
    expect(delivered.some((id) => store.assistantWork.getFollowupReport(id)?.dispatchId === dispatches[0]!.id)).toBe(true);
    expect(store.assistantWork.listPendingFollowupReports().map((report) => report.id)).toEqual(["bad-report"]);
    const policyError = errors.find((error) => error instanceof Error && error.message === `Assistant work followup failed for work ${obsolete.work.id} action ${obsolete.action.id}`);
    expect(policyError).toBeInstanceOf(Error);
    expect((policyError as Error).cause).toBeInstanceOf(Error);
    expect(String((policyError as Error).cause)).toContain("unsupported assistant action state");
    const reportError = errors.find((error) => error instanceof Error && error.message === "Assistant work report bad-report failed");
    expect(reportError).toBeInstanceOf(Error);
    expect((reportError as Error).cause).toBe(deliveryFailure);
  } finally { await runtime.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
