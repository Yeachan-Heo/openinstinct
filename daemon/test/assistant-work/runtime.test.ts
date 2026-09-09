import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../../src/store/db.ts";
import { preflightLocalFileAction } from "../../src/assistant-work/local-effects.ts";
import { AssistantWorkRuntime } from "../../src/assistant-work/runtime.ts";
import { executeManagedLocalFileAction } from "../../src/assistant-work/execution.ts";
import { dispatchManagedAction } from "../../src/assistant-work/dispatch.ts";
import { configuredHttpAccess } from "../../src/assistant-work/http-policy.ts";
import { preflightManagedHttpAction } from "../../src/assistant-work/http-effects.ts";

test("partial paused startup retries only captured identities and leaves live HTTP and pre-effect owners alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-runtime-startup-cohort-"));
  const store = StateStore.open(join(root, "state.db"));
  const now = new Date().toISOString();
  const work = store.assistantWork.admitObservation({ source: "fixture", occurrenceKey: "cohort", workKey: "cohort", workTitle: "cohort",
    observedAt: now, evidence: {}, provenance: { principal: "system", channel: "fixture", subject: "cohort", evidenceId: "cohort" } }, now).work;
  async function local(key: string) {
    const path = join(root, `${key}.txt`);
    writeFileSync(path, "before");
    const preflight = await preflightLocalFileAction({ workId: work.id, semanticKey: key, operations: [{ operation: "write_file", path, content: "after" }] });
    const action = store.assistantWork.proposeAction(preflight.proposal, now);
    store.assistantWork.claimForDispatch({ actionId: action.id, revision: action.revision, digest: action.digest, attemptId: key, workerId: key }, now);
    return { action, path };
  }
  const original = await local("original-startup");
  const repository = store.assistantWork;
  const recover = repository.recoverAttempt.bind(repository);
  let failOriginal = true;
  const transient = new Error("original startup temporarily unavailable");
  repository.recoverAttempt = (input, at) => {
    if (input.attemptId === "original-startup" && failOriginal) throw transient;
    return recover(input, at);
  };
  let paused = true;
  const errors: unknown[] = [];
  const runtime = new AssistantWorkRuntime({ store, isPaused: () => paused, report: async () => true, onError: (error) => errors.push(error) });
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { received = resolve; });
  let posts = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "POST") { posts++; received(); await held; }
    return Response.json({ done: true });
  } });
  let sending: ReturnType<typeof dispatchManagedAction> | undefined;
  try {
    runtime.start();
    await runtime.drain();
    const live = await local("live-before-unpause");
    const liveBefore = repository.getAttempt("live-before-unpause");
    paused = false;
    await runtime.drain();
    expect(errors.some((error) => error instanceof Error && error.cause === transient)).toBe(true);
    expect(repository.getAttempt("live-before-unpause")).toEqual(liveBefore);
    const origin = `http://127.0.0.1:${server.port}`;
    const access = configuredHttpAccess({ OI_HTTP_LOCAL_ORIGINS: JSON.stringify([origin]) });
    const proposal = await preflightManagedHttpAction({ workId: work.id, semanticKey: "live-http", method: "POST", url: origin,
      body: "{}", headers: [{ name: "content-type", value: "application/json" }],
      verification: { url: origin, expected: { kind: "json_field", path: ["done"], value: true } } }, { endpointPolicy: access.endpointPolicy });
    const action = repository.proposeAction(proposal.proposal, now);
    sending = dispatchManagedAction({ repository, action, attemptId: "live-http", workerId: "live-http-owner", httpAccess: access });
    await Promise.race([entered, sending.then((result) => { throw new Error(`HTTP operation completed before held POST: ${result.kind}`); })]);
    const before = repository.getAttempt("live-http");
    expect(before).toMatchObject({ state: "effect_started", workerId: "live-http-owner", recoveryCount: 0 });
    await runtime.drain();
    expect(repository.getAttempt("live-http")).toEqual(before);
    expect(repository.getAttempt("live-before-unpause")).toEqual(liveBefore);
    failOriginal = false;
    await runtime.drain();
    expect(repository.getAttempt("original-startup")?.state).toBe("confirmed");
    expect(readFileSync(original.path, "utf8")).toBe("after");
    expect(readFileSync(live.path, "utf8")).toBe("before");
    expect(repository.getAttempt("live-http")).toEqual(before);
    release();
    expect(await sending).toMatchObject({ kind: "confirmed" });
    await runtime.drain();
    expect(posts).toBe(1);
    expect(repository.listAttempts(action.id)).toHaveLength(1);
    expect(repository.listAttempts(original.action.id)).toHaveLength(1);
    expect(repository.getAttempt("live-before-unpause")).toEqual(liveBefore);
  } finally {
    release();
    await sending?.catch(() => {});
    await runtime.stop();
    server.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
