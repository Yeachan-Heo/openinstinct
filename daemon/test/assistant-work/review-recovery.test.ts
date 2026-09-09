import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FollowupRecoveryService,
  type FollowupDispatcherResult,
} from "../../src/assistant-work/recovery.ts";
import {
  stableAttemptId,
  type ActionRecord,
  type EvidenceProvenance,
  type JsonValue,
} from "../../src/assistant-work/model.ts";
import type {
  AssistantWorkRepository,
  FollowupReportInput,
} from "../../src/store/assistant-work.ts";
import { openStateStore } from "../../src/store/db.ts";

const directories: string[] = [];
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const T3 = "2026-01-01T00:03:00.000Z";
const T4 = "2026-01-01T00:04:00.000Z";
const FOLLOWUP_WORKER = "review-recovery-worker";
const OWNER: EvidenceProvenance = {
  principal: "owner",
  channel: "chat",
  subject: "owner-account",
  evidenceId: "review-recovery-owner",
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stateDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "openinstinct-review-recovery-"));
  directories.push(directory);
  return join(directory, "state.db");
}

function setupMessage(
  store: ReturnType<typeof openStateStore>,
  suffix: string,
  options: {
    readonly confirmed?: boolean;
    readonly deadlineAt?: string;
  } = {},
) {
  const work = store.assistantWork.admitObservation({
    source: "test:review-recovery",
    occurrenceKey: `occurrence-${suffix}`,
    workKey: `work-${suffix}`,
    workTitle: `Review recovery ${suffix}`,
    provenance: {
      principal: "system",
      channel: "test",
      subject: "review-recovery-fixture",
      evidenceId: `observation-${suffix}`,
    },
    observedAt: T0,
    evidence: { fixture: suffix },
  }, T0).work;
  const matcher = {
    effectClass: "external_message" as const,
    recipient: `${suffix}@example.test`,
    topic: `topic-${suffix}`,
    action: "send_follow_up",
  };
  const action = store.assistantWork.proposeAction({
    workId: work.id,
    semanticKey: "source-message",
    ...matcher,
    payload: { body: `Source ${suffix}` },
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  }, T0);

  if (options.confirmed !== false) {
    confirmAction(
      store.assistantWork,
      action,
      stableAttemptId(action.id, action.revision, `source-${suffix}`),
      `source-worker-${suffix}`,
      T0,
      { sourceConfirmed: suffix },
    );
  }

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
    provenance: { ...OWNER, evidenceId: `followup-policy-${workId}` },
  }, T0);
}

function claimAction(
  repository: AssistantWorkRepository,
  action: ActionRecord,
  attemptId: string,
  workerId: string,
  now: string,
): void {
  const claim = repository.claimForDispatch({
    actionId: action.id,
    revision: action.revision,
    digest: action.digest,
    attemptId,
    workerId,
  }, now);
  if (claim.kind !== "claimed") {
    throw new Error(`action was not claimable: ${claim.reason}`);
  }
}

function confirmAction(
  repository: AssistantWorkRepository,
  action: ActionRecord,
  attemptId: string,
  workerId: string,
  now: string,
  outcome: JsonValue,
): void {
  claimAction(repository, action, attemptId, workerId, now);
  repository.markEffectStarted({ attemptId, workerId }, now);
  repository.confirmAttempt({ attemptId, workerId, outcome }, now);
}

function managedConfirmedExecutor(
  repository: AssistantWorkRepository,
  now: () => string,
  evidence: (action: ActionRecord) => JsonValue = (action) => ({ remoteActionId: action.id }),
): {
  readonly calls: Array<{
    readonly actionId: string;
    readonly attemptId: string;
    readonly workerId: string;
  }>;
  readonly dispatch: (
    action: ActionRecord,
    attemptId: string,
    workerId: string,
  ) => Promise<FollowupDispatcherResult>;
} {
  const calls: Array<{
    readonly actionId: string;
    readonly attemptId: string;
    readonly workerId: string;
  }> = [];
  return {
    calls,
    dispatch: async (action, attemptId, workerId): Promise<FollowupDispatcherResult> => {
      calls.push({ actionId: action.id, attemptId, workerId });
      const claim = repository.claimForDispatch({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId,
        workerId,
      }, now());
      if (claim.kind === "rejected") return claim;
      repository.markEffectStarted({ attemptId, workerId }, now());
      const outcome = evidence(action);
      const settled = repository.confirmAttempt({ attemptId, workerId, outcome }, now());
      return { kind: "confirmed", ...settled, evidence: outcome };
    },
  };
}

