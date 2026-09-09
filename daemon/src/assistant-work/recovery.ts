import { createHash } from "node:crypto";
import { stableAttemptId, type ActionRecord, type AttemptRecord, type AttemptRecoveryResult, type ClaimDueFollowupResult, type FollowupDispatchRecord, type ClaimRejectionReason, type JsonValue } from "./model.ts";
import { canonicalJson } from "./model.ts";
import type { AssistantWorkRepository, FollowupReportInput } from "../store/assistant-work.ts";

export type FollowupDispatcherResult =
  | { readonly kind: "confirmed" | "definitive_failed" | "ambiguous"; readonly action: ActionRecord; readonly attempt: AttemptRecord; readonly evidence: JsonValue }
  | { readonly kind: "rejected"; readonly reason: ClaimRejectionReason; readonly action?: ActionRecord; readonly attempt?: AttemptRecord };
export interface AuthoredRecoveryReport {
  readonly code: string;
  readonly workId?: string;
  readonly actionId?: string;
  readonly attemptId?: string;
  readonly dispatchId?: string;
  readonly detail: JsonValue;
}
export interface FollowupRecoveryServiceOptions {
  readonly repository: AssistantWorkRepository;
  readonly workerId: string;
  /** The real executor owns claim, effect-start and settlement. */
  readonly dispatch: (action: ActionRecord, attemptId: string, workerId: string) => Promise<FollowupDispatcherResult>;
  readonly authoredReport?: (report: AuthoredRecoveryReport) => Promise<void> | void;
  readonly now?: () => string;
}
type FollowupSkip = Extract<ClaimDueFollowupResult, { readonly kind: "none" }>;
export type FollowupTickResult =
  | { readonly kind: "dispatched"; readonly dispatch: FollowupDispatchRecord; readonly result: FollowupDispatcherResult }
  | { readonly kind: "resumed_attempt"; readonly recovery: AttemptRecoveryResult; readonly result: FollowupDispatcherResult }
  | { readonly kind: "not_dispatched"; readonly reason: FollowupSkip["reason"] }
  | { readonly kind: "recovered_attempt"; readonly recovery: AttemptRecoveryResult };

export type FollowupRecoveryResult = FollowupTickResult | {
  readonly kind: "recovery_failed";
  readonly actionId: string;
  readonly error: Error;
} & (
  | { readonly dispatchId: string; readonly attemptId?: never }
  | { readonly attemptId: string; readonly dispatchId?: never }
);

export interface FollowupRecoveryScope {
  readonly dispatches: readonly Pick<FollowupDispatchRecord, "id" | "actionId" | "workId">[];
  readonly attempts: readonly Pick<AttemptRecord, "id" | "actionId">[];
}

export function stableRecoveryReport(report: AuthoredRecoveryReport): FollowupReportInput {
  const id = createHash("sha256").update(canonicalJson({
    code: report.code,
    workId: report.workId ?? null,
    actionId: report.actionId ?? null,
    attemptId: report.attemptId ?? null,
    dispatchId: report.dispatchId ?? null,
    detail: report.detail,
  })).digest("hex");
  return { id, ...report };
}

