import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FollowupRecoveryService,
  type AuthoredRecoveryReport,
  type FollowupDispatcherResult,
} from "../../src/assistant-work/recovery.ts";
import {
  followupSemanticKey,
  stableAttemptId,
  stableFollowupDispatchId,
  type ActionRecord,
  type EvidenceProvenance,
  type JsonValue,
} from "../../src/assistant-work/model.ts";
import type { AssistantWorkRepository } from "../../src/store/assistant-work.ts";
import { openStateStore } from "../../src/store/db.ts";

const directories: string[] = [];
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const T3 = "2026-01-01T00:03:00.000Z";
const OWNER: EvidenceProvenance = {
  principal: "owner",
  channel: "chat",
  subject: "owner-account",
  evidenceId: "owner-followup-policy",
};

interface CountingExecutor {
  readonly dispatch: (
    action: ActionRecord,
    attemptId: string,
    workerId: string,
  ) => Promise<FollowupDispatcherResult>;
  readonly calls: readonly {
    readonly actionId: string;
    readonly attemptId: string;
    readonly workerId: string;
  }[];
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stateDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "openinstinct-recovery-"));
  directories.push(directory);
  return join(directory, "state.db");
}

function setupConfirmedMessage(
  store: ReturnType<typeof openStateStore>,
  suffix: string,
  options: { readonly deadlineAt?: string } = {},
) {
  const work = store.assistantWork.admitObservation({
    source: "test:followup",
    occurrenceKey: `occurrence-${suffix}`,
    workKey: `work-${suffix}`,
    workTitle: `Follow up ${suffix}`,
    provenance: {
      principal: "system",
      channel: "test",
      subject: "fixture",
      evidenceId: `evidence-${suffix}`,
    },
    observedAt: T0,
    evidence: { fixture: suffix },
  }, T0).work;
  const matcher = {
    effectClass: "external_message" as const,
    recipient: `recipient-${suffix}@example.test`,
    topic: `topic-${suffix}`,
    action: "send_follow_up",
  };
  const action = store.assistantWork.proposeAction({
    workId: work.id,
    semanticKey: "original-message",
    ...matcher,
    payload: { body: `Original ${suffix}` },
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  }, T0);
  const attemptId = stableAttemptId(action.id, action.revision, `original-${suffix}`);
  const claimed = store.assistantWork.claimForDispatch({
    actionId: action.id,
    revision: action.revision,
    digest: action.digest,
    attemptId,
    workerId: "original-worker",
  }, T0);
  if (claimed.kind !== "claimed") throw new Error(`original action was not claimable: ${claimed.reason}`);
  store.assistantWork.markEffectStarted({ attemptId, workerId: "original-worker" }, T0);
  store.assistantWork.confirmAttempt({
    attemptId,
    workerId: "original-worker",
    outcome: { confirmed: true },
  }, T0);
  return { work, action };
}

function setPolicy(
  store: ReturnType<typeof openStateStore>,
  workId: string,
  actionId: string,
  maxAttempts = 2,
) {
  return store.assistantWork.setFollowupPolicy({
    workId,
    actionId,
    enabled: true,
    intervalMs: 60_000,
    maxAttempts,
    provenance: OWNER,
  }, T0);
}