function prepareClaimedFollowup(
  store: ReturnType<typeof openStateStore>,
  suffix: string,
  options: { readonly deadlineAt?: string } = {},
) {
  const fixture = setupMessage(store, suffix, options);
  const policy = setPolicy(store, fixture.work.id, fixture.action.id);
  const claim = store.assistantWork.claimDueFollowup(fixture.work.id, FOLLOWUP_WORKER, T1);
  if (claim.kind !== "claimed") {
    throw new Error(`follow-up was not claimable: ${claim.reason}`);
  }
  const attemptId = stableAttemptId(claim.action.id, claim.action.revision, claim.dispatch.id);
  claimAction(store.assistantWork, claim.action, attemptId, FOLLOWUP_WORKER, T1);
  return {
    ...fixture,
    policy,
    dispatch: claim.dispatch,
    followupAction: claim.action,
    attemptId,
  };
}

function prepareStartedFollowup(
  store: ReturnType<typeof openStateStore>,
  suffix: string,
) {
  const prepared = prepareClaimedFollowup(store, suffix);
  store.assistantWork.markEffectStarted({
    attemptId: prepared.attemptId,
    workerId: FOLLOWUP_WORKER,
  }, T1);
  return prepared;
}

describe("review recovery boundary regressions", () => {
  test("verified follow-up resolution creates one report and replay preserves schedule", () => {
    const store = openStateStore(stateDbPath());
    try {
      const prepared = prepareStartedFollowup(store, "single-verified-report");
      store.assistantWork.recoverAttempt({ attemptId: prepared.attemptId, workerId: FOLLOWUP_WORKER }, T2);
      const input = { attemptId: prepared.attemptId, workerId: FOLLOWUP_WORKER, resolution: "confirmed" as const, evidenceSource: "remote-receipt", evidenceId: "receipt-1", evidence: { receipt: "receipt-1" } };
      const report = { id: "followup-verified-once", code: "followup_verified", workId: prepared.work.id, actionId: prepared.followupAction.id, dispatchId: prepared.dispatch.id, detail: { receipt: "receipt-1" } };
      const resolved = store.assistantWork.resolveFollowupAmbiguity(prepared.dispatch.id, input, report, T2);
      expect(store.assistantWork.listPendingFollowupReports()).toHaveLength(1);
      expect(store.assistantWork.listPendingFollowupReports()[0]?.id).toBe(report.id);
      expect(store.assistantWork.resolveFollowupAmbiguity(prepared.dispatch.id, input, report, T3)).toEqual(resolved);
      expect(store.assistantWork.listPendingFollowupReports()).toHaveLength(1);
    } finally { store.close(); }
  });
  test("F1 same worker resumes a pre-effect message without grants before invoking the executor", async () => {
    const store = openStateStore(stateDbPath());
    try {
      const prepared = prepareClaimedFollowup(store, "f1-autonomous");
      const executor = managedConfirmedExecutor(store.assistantWork, () => T2);
      const service = new FollowupRecoveryService({
        repository: store.assistantWork,
        workerId: FOLLOWUP_WORKER,
        now: () => T2,
        dispatch: executor.dispatch,
      });

      const result = await service.tick(prepared.work.id);

      expect(executor.calls).toHaveLength(1);
      expect(result).toMatchObject({
        kind: "dispatched",
        dispatch: { id: prepared.dispatch.id, state: "completed" },
        result: { kind: "confirmed" },
      });
      expect(store.assistantWork.getAttempt(prepared.attemptId)).toMatchObject({
        state: "confirmed", recoveryCount: 1,
      });
      expect(store.assistantWork.listAttempts(prepared.followupAction.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("F1 same worker revalidates deadline expiry before invoking the executor", async () => {
    const store = openStateStore(stateDbPath());
    try {
      const prepared = prepareClaimedFollowup(store, "f1-expired", { deadlineAt: T2 });
      const executor = managedConfirmedExecutor(store.assistantWork, () => T2);
      const service = new FollowupRecoveryService({
        repository: store.assistantWork,
        workerId: FOLLOWUP_WORKER,
        now: () => T2,
        dispatch: executor.dispatch,
      });

      const result = await service.tick(prepared.work.id);

      expect(executor.calls).toHaveLength(0);
      expect(result).toMatchObject({
        kind: "dispatched",
        dispatch: {
          id: prepared.dispatch.id,
          state: "completed",
          outcome: { kind: "rejected", detail: { reason: "terminal" } },
        },
        result: { kind: "rejected", reason: "terminal" },
      });
      expect(store.assistantWork.getAttempt(prepared.attemptId)).toMatchObject({
        state: "cancelled",
        outcome: { reason: "deadline_expired" },
      });
      expect(store.assistantWork.getAction(prepared.followupAction.id)).toMatchObject({
        state: "expired",
      });
    } finally {
      store.close();
    }
  });

  test("F2 externally confirmed due follow-up completes and advances without resend", async () => {
    const store = openStateStore(stateDbPath());
    try {
      const { work, action } = setupMessage(store, "f2-external");
      setPolicy(store, work.id, action.id, 2);
      const due = store.assistantWork.claimDueFollowup(work.id, FOLLOWUP_WORKER, T1);
      expect(due).toMatchObject({ kind: "claimed", dispatch: { state: "claimed", ordinal: 1 } });
      if (due.kind !== "claimed") throw new Error("expected an immediately claimable follow-up");
      const attemptId = stableAttemptId(due.action.id, due.action.revision, due.dispatch.id);
      confirmAction(
        store.assistantWork,
        due.action,
        attemptId,
        "external-confirmation-worker",
        T1,
        { providerReceipt: "receipt-f2" },
      );
      const executor = managedConfirmedExecutor(store.assistantWork, () => T2, () => ({ duplicate: true }));
      const service = new FollowupRecoveryService({
        repository: store.assistantWork,
        workerId: FOLLOWUP_WORKER,
        now: () => T2,
        dispatch: executor.dispatch,
      });

      const result = await service.tick(work.id);

      expect(executor.calls).toHaveLength(0);
      expect(result).toMatchObject({
        kind: "dispatched",
        dispatch: {
          id: due.dispatch.id,
          state: "completed",
          outcome: { kind: "confirmed", detail: { providerReceipt: "receipt-f2" } },
        },
        result: {
          kind: "confirmed",
          attempt: {
            id: attemptId,
            workerId: "external-confirmation-worker",
            state: "confirmed",
          },
          evidence: { providerReceipt: "receipt-f2" },
        },
      });
      expect(store.assistantWork.listAttempts(due.action.id)).toHaveLength(1);
      expect(store.assistantWork.getFollowupPolicy(work.id)).toMatchObject({
        nextOrdinal: 2,
        nextDueAt: T3,
      });
    } finally {
      store.close();
    }
  });

  test("F3 ambiguity resolution persists exact evidence provenance and rejects fake replays", () => {
    const store = openStateStore(stateDbPath());
    try {
      const { action } = setupMessage(store, "f3-evidence", { confirmed: false });
      const attemptId = stableAttemptId(action.id, action.revision, "f3-effect");
      claimAction(store.assistantWork, action, attemptId, "effect-worker", T0);
      store.assistantWork.markEffectStarted({ attemptId, workerId: "effect-worker" }, T0);
      store.assistantWork.markAttemptAmbiguous({
        attemptId,
        workerId: "effect-worker",
        outcome: { reason: "provider_timeout" },
      }, T1);
      const resolution = {
        attemptId,
        workerId: "reconciliation-worker",
        resolution: "confirmed" as const,
        evidenceSource: "provider-status-api",
        evidenceId: "provider-receipt-f3",
        evidence: { remoteMessageId: "message-f3", delivered: true },
      };

      const resolved = store.assistantWork.resolveAmbiguousAttempt(resolution, T2);

      expect(resolved).toMatchObject({
        action: { id: action.id, state: "confirmed" },
        attempt: {
          id: attemptId,
          state: "confirmed",
          workerId: "reconciliation-worker",
          outcome: {
            verified: true,
            source: "provider-status-api",
            evidenceId: "provider-receipt-f3",
            evidence: { remoteMessageId: "message-f3", delivered: true },
          },
        },
      });
      expect(store.assistantWork.resolveAmbiguousAttempt(resolution, T3)).toEqual(resolved);
      expect(() => store.assistantWork.resolveAmbiguousAttempt({
        ...resolution,
        evidenceSource: "unverified-callback",
      }, T3)).toThrow("ambiguous resolution replay changed evidence");
      expect(() => store.assistantWork.resolveAmbiguousAttempt({
        ...resolution,
        evidenceId: "fabricated-receipt",
      }, T3)).toThrow("ambiguous resolution replay changed evidence");
    } finally {
      store.close();
    }
  });

  test("F4 follow-up completion and report insertion are atomic and admission replay is idempotent", () => {
    const store = openStateStore(stateDbPath());
    try {
      const { work, action } = setupMessage(store, "f4-report");
      setPolicy(store, work.id, action.id, 2);
      const claim = store.assistantWork.claimDueFollowup(work.id, "completion-worker", T1);
      if (claim.kind !== "claimed") throw new Error(`follow-up was not claimable: ${claim.reason}`);
      const attemptId = stableAttemptId(claim.action.id, claim.action.revision, claim.dispatch.id);
      const evidence = { providerReceipt: "receipt-f4" };
      confirmAction(
        store.assistantWork,
        claim.action,
        attemptId,
        "completion-worker",
        T1,
        evidence,
      );
      const completionInput = {
        dispatchId: claim.dispatch.id,
        workerId: "completion-worker",
        outcome: { kind: "confirmed" as const, detail: evidence },
      };
      const collidingReport: FollowupReportInput = {
        id: "f4-atomic-report",
        code: "preexisting_report",
        workId: work.id,
        actionId: claim.action.id,
        attemptId,
        dispatchId: claim.dispatch.id,
        detail: { preexisting: true },
      };
      store.assistantWork.admitFollowupReport(collidingReport, T1);
      const conflictingCompletionReport: FollowupReportInput = {
        ...collidingReport,
        code: "followup_confirmed",
        detail: evidence,
      };

      expect(() => store.assistantWork.completeFollowup(
        completionInput,
        conflictingCompletionReport,
        T2,
      )).toThrow("followup report identity collision");
      expect(store.assistantWork.getFollowupDispatch(claim.dispatch.id)).toMatchObject({
        state: "claimed",
        workerId: "completion-worker",
      });
      expect(store.assistantWork.getFollowupPolicy(work.id)).toMatchObject({
        nextOrdinal: 1,
        nextDueAt: T1,
      });
      expect(store.assistantWork.getFollowupReport(collidingReport.id)).toEqual(expect.objectContaining({
        code: "preexisting_report",
        detail: { preexisting: true },
        state: "pending",
      }));

      const report: FollowupReportInput = {
        id: "f4-completion-report",
        code: "followup_confirmed",
        workId: work.id,
        actionId: claim.action.id,
        attemptId,
        dispatchId: claim.dispatch.id,
        detail: evidence,
      };
      const completion = store.assistantWork.completeFollowup(completionInput, report, T2);
      expect(completion).toMatchObject({
        dispatch: { state: "completed", outcome: { kind: "confirmed", detail: evidence } },
        policy: { nextOrdinal: 2, nextDueAt: T3 },
      });
      expect(store.assistantWork.getFollowupReport(report.id)).toMatchObject({
        ...report,
        state: "pending",
        createdAt: T2,
        updatedAt: T2,
      });

      const admitted = store.assistantWork.markFollowupReportAdmitted(report.id, T3);
      expect(admitted).toMatchObject({ state: "admitted", admittedAt: T3, updatedAt: T3 });
      expect(store.assistantWork.completeFollowup(completionInput, report, T4).dispatch).toEqual(completion.dispatch);
      expect(store.assistantWork.getFollowupReport(report.id)).toEqual(admitted);
      expect(store.assistantWork.markFollowupReportAdmitted(report.id, T4)).toEqual(admitted);
      expect(store.assistantWork.listPendingFollowupReports().map((entry) => entry.id)).not.toContain(report.id);
    } finally {
      store.close();
    }
  });

  test("F5 source transient states retain overdue eligibility and confirmation rearms dispatch", async () => {
    const store = openStateStore(stateDbPath());
    try {
      const { work, action } = setupMessage(store, "f5-source", { confirmed: false });
      setPolicy(store, work.id, action.id, 2);
      let now = T1;
      const executor = managedConfirmedExecutor(store.assistantWork, () => now);
      const service = new FollowupRecoveryService({
        repository: store.assistantWork,
        workerId: FOLLOWUP_WORKER,
        now: () => now,
        dispatch: executor.dispatch,
      });

      expect(await service.tick(work.id)).toEqual({
        kind: "not_dispatched",
        reason: "source_unconfirmed",
      });
      expect(store.assistantWork.getFollowupPolicy(work.id)).toMatchObject({
        nextOrdinal: 1,
        nextDueAt: T1,
      });
      expect(store.assistantWork.listFollowupDispatches(work.id)).toHaveLength(0);

      const sourceAttemptId = stableAttemptId(action.id, action.revision, "f5-source-effect");
      claimAction(store.assistantWork, action, sourceAttemptId, "source-effect-worker", T1);
      store.assistantWork.markEffectStarted({
        attemptId: sourceAttemptId,
        workerId: "source-effect-worker",
      }, T1);
      now = T2;
      expect(await service.tick(work.id)).toEqual({
        kind: "not_dispatched",
        reason: "active_effect",
      });
      expect(store.assistantWork.getFollowupPolicy(work.id)).toMatchObject({
        nextOrdinal: 1,
        nextDueAt: T1,
      });
      expect(store.assistantWork.listFollowupDispatches(work.id)).toHaveLength(0);

      store.assistantWork.confirmAttempt({
        attemptId: sourceAttemptId,
        workerId: "source-effect-worker",
        outcome: { providerReceipt: "source-f5" },
      }, T2);
      const dispatched = await service.tick(work.id);

      expect(dispatched).toMatchObject({
        kind: "dispatched",
        dispatch: { ordinal: 1, state: "completed", outcome: { kind: "confirmed" } },
        result: { kind: "confirmed", attempt: { state: "confirmed" } },
      });
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.actionId).not.toBe(action.id);
      expect(store.assistantWork.getFollowupPolicy(work.id)).toMatchObject({
        nextOrdinal: 2,
        nextDueAt: T3,
      });
    } finally {
      store.close();
    }
  });

  test("F6 policy changes do not orphan an associated started attempt", async () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const prepared = prepareStartedFollowup(initial, "f6-policy-changed");
    const changedPolicy = initial.assistantWork.setFollowupPolicy({
      workId: prepared.work.id,
      actionId: prepared.action.id,
      enabled: false,
      intervalMs: 60_000,
      maxAttempts: 2,
      provenance: { ...OWNER, evidenceId: "f6-disabled-policy" },
    }, T2);
    expect(changedPolicy).toMatchObject({ revision: 2, enabled: false, nextOrdinal: 1 });
    initial.close();

    const reopened = openStateStore(path);
    try {
      const executor = managedConfirmedExecutor(reopened.assistantWork, () => T3, () => ({ duplicate: true }));
      const service = new FollowupRecoveryService({
        repository: reopened.assistantWork,
        workerId: "f6-recovery-worker",
        now: () => T3,
        dispatch: executor.dispatch,
      });

      const results = await service.recover();

      expect(executor.calls).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: "dispatched",
        dispatch: {
          id: prepared.dispatch.id,
          state: "skipped",
          outcome: {
            kind: "ambiguous",
            detail: { reason: "recovered_effect_started_without_outcome" },
          },
        },
        result: {
          kind: "ambiguous",
          attempt: { id: prepared.attemptId, state: "ambiguous" },
        },
      });
      expect(reopened.assistantWork.getAttempt(prepared.attemptId)).toMatchObject({
        state: "ambiguous",
        workerId: FOLLOWUP_WORKER,
        outcome: { reason: "recovered_effect_started_without_outcome" },
      });
      expect(reopened.assistantWork.getFollowupPolicy(prepared.work.id)).toMatchObject({
        revision: 2,
        enabled: false,
        nextOrdinal: 1,
      });
      expect(reopened.assistantWork.listPendingFollowupReports()).toContainEqual(expect.objectContaining({
        code: "followup_ambiguous",
        dispatchId: prepared.dispatch.id,
      }));
    } finally {
      reopened.close();
    }
  });

  test("F6 terminal work still reconciles its associated started attempt", async () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const prepared = prepareStartedFollowup(initial, "f6-work-terminal");
    initial.assistantWork.setWorkState(prepared.work.id, "completed", T2);
    initial.close();

    const reopened = openStateStore(path);
    try {
      const executor = managedConfirmedExecutor(reopened.assistantWork, () => T3, () => ({ duplicate: true }));
      const service = new FollowupRecoveryService({
        repository: reopened.assistantWork,
        workerId: "f6-recovery-worker",
        now: () => T3,
        dispatch: executor.dispatch,
      });

      const results = await service.recover();

      expect(executor.calls).toHaveLength(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: "dispatched",
        dispatch: {
          id: prepared.dispatch.id,
          state: "completed",
          outcome: {
            kind: "ambiguous",
            detail: { reason: "recovered_effect_started_without_outcome" },
          },
        },
        result: {
          kind: "ambiguous",
          attempt: { id: prepared.attemptId, state: "ambiguous" },
        },
      });
      expect(reopened.assistantWork.getWork(prepared.work.id)).toMatchObject({ state: "completed" });
      expect(reopened.assistantWork.getAttempt(prepared.attemptId)).toMatchObject({
        state: "ambiguous",
        outcome: { reason: "recovered_effect_started_without_outcome" },
      });
      expect(reopened.assistantWork.getFollowupPolicy(prepared.work.id)).toMatchObject({
        nextOrdinal: 2,
      });
      expect(reopened.assistantWork.getFollowupPolicy(prepared.work.id)?.nextDueAt).toBeUndefined();
    } finally {
      reopened.close();
    }
  });
});