export class FollowupRecoveryService {
  private readonly ticks = new Map<string, Promise<FollowupTickResult>>();
  private readonly now: () => string;
  public constructor(private readonly options: FollowupRecoveryServiceOptions) {
    if (!options.workerId.trim()) throw new Error("followup workerId must be non-empty");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public tick(workId: string): Promise<FollowupTickResult> {
    const existing = this.ticks.get(workId);
    if (existing) return existing;
    const operation = this.tickOnce(workId);
    this.ticks.set(workId, operation);
    void operation.finally(() => { if (this.ticks.get(workId) === operation) this.ticks.delete(workId); }).catch(() => {});
    return operation;
  }

  public async recoverAttempt(attemptId: string): Promise<FollowupTickResult> {
    const recovery = this.options.repository.recoverAttempt({ attemptId, workerId: this.options.workerId }, this.now());
    if (recovery.kind === "resume_pre_effect") {
      const result = await this.invoke(recovery.action, recovery.attempt.id);
      const dispatch = this.options.repository.listFollowupDispatches()
        .find((row) => row.actionId === recovery.action.id && row.state === "claimed");
      if (dispatch && result.kind !== "rejected") {
        const outcome = { kind: result.kind, detail: result.evidence } as const;
        const report = followupReport(dispatch.id, dispatch.workId, recovery.action.id, outcome);
        this.options.repository.completeFollowup(
          { dispatchId: dispatch.id, workerId: this.options.workerId, outcome },
          report,
          this.now(),
        );
        await this.options.authoredReport?.(report);
      }
      return { kind: "resumed_attempt", recovery, result };
    }
    if (recovery.kind !== "confirmed_no_replay") {
      const report = stableRecoveryReport({
        code: recovery.kind === "reconcile_only" ? "attempt_reconcile_only" : "attempt_terminal_no_replay",
        actionId: recovery.action.id,
        attemptId,
        detail: { attemptId, state: recovery.attempt.state },
      });
      this.options.repository.admitFollowupReport(report, this.now());
      await this.options.authoredReport?.(report);
    }
    return { kind: "recovered_attempt", recovery };
  }


  public captureRecoveryScope(): FollowupRecoveryScope {
    return {
      dispatches: this.options.repository.listFollowupDispatches().filter((row) => row.state === "claimed")
        .map(({ id, actionId, workId }) => ({ id, actionId, workId })),
      attempts: this.options.repository.listRecoveryCandidates().map(({ id, actionId }) => ({ id, actionId })),
    };
  }

  /** Each failed record is returned explicitly; unrelated records still recover. */
  public async recover(scope: FollowupRecoveryScope = this.captureRecoveryScope()): Promise<readonly FollowupRecoveryResult[]> {
    const results: FollowupRecoveryResult[] = [];
    const associated = new Set<string>();
    const failedFollowupActions = new Set<string>();
    for (const dispatch of scope.dispatches) {
      try {
        if (this.options.repository.getFollowupDispatch(dispatch.id)?.state !== "claimed") continue;
        const action = this.options.repository.getAction(dispatch.actionId);
        const attemptId = action?.activeAttemptId;
        const claim = this.options.repository.recoverClaimedFollowup(dispatch.id, this.options.workerId, this.now());
        if (attemptId) {
          const recoveredAttempt = this.options.repository.getAttempt(attemptId);
          if (recoveredAttempt?.state !== "effect_started" && recoveredAttempt?.state !== "claimed_pre_effect") {
            associated.add(attemptId);
          }
        }
        if (claim.kind === "none") {
          await this.reportSkip(dispatch.workId, claim);
          results.push({ kind: "not_dispatched", reason: claim.reason });
        } else {
          if (attemptId) associated.add(attemptId);
          results.push(await this.executeClaim(claim));
        }
      } catch (cause) {
        // Dispatch identity is available even when strict action decoding fails.
        failedFollowupActions.add(dispatch.actionId);
        results.push({ kind: "recovery_failed", actionId: dispatch.actionId, dispatchId: dispatch.id,
          error: new Error(`Assistant work recovery failed for dispatch ${dispatch.id} work ${dispatch.workId} action ${dispatch.actionId}`, { cause }) });
      }
    }
    for (const attempt of scope.attempts) {
      if (associated.has(attempt.id) || failedFollowupActions.has(attempt.actionId)) continue;
      try {
        const current = this.options.repository.getAttempt(attempt.id);
        if (!current || (current.state !== "claimed_pre_effect" && current.state !== "effect_started" && current.state !== "ambiguous")) continue;
        results.push(await this.recoverAttempt(attempt.id));
      } catch (cause) {
        results.push({ kind: "recovery_failed", actionId: attempt.actionId, attemptId: attempt.id,
          error: new Error(`Assistant work recovery failed for attempt ${attempt.id} action ${attempt.actionId}`, { cause }) });
      }
    }
    return results;
  }

  private async tickOnce(workId: string): Promise<FollowupTickResult> {
    const pending = this.options.repository.listFollowupDispatches(workId)
      .find((dispatch) => dispatch.state === "claimed" && dispatch.workerId === this.options.workerId);
    const claim = pending
      ? this.options.repository.recoverClaimedFollowup(pending.id, this.options.workerId, this.now())
      : this.options.repository.claimDueFollowup(workId, this.options.workerId, this.now());
    if (claim.kind === "none") {
      await this.reportSkip(workId, claim);
      return { kind: "not_dispatched", reason: claim.reason };
    }
    return this.executeClaim(claim);
  }

  private async executeClaim(claim: Extract<ClaimDueFollowupResult, { kind: "claimed" }>): Promise<FollowupTickResult> {
    const attemptId = claim.action.activeAttemptId ?? stableAttemptId(claim.action.id, claim.action.revision, claim.dispatch.id);
    const result = await this.invoke(claim.action, attemptId);
    const outcome = result.kind === "rejected"
      ? { kind: "rejected" as const, detail: { reason: result.reason } }
      : { kind: result.kind, detail: result.evidence };
    const report = followupReport(claim.dispatch.id, claim.policy.workId, claim.action.id, outcome);
    const completed = this.options.repository.completeFollowup(
      { dispatchId: claim.dispatch.id, workerId: this.options.workerId, outcome },
      report,
      this.now(),
    );
    await this.options.authoredReport?.(report);
    return { kind: "dispatched", dispatch: completed.dispatch, result };
  }

  private async invoke(action: ActionRecord, attemptId: string): Promise<FollowupDispatcherResult> {
    const repository = this.options.repository;
    const prior = repository.getAttempt(attemptId);
    if (prior && prior.state !== "claimed_pre_effect") {
      if (prior.state === "confirmed" || prior.state === "definitive_failed" || prior.state === "ambiguous") {
        return { kind: prior.state, action: repository.getAction(action.id) ?? action, attempt: prior, evidence: prior.outcome ?? { recovered: true } };
      }
      if (prior.state === "effect_started") {
        const recovery = repository.recoverAttempt({ attemptId, workerId: this.options.workerId }, this.now());
        return { kind: "ambiguous", action: recovery.action, attempt: recovery.attempt, evidence: { reason: "interrupted_effect" } };
      }
      return { kind: "rejected", reason: "terminal", action, attempt: prior };
    }
    let result: FollowupDispatcherResult;
    try {
      result = await this.options.dispatch(action, attemptId, this.options.workerId);
    } catch (error) {
      const attempt = repository.getAttempt(attemptId);
      if (attempt?.state === "effect_started") {
        const settled = repository.markAttemptAmbiguous({ attemptId, workerId: this.options.workerId, outcome: { reason: "executor_threw_after_start" } }, this.now());
        return { kind: "ambiguous", ...settled, evidence: { reason: "executor_threw_after_start" } };
      }
      throw error;
    }
    if (result.kind !== "rejected") {
      const persisted = repository.getAttempt(attemptId);
      if (!persisted || persisted.actionId !== action.id || persisted.actionRevision !== action.revision || persisted.state !== result.kind) {
        throw new Error("executor result lacks matching durable settlement");
      }
    }
    return result;
  }

  private async reportSkip(workId: string, claim: FollowupSkip): Promise<void> {
    if (["not_due", "missing_policy", "disabled", "cap_reached"].includes(claim.reason)) return;
    const report = stableRecoveryReport({
      code: `followup_${claim.reason}`,
      workId,
      ...(claim.action ? { actionId: claim.action.id } : {}),
      ...(claim.action?.activeAttemptId ? { attemptId: claim.action.activeAttemptId } : {}),
      ...(claim.dispatch ? { dispatchId: claim.dispatch.id } : {}),
      detail: { reason: claim.reason },
    });
    this.options.repository.admitFollowupReport(report, this.now());
    await this.options.authoredReport?.(report);
  }
}

function followupReport(
  dispatchId: string,
  workId: string,
  actionId: string,
  outcome: { readonly kind: string; readonly detail: JsonValue },
): FollowupReportInput & AuthoredRecoveryReport {
  const code = `followup_${outcome.kind}`;
  const id = createHash("sha256").update(canonicalJson({
    dispatchId,
    actionId,
    code,
    detail: outcome.detail,
  })).digest("hex");
  return { id, code, workId, actionId, dispatchId, detail: outcome.detail };
}