function confirmedExecutor(
  repository: AssistantWorkRepository,
  evidence: (action: ActionRecord) => JsonValue = (action) => ({ confirmedActionId: action.id }),
  beforeSettle?: (action: ActionRecord, attemptId: string, workerId: string) => void | Promise<void>,
  now: () => string = () => T1,
): CountingExecutor {
  const calls: Array<{ readonly actionId: string; readonly attemptId: string; readonly workerId: string }> = [];
  return {
    calls,
    dispatch: async (action, attemptId, workerId) => {
      const at = now();
      const existing = repository.getAttempt(attemptId);
      if (existing?.state === "claimed_pre_effect" && existing.workerId !== workerId) {
        const recovery = repository.recoverAttempt({ attemptId, workerId }, at);
        if (recovery.kind !== "resume_pre_effect") {
          return { kind: "rejected", reason: "terminal", action: recovery.action, attempt: recovery.attempt };
        }
      }
      calls.push({ actionId: action.id, attemptId, workerId });
      const claim = repository.claimForDispatch({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId,
        workerId,
      }, at);
      if (claim.kind === "rejected") return claim;
      repository.markEffectStarted({ attemptId, workerId }, at);
      await beforeSettle?.(action, attemptId, workerId);
      const outcome = evidence(action);
      const settled = repository.confirmAttempt({ attemptId, workerId, outcome }, at);
      return { kind: "confirmed", ...settled, evidence: outcome };
    },
  };
}
function reportsCollector(): {
  readonly reports: AuthoredRecoveryReport[];
  readonly authoredReport: (report: AuthoredRecoveryReport) => void;
} {
  const reports: AuthoredRecoveryReport[] = [];
  return { reports, authoredReport: (report) => { reports.push(report); } };
}

describe("durable follow-up policy", () => {
  test("only authenticated owner provenance can set explicit enabled/interval/maxAttempts", () => {
    const store = openStateStore(stateDbPath());
    try {
      const { work, action } = setupConfirmedMessage(store, "owner-policy");
      expect(() => store.assistantWork.setFollowupPolicy({
        workId: work.id,
        actionId: action.id,
        enabled: true,
        intervalMs: 60_000,
        maxAttempts: 2,
        provenance: {
          principal: "third_party",
          channel: "mail",
          subject: "sender@example.test",
          evidenceId: "mail-policy-text",
        },
      }, T0)).toThrow("third_party evidence cannot configure owner followups");

      const policy = setPolicy(store, work.id, action.id);
      expect(policy).toMatchObject({
        workId: work.id,
        actionId: action.id,
        revision: 1,
        enabled: true,
        intervalMs: 60_000,
        maxAttempts: 2,
        nextDueAt: T1,
        nextOrdinal: 1,
        provenance: OWNER,
      });
      expect(setPolicy(store, work.id, action.id).revision).toBe(1);
      expect(store.assistantWork.setFollowupPolicy({
        workId: work.id,
        actionId: action.id,
        enabled: true,
        intervalMs: 120_000,
        maxAttempts: 3,
        provenance: { ...OWNER, evidenceId: "owner-followup-policy-changed" },
      }, T1)).toMatchObject({ revision: 2, intervalMs: 120_000, maxAttempts: 3 });
    } finally {
      store.close();
    }
  });

  test("missing policy never invokes the real executor", async () => {
    const store = openStateStore(stateDbPath());
    const { work } = setupConfirmedMessage(store, "missing-policy");
    const executor = confirmedExecutor(store.assistantWork);
    const reports = reportsCollector();
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "recovery-worker",
      now: () => T1,
      dispatch: executor.dispatch,
      authoredReport: reports.authoredReport,
    });
    try {
      expect(await service.tick(work.id)).toEqual({ kind: "not_dispatched", reason: "missing_policy" });
      expect(executor.calls).toHaveLength(0);
      expect(store.assistantWork.listFollowupDispatches(work.id)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("creates stable distinct ordinal actions, persists actual executor settlements, and enforces the cap", async () => {
    const store = openStateStore(stateDbPath());
    const { work, action } = setupConfirmedMessage(store, "ordinals");
    const policy = setPolicy(store, work.id, action.id, 2);
    let now = T1;
    const executor = confirmedExecutor(
      store.assistantWork,
      (followup) => ({ confirmedActionId: followup.id }),
      undefined,
      () => now,
    );
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "recovery-worker",
      now: () => now,
      dispatch: executor.dispatch,
      authoredReport: () => undefined,
    });
    try {
      const first = await service.tick(work.id);
      expect(first).toMatchObject({
        kind: "dispatched",
        dispatch: { ordinal: 1, state: "completed", outcome: { kind: "confirmed" } },
        result: { kind: "confirmed", attempt: { state: "confirmed" } },
      });
      if (first.kind !== "dispatched") throw new Error("first follow-up was not dispatched");
      const firstAction = store.assistantWork.getAction(first.dispatch.actionId);
      if (!firstAction) throw new Error("first follow-up action was not persisted");
      expect(firstAction).toMatchObject({
        semanticKey: followupSemanticKey(action.id, policy.revision, 1),
        recipient: action.recipient,
        topic: action.topic,
        action: action.action,
        payload: action.payload,
        state: "confirmed",
      });
      expect(firstAction.id).not.toBe(action.id);
      expect(firstAction.digest).toBe(action.digest);
      expect(first.dispatch.id).toBe(stableFollowupDispatchId(work.id, policy.revision, 1));
      expect(first.result).toMatchObject({
        kind: "confirmed",
        action: { id: firstAction.id, state: "confirmed" },
        attempt: { actionId: firstAction.id, state: "confirmed", workerId: "recovery-worker" },
        evidence: { confirmedActionId: firstAction.id },
      });
      expect(store.assistantWork.getFollowupPolicy(work.id)).toMatchObject({ nextDueAt: T2, nextOrdinal: 2 });

      now = T2;
      const second = await service.tick(work.id);
      expect(second).toMatchObject({ kind: "dispatched", dispatch: { ordinal: 2, state: "completed" } });
      if (second.kind !== "dispatched") throw new Error("second follow-up was not dispatched");
      const secondAction = store.assistantWork.getAction(second.dispatch.actionId);
      if (!secondAction) throw new Error("second follow-up action was not persisted");
      expect(secondAction).toMatchObject({
        semanticKey: followupSemanticKey(action.id, policy.revision, 2),
        state: "confirmed",
      });
      expect(secondAction.id).not.toBe(firstAction.id);
      expect(second.result).toMatchObject({
        kind: "confirmed",
        attempt: { actionId: secondAction.id, state: "confirmed", workerId: "recovery-worker" },
      });
      expect(store.assistantWork.getFollowupPolicy(work.id)?.nextOrdinal).toBe(3);
      expect(store.assistantWork.getFollowupPolicy(work.id)?.nextDueAt).toBeUndefined();

      now = T3;
      expect(await service.tick(work.id)).toEqual({ kind: "not_dispatched", reason: "cap_reached" });
      expect(executor.calls.map((call) => call.actionId)).toEqual([firstAction.id, secondAction.id]);
      expect(store.assistantWork.listAttempts(firstAction.id)).toHaveLength(1);
      expect(store.assistantWork.listAttempts(secondAction.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("dispatches a distinct follow-up immediately under its scheduling policy", async () => {
    const store = openStateStore(stateDbPath());
    const { work, action } = setupConfirmedMessage(store, "immediate-followup");
    setPolicy(store, work.id, action.id, 1);
    const executor = confirmedExecutor(store.assistantWork);
    const reports = reportsCollector();
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "recovery-worker",
      now: () => T1,
      dispatch: executor.dispatch,
      authoredReport: reports.authoredReport,
    });
    try {
      expect(await service.tick(work.id)).toMatchObject({
        kind: "dispatched",
        dispatch: { ordinal: 1, state: "completed" },
        result: { kind: "confirmed", attempt: { state: "confirmed" } },
      });
      expect(executor.calls).toHaveLength(1);
      const dispatch = store.assistantWork.listFollowupDispatches(work.id)[0]!;
      expect(dispatch.actionId).not.toBe(action.id);
      expect(store.assistantWork.getAction(dispatch.actionId)).toMatchObject({ state: "confirmed" });
      expect(store.assistantWork.listAttempts(dispatch.actionId)).toMatchObject([{
        state: "confirmed", outcome: { confirmedActionId: dispatch.actionId },
      }]);
      expect(await service.tick(work.id)).toEqual({ kind: "not_dispatched", reason: "cap_reached" });
      expect(executor.calls).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("follow-up dispatch races and recovery", () => {
  test("recovery returns the original executor failure and continues later claimed dispatches", async () => {
    const store = openStateStore(stateDbPath());
    try {
      const first = setupConfirmedMessage(store, "executor-fails");
      const second = setupConfirmedMessage(store, "executor-healthy");
      setPolicy(store, first.work.id, first.action.id, 1);
      setPolicy(store, second.work.id, second.action.id, 1);
      const failed = store.assistantWork.claimDueFollowup(first.work.id, "worker", T1);
      const healthy = store.assistantWork.claimDueFollowup(second.work.id, "worker", T1);
      if (failed.kind !== "claimed" || healthy.kind !== "claimed") throw new Error("expected claimed fixtures");
      const cause = new Error("executor unavailable before effect");
      const executor = confirmedExecutor(store.assistantWork);
      const service = new FollowupRecoveryService({ repository: store.assistantWork, workerId: "worker", now: () => T1,
        dispatch: async (action, attemptId, workerId) => {
          if (action.id === failed.action.id) throw cause;
          return executor.dispatch(action, attemptId, workerId);
        } });
      const results = await service.recover();
      const failure = results.find((result) => result.kind === "recovery_failed");
      expect(failure).toMatchObject({ kind: "recovery_failed", actionId: failed.action.id, dispatchId: failed.dispatch.id });
      if (failure?.kind !== "recovery_failed") throw new Error("expected explicit failure");
      expect(failure.error.cause).toBe(cause);
      expect(executor.calls.map((call) => call.actionId)).toEqual([healthy.action.id]);
      expect(store.assistantWork.getFollowupDispatch(healthy.dispatch.id)?.state).toBe("completed");
      expect(store.assistantWork.listAttempts(failed.action.id)).toHaveLength(0);
    } finally { store.close(); }
  });
  test("concurrent ticks invoke one real executor and persist one ordinal settlement", async () => {
    const path = stateDbPath();
    const firstStore = openStateStore(path);
    const { work, action } = setupConfirmedMessage(firstStore, "concurrent");
    setPolicy(firstStore, work.id, action.id, 1);
    const secondStore = openStateStore(path);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const effectStarted = new Promise<void>((resolve) => { started = resolve; });
    const firstExecutor = confirmedExecutor(
      firstStore.assistantWork,
      (followup) => ({ confirmed: followup.id }),
      async (_followup, attemptId) => {
        expect(firstStore.assistantWork.getAttempt(attemptId)).toMatchObject({ state: "effect_started" });
        started();
        await blocked;
      },
    );
    const secondExecutor = confirmedExecutor(secondStore.assistantWork, () => ({ duplicate: true }));
    const firstService = new FollowupRecoveryService({
      repository: firstStore.assistantWork,
      workerId: "worker-a",
      now: () => T1,
      dispatch: firstExecutor.dispatch,
      authoredReport: () => undefined,
    });
    const secondService = new FollowupRecoveryService({
      repository: secondStore.assistantWork,
      workerId: "worker-b",
      now: () => T1,
      dispatch: secondExecutor.dispatch,
      authoredReport: () => undefined,
    });
    try {
      const firstTick = firstService.tick(work.id);
      await effectStarted;
      expect(firstExecutor.calls).toHaveLength(1);
      expect(secondExecutor.calls).toHaveLength(0);
      const secondTick = secondService.tick(work.id);
      expect(await secondTick).toEqual({ kind: "not_dispatched", reason: "active_effect" });
      expect(secondExecutor.calls).toHaveLength(0);
      release();
      expect(await firstTick).toMatchObject({
        kind: "dispatched",
        dispatch: { ordinal: 1, state: "completed" },
        result: { kind: "confirmed", attempt: { state: "confirmed" } },
      });
      expect(firstExecutor.calls).toHaveLength(1);
      expect(firstStore.assistantWork.listFollowupDispatches(work.id)).toHaveLength(1);
      const followup = firstStore.assistantWork.getAction(firstStore.assistantWork.listFollowupDispatches(work.id)[0]!.actionId);
      expect(followup).toMatchObject({ state: "confirmed" });
      expect(firstStore.assistantWork.listAttempts(followup!.id)).toHaveLength(1);
    } finally {
      release();
      secondStore.close();
      firstStore.close();
    }
  });

  test("dispatches a prepared ordinal without an intervening owner rule", async () => {
    const store = openStateStore(stateDbPath());
    const { work, action } = setupConfirmedMessage(store, "prepared-immediate");
    setPolicy(store, work.id, action.id, 1);
    const prepared = store.assistantWork.claimDueFollowup(work.id, "recovery-worker", T1);
    expect(prepared).toMatchObject({ kind: "claimed", dispatch: { ordinal: 1 } });
    const executor = confirmedExecutor(store.assistantWork);
    const reports = reportsCollector();
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "recovery-worker",
      now: () => T1,
      dispatch: executor.dispatch,
      authoredReport: reports.authoredReport,
    });
    try {
      const result = await service.tick(work.id);
      expect(result).toMatchObject({ kind: "dispatched", result: { kind: "confirmed" } });
      expect(executor.calls).toHaveLength(1);
      const followup = store.assistantWork.listFollowupDispatches(work.id)[0];
      expect(followup).toMatchObject({ state: "completed" });
      expect(store.assistantWork.listAttempts(followup!.actionId)).toMatchObject([{
        state: "confirmed", outcome: { confirmedActionId: followup!.actionId },
      }]);
    } finally {
      store.close();
    }
  });

  test("rejects a callback that claims success without a matching durable settlement", async () => {
    const store = openStateStore(stateDbPath());
    const { work, action } = setupConfirmedMessage(store, "unbacked-success");
    setPolicy(store, work.id, action.id, 1);
    const prepared = store.assistantWork.claimDueFollowup(work.id, "recovery-worker", T1);
    if (prepared.kind !== "claimed") throw new Error(`unbacked-success follow-up was not claimable: ${prepared.reason}`);
    let callbackCalls = 0;
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "recovery-worker",
      now: () => T1,
      dispatch: async (followup, attemptId, workerId) => {
        callbackCalls += 1;
        return {
          kind: "confirmed",
          action: followup,
          attempt: {
            id: attemptId,
            actionId: followup.id,
            actionRevision: followup.revision,
            actionDigest: followup.digest,
            sequence: 1,
            state: "confirmed",
            workerId,
            claimedAt: T1,
            effectStartedAt: T1,
            settledAt: T1,
            recoveryCount: 0,
            updatedAt: T1,
          },
          evidence: { fabricated: true },
        };
      },
      authoredReport: () => undefined,
    });
    try {
      await expect(service.tick(work.id)).rejects.toThrow("executor result lacks matching durable settlement");
      expect(callbackCalls).toBe(1);
      const dispatch = store.assistantWork.listFollowupDispatches(work.id)[0];
      expect(dispatch).toMatchObject({ state: "claimed" });
      expect(store.assistantWork.getAction(dispatch!.actionId)).toMatchObject({ state: "planned" });
      expect(store.assistantWork.listAttempts(dispatch!.actionId)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("restart resumes claimed_pre_effect through the real executor exactly once", async () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const { work, action } = setupConfirmedMessage(initial, "restart-preeffect");
    const policy = setPolicy(initial, work.id, action.id, 1);
    const claimed = initial.assistantWork.claimDueFollowup(work.id, "worker-before", T1);
    if (claimed.kind !== "claimed") throw new Error("expected claimed follow-up");
    const attemptId = stableAttemptId(claimed.action.id, claimed.action.revision, claimed.dispatch.id);
    const actionClaim = initial.assistantWork.claimForDispatch({
      actionId: claimed.action.id,
      revision: claimed.action.revision,
      digest: claimed.action.digest,
      attemptId,
      workerId: "worker-before",
    }, T1);
    if (actionClaim.kind !== "claimed") throw new Error(`follow-up attempt was not claimed: ${actionClaim.reason}`);
    initial.close();

    const reopened = openStateStore(path);
    const executor = confirmedExecutor(
      reopened.assistantWork,
      () => ({ confirmedAfterRestart: true }),
      undefined,
      () => T2,
    );
    const service = new FollowupRecoveryService({
      repository: reopened.assistantWork,
      workerId: "worker-after",
      now: () => T2,
      dispatch: executor.dispatch,
      authoredReport: () => undefined,
    });
    try {
      const results = await service.recover();
      expect(results).toContainEqual(expect.objectContaining({ kind: "dispatched" }));
      expect(executor.calls).toEqual([{
        actionId: claimed.action.id,
        attemptId,
        workerId: "worker-after",
      }]);
      expect(reopened.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "confirmed",
        workerId: "worker-after",
        outcome: { confirmedAfterRestart: true },
      });
      expect(reopened.assistantWork.getFollowupDispatch(
        stableFollowupDispatchId(work.id, policy.revision, 1),
      )).toMatchObject({ state: "completed", outcome: { kind: "confirmed" } });
    } finally {
      reopened.close();
    }
  });

  test("effect_started becomes ambiguous on restart and is never redispatched", async () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const { work, action } = setupConfirmedMessage(initial, "restart-ambiguous");
    setPolicy(initial, work.id, action.id, 1);
    const claimed = initial.assistantWork.claimDueFollowup(work.id, "worker-before", T1);
    if (claimed.kind !== "claimed") throw new Error("expected claimed follow-up");
    const attemptId = stableAttemptId(claimed.action.id, claimed.action.revision, claimed.dispatch.id);
    const actionClaim = initial.assistantWork.claimForDispatch({
      actionId: claimed.action.id,
      revision: claimed.action.revision,
      digest: claimed.action.digest,
      attemptId,
      workerId: "worker-before",
    }, T1);
    if (actionClaim.kind !== "claimed") throw new Error(`follow-up attempt was not claimed: ${actionClaim.reason}`);
    initial.assistantWork.markEffectStarted({ attemptId, workerId: "worker-before" }, T1);
    initial.close();

    const reopened = openStateStore(path);
    const executor = confirmedExecutor(reopened.assistantWork, () => ({ duplicate: true }));
    const reports = reportsCollector();
    const service = new FollowupRecoveryService({
      repository: reopened.assistantWork,
      workerId: "worker-after",
      now: () => T2,
      dispatch: executor.dispatch,
      authoredReport: reports.authoredReport,
    });
    try {
      const results = await service.recover();
      expect(executor.calls).toHaveLength(0);
      expect(reopened.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "ambiguous",
        workerId: "worker-before",
      });
      expect(reopened.assistantWork.getFollowupDispatch(claimed.dispatch.id)).toMatchObject({
        state: "completed",
        outcome: { kind: "ambiguous", detail: { reason: "recovered_effect_started_without_outcome" } },
      });
      const recoveredDispatch = results.find((result) => result.kind === "dispatched");
      if (recoveredDispatch?.kind !== "dispatched") throw new Error("expected recovered dispatch");
      expect(recoveredDispatch.result).toMatchObject({ kind: "ambiguous", attempt: { id: attemptId, state: "ambiguous" } });
      expect(reports.reports).toContainEqual(expect.objectContaining({ code: "followup_ambiguous" }));
      await service.recover();
      expect(executor.calls).toHaveLength(0);
    } finally {
      reopened.close();
    }
  });

  test("confirmed attempt is completed on restart without replay", async () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const { work, action } = setupConfirmedMessage(initial, "restart-confirmed");
    setPolicy(initial, work.id, action.id, 1);
    const claimed = initial.assistantWork.claimDueFollowup(work.id, "worker-before", T1);
    if (claimed.kind !== "claimed") throw new Error("expected claimed follow-up");
    const attemptId = stableAttemptId(claimed.action.id, claimed.action.revision, claimed.dispatch.id);
    const actionClaim = initial.assistantWork.claimForDispatch({
      actionId: claimed.action.id,
      revision: claimed.action.revision,
      digest: claimed.action.digest,
      attemptId,
      workerId: "worker-before",
    }, T1);
    if (actionClaim.kind !== "claimed") throw new Error(`follow-up attempt was not claimed: ${actionClaim.reason}`);
    initial.assistantWork.markEffectStarted({ attemptId, workerId: "worker-before" }, T1);
    initial.assistantWork.confirmAttempt({
      attemptId,
      workerId: "worker-before",
      outcome: { remoteConfirmed: true },
    }, T1);
    initial.close();

    const reopened = openStateStore(path);
    const executor = confirmedExecutor(reopened.assistantWork, () => ({ duplicate: true }));
    const service = new FollowupRecoveryService({
      repository: reopened.assistantWork,
      workerId: "worker-after",
      now: () => T2,
      dispatch: executor.dispatch,
      authoredReport: () => undefined,
    });
    try {
      await service.recover();
      expect(executor.calls).toHaveLength(0);
      expect(reopened.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "confirmed",
        workerId: "worker-before",
        outcome: { remoteConfirmed: true },
      });
      expect(reopened.assistantWork.getFollowupDispatch(claimed.dispatch.id)).toMatchObject({
        state: "completed",
        outcome: { kind: "confirmed", detail: { remoteConfirmed: true } },
      });
    } finally {
      reopened.close();
    }
  });

  test("deadline expiry during preeffect recovery cancels without executor invocation", async () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const { work, action } = setupConfirmedMessage(initial, "restart-expired", { deadlineAt: T2 });
    setPolicy(initial, work.id, action.id, 1);
    const claimed = initial.assistantWork.claimDueFollowup(work.id, "worker-before", T1);
    if (claimed.kind !== "claimed") throw new Error("expected claimed follow-up");
    const attemptId = stableAttemptId(claimed.action.id, claimed.action.revision, claimed.dispatch.id);
    const actionClaim = initial.assistantWork.claimForDispatch({
      actionId: claimed.action.id,
      revision: claimed.action.revision,
      digest: claimed.action.digest,
      attemptId,
      workerId: "worker-before",
    }, T1);
    if (actionClaim.kind !== "claimed") throw new Error(`follow-up attempt was not claimed: ${actionClaim.reason}`);
    initial.close();

    const reopened = openStateStore(path);
    const executor = confirmedExecutor(reopened.assistantWork, () => ({ duplicate: true }), undefined, () => T2);
    const reports = reportsCollector();
    const service = new FollowupRecoveryService({
      repository: reopened.assistantWork,
      workerId: "worker-after",
      now: () => T2,
      dispatch: executor.dispatch,
      authoredReport: reports.authoredReport,
    });
    try {
      const results = await service.recover();
      expect(executor.calls).toHaveLength(0);
      expect(reopened.assistantWork.getAction(claimed.action.id)).toMatchObject({ state: "expired" });
      expect(reopened.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "cancelled",
        workerId: "worker-before",
        outcome: { reason: "deadline_expired" },
      });
      expect(reopened.assistantWork.getFollowupDispatch(claimed.dispatch.id)).toMatchObject({
        state: "completed",
        outcome: { kind: "rejected", detail: { reason: "terminal" } },
      });
      const expiredDispatch = results.find((result) => result.kind === "dispatched");
      if (expiredDispatch?.kind !== "dispatched") throw new Error("expected expired dispatch bookkeeping");
      expect(expiredDispatch.result).toMatchObject({ kind: "rejected", reason: "terminal" });
      expect(reports.reports).toContainEqual(expect.objectContaining({ code: "followup_rejected" }));
    } finally {
      reopened.close();
    }
  });
});
