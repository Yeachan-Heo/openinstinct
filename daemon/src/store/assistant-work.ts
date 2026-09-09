import type { Database } from "bun:sqlite";

import {
  actionMaterialDigest,
  isActionState,
  canonicalJson,
  stableActionId,
  stableObservationId,
  stableRecontactId,
  stableWorkId,
  followupSemanticKey,
  stableFollowupDispatchId,
} from "../assistant-work/model.ts";
import type {
  ActionMaterial,
  ActionRecord,
  ActionListResult,
  ActionState,
  AdmitObservationInput,
  AdmitRecontactInput,
  AttemptRecord,
  AttemptRecoveryResult,
  AttemptState,
  AttemptTransitionInput,
  AttemptTransitionRecord,
  ClaimForDispatchInput,
  ClaimForDispatchResult,
  ClaimRejectionReason,
  ClaimNotificationRouteResult,
  EffectClass,
  EvidenceProvenance,
  AdmitNotificationInput,
  ClaimDueFollowupResult,
  CompleteFollowupInput,
  FollowupCompletion,
  FollowupDispatchRecord,
  FollowupDispatchOutcome,
  FollowupPolicyRecord,
  SetFollowupPolicyInput,
  JsonValue,
  ObservationAdmission,
  ObservationRecord,
  NotificationRecord,
  NotificationRecoveryResult,
  NotificationRoute,
  NotificationRouteRecord,
  NotificationRouteState,
  NotificationRouteTransition,
  NotificationWithRoutes,
  ProposeActionInput,
  ReserveNotificationRouteResult,
  RecontactRecord,
  SettleNotificationRouteInput,
  SettleAttemptInput,
  WorkRecord,
  WorkState,
} from "../assistant-work/model.ts";


interface WorkRow {
  readonly id: string;
  readonly stable_key: string;
  readonly title: string;
  readonly state: WorkState;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ObservationRow {
  readonly id: string;
  readonly work_id: string;
  readonly source: string;
  readonly occurrence_key: string;
  readonly provenance_principal: EvidenceProvenance["principal"];
  readonly provenance_channel: string;
  readonly provenance_subject: string;
  readonly provenance_evidence_id: string;
  readonly observed_at: string;
  readonly evidence_json: string;
  readonly created_at: string;
}

interface ActionRow {
  readonly id: string;
  readonly work_id: string;
  readonly semantic_key: string;
  readonly current_revision: number;
  readonly current_digest: string;
  readonly state: string;
  readonly active_attempt_id: string | null;
  readonly cancelled_at: string | null;
  readonly cancel_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly effect_class: EffectClass;
  readonly recipient: string | null;
  readonly topic: string | null;
  readonly action_key: string;
  readonly payload_json: string;
  readonly scope_json: string | null;
  readonly cost_json: string | null;
  readonly deadline_at: string | null;
  readonly blocked_evidence_json: string | null;
}


interface AttemptRow {
  readonly id: string;
  readonly action_id: string;
  readonly action_revision: number;
  readonly action_digest: string;
  readonly sequence: number;
  readonly state: AttemptState;
  readonly worker_id: string;
  readonly claimed_at: string;
  readonly effect_started_at: string | null;
  readonly settled_at: string | null;
  readonly outcome_json: string | null;
  readonly recovered_at: string | null;
  readonly recovery_count: number;
  readonly updated_at: string;
}

interface RecontactRow {
  readonly id: string;
  readonly action_id: string;
  readonly action_revision: number;
  readonly ordinal: number;
  readonly scheduled_at: string;
  readonly context_json: string | null;
  readonly created_at: string;
}

interface FollowupPolicyRow {
  readonly work_id: string;
  readonly action_id: string;
  readonly action_revision: number;
  readonly action_digest: string;
  readonly revision: number;
  readonly enabled: number;
  readonly interval_ms: number;
  readonly max_attempts: number;
  readonly next_due_at: string | null;
  readonly next_ordinal: number;
  readonly provenance_principal: EvidenceProvenance["principal"];
  readonly provenance_channel: string;
  readonly provenance_subject: string;
  readonly provenance_evidence_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface FollowupDispatchRow {
  readonly id: string;
  readonly work_id: string;
  readonly policy_revision: number;
  readonly ordinal: number;
  readonly original_action_id: string;
  readonly action_id: string;
  readonly state: FollowupDispatchRecord["state"];
  readonly due_at: string;
  readonly worker_id: string | null;
  readonly claimed_at: string | null;
  readonly completed_at: string | null;
  readonly outcome_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface NotificationRow {
  readonly id: string;
  readonly body: string;
  readonly work_id: string | null;
  readonly action_id: string | null;
  readonly rendered_at: string | null;
  readonly owner_ack_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface NotificationRouteRow {
  readonly notification_id: string;
  readonly route: NotificationRoute;
  readonly state: NotificationRouteState;
  readonly worker_id: string | null;
  readonly reserved_at: string;
  readonly dispatching_at: string | null;
  readonly settled_at: string | null;
  readonly external_id: string | null;
  readonly detail_json: string | null;
  readonly updated_at: string;
}

interface CountRow {
  readonly count: number;
}


export interface FollowupReportInput {
  readonly id: string;
  readonly code: string;
  readonly workId?: string;
  readonly actionId?: string;
  readonly attemptId?: string;
  readonly dispatchId?: string;
  readonly detail: JsonValue;
}

export interface FollowupReportRecord extends FollowupReportInput {
  readonly state: "pending" | "admitted";
  readonly createdAt: string;
  readonly admittedAt?: string;
  readonly updatedAt: string;
}

interface FollowupReportRow {
  readonly id: string;
  readonly code: string;
  readonly work_id: string | null;
  readonly action_id: string | null;
  readonly attempt_id: string | null;
  readonly dispatch_id: string | null;
  readonly detail_json: string;
  readonly state: FollowupReportRecord["state"];
  readonly created_at: string;
  readonly admitted_at: string | null;
  readonly updated_at: string;
}

export interface AmbiguousAttemptResolutionInput {
  readonly attemptId: string;
  readonly workerId: string;
  readonly resolution: "confirmed" | "definitive_failed";
  readonly evidenceSource: string;
  readonly evidenceId: string;
  readonly evidence: JsonValue;
}

const ACTION_COLUMNS = `
  actions.id, actions.work_id, actions.semantic_key, actions.current_revision, actions.current_digest,
  actions.state, actions.active_attempt_id, actions.cancelled_at, actions.cancel_reason,
  actions.created_at, actions.updated_at, revisions.effect_class, revisions.recipient,
  revisions.topic, revisions.action_key, revisions.payload_json, revisions.scope_json,
  revisions.cost_json, revisions.deadline_at, revisions.blocked_evidence_json
`;


const ATTEMPT_COLUMNS = `
  id, action_id, action_revision, action_digest, sequence, state, worker_id,
  claimed_at,
  effect_started_at, settled_at, outcome_json, recovered_at, recovery_count, updated_at
`;

const FOLLOWUP_POLICY_COLUMNS = `
  work_id, action_id, action_revision, action_digest, revision, enabled, interval_ms, max_attempts,
  next_due_at, next_ordinal, provenance_principal, provenance_channel,
  provenance_subject, provenance_evidence_id, created_at, updated_at
`;

const FOLLOWUP_DISPATCH_COLUMNS = `
  id, work_id, policy_revision, ordinal, original_action_id, action_id,
  state, due_at, worker_id, claimed_at, completed_at, outcome_json, created_at, updated_at
`;

const FOLLOWUP_REPORT_COLUMNS = `
  id, code, work_id, action_id, attempt_id, dispatch_id, detail_json,
  state, created_at, admitted_at, updated_at
`;

const NOTIFICATION_COLUMNS = `
  id, body, work_id, action_id, rendered_at, owner_ack_at, created_at, updated_at
`;

const NOTIFICATION_ROUTE_COLUMNS = `
  notification_id, route, state, worker_id, reserved_at, dispatching_at,
  settled_at, external_id, detail_json, updated_at
`;

export interface AssistantWorkRepository {
  admitObservation(input: AdmitObservationInput, now: string): ObservationAdmission;
  getWork(id: string): WorkRecord | undefined;
  listWorks(state?: WorkState): WorkRecord[];
  setWorkState(id: string, state: Exclude<WorkState, "open">, now: string): WorkRecord;
  getObservation(id: string): ObservationRecord | undefined;
  listObservations(workId?: string): ObservationRecord[];

  proposeAction(input: ProposeActionInput, now: string): ActionRecord;
  getAction(id: string): ActionRecord | undefined;
  listActions(workId?: string): ActionListResult;
  cancelAction(
    input: { readonly actionId: string; readonly revision: number; readonly digest: string; readonly reason: string },
    now: string,
  ): ActionRecord;

  /** Atomically rechecks revision, cancellation and deadline before inserting the pre-effect attempt. */
  claimForDispatch(input: ClaimForDispatchInput, now: string): ClaimForDispatchResult;
  /** Persist this transition and wait for its return before invoking any external effect. */
  markEffectStarted(input: AttemptTransitionInput, now: string): AttemptTransitionRecord;
  confirmAttempt(input: SettleAttemptInput, now: string): AttemptTransitionRecord;
  failAttemptDefinitively(input: SettleAttemptInput, now: string): AttemptTransitionRecord;
  markAttemptAmbiguous(input: SettleAttemptInput, now: string): AttemptTransitionRecord;
  /** Evidence-only resolution; this never invokes or reclaims the effect. */
  resolveAmbiguousAttempt(input: AmbiguousAttemptResolutionInput, now: string): AttemptTransitionRecord;
  /** claimed_pre_effect may be resumed; effect_started is fenced to reconcile-only ambiguity. */
  recoverAttempt(input: AttemptTransitionInput, now: string): AttemptRecoveryResult;
  getAttempt(id: string): AttemptRecord | undefined;
  listAttempts(actionId?: string): AttemptRecord[];
  listRecoveryCandidates(): AttemptRecord[];

  admitRecontact(input: AdmitRecontactInput, now: string): RecontactRecord;
  listRecontacts(actionId?: string): RecontactRecord[];

  setFollowupPolicy(input: SetFollowupPolicyInput, now: string): FollowupPolicyRecord;
  getFollowupPolicy(workId: string): FollowupPolicyRecord | undefined;
  listFollowupPolicies(): FollowupPolicyRecord[];
  claimDueFollowup(workId: string, workerId: string, now: string): ClaimDueFollowupResult;
  recoverClaimedFollowup(dispatchId: string, workerId: string, now: string): ClaimDueFollowupResult;
  getFollowupDispatch(id: string): FollowupDispatchRecord | undefined;
  listFollowupDispatches(workId?: string): FollowupDispatchRecord[];
  completeFollowup(input: CompleteFollowupInput, report: FollowupReportInput, now: string): FollowupCompletion;
  admitFollowupReport(report: FollowupReportInput, now: string): FollowupReportRecord;
  getFollowupReport(id: string): FollowupReportRecord | undefined;
  listPendingFollowupReports(): FollowupReportRecord[];
  markFollowupReportAdmitted(id: string, admittedAt: string): FollowupReportRecord;
  resolveFollowupAmbiguity(
    dispatchId: string,
    input: AmbiguousAttemptResolutionInput,
    report: FollowupReportInput,
    now: string,
  ): FollowupCompletion;

  admitNotification(input: AdmitNotificationInput, now: string): NotificationRecord;
  getNotification(id: string): NotificationRecord | undefined;
  getNotificationWithRoutes(id: string): NotificationWithRoutes | undefined;
  listNotifications(): NotificationRecord[];
  reserveNotificationRoute(notificationId: string, route: NotificationRoute, now: string): ReserveNotificationRouteResult;
  getNotificationRoute(notificationId: string, route: NotificationRoute): NotificationRouteRecord | undefined;
  listNotificationRoutes(notificationId?: string): NotificationRouteRecord[];
  claimNotificationRoute(
    notificationId: string,
    route: NotificationRoute,
    workerId: string,
    now: string,
    options?: { readonly renderedFallback?: boolean },
  ): ClaimNotificationRouteResult;
  markNotificationRendered(notificationId: string, route: NotificationRoute, renderedAt: string): NotificationRecord;
  acknowledgeNotification(notificationId: string, ownerAckAt: string): NotificationRecord;
  markNotificationRouteDelivered(input: SettleNotificationRouteInput, now: string): NotificationRouteTransition;
  markNotificationRouteUncertain(input: SettleNotificationRouteInput, now: string): NotificationRouteTransition;
  markNotificationRouteFailedDefinitively(
    input: SettleNotificationRouteInput,
    now: string,
  ): NotificationRouteTransition;
  recoverNotificationRoute(
    notificationId: string,
    route: NotificationRoute,
    now: string,
  ): NotificationRecoveryResult;
  listNotificationRecoveryCandidates(): NotificationRouteRecord[];
}

/** @internal StateStore wiring only; callers receive this repository from StateStore.assistantWork. */
export function createAssistantWorkRepository(db: Database): AssistantWorkRepository {
  return new SqliteAssistantWorkRepository(db);
}

class SqliteAssistantWorkRepository implements AssistantWorkRepository {
  public constructor(private readonly db: Database) {}

  public admitObservation(input: AdmitObservationInput, now: string): ObservationAdmission {
    assertObservationInput(input);
    assertTimestamp(now, "observation admission now");
    const observationId = stableObservationId(input.source, input.occurrenceKey);
    const workId = stableWorkId(input.workKey);
    const evidenceJson = canonicalJson(input.evidence);

    return this.transaction("admitObservation", () => {
      const duplicateRow = this.db.query(
        `SELECT id, work_id, source, occurrence_key,
                provenance_principal, provenance_channel, provenance_subject, provenance_evidence_id,
                observed_at, evidence_json, created_at
         FROM assistant_work_observations
         WHERE source = ? AND occurrence_key = ?`,
      ).get(input.source, input.occurrenceKey) as ObservationRow | null;
      if (duplicateRow !== null) {
        const duplicate = toObservationRecord(duplicateRow);
        assertObservationReplay(duplicate, observationId, workId, input);
        const work = this.getRequiredWork(duplicate.workId);
        return { created: false, work, observation: duplicate };
      }

      const workByKey = this.db.query(
        "SELECT id, stable_key, title, state, created_at, updated_at FROM assistant_work_works WHERE stable_key = ?",
      ).get(input.workKey) as WorkRow | null;
      if (workByKey === null) {
        this.db.query(
          `INSERT INTO assistant_work_works (id, stable_key, title, state, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?)`,
        ).run(workId, input.workKey, input.workTitle, now, now);
      } else {
        if (workByKey.id !== workId) {
          throw new Error(`assistant work stable-key collision: ${input.workKey}`);
        }
        this.db.query(
          "UPDATE assistant_work_works SET title = ?, updated_at = ? WHERE id = ? AND title <> ?",
        ).run(input.workTitle, now, workId, input.workTitle);
      }

      this.db.query(
        `INSERT INTO assistant_work_observations (
          id, work_id, source, occurrence_key,
          provenance_principal, provenance_channel, provenance_subject, provenance_evidence_id,
          observed_at, evidence_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        observationId,
        workId,
        input.source,
        input.occurrenceKey,
        input.provenance.principal,
        input.provenance.channel,
        input.provenance.subject,
        input.provenance.evidenceId,
        input.observedAt,
        evidenceJson,
        now,
      );

      return {
        created: true,
        work: this.getRequiredWork(workId),
        observation: this.getRequiredObservation(observationId),
      };
    });
  }

  public getWork(id: string): WorkRecord | undefined {
    assertNonEmpty(id, "work id");
    const row = this.db.query(
      "SELECT id, stable_key, title, state, created_at, updated_at FROM assistant_work_works WHERE id = ?",
    ).get(id) as WorkRow | null;
    return row === null ? undefined : toWorkRecord(row);
  }

  public listWorks(state?: WorkState): WorkRecord[] {
    if (state !== undefined) {
      assertWorkState(state);
    }
    const clause = state === undefined ? "" : " WHERE state = ?";
    return (this.db.query(
      `SELECT id, stable_key, title, state, created_at, updated_at
       FROM assistant_work_works${clause} ORDER BY created_at, ROWID`,
    ).all(...(state === undefined ? [] : [state])) as WorkRow[]).map(toWorkRecord);
  }

  public setWorkState(id: string, state: Exclude<WorkState, "open">, now: string): WorkRecord {
    assertNonEmpty(id, "work id");
    if (state !== "completed" && state !== "cancelled") {
      throw new Error("work terminal state is invalid");
    }
    assertTimestamp(now, "work state now");
    const result = this.db.query(
      "UPDATE assistant_work_works SET state = ?, updated_at = ? WHERE id = ? AND state = 'open'",
    ).run(state, now, id);
    const work = this.getWork(id);
    if (!work) {
      throw new Error(`unknown assistant work: ${id}`);
    }
    if (result.changes === 0 && work.state !== state) {
      throw new Error(`assistant work cannot transition from ${work.state} to ${state}: ${id}`);
    }
    return work;
  }

  public getObservation(id: string): ObservationRecord | undefined {
    assertNonEmpty(id, "observation id");
    const row = this.db.query(
      `SELECT id, work_id, source, occurrence_key,
              provenance_principal, provenance_channel, provenance_subject, provenance_evidence_id,
              observed_at, evidence_json, created_at
       FROM assistant_work_observations WHERE id = ?`,
    ).get(id) as ObservationRow | null;
    return row === null ? undefined : toObservationRecord(row);
  }

  public listObservations(workId?: string): ObservationRecord[] {
    if (workId !== undefined) {
      assertNonEmpty(workId, "observation workId");
    }
    const clause = workId === undefined ? "" : " WHERE work_id = ?";
    return (this.db.query(
      `SELECT id, work_id, source, occurrence_key,
              provenance_principal, provenance_channel, provenance_subject, provenance_evidence_id,
              observed_at, evidence_json, created_at
       FROM assistant_work_observations${clause} ORDER BY observed_at, ROWID`,
    ).all(...(workId === undefined ? [] : [workId])) as ObservationRow[]).map(toObservationRecord);
  }

  public proposeAction(input: ProposeActionInput, now: string): ActionRecord {
    assertActionProposal(input);
    assertTimestamp(now, "action proposal now");
    const actionId = stableActionId(input.workId, input.semanticKey);
    const digest = actionMaterialDigest(input);

    return this.transaction("proposeAction", () => {
      const work = this.getRequiredWork(input.workId);
      if (work.state !== "open") {
        throw new Error(`cannot propose an action for ${work.state} work: ${work.id}`);
      }

      const existing = this.getAction(actionId);
      if (!existing) {
        const state = initialActionState(input.effectClass);
        this.db.query(
          `INSERT INTO assistant_work_actions (
            id, work_id, semantic_key, current_revision, current_digest, state, created_at, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
        ).run(actionId, input.workId, input.semanticKey, digest, state, now, now);
        this.insertActionRevision(actionId, 1, digest, input, now);
        return this.getRequiredAction(actionId);
      }

      if (existing.workId !== input.workId || existing.semanticKey !== input.semanticKey) {
        throw new Error(`assistant action identity collision: ${actionId}`);
      }
      if (existing.digest === digest) {
        return existing;
      }
      if (!canReviseAction(existing.state)) {
        throw new Error(`assistant action cannot be revised from ${existing.state}: ${actionId}`);
      }

      const revision = existing.revision + 1;
      this.insertActionRevision(actionId, revision, digest, input, now);
      this.db.query(
        `UPDATE assistant_work_actions
         SET current_revision = ?, current_digest = ?, state = ?, active_attempt_id = NULL,
             cancelled_at = NULL, cancel_reason = NULL, updated_at = ?
         WHERE id = ? AND current_revision = ? AND current_digest = ?`,
      ).run(revision, digest, initialActionState(input.effectClass), now, actionId, existing.revision, existing.digest);
      return this.getRequiredAction(actionId);
    });
  }

  public getAction(id: string): ActionRecord | undefined {
    assertNonEmpty(id, "action id");
    const row = this.db.query(
      `SELECT ${ACTION_COLUMNS}
       FROM assistant_work_actions AS actions
       JOIN assistant_work_action_revisions AS revisions
         ON revisions.action_id = actions.id AND revisions.revision = actions.current_revision
       WHERE actions.id = ?`,
    ).get(id) as ActionRow | null;
    return row === null ? undefined : toActionRecord(row);
  }

  public listActions(workId?: string): ActionListResult {
    if (workId !== undefined) {
      assertNonEmpty(workId, "action workId");
    }
    const clause = workId === undefined ? "" : " WHERE actions.work_id = ?";
    const rows = this.db.query(
      `SELECT ${ACTION_COLUMNS}
       FROM assistant_work_actions AS actions
       JOIN assistant_work_action_revisions AS revisions
         ON revisions.action_id = actions.id AND revisions.revision = actions.current_revision
       ${clause} ORDER BY actions.created_at, actions.ROWID`,
    ).all(...(workId === undefined ? [] : [workId])) as ActionRow[];
    const result: ActionListResult = { actions: [], unsupported: [] };
    for (const row of rows) {
      if (!isActionState(row.state)) {
        result.unsupported.push({ kind: "unsupported_action_state", actionId: row.id,
          workId: row.work_id, state: row.state, revision: row.current_revision, digest: row.current_digest });
      } else {
        result.actions.push(toActionRecord(row));
      }
    }
    return result;
  }

  public cancelAction(
    input: { readonly actionId: string; readonly revision: number; readonly digest: string; readonly reason: string },
    now: string,
  ): ActionRecord {
    assertNonEmpty(input.actionId, "cancel actionId");
    assertPositiveInteger(input.revision, "cancel action revision");
    assertDigest(input.digest, "cancel action digest");
    assertNonEmpty(input.reason, "cancel reason");
    assertTimestamp(now, "action cancellation now");

    return this.transaction("cancelAction", () => {
      const action = this.getRequiredAction(input.actionId);
      assertCurrentAction(action, input.revision, input.digest);
      if (action.state === "cancelled") {
        return action;
      }
      if (!canCancelAction(action.state)) {
        throw new Error(`assistant action cannot be cancelled from ${action.state}: ${action.id}`);
      }

      if (action.activeAttemptId !== undefined) {
        this.db.query(
          `UPDATE assistant_work_attempts
           SET state = 'cancelled', settled_at = ?, outcome_json = ?, updated_at = ?
           WHERE id = ? AND state = 'claimed_pre_effect'`,
        ).run(now, canonicalJson({ reason: input.reason }), now, action.activeAttemptId);
      }
      this.db.query(
        `UPDATE assistant_work_actions
         SET state = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
         WHERE id = ? AND current_revision = ? AND current_digest = ?`,
      ).run(now, input.reason, now, action.id, action.revision, action.digest);
      return this.getRequiredAction(action.id);
    });
  }


  public claimForDispatch(input: ClaimForDispatchInput, now: string): ClaimForDispatchResult {
    assertClaimInput(input);
    assertTimestamp(now, "dispatch claim now");

    return this.transaction("claimForDispatch", () => {
      const priorAttempt = this.getAttempt(input.attemptId);
      if (priorAttempt) {
        assertAttemptReplay(priorAttempt, input);
        const action = this.getAction(input.actionId);
        if (
          priorAttempt.state === "claimed_pre_effect"
          && action?.revision === input.revision
          && action.digest === input.digest
          && action.activeAttemptId === priorAttempt.id
        ) {
          if (this.getRequiredWork(action.workId).state !== "open") {
            return rejectedClaim("terminal", action, priorAttempt);
          }
          if (action.deadlineAt !== undefined && Date.parse(action.deadlineAt) <= Date.parse(now)) {
            return rejectedClaim("expired", action, priorAttempt);
          }
          return { kind: "claimed", resumed: true, action, attempt: priorAttempt };
        }
        return rejectedClaim(rejectionForAttempt(priorAttempt.state), action, priorAttempt);
      }

      const action = this.getAction(input.actionId);
      if (!action) {
        return { kind: "rejected", reason: "unknown_action" };
      }
      if (action.revision !== input.revision) {
        return rejectedClaim("stale_revision", action);
      }
      if (action.digest !== input.digest) {
        return rejectedClaim("stale_digest", action);
      }
      if (this.getRequiredWork(action.workId).state !== "open") {
        return rejectedClaim("terminal", action);
      }

      const stateRejection = rejectionForAction(action.state);
      if (stateRejection !== undefined) {
        return rejectedClaim(stateRejection, action, this.getActiveAttempt(action));
      }
      if (action.deadlineAt !== undefined && Date.parse(action.deadlineAt) <= Date.parse(now)) {
        this.db.query(
          `UPDATE assistant_work_actions SET state = 'expired', updated_at = ?
           WHERE id = ? AND current_revision = ? AND current_digest = ?
             AND state = 'planned'`,
        ).run(now, action.id, action.revision, action.digest);
        return rejectedClaim("expired", this.getRequiredAction(action.id));
      }
      if (action.activeAttemptId !== undefined) {
        return rejectedClaim("already_claimed", action, this.getActiveAttempt(action));
      }


      const sequence = (this.db.query(
        "SELECT count(*) AS count FROM assistant_work_attempts WHERE action_id = ? AND action_revision = ?",
      ).get(action.id, action.revision) as CountRow).count + 1;
      this.db.query(
        `INSERT INTO assistant_work_attempts (
          id, action_id, action_revision, action_digest, sequence, state, worker_id,
          authorization_source, authorization_id, authorization_revision,
          claimed_at, recovery_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'claimed_pre_effect', ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        input.attemptId,
        action.id,
        action.revision,
        action.digest,
        sequence,
        input.workerId,
        // Immutable historical schema requires this value; it carries no authority.
        "local_policy",
        null,
        null,
        now,
        now,
      );

      const claimed = this.db.query(
        `UPDATE assistant_work_actions
         SET state = 'claimed_pre_effect', active_attempt_id = ?, updated_at = ?
         WHERE id = ? AND current_revision = ? AND current_digest = ?
           AND active_attempt_id IS NULL AND cancelled_at IS NULL
           AND state = 'planned'`,
      ).run(input.attemptId, now, action.id, action.revision, action.digest);
      if (claimed.changes !== 1) {
        throw new Error(`assistant action claim lost its compare-and-swap: ${action.id}`);
      }


      return {
        kind: "claimed",
        resumed: false,
        action: this.getRequiredAction(action.id),
        attempt: this.getRequiredAttempt(input.attemptId),
      };
    });
  }

  public markEffectStarted(input: AttemptTransitionInput, now: string): AttemptTransitionRecord {
    assertAttemptTransitionInput(input);
    assertTimestamp(now, "effect start now");

    return this.transaction("markEffectStarted", () => {
      const attempt = this.getRequiredAttempt(input.attemptId);
      assertAttemptWorker(attempt, input.workerId);
      if (attempt.state !== "claimed_pre_effect") {
        throw new Error(
          `attempt is ${attempt.state}; external effect must not be invoked or repeated: ${attempt.id}`,
        );
      }
      const action = this.getRequiredAction(attempt.actionId);
      assertAttemptOwnsCurrentAction(attempt, action, "claimed_pre_effect");
      if (this.getRequiredWork(action.workId).state !== "open") {
        throw new Error(`cannot start effect for terminal work: ${action.workId}`);
      }
      if (action.deadlineAt !== undefined && Date.parse(action.deadlineAt) <= Date.parse(now)) {
        throw new Error(`cannot start effect after action deadline: ${action.id}`);
      }

      const attemptUpdate = this.db.query(
        `UPDATE assistant_work_attempts
         SET state = 'effect_started', effect_started_at = ?, updated_at = ?
         WHERE id = ? AND state = 'claimed_pre_effect' AND worker_id = ?`,
      ).run(now, now, attempt.id, input.workerId);
      const actionUpdate = this.db.query(
        `UPDATE assistant_work_actions SET state = 'effect_started', updated_at = ?
         WHERE id = ? AND current_revision = ? AND current_digest = ?
           AND active_attempt_id = ? AND state = 'claimed_pre_effect'`,
      ).run(now, action.id, action.revision, action.digest, attempt.id);
      if (attemptUpdate.changes !== 1 || actionUpdate.changes !== 1) {
        throw new Error(`effect-start transition lost its compare-and-swap: ${attempt.id}`);
      }
      return this.getAttemptTransition(attempt.id);
    });
  }

  public confirmAttempt(input: SettleAttemptInput, now: string): AttemptTransitionRecord {
    return this.settleAttempt(input, "confirmed", now);
  }

  public failAttemptDefinitively(input: SettleAttemptInput, now: string): AttemptTransitionRecord {
    return this.settleAttempt(input, "definitive_failed", now);
  }

  public markAttemptAmbiguous(input: SettleAttemptInput, now: string): AttemptTransitionRecord {
    return this.settleAttempt(input, "ambiguous", now);
  }

  public resolveAmbiguousAttempt(
    input: AmbiguousAttemptResolutionInput,
    now: string,
    reportOverride?: FollowupReportInput,
  ): AttemptTransitionRecord {
    assertAttemptTransitionInput(input);
    if (input.resolution !== "confirmed" && input.resolution !== "definitive_failed") {
      throw new Error("ambiguous resolution is invalid");
    }
    assertNonEmpty(input.evidenceSource, "ambiguous evidenceSource");
    assertNonEmpty(input.evidenceId, "ambiguous evidenceId");
    assertTimestamp(now, "ambiguous resolution now");
    const evidenceJson = canonicalJson({
      verified: true,
      source: input.evidenceSource,
      evidenceId: input.evidenceId,
      evidence: input.evidence,
    });
    return this.transaction("resolveAmbiguousAttempt", () => {
      const attempt = this.getRequiredAttempt(input.attemptId);
      if (attempt.state === input.resolution) {
        if (nullableJson(attempt.outcome) !== evidenceJson) {
          throw new Error(`ambiguous resolution replay changed evidence: ${attempt.id}`);
        }
        return this.getAttemptTransition(attempt.id);
      }
      if (attempt.state !== "ambiguous") {
        throw new Error(`attempt cannot resolve ambiguity from ${attempt.state}: ${attempt.id}`);
      }
      const action = this.getRequiredAction(attempt.actionId);
      if (action.state !== "ambiguous" || action.activeAttemptId !== attempt.id) {
        throw new Error(`ambiguous attempt no longer owns action: ${attempt.id}`);
      }
      const attemptUpdate = this.db.query(
        `UPDATE assistant_work_attempts
         SET state = ?, worker_id = ?, settled_at = ?, outcome_json = ?, updated_at = ?
         WHERE id = ? AND state = 'ambiguous'`,
      ).run(input.resolution, input.workerId, now, evidenceJson, now, attempt.id);
      const actionUpdate = this.db.query(
        `UPDATE assistant_work_actions SET state = ?, updated_at = ?
         WHERE id = ? AND active_attempt_id = ? AND state = 'ambiguous'`,
      ).run(input.resolution, now, action.id, attempt.id);
      if (attemptUpdate.changes !== 1 || actionUpdate.changes !== 1) {
        throw new Error(`ambiguous resolution lost its compare-and-swap: ${attempt.id}`);
      }
      this.insertFollowupReport(reportOverride ?? {
        id: `verified:${attempt.id}:${input.evidenceId}`,
        code: `attempt_verified_${input.resolution}`,
        workId: action.workId, actionId: action.id, attemptId: attempt.id,
        detail: input.evidence,
      }, now);
      return this.getAttemptTransition(attempt.id);
    });
  }

  public recoverAttempt(input: AttemptTransitionInput, now: string): AttemptRecoveryResult {
    assertAttemptTransitionInput(input);
    assertTimestamp(now, "attempt recovery now");

    return this.transaction("recoverAttempt", () => {
      const attempt = this.getRequiredAttempt(input.attemptId);
      const action = this.getRequiredAction(attempt.actionId);
      if (attempt.state === "claimed_pre_effect") {
        assertAttemptOwnsCurrentAction(attempt, action, "claimed_pre_effect");
        if (this.getRequiredWork(action.workId).state !== "open") {
          const transition = this.cancelPreEffectRecovery(attempt, action, "cancelled", "work_terminal", now);
          return { kind: "terminal_no_replay", ...transition };
        }
        if (action.deadlineAt !== undefined && Date.parse(action.deadlineAt) <= Date.parse(now)) {
          const transition = this.cancelPreEffectRecovery(attempt, action, "expired", "deadline_expired", now);
          return { kind: "terminal_no_replay", ...transition };
        }
        this.db.query(
          `UPDATE assistant_work_attempts
           SET worker_id = ?, recovered_at = ?, recovery_count = recovery_count + 1, updated_at = ?
           WHERE id = ? AND state = 'claimed_pre_effect'`,
        ).run(input.workerId, now, now, attempt.id);
        return { kind: "resume_pre_effect", ...this.getAttemptTransition(attempt.id) };
      }
      if (attempt.state === "effect_started") {
        assertAttemptOwnsCurrentAction(attempt, action, "effect_started");
        const outcome = canonicalJson({ reason: "recovered_effect_started_without_outcome" });
        this.db.query(
          `UPDATE assistant_work_attempts
           SET state = 'ambiguous', settled_at = ?, outcome_json = ?, updated_at = ?
           WHERE id = ? AND state = 'effect_started'`,
        ).run(now, outcome, now, attempt.id);
        this.db.query(
          `UPDATE assistant_work_actions SET state = 'ambiguous', updated_at = ?
           WHERE id = ? AND active_attempt_id = ? AND state = 'effect_started'`,
        ).run(now, action.id, attempt.id);
        return { kind: "reconcile_only", ...this.getAttemptTransition(attempt.id) };
      }
      if (attempt.state === "ambiguous") {
        return { kind: "reconcile_only", action, attempt };
      }
      if (attempt.state === "confirmed") {
        return { kind: "confirmed_no_replay", action, attempt };
      }
      return { kind: "terminal_no_replay", action, attempt };
    });
  }

  public getAttempt(id: string): AttemptRecord | undefined {
    assertNonEmpty(id, "attempt id");
    const row = this.db.query(
      `SELECT ${ATTEMPT_COLUMNS} FROM assistant_work_attempts WHERE id = ?`,
    ).get(id) as AttemptRow | null;
    return row === null ? undefined : toAttemptRecord(row);
  }

  public listAttempts(actionId?: string): AttemptRecord[] {
    if (actionId !== undefined) {
      assertNonEmpty(actionId, "attempt actionId");
    }
    const clause = actionId === undefined ? "" : " WHERE action_id = ?";
    return (this.db.query(
      `SELECT ${ATTEMPT_COLUMNS} FROM assistant_work_attempts${clause}
       ORDER BY claimed_at, action_id, sequence`,
    ).all(...(actionId === undefined ? [] : [actionId])) as AttemptRow[]).map(toAttemptRecord);
  }

  public listRecoveryCandidates(): AttemptRecord[] {
    return (this.db.query(
      `SELECT ${ATTEMPT_COLUMNS} FROM assistant_work_attempts
       WHERE state IN ('claimed_pre_effect', 'effect_started', 'ambiguous')
       ORDER BY claimed_at, action_id, sequence`,
    ).all() as AttemptRow[]).map(toAttemptRecord);
  }

  public admitRecontact(input: AdmitRecontactInput, now: string): RecontactRecord {
    assertNonEmpty(input.actionId, "recontact actionId");
    assertPositiveInteger(input.actionRevision, "recontact action revision");
    assertPositiveInteger(input.ordinal, "recontact ordinal");
    assertTimestamp(input.scheduledAt, "recontact scheduledAt");
    assertTimestamp(now, "recontact admission now");
    const id = stableRecontactId(input.actionId, input.actionRevision, input.ordinal);
    const contextJson = input.context === undefined ? null : canonicalJson(input.context);

    return this.transaction("admitRecontact", () => {
      const action = this.getRequiredAction(input.actionId);
      if (action.revision !== input.actionRevision) {
        throw new Error(
          `stale recontact action revision: expected ${input.actionRevision}, current ${action.revision}`,
        );
      }
      const existing = this.db.query(
        `SELECT id, action_id, action_revision, ordinal, scheduled_at, context_json, created_at
         FROM assistant_work_recontacts WHERE id = ?`,
      ).get(id) as RecontactRow | null;
      if (existing !== null) {
        const record = toRecontactRecord(existing);
        if (record.scheduledAt !== input.scheduledAt || nullableJson(record.context) !== nullableJson(input.context)) {
          throw new Error(`recontact identity collision: ${id}`);
        }
        return record;
      }
      this.db.query(
        `INSERT INTO assistant_work_recontacts (
          id, action_id, action_revision, ordinal, scheduled_at, context_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.actionId, input.actionRevision, input.ordinal, input.scheduledAt, contextJson, now);
      return this.getRequiredRecontact(id);
    });
  }

  public listRecontacts(actionId?: string): RecontactRecord[] {
    if (actionId !== undefined) {
      assertNonEmpty(actionId, "recontact actionId");
    }
    const clause = actionId === undefined ? "" : " WHERE action_id = ?";
    return (this.db.query(
      `SELECT id, action_id, action_revision, ordinal, scheduled_at, context_json, created_at
       FROM assistant_work_recontacts${clause} ORDER BY action_id, action_revision, ordinal`,
    ).all(...(actionId === undefined ? [] : [actionId])) as RecontactRow[]).map(toRecontactRecord);
  }

  public setFollowupPolicy(input: SetFollowupPolicyInput, now: string): FollowupPolicyRecord {
    assertFollowupPolicyInput(input);
    assertTimestamp(now, "followup policy now");
    return this.transaction("setFollowupPolicy", () => {
      const work = this.getRequiredWork(input.workId);
      if (work.state !== "open") {
        throw new Error(`cannot set followup policy for ${work.state} work: ${work.id}`);
      }
      const action = this.getRequiredAction(input.actionId);
      if (action.workId !== input.workId) {
        throw new Error("followup policy action does not belong to work");
      }
      const existing = this.getFollowupPolicy(input.workId);
      if (
        existing
        && existing.actionId === input.actionId
        && existing.actionRevision === action.revision
        && existing.actionDigest === action.digest
        && existing.enabled === input.enabled
        && existing.intervalMs === input.intervalMs
        && existing.maxAttempts === input.maxAttempts
        && sameProvenance(existing.provenance, input.provenance)
      ) {
        return existing;
      }
      const revision = (existing?.revision ?? 0) + 1;
      const nextDueAt = input.enabled && input.maxAttempts > 0
        ? addMilliseconds(now, input.intervalMs, "followup next due")
        : null;
      this.db.query(
        `INSERT INTO assistant_work_followup_policies (
          work_id, action_id, action_revision, action_digest, revision, enabled,
          interval_ms, max_attempts, next_due_at, next_ordinal,
          provenance_principal, provenance_channel, provenance_subject, provenance_evidence_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'owner', ?, ?, ?, ?, ?)
        ON CONFLICT(work_id) DO UPDATE SET
          action_id = excluded.action_id,
          action_revision = excluded.action_revision,
          action_digest = excluded.action_digest,
          revision = excluded.revision,
          enabled = excluded.enabled,
          interval_ms = excluded.interval_ms,
          max_attempts = excluded.max_attempts,
          next_due_at = excluded.next_due_at,
          next_ordinal = 1,
          provenance_principal = excluded.provenance_principal,
          provenance_channel = excluded.provenance_channel,
          provenance_subject = excluded.provenance_subject,
          provenance_evidence_id = excluded.provenance_evidence_id,
          updated_at = excluded.updated_at`,
      ).run(
        input.workId,
        input.actionId,
        action.revision,
        action.digest,
        revision,
        input.enabled ? 1 : 0,
        input.intervalMs,
        input.maxAttempts,
        nextDueAt,
        input.provenance.channel,
        input.provenance.subject,
        input.provenance.evidenceId,
        now,
        now,
      );
      return this.getRequiredFollowupPolicy(input.workId);
    });
  }

  public getFollowupPolicy(workId: string): FollowupPolicyRecord | undefined {
    assertNonEmpty(workId, "followup policy workId");
    const row = this.db.query(
      `SELECT ${FOLLOWUP_POLICY_COLUMNS} FROM assistant_work_followup_policies WHERE work_id = ?`,
    ).get(workId) as FollowupPolicyRow | null;
    return row === null ? undefined : toFollowupPolicyRecord(row);
  }

  public listFollowupPolicies(): FollowupPolicyRecord[] {
    return (this.db.query(
      `SELECT ${FOLLOWUP_POLICY_COLUMNS}
       FROM assistant_work_followup_policies ORDER BY created_at, work_id`,
    ).all() as FollowupPolicyRow[]).map(toFollowupPolicyRecord);
  }

  public claimDueFollowup(workId: string, workerId: string, now: string): ClaimDueFollowupResult {
    assertNonEmpty(workId, "followup claim workId");
    assertNonEmpty(workerId, "followup claim workerId");
    assertTimestamp(now, "followup claim now");
    return this.transaction<ClaimDueFollowupResult>("claimDueFollowup", () => {
      const policy = this.getFollowupPolicy(workId);
      if (!policy) {
        return { kind: "none", reason: "missing_policy" };
      }
      if (!policy.enabled) {
        return { kind: "none", reason: "disabled", policy };
      }
      const work = this.getRequiredWork(workId);
      if (work.state !== "open") {
        this.clearFollowupDue(policy, now);
        return { kind: "none", reason: "work_terminal", policy };
      }
      if (policy.nextOrdinal > policy.maxAttempts) {
        this.clearFollowupDue(policy, now);
        return { kind: "none", reason: "cap_reached", policy };
      }
      if (policy.nextDueAt === undefined || Date.parse(policy.nextDueAt) > Date.parse(now)) {
        return { kind: "none", reason: "not_due", policy };
      }

      const originalAction = this.getRequiredAction(policy.actionId);
      if (originalAction.revision !== policy.actionRevision || originalAction.digest !== policy.actionDigest) {
        this.clearFollowupDue(policy, now);
        return { kind: "none", reason: "policy_changed", policy, action: originalAction };
      }
      if (originalAction.state === "planned") {
        return { kind: "none", reason: "source_unconfirmed", policy, action: originalAction };
      }
      if (originalAction.deadlineAt !== undefined && Date.parse(originalAction.deadlineAt) <= Date.parse(now)) {
        this.clearFollowupDue(policy, now);
        return { kind: "none", reason: "expired", policy, action: originalAction };
      }
      if (originalAction.state === "claimed_pre_effect" || originalAction.state === "effect_started") {
        return { kind: "none", reason: "active_effect", policy, action: originalAction };
      }
      if (originalAction.state === "ambiguous") {
        this.clearFollowupDue(policy, now);
        return { kind: "none", reason: "ambiguous", policy, action: originalAction };
      }
      if (originalAction.state === "definitive_failed" || originalAction.state === "cancelled" || originalAction.state === "expired" || originalAction.state === "blocked") {
        this.clearFollowupDue(policy, now);
        return { kind: "none", reason: "definitive_failed", policy, action: originalAction };
      }

      const dispatchId = stableFollowupDispatchId(workId, policy.revision, policy.nextOrdinal);
      const existingDispatch = this.getFollowupDispatch(dispatchId);
      if (existingDispatch) {
        const action = this.getRequiredAction(existingDispatch.actionId);
        if (existingDispatch.state === "claimed") {
          if (existingDispatch.workerId === workerId) {
            return { kind: "claimed", policy, dispatch: existingDispatch, originalAction, action };
          }
          return { kind: "none", reason: "active_effect", policy, dispatch: existingDispatch, action };
        }
        if (existingDispatch.state !== "due") {
          return { kind: "none", reason: "not_due", policy, dispatch: existingDispatch, action };
        }
        if (action.deadlineAt !== undefined && Date.parse(action.deadlineAt) <= Date.parse(now)) {
          this.db.query(
            `UPDATE assistant_work_actions SET state = 'expired', updated_at = ?
             WHERE id = ? AND current_revision = ? AND current_digest = ?
               AND state = 'planned'`,
          ).run(now, action.id, action.revision, action.digest);
          this.db.query(
            `UPDATE assistant_work_followup_dispatches
             SET state = 'claimed', worker_id = ?, claimed_at = COALESCE(claimed_at, ?), updated_at = ?
             WHERE id = ? AND state = 'due'`,
          ).run(workerId, now, now, dispatchId);
          return {
            kind: "claimed",
            policy,
            dispatch: this.getRequiredFollowupDispatch(dispatchId),
            originalAction,
            action: this.getRequiredAction(action.id),
          };
        }
        if (action.state === "claimed_pre_effect" || action.state === "effect_started") {
          return { kind: "none", reason: "active_effect", policy, dispatch: existingDispatch, action };
        }
        if (
          action.state === "ambiguous"
          || action.state === "confirmed"
          || action.state === "definitive_failed"
          || action.state === "cancelled"
          || action.state === "expired"
          || action.state === "blocked"
        ) {
          this.db.query(
            `UPDATE assistant_work_followup_dispatches
             SET state = 'claimed', worker_id = ?, claimed_at = COALESCE(claimed_at, ?), updated_at = ?
             WHERE id = ? AND state = 'due'`,
          ).run(workerId, now, now, dispatchId);
          return {
            kind: "claimed",
            policy,
            dispatch: this.getRequiredFollowupDispatch(dispatchId),
            originalAction,
            action,
          };
        }
        this.db.query(
          `UPDATE assistant_work_followup_dispatches
           SET state = 'claimed', worker_id = ?, claimed_at = ?, outcome_json = NULL, updated_at = ?
           WHERE id = ? AND state = 'due'`,
        ).run(workerId, now, now, dispatchId);
        return {
          kind: "claimed",
          policy,
          dispatch: this.getRequiredFollowupDispatch(dispatchId),
          originalAction,
          action,
        };
      }

      const action = this.proposeAction({
        workId,
        semanticKey: followupSemanticKey(originalAction.id, policy.revision, policy.nextOrdinal),
        effectClass: originalAction.effectClass,
        ...(originalAction.recipient === undefined ? {} : { recipient: originalAction.recipient }),
        ...(originalAction.topic === undefined ? {} : { topic: originalAction.topic }),
        action: originalAction.action,
        payload: originalAction.payload,
        ...(originalAction.scope === undefined ? {} : { scope: originalAction.scope }),
        ...(originalAction.cost === undefined ? {} : { cost: originalAction.cost }),
        ...(originalAction.deadlineAt === undefined ? {} : { deadlineAt: originalAction.deadlineAt }),
        ...(originalAction.blockedEvidence === undefined ? {} : { blockedEvidence: originalAction.blockedEvidence }),
      }, now);
      this.db.query(
        `INSERT INTO assistant_work_followup_dispatches (
          id, work_id, policy_revision, ordinal, original_action_id, action_id,
          state, due_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'due', ?, ?, ?)`,
      ).run(
        dispatchId,
        workId,
        policy.revision,
        policy.nextOrdinal,
        originalAction.id,
        action.id,
        policy.nextDueAt,
        now,
        now,
      );
      this.db.query(
        `UPDATE assistant_work_followup_dispatches
         SET state = 'claimed', worker_id = ?, claimed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'due'`,
      ).run(workerId, now, now, dispatchId);
      return {
        kind: "claimed",
        policy,
        dispatch: this.getRequiredFollowupDispatch(dispatchId),
        originalAction,
        action,
      };
    });
  }

  public recoverClaimedFollowup(
    dispatchId: string,
    workerId: string,
    now: string,
  ): ClaimDueFollowupResult {
    assertNonEmpty(dispatchId, "followup recovery dispatchId");
    assertNonEmpty(workerId, "followup recovery workerId");
    assertTimestamp(now, "followup recovery now");
    return this.transaction<ClaimDueFollowupResult>("recoverClaimedFollowup", () => {
      const dispatch = this.getFollowupDispatch(dispatchId);
      if (!dispatch || dispatch.state !== "claimed") {
        return { kind: "none", reason: "not_due", dispatch };
      }
      const policy = this.getRequiredFollowupPolicy(dispatch.workId);
      const originalAction = this.getRequiredAction(dispatch.originalActionId);
      let action = this.getRequiredAction(dispatch.actionId);
      this.db.query(
        `UPDATE assistant_work_followup_dispatches SET worker_id = ?, updated_at = ?
         WHERE id = ? AND state = 'claimed'`,
      ).run(workerId, now, dispatch.id);

      const attempt = action.activeAttemptId === undefined ? undefined : this.getAttempt(action.activeAttemptId);
      if (attempt) {
        const recovery = this.recoverAttempt({ attemptId: attempt.id, workerId }, now);
        action = recovery.action;
        if (recovery.kind !== "resume_pre_effect") {
          return {
            kind: "claimed",
            policy,
            dispatch: this.getRequiredFollowupDispatch(dispatch.id),
            originalAction,
            action,
          };
        }

        const work = this.getRequiredWork(dispatch.workId);
        const policyCurrent = work.state === "open"
          && policy.enabled
          && policy.revision === dispatch.policyRevision
          && originalAction.revision === policy.actionRevision
          && originalAction.digest === policy.actionDigest;
        if (!policyCurrent) {
          this.cancelAction({
            actionId: action.id,
            revision: action.revision,
            digest: action.digest,
            reason: work.state === "open" ? "followup_policy_changed_before_effect" : "followup_work_terminal_before_effect",
          }, now);
          return {
            kind: "claimed",
            policy,
            dispatch: this.getRequiredFollowupDispatch(dispatch.id),
            originalAction,
            action: this.getRequiredAction(action.id),
          };
        }
        return {
          kind: "claimed",
          policy,
          dispatch: this.getRequiredFollowupDispatch(dispatch.id),
          originalAction,
          action,
        };
      }

      if (
        action.state === "confirmed"
        || action.state === "ambiguous"
        || action.state === "definitive_failed"
        || action.state === "cancelled"
        || action.state === "expired"
        || action.state === "blocked"
      ) {
        return {
          kind: "claimed",
          policy,
          dispatch: this.getRequiredFollowupDispatch(dispatch.id),
          originalAction,
          action,
        };
      }

      const work = this.getRequiredWork(dispatch.workId);
      const obsoleteReason = work.state !== "open" ? "work_terminal"
        : !policy.enabled || policy.revision !== dispatch.policyRevision
          || originalAction.revision !== policy.actionRevision || originalAction.digest !== policy.actionDigest ? "policy_changed"
          : action.deadlineAt !== undefined && Date.parse(action.deadlineAt) <= Date.parse(now) ? "expired" : undefined;
      if (obsoleteReason) {
        this.db.query(`UPDATE assistant_work_followup_dispatches SET state = 'skipped', completed_at = ?, outcome_json = ?, updated_at = ? WHERE id = ? AND state = 'claimed'`)
          .run(now, canonicalJson({ kind: "rejected", detail: { reason: obsoleteReason } }), now, dispatch.id);
        return { kind: "none", reason: obsoleteReason, policy, dispatch: this.getRequiredFollowupDispatch(dispatch.id), action };
      }
      return {
        kind: "claimed",
        policy,
        dispatch: this.getRequiredFollowupDispatch(dispatch.id),
        originalAction,
        action,
      };
    });
  }

  public getFollowupDispatch(id: string): FollowupDispatchRecord | undefined {
    assertNonEmpty(id, "followup dispatch id");
    const row = this.db.query(
      `SELECT ${FOLLOWUP_DISPATCH_COLUMNS} FROM assistant_work_followup_dispatches WHERE id = ?`,
    ).get(id) as FollowupDispatchRow | null;
    return row === null ? undefined : toFollowupDispatchRecord(row);
  }

  public listFollowupDispatches(workId?: string): FollowupDispatchRecord[] {
    if (workId !== undefined) {
      assertNonEmpty(workId, "followup dispatch workId");
    }
    const clause = workId === undefined ? "" : " WHERE work_id = ?";
    return (this.db.query(
      `SELECT ${FOLLOWUP_DISPATCH_COLUMNS}
       FROM assistant_work_followup_dispatches${clause}
       ORDER BY due_at, work_id, policy_revision, ordinal`,
    ).all(...(workId === undefined ? [] : [workId])) as FollowupDispatchRow[])
      .map(toFollowupDispatchRecord);
  }

  public completeFollowup(
    input: CompleteFollowupInput,
    report: FollowupReportInput,
    now: string,
  ): FollowupCompletion {
    assertCompleteFollowupInput(input);
    assertFollowupReportInput(report);
    assertTimestamp(now, "followup completion now");
    if (report.dispatchId !== input.dispatchId) {
      throw new Error("followup completion report dispatchId must match");
    }
    return this.transaction("completeFollowup", () => {
      const dispatch = this.getRequiredFollowupDispatch(input.dispatchId);
      if (dispatch.state === "completed" || dispatch.state === "skipped") {
        if (
          dispatch.workerId !== input.workerId
          || nullableJson(dispatch.outcome) !== canonicalJson(followupOutcomeToJson(input.outcome))
        ) {
          throw new Error(`followup completion replay changed outcome: ${dispatch.id}`);
        }
        this.insertFollowupReport(report, now);
        return { policy: this.getRequiredFollowupPolicy(dispatch.workId), dispatch };
      }
      if (dispatch.state !== "claimed" || dispatch.workerId !== input.workerId) {
        throw new Error(`followup dispatch is not owned by worker: ${dispatch.id}`);
      }
      const policy = this.getRequiredFollowupPolicy(dispatch.workId);
      const policyCurrent = policy.revision === dispatch.policyRevision;
      const stopsPolicy = input.outcome.kind === "ambiguous" || input.outcome.kind === "rejected";
      const nextOrdinal = dispatch.ordinal + 1;
      const canSchedule = policyCurrent
        && policy.enabled
        && !stopsPolicy
        && nextOrdinal <= policy.maxAttempts;
      const nextDueAt = canSchedule ? addMilliseconds(now, policy.intervalMs, "followup next due") : null;
      const dispatchState = policyCurrent ? "completed" : "skipped";
      this.db.query(
        `UPDATE assistant_work_followup_dispatches
         SET state = ?, completed_at = ?, outcome_json = ?, updated_at = ?
         WHERE id = ? AND state = 'claimed' AND worker_id = ?`,
      ).run(dispatchState, now, canonicalJson(followupOutcomeToJson(input.outcome)), now, dispatch.id, input.workerId);
      if (policyCurrent) {
        this.db.query(
          `UPDATE assistant_work_followup_policies
           SET next_ordinal = ?, next_due_at = ?, updated_at = ?
           WHERE work_id = ? AND revision = ?`,
        ).run(
          nextOrdinal,
          nextDueAt,
          now,
          policy.workId,
          policy.revision,
        );
      }
      this.insertFollowupReport(report, now);
      return {
        policy: this.getRequiredFollowupPolicy(dispatch.workId),
        dispatch: this.getRequiredFollowupDispatch(dispatch.id),
      };
    });
  }

  public admitFollowupReport(report: FollowupReportInput, now: string): FollowupReportRecord {
    assertFollowupReportInput(report);
    assertTimestamp(now, "followup report admission now");
    return this.transaction("admitFollowupReport", () => {
      this.insertFollowupReport(report, now);
      return this.getRequiredFollowupReport(report.id);
    });
  }

  public getFollowupReport(id: string): FollowupReportRecord | undefined {
    assertNonEmpty(id, "followup report id");
    const row = this.db.query(
      `SELECT ${FOLLOWUP_REPORT_COLUMNS} FROM assistant_work_reports WHERE id = ?`,
    ).get(id) as FollowupReportRow | null;
    return row === null ? undefined : toFollowupReportRecord(row);
  }

  public listPendingFollowupReports(): FollowupReportRecord[] {
    return (this.db.query(
      `SELECT ${FOLLOWUP_REPORT_COLUMNS}
       FROM assistant_work_reports WHERE state = 'pending' ORDER BY created_at, id`,
    ).all() as FollowupReportRow[]).map(toFollowupReportRecord);
  }

  public markFollowupReportAdmitted(id: string, admittedAt: string): FollowupReportRecord {
    assertNonEmpty(id, "followup report id");
    assertTimestamp(admittedAt, "followup report admittedAt");
    this.db.query(
      `UPDATE assistant_work_reports
       SET state = 'admitted', admitted_at = COALESCE(admitted_at, ?), updated_at = ?
       WHERE id = ? AND state = 'pending'`,
    ).run(admittedAt, admittedAt, id);
    const report = this.getFollowupReport(id);
    if (!report) {
      throw new Error(`unknown followup report: ${id}`);
    }
    return report;
  }

  public resolveFollowupAmbiguity(
    dispatchId: string,
    input: AmbiguousAttemptResolutionInput,
    report: FollowupReportInput,
    now: string,
  ): FollowupCompletion {
    const { workerId, resolution, evidence } = input;
    assertNonEmpty(dispatchId, "followup ambiguity dispatchId");
    assertNonEmpty(workerId, "followup ambiguity workerId");
    assertFollowupReportInput(report);
    assertTimestamp(now, "followup ambiguity resolution now");
    if (report.dispatchId !== dispatchId) {
      throw new Error("followup ambiguity report dispatchId must match");
    }
    return this.transaction("resolveFollowupAmbiguity", () => {
      const dispatch = this.getRequiredFollowupDispatch(dispatchId);
      const action = this.getRequiredAction(dispatch.actionId);
      if (!action.activeAttemptId) {
        throw new Error(`followup action has no attempt to reconcile: ${action.id}`);
      }
      if (input.attemptId !== action.activeAttemptId) {
        throw new Error("followup ambiguity evidence must refer to the active attempt");
      }
      this.resolveAmbiguousAttempt(input, now, report);
      const priorOutcome = dispatch.outcome;
      if (priorOutcome !== null && typeof priorOutcome === "object" && "kind" in priorOutcome
        && priorOutcome.kind === resolution && (dispatch.state === "completed" || dispatch.state === "skipped")) {
        this.insertFollowupReport(report, now);
        return { policy: this.getRequiredFollowupPolicy(dispatch.workId), dispatch };
      }
      const policy = this.getRequiredFollowupPolicy(dispatch.workId);
      const policyCurrent = policy.revision === dispatch.policyRevision;
      const nextOrdinal = dispatch.ordinal + 1;
      const canSchedule = policyCurrent && policy.enabled && nextOrdinal <= policy.maxAttempts;
      this.db.query(
        `UPDATE assistant_work_followup_dispatches
         SET state = ?, worker_id = ?, completed_at = ?, outcome_json = ?, updated_at = ?
         WHERE id = ? AND state IN ('claimed', 'completed')`,
      ).run(
        policyCurrent ? "completed" : "skipped",
        workerId,
        now,
        canonicalJson({ kind: resolution, detail: evidence }),
        now,
        dispatch.id,
      );
      if (policyCurrent && (policy.nextOrdinal <= dispatch.ordinal || (policy.nextOrdinal === nextOrdinal && policy.nextDueAt === undefined))) {
        this.db.query(
          `UPDATE assistant_work_followup_policies
           SET next_ordinal = ?, next_due_at = ?, updated_at = ?
           WHERE work_id = ? AND revision = ?`,
        ).run(
          nextOrdinal,
          canSchedule ? addMilliseconds(now, policy.intervalMs, "followup next due") : null,
          now,
          policy.workId,
          policy.revision,
        );
      }
      this.insertFollowupReport(report, now);
      return {
        policy: this.getRequiredFollowupPolicy(dispatch.workId),
        dispatch: this.getRequiredFollowupDispatch(dispatch.id),
      };
    });
  }

  public admitNotification(input: AdmitNotificationInput, now: string): NotificationRecord {
    assertNotificationInput(input);
    assertTimestamp(now, "notification admission now");
    return this.transaction("admitNotification", () => {
      const existing = this.getNotification(input.id);
      if (existing) {
        assertNotificationReplay(existing, input);
        return existing;
      }
      if (input.workId !== undefined && !this.getWork(input.workId)) {
        throw new Error(`unknown notification work: ${input.workId}`);
      }
      if (input.actionId !== undefined) {
        const action = this.getAction(input.actionId);
        if (!action) {
          throw new Error(`unknown notification action: ${input.actionId}`);
        }
        if (input.workId !== undefined && action.workId !== input.workId) {
          throw new Error("notification action does not belong to work");
        }
      }
      this.db.query(
        `INSERT INTO assistant_work_notifications (
          id, body, work_id, action_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.body, input.workId ?? null, input.actionId ?? null, now, now);
      return this.getRequiredNotification(input.id);
    });
  }

  public getNotification(id: string): NotificationRecord | undefined {
    assertNonEmpty(id, "notification id");
    const row = this.db.query(
      `SELECT ${NOTIFICATION_COLUMNS} FROM assistant_work_notifications WHERE id = ?`,
    ).get(id) as NotificationRow | null;
    return row === null ? undefined : toNotificationRecord(row);
  }

  public getNotificationWithRoutes(id: string): NotificationWithRoutes | undefined {
    const notification = this.getNotification(id);
    return notification === undefined
      ? undefined
      : { notification, routes: this.listNotificationRoutes(id) };
  }

  public listNotifications(): NotificationRecord[] {
    return (this.db.query(
      `SELECT ${NOTIFICATION_COLUMNS} FROM assistant_work_notifications ORDER BY created_at, ROWID`,
    ).all() as NotificationRow[]).map(toNotificationRecord);
  }

  public reserveNotificationRoute(
    notificationId: string,
    route: NotificationRoute,
    now: string,
  ): ReserveNotificationRouteResult {
    assertNonEmpty(notificationId, "notification route notificationId");
    assertNotificationRoute(route);
    assertTimestamp(now, "notification route reservation now");
    return this.transaction<ReserveNotificationRouteResult>("reserveNotificationRoute", () => {
      const notification = this.getNotification(notificationId);
      if (!notification) {
        return { kind: "rejected", reason: "unknown_notification" };
      }
      const existing = this.getNotificationRoute(notificationId, route);
      if (notification.ownerAckAt !== undefined) {
        return {
          kind: "rejected",
          reason: "acknowledged",
          notification,
          ...(existing === undefined ? {} : { route: existing }),
        };
      }
      if (existing) {
        return { kind: "reserved", created: false, notification, route: existing };
      }
      this.db.query(
        `INSERT INTO assistant_work_notification_routes (
          notification_id, route, state, reserved_at, updated_at
        ) VALUES (?, ?, 'reserved', ?, ?)`,
      ).run(notificationId, route, now, now);
      return {
        kind: "reserved",
        created: true,
        notification,
        route: this.getRequiredNotificationRoute(notificationId, route),
      };
    });
  }

  public getNotificationRoute(
    notificationId: string,
    route: NotificationRoute,
  ): NotificationRouteRecord | undefined {
    assertNonEmpty(notificationId, "notification route notificationId");
    assertNotificationRoute(route);
    const row = this.db.query(
      `SELECT ${NOTIFICATION_ROUTE_COLUMNS}
       FROM assistant_work_notification_routes WHERE notification_id = ? AND route = ?`,
    ).get(notificationId, route) as NotificationRouteRow | null;
    return row === null ? undefined : toNotificationRouteRecord(row);
  }

  public listNotificationRoutes(notificationId?: string): NotificationRouteRecord[] {
    if (notificationId !== undefined) {
      assertNonEmpty(notificationId, "notification route notificationId");
    }
    const clause = notificationId === undefined ? "" : " WHERE notification_id = ?";
    return (this.db.query(
      `SELECT ${NOTIFICATION_ROUTE_COLUMNS}
       FROM assistant_work_notification_routes${clause}
       ORDER BY reserved_at, notification_id, route`,
    ).all(...(notificationId === undefined ? [] : [notificationId])) as NotificationRouteRow[])
      .map(toNotificationRouteRecord);
  }

  public claimNotificationRoute(
    notificationId: string,
    route: NotificationRoute,
    workerId: string,
    now: string,
    options: { readonly renderedFallback?: boolean } = {},
  ): ClaimNotificationRouteResult {
    assertNonEmpty(notificationId, "notification claim notificationId");
    assertNotificationRoute(route);
    assertNonEmpty(workerId, "notification claim workerId");
    assertTimestamp(now, "notification claim now");
    if (options.renderedFallback !== undefined && typeof options.renderedFallback !== "boolean") {
      throw new Error("notification claim renderedFallback must be boolean");
    }
    return this.transaction<ClaimNotificationRouteResult>("claimNotificationRoute", () => {
      const notification = this.getNotification(notificationId);
      if (!notification) {
        return { kind: "rejected", reason: "unknown_notification" };
      }
      const routeRecord = this.getNotificationRoute(notificationId, route);
      if (!routeRecord) {
        return { kind: "rejected", reason: "unreserved", notification };
      }
      if (notification.ownerAckAt !== undefined) {
        return { kind: "rejected", reason: "acknowledged", notification, route: routeRecord };
      }
      if (route === "imessage" && notification.renderedAt !== undefined && options.renderedFallback !== true) {
        return { kind: "rejected", reason: "superseded", notification, route: routeRecord };
      }
      if (routeRecord.state === "dispatching") {
        return { kind: "rejected", reason: "already_claimed", notification, route: routeRecord };
      }
      if (routeRecord.state !== "reserved") {
        return { kind: "rejected", reason: "terminal", notification, route: routeRecord };
      }
      const result = this.db.query(
        `UPDATE assistant_work_notification_routes
         SET state = 'dispatching', worker_id = ?, dispatching_at = ?, updated_at = ?
         WHERE notification_id = ? AND route = ? AND state = 'reserved'`,
      ).run(workerId, now, now, notificationId, route);
      if (result.changes !== 1) {
        throw new Error(`notification route claim lost its compare-and-swap: ${notificationId}/${route}`);
      }
      return {
        kind: "claimed",
        notification,
        route: this.getRequiredNotificationRoute(notificationId, route),
      };
    });
  }

  public markNotificationRendered(
    notificationId: string,
    route: NotificationRoute,
    renderedAt: string,
  ): NotificationRecord {
    assertNonEmpty(notificationId, "notification render notificationId");
    assertNotificationRoute(route);
    if (route !== "chat") {
      throw new Error("only the chat route can be rendered");
    }
    assertTimestamp(renderedAt, "notification renderedAt");
    return this.transaction("markNotificationRendered", () => {
      // iMessage-first notices are also visible in the shared panel history.
      const routeRecord = this.getNotificationRoute(notificationId, route);
      if (routeRecord && (routeRecord.state === "reserved" || routeRecord.state === "failed_definitive")) {
        throw new Error(`notification route cannot be rendered from ${routeRecord.state}`);
      }
      const notification = this.getRequiredNotification(notificationId);
      if (notification.renderedAt !== undefined) {
        return notification;
      }
      this.db.query(
        `UPDATE assistant_work_notifications
         SET rendered_at = ?, updated_at = ? WHERE id = ? AND rendered_at IS NULL`,
      ).run(renderedAt, renderedAt, notificationId);
      return this.getRequiredNotification(notificationId);
    });
  }

  public acknowledgeNotification(notificationId: string, ownerAckAt: string): NotificationRecord {
    assertNonEmpty(notificationId, "notification acknowledgement notificationId");
    assertTimestamp(ownerAckAt, "notification ownerAckAt");
    return this.transaction("acknowledgeNotification", () => {
      const notification = this.getRequiredNotification(notificationId);
      if (notification.ownerAckAt !== undefined) {
        return notification;
      }
      this.db.query(
        `UPDATE assistant_work_notifications
         SET owner_ack_at = ?, updated_at = ? WHERE id = ? AND owner_ack_at IS NULL`,
      ).run(ownerAckAt, ownerAckAt, notificationId);
      return this.getRequiredNotification(notificationId);
    });
  }

  public markNotificationRouteDelivered(
    input: SettleNotificationRouteInput,
    now: string,
  ): NotificationRouteTransition {
    return this.settleNotificationRoute(input, "delivered", now);
  }

  public markNotificationRouteUncertain(
    input: SettleNotificationRouteInput,
    now: string,
  ): NotificationRouteTransition {
    return this.settleNotificationRoute(input, "uncertain", now);
  }

  public markNotificationRouteFailedDefinitively(
    input: SettleNotificationRouteInput,
    now: string,
  ): NotificationRouteTransition {
    return this.settleNotificationRoute(input, "failed_definitive", now);
  }

  public recoverNotificationRoute(
    notificationId: string,
    route: NotificationRoute,
    now: string,
  ): NotificationRecoveryResult {
    assertNonEmpty(notificationId, "notification recovery notificationId");
    assertNotificationRoute(route);
    assertTimestamp(now, "notification recovery now");
    return this.transaction<NotificationRecoveryResult>("recoverNotificationRoute", () => {
      const notification = this.getRequiredNotification(notificationId);
      const routeRecord = this.getRequiredNotificationRoute(notificationId, route);
      if (routeRecord.state === "reserved") {
        if (notification.ownerAckAt !== undefined || (route === "imessage" && notification.renderedAt !== undefined)) {
          return { kind: "terminal", notification, route: routeRecord };
        }
        return { kind: "claimable", notification, route: routeRecord };
      }
      if (routeRecord.state === "dispatching") {
        this.db.query(
          `UPDATE assistant_work_notification_routes
           SET state = 'uncertain', settled_at = ?, detail_json = ?, updated_at = ?
           WHERE notification_id = ? AND route = ? AND state = 'dispatching'`,
        ).run(
          now,
          canonicalJson({ reason: "recovered_dispatching_without_outcome" }),
          now,
          notificationId,
          route,
        );
        return {
          kind: "reconcile_only",
          notification,
          route: this.getRequiredNotificationRoute(notificationId, route),
        };
      }
      if (routeRecord.state === "uncertain") {
        return { kind: "reconcile_only", notification, route: routeRecord };
      }
      return { kind: "terminal", notification, route: routeRecord };
    });
  }

  public listNotificationRecoveryCandidates(): NotificationRouteRecord[] {
    return (this.db.query(
      `SELECT ${NOTIFICATION_ROUTE_COLUMNS}
       FROM assistant_work_notification_routes
       WHERE state IN ('reserved', 'dispatching', 'uncertain')
       ORDER BY reserved_at, notification_id, route`,
    ).all() as NotificationRouteRow[]).map(toNotificationRouteRecord);
  }

  private insertActionRevision(
    actionId: string,
    revision: number,
    digest: string,
    material: ActionMaterial,
    now: string,
  ): void {
    this.db.query(
      `INSERT INTO assistant_work_action_revisions (
        action_id, revision, digest, effect_class, recipient, topic, action_key,
        payload_json, scope_json, cost_json, deadline_at, blocked_evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      actionId,
      revision,
      digest,
      material.effectClass,
      material.recipient ?? null,
      material.topic ?? null,
      material.action,
      canonicalJson(material.payload),
      material.scope === undefined ? null : canonicalJson(material.scope),
      material.cost === undefined ? null : canonicalJson(material.cost),
      material.deadlineAt ?? null,
      material.blockedEvidence === undefined ? null : canonicalJson(material.blockedEvidence),
      now,
    );
  }


  private cancelPreEffectRecovery(
    attempt: AttemptRecord,
    action: ActionRecord,
    nextState: ActionState,
    reason: string,
    now: string,
  ): AttemptTransitionRecord {
    const outcomeJson = canonicalJson({ reason });
    const attemptUpdate = this.db.query(
      `UPDATE assistant_work_attempts
       SET state = 'cancelled', settled_at = ?, outcome_json = ?, updated_at = ?
       WHERE id = ? AND state = 'claimed_pre_effect'`,
    ).run(now, outcomeJson, now, attempt.id);
    const actionUpdate = this.db.query(
      `UPDATE assistant_work_actions
       SET state = ?, active_attempt_id = NULL, updated_at = ?
       WHERE id = ? AND current_revision = ? AND current_digest = ?
         AND active_attempt_id = ? AND state = 'claimed_pre_effect'`,
    ).run(nextState, now, action.id, action.revision, action.digest, attempt.id);
    if (attemptUpdate.changes !== 1 || actionUpdate.changes !== 1) {
      throw new Error(`pre-effect recovery cancellation lost its compare-and-swap: ${attempt.id}`);
    }
    return this.getAttemptTransition(attempt.id);
  }

  private settleNotificationRoute(
    input: SettleNotificationRouteInput,
    state: Extract<NotificationRouteState, "delivered" | "uncertain" | "failed_definitive">,
    now: string,
  ): NotificationRouteTransition {
    assertNotificationSettlementInput(input);
    assertTimestamp(now, "notification route settlement now");
    const detailJson = input.detail === undefined ? null : canonicalJson(input.detail);
    return this.transaction(`settleNotificationRoute:${state}`, () => {
      const notification = this.getRequiredNotification(input.notificationId);
      const routeRecord = this.getRequiredNotificationRoute(input.notificationId, input.route);
      if (routeRecord.state === state) {
        const sameWorker = routeRecord.workerId === input.workerId;
        const sameExternalId = input.externalId === undefined || routeRecord.externalId === input.externalId;
        const sameDetail = input.detail === undefined || nullableJson(routeRecord.detail) === detailJson;
        if (!sameWorker || !sameExternalId || !sameDetail) {
          throw new Error(`notification route settlement replay changed evidence: ${input.notificationId}/${input.route}`);
        }
        return { notification, route: routeRecord };
      }
      const reconciling = routeRecord.state === "uncertain" && state !== "uncertain";
      if (routeRecord.state !== "dispatching" && !reconciling) {
        throw new Error(`notification route cannot transition from ${routeRecord.state} to ${state}`);
      }
      if (!reconciling && routeRecord.workerId !== input.workerId) {
        throw new Error(`notification route is owned by another worker: ${input.notificationId}/${input.route}`);
      }
      if (reconciling && input.externalId === undefined && input.detail === undefined) {
        throw new Error("notification reconciliation requires evidence");
      }
      const sourceState = routeRecord.state;
      const result = this.db.query(
        `UPDATE assistant_work_notification_routes
         SET state = ?, worker_id = ?, settled_at = ?, external_id = ?, detail_json = ?, updated_at = ?
         WHERE notification_id = ? AND route = ? AND state = ?`,
      ).run(
        state,
        input.workerId,
        now,
        input.externalId ?? null,
        detailJson,
        now,
        input.notificationId,
        input.route,
        sourceState,
      );
      if (result.changes !== 1) {
        throw new Error(`notification route settlement lost its compare-and-swap: ${input.notificationId}/${input.route}`);
      }
      return {
        notification,
        route: this.getRequiredNotificationRoute(input.notificationId, input.route),
      };
    });
  }

  private settleAttempt(
    input: SettleAttemptInput,
    state: Extract<AttemptState, "confirmed" | "definitive_failed" | "ambiguous">,
    now: string,
  ): AttemptTransitionRecord {
    assertAttemptTransitionInput(input);
    assertTimestamp(now, "attempt settlement now");
    const outcomeJson = canonicalJson(input.outcome);

    return this.transaction(`settleAttempt:${state}`, () => {
      const attempt = this.getRequiredAttempt(input.attemptId);
      assertAttemptWorker(attempt, input.workerId);
      if (attempt.state === state) {
        if (nullableJson(attempt.outcome) !== outcomeJson) {
          throw new Error(`attempt settlement replay changed its outcome: ${attempt.id}`);
        }
        return this.getAttemptTransition(attempt.id);
      }
      if (attempt.state !== "effect_started") {
        throw new Error(`attempt cannot transition from ${attempt.state} to ${state}: ${attempt.id}`);
      }
      const action = this.getRequiredAction(attempt.actionId);
      assertAttemptOwnsCurrentAction(attempt, action, "effect_started");

      const attemptUpdate = this.db.query(
        `UPDATE assistant_work_attempts
         SET state = ?, settled_at = ?, outcome_json = ?, updated_at = ?
         WHERE id = ? AND state = 'effect_started' AND worker_id = ?`,
      ).run(state, now, outcomeJson, now, attempt.id, input.workerId);
      const actionUpdate = this.db.query(
        `UPDATE assistant_work_actions SET state = ?, updated_at = ?
         WHERE id = ? AND current_revision = ? AND current_digest = ?
           AND active_attempt_id = ? AND state = 'effect_started'`,
      ).run(state, now, action.id, action.revision, action.digest, attempt.id);
      if (attemptUpdate.changes !== 1 || actionUpdate.changes !== 1) {
        throw new Error(`attempt settlement lost its compare-and-swap: ${attempt.id}`);
      }
      return this.getAttemptTransition(attempt.id);
    });
  }


  private insertFollowupReport(input: FollowupReportInput, now: string): void {
    const existing = this.getFollowupReport(input.id);
    if (existing) {
      if (
        existing.code !== input.code
        || existing.workId !== input.workId
        || existing.actionId !== input.actionId
        || existing.attemptId !== input.attemptId
        || existing.dispatchId !== input.dispatchId
        || canonicalJson(existing.detail) !== canonicalJson(input.detail)
      ) {
        throw new Error(`followup report identity collision: ${input.id}`);
      }
      return;
    }
    this.db.query(
      `INSERT INTO assistant_work_reports (
        id, code, work_id, action_id, attempt_id, dispatch_id, detail_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      input.id,
      input.code,
      input.workId ?? null,
      input.actionId ?? null,
      input.attemptId ?? null,
      input.dispatchId ?? null,
      canonicalJson(input.detail),
      now,
      now,
    );
  }

  private clearFollowupDue(policy: FollowupPolicyRecord, now: string): void {
    this.db.query(
      `UPDATE assistant_work_followup_policies SET next_due_at = NULL, updated_at = ?
       WHERE work_id = ? AND revision = ?`,
    ).run(now, policy.workId, policy.revision);
  }

  private getActiveAttempt(action: ActionRecord): AttemptRecord | undefined {
    return action.activeAttemptId === undefined ? undefined : this.getAttempt(action.activeAttemptId);
  }

  private getAttemptTransition(attemptId: string): AttemptTransitionRecord {
    const attempt = this.getRequiredAttempt(attemptId);
    return { action: this.getRequiredAction(attempt.actionId), attempt };
  }

  private getRequiredWork(id: string): WorkRecord {
    const record = this.getWork(id);
    if (!record) {
      throw new Error(`unknown assistant work: ${id}`);
    }
    return record;
  }

  private getRequiredObservation(id: string): ObservationRecord {
    const record = this.getObservation(id);
    if (!record) {
      throw new Error(`unknown assistant observation: ${id}`);
    }
    return record;
  }

  private getRequiredAction(id: string): ActionRecord {
    const record = this.getAction(id);
    if (!record) {
      throw new Error(`unknown assistant action: ${id}`);
    }
    return record;
  }


  private getRequiredAttempt(id: string): AttemptRecord {
    const record = this.getAttempt(id);
    if (!record) {
      throw new Error(`unknown assistant attempt: ${id}`);
    }
    return record;
  }

  private getRequiredRecontact(id: string): RecontactRecord {
    const row = this.db.query(
      `SELECT id, action_id, action_revision, ordinal, scheduled_at, context_json, created_at
       FROM assistant_work_recontacts WHERE id = ?`,
    ).get(id) as RecontactRow | null;
    if (row === null) {
      throw new Error(`unknown assistant recontact: ${id}`);
    }
    return toRecontactRecord(row);
  }

  private getRequiredFollowupPolicy(workId: string): FollowupPolicyRecord {
    const policy = this.getFollowupPolicy(workId);
    if (!policy) {
      throw new Error(`unknown followup policy: ${workId}`);
    }
    return policy;
  }

  private getRequiredFollowupDispatch(id: string): FollowupDispatchRecord {
    const dispatch = this.getFollowupDispatch(id);
    if (!dispatch) {
      throw new Error(`unknown followup dispatch: ${id}`);
    }
    return dispatch;
  }

  private getRequiredFollowupReport(id: string): FollowupReportRecord {
    const report = this.getFollowupReport(id);
    if (!report) {
      throw new Error(`unknown followup report: ${id}`);
    }
    return report;
  }

  private getRequiredNotification(id: string): NotificationRecord {
    const notification = this.getNotification(id);
    if (!notification) {
      throw new Error(`unknown assistant notification: ${id}`);
    }
    return notification;
  }

  private getRequiredNotificationRoute(
    notificationId: string,
    route: NotificationRoute,
  ): NotificationRouteRecord {
    const routeRecord = this.getNotificationRoute(notificationId, route);
    if (!routeRecord) {
      throw new Error(`unknown assistant notification route: ${notificationId}/${route}`);
    }
    return routeRecord;
  }

  private transaction<T>(_operationName: string, operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }
}

function toWorkRecord(row: WorkRow): WorkRecord {
  return {
    id: row.id,
    stableKey: row.stable_key,
    title: row.title,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toObservationRecord(row: ObservationRow): ObservationRecord {
  return {
    id: row.id,
    workId: row.work_id,
    source: row.source,
    occurrenceKey: row.occurrence_key,
    provenance: provenanceFromRow(row),
    observedAt: row.observed_at,
    evidence: parseJson(row.evidence_json, "observation evidence"),
    createdAt: row.created_at,
  };
}

function toActionRecord(row: ActionRow): ActionRecord {
  const state = row.state;
  if (!isActionState(state)) {
    throw new Error(`unsupported assistant action state ${state}: action ${row.id}, work ${row.work_id}, revision ${row.current_revision}, digest ${row.current_digest}`);
  }
  return {
    id: row.id,
    workId: row.work_id,
    semanticKey: row.semantic_key,
    revision: row.current_revision,
    digest: row.current_digest,
    state,
    effectClass: row.effect_class,
    ...(row.recipient === null ? {} : { recipient: row.recipient }),
    ...(row.topic === null ? {} : { topic: row.topic }),
    action: row.action_key,
    payload: parseJson(row.payload_json, "action payload"),
    ...(row.scope_json === null ? {} : { scope: parseJson(row.scope_json, "action scope") }),
    ...(row.cost_json === null ? {} : { cost: parseJson(row.cost_json, "action cost") }),
    ...(row.deadline_at === null ? {} : { deadlineAt: row.deadline_at }),
    ...(row.blocked_evidence_json === null
      ? {}
      : { blockedEvidence: parseJson(row.blocked_evidence_json, "action blocked evidence") }),
    ...(row.active_attempt_id === null ? {} : { activeAttemptId: row.active_attempt_id }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
    ...(row.cancel_reason === null ? {} : { cancelReason: row.cancel_reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


function toAttemptRecord(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    actionId: row.action_id,
    actionRevision: row.action_revision,
    actionDigest: row.action_digest,
    sequence: row.sequence,
    state: row.state,
    workerId: row.worker_id,
    claimedAt: row.claimed_at,
    ...(row.effect_started_at === null ? {} : { effectStartedAt: row.effect_started_at }),
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
    ...(row.outcome_json === null ? {} : { outcome: parseJson(row.outcome_json, "attempt outcome") }),
    ...(row.recovered_at === null ? {} : { recoveredAt: row.recovered_at }),
    recoveryCount: row.recovery_count,
    updatedAt: row.updated_at,
  };
}

function toRecontactRecord(row: RecontactRow): RecontactRecord {
  return {
    id: row.id,
    actionId: row.action_id,
    actionRevision: row.action_revision,
    ordinal: row.ordinal,
    scheduledAt: row.scheduled_at,
    ...(row.context_json === null ? {} : { context: parseJson(row.context_json, "recontact context") }),
    createdAt: row.created_at,
  };
}

function toFollowupPolicyRecord(row: FollowupPolicyRow): FollowupPolicyRecord {
  return {
    workId: row.work_id,
    actionId: row.action_id,
    actionRevision: row.action_revision,
    actionDigest: row.action_digest,
    revision: row.revision,
    enabled: row.enabled === 1,
    intervalMs: row.interval_ms,
    maxAttempts: row.max_attempts,
    ...(row.next_due_at === null ? {} : { nextDueAt: row.next_due_at }),
    nextOrdinal: row.next_ordinal,
    provenance: provenanceFromRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFollowupDispatchRecord(row: FollowupDispatchRow): FollowupDispatchRecord {
  return {
    id: row.id,
    workId: row.work_id,
    policyRevision: row.policy_revision,
    ordinal: row.ordinal,
    originalActionId: row.original_action_id,
    actionId: row.action_id,
    state: row.state,
    dueAt: row.due_at,
    ...(row.worker_id === null ? {} : { workerId: row.worker_id }),
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.outcome_json === null ? {} : { outcome: parseJson(row.outcome_json, "followup outcome") }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFollowupReportRecord(row: FollowupReportRow): FollowupReportRecord {
  return {
    id: row.id,
    code: row.code,
    ...(row.work_id === null ? {} : { workId: row.work_id }),
    ...(row.action_id === null ? {} : { actionId: row.action_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    ...(row.dispatch_id === null ? {} : { dispatchId: row.dispatch_id }),
    detail: parseJson(row.detail_json, "followup report detail"),
    state: row.state,
    createdAt: row.created_at,
    ...(row.admitted_at === null ? {} : { admittedAt: row.admitted_at }),
    updatedAt: row.updated_at,
  };
}

function toNotificationRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    body: row.body,
    ...(row.work_id === null ? {} : { workId: row.work_id }),
    ...(row.action_id === null ? {} : { actionId: row.action_id }),
    ...(row.rendered_at === null ? {} : { renderedAt: row.rendered_at }),
    ...(row.owner_ack_at === null ? {} : { ownerAckAt: row.owner_ack_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toNotificationRouteRecord(row: NotificationRouteRow): NotificationRouteRecord {
  return {
    notificationId: row.notification_id,
    route: row.route,
    state: row.state,
    ...(row.worker_id === null ? {} : { workerId: row.worker_id }),
    reservedAt: row.reserved_at,
    ...(row.dispatching_at === null ? {} : { dispatchingAt: row.dispatching_at }),
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
    ...(row.external_id === null ? {} : { externalId: row.external_id }),
    ...(row.detail_json === null ? {} : { detail: parseJson(row.detail_json, "notification route detail") }),
    updatedAt: row.updated_at,
  };
}

function provenanceFromRow(row: {
  readonly provenance_principal: EvidenceProvenance["principal"];
  readonly provenance_channel: string;
  readonly provenance_subject: string;
  readonly provenance_evidence_id: string;
}): EvidenceProvenance {
  return {
    principal: row.provenance_principal,
    channel: row.provenance_channel,
    subject: row.provenance_subject,
    evidenceId: row.provenance_evidence_id,
  };
}

function followupOutcomeToJson(outcome: FollowupDispatchOutcome): JsonValue {
  return { kind: outcome.kind, detail: outcome.detail };
}

function initialActionState(effectClass: EffectClass): ActionState {
  return effectClass === "uncovered" ? "blocked" : "planned";
}

function canReviseAction(state: ActionState): boolean {
  return state === "planned"
    || state === "definitive_failed"
    || state === "blocked";
}

function canCancelAction(state: ActionState): boolean {
  return state === "planned"
    || state === "claimed_pre_effect"
    || state === "blocked";
}


function rejectionForAction(state: ActionState): ClaimRejectionReason | undefined {
  switch (state) {
    case "planned":
      return undefined;
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "claimed_pre_effect":
      return "already_claimed";
    case "effect_started":
      return "effect_started";
    case "ambiguous":
      return "ambiguous";
    case "confirmed":
      return "confirmed";
    case "definitive_failed":
      return "terminal";
  }
}

function rejectionForAttempt(state: AttemptState): ClaimRejectionReason {
  switch (state) {
    case "claimed_pre_effect":
      return "already_claimed";
    case "effect_started":
      return "effect_started";
    case "ambiguous":
      return "ambiguous";
    case "confirmed":
      return "confirmed";
    case "definitive_failed":
    case "cancelled":
      return "terminal";
  }
}

function rejectedClaim(
  reason: ClaimRejectionReason,
  action?: ActionRecord,
  attempt?: AttemptRecord,
): ClaimForDispatchResult {
  return {
    kind: "rejected",
    reason,
    ...(action === undefined ? {} : { action }),
    ...(attempt === undefined ? {} : { attempt }),
  };
}

function assertFollowupPolicyInput(input: SetFollowupPolicyInput): void {
  assertNonEmpty(input.workId, "followup policy workId");
  assertNonEmpty(input.actionId, "followup policy actionId");
  if (typeof input.enabled !== "boolean") {
    throw new Error("followup policy enabled must be boolean");
  }
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs <= 0) {
    throw new Error("followup policy intervalMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 0) {
    throw new Error("followup policy maxAttempts must be a non-negative safe integer");
  }
  assertOwnerProvenance(input.provenance);
}

function assertFollowupReportInput(input: FollowupReportInput): void {
  assertNonEmpty(input.id, "followup report id");
  assertNonEmpty(input.code, "followup report code");
  if (input.workId !== undefined) {
    assertNonEmpty(input.workId, "followup report workId");
  }
  if (input.actionId !== undefined) {
    assertNonEmpty(input.actionId, "followup report actionId");
  }
  if (input.attemptId !== undefined) {
    assertNonEmpty(input.attemptId, "followup report attemptId");
  }
  if (input.dispatchId !== undefined) {
    assertNonEmpty(input.dispatchId, "followup report dispatchId");
  }
  canonicalJson(input.detail);
}

function assertCompleteFollowupInput(input: CompleteFollowupInput): void {
  assertNonEmpty(input.dispatchId, "followup completion dispatchId");
  assertNonEmpty(input.workerId, "followup completion workerId");
  if (
    input.outcome.kind !== "confirmed"
    && input.outcome.kind !== "definitive_failed"
    && input.outcome.kind !== "ambiguous"
    && input.outcome.kind !== "rejected"
  ) {
    throw new Error("followup completion outcome kind is invalid");
  }
  canonicalJson(input.outcome.detail);
}

function assertNotificationInput(input: AdmitNotificationInput): void {
  assertNonEmpty(input.id, "notification id");
  assertNonEmpty(input.body, "notification body");
  if (input.workId !== undefined) {
    assertNonEmpty(input.workId, "notification workId");
  }
  if (input.actionId !== undefined) {
    assertNonEmpty(input.actionId, "notification actionId");
  }
}

function assertNotificationReplay(record: NotificationRecord, input: AdmitNotificationInput): void {
  if (
    record.body !== input.body
    || record.workId !== input.workId
    || record.actionId !== input.actionId
  ) {
    throw new Error(`notification identity collision: ${input.id}`);
  }
}

function assertNotificationRoute(route: NotificationRoute): void {
  if (route !== "chat" && route !== "imessage") {
    throw new Error("notification route is invalid");
  }
}

function assertNotificationSettlementInput(input: SettleNotificationRouteInput): void {
  assertNonEmpty(input.notificationId, "notification settlement notificationId");
  assertNotificationRoute(input.route);
  assertNonEmpty(input.workerId, "notification settlement workerId");
  if (input.externalId !== undefined) {
    assertNonEmpty(input.externalId, "notification settlement externalId");
  }
  if (input.detail !== undefined) {
    canonicalJson(input.detail);
  }
}

function assertObservationInput(input: AdmitObservationInput): void {
  assertNonEmpty(input.source, "observation source");
  assertNonEmpty(input.occurrenceKey, "observation occurrenceKey");
  assertNonEmpty(input.workKey, "observation workKey");
  assertNonEmpty(input.workTitle, "observation workTitle");
  assertProvenance(input.provenance);
  assertTimestamp(input.observedAt, "observation observedAt");
  canonicalJson(input.evidence);
}

function assertObservationReplay(
  record: ObservationRecord,
  observationId: string,
  workId: string,
  input: AdmitObservationInput,
): void {
  const exact = record.id === observationId
    && record.workId === workId
    && record.source === input.source
    && record.occurrenceKey === input.occurrenceKey;
  if (!exact) {
    throw new Error(`observation occurrence identity collision: ${input.source}/${input.occurrenceKey}`);
  }
}

function assertActionProposal(input: ProposeActionInput): void {
  assertNonEmpty(input.workId, "action workId");
  assertNonEmpty(input.semanticKey, "action semanticKey");
  assertNonEmpty(input.action, "action key");
  assertEffectClass(input.effectClass);
  if (input.recipient !== undefined) {
    assertNonEmpty(input.recipient, "action recipient");
  }
  if (input.topic !== undefined) {
    assertNonEmpty(input.topic, "action topic");
  }
  if (input.effectClass === "external_message") {
    assertNonEmpty(input.recipient ?? "", "external message recipient");
    assertNonEmpty(input.topic ?? "", "external message topic");
  }
  if (input.effectClass === "uncovered" && input.blockedEvidence === undefined) {
    throw new Error("uncovered action requires blockedEvidence");
  }
  if (input.effectClass !== "uncovered" && input.blockedEvidence !== undefined) {
    throw new Error("blockedEvidence is only valid for an uncovered action");
  }
  if (input.deadlineAt !== undefined) {
    assertTimestamp(input.deadlineAt, "action deadlineAt");
  }
  canonicalJson(input.payload);
  if (input.scope !== undefined) {
    canonicalJson(input.scope);
  }
  if (input.cost !== undefined) {
    canonicalJson(input.cost);
  }
  if (input.blockedEvidence !== undefined) {
    canonicalJson(input.blockedEvidence);
  }
}


function assertClaimInput(input: ClaimForDispatchInput): void {
  assertNonEmpty(input.actionId, "claim actionId");
  assertPositiveInteger(input.revision, "claim action revision");
  assertDigest(input.digest, "claim action digest");
  assertNonEmpty(input.attemptId, "claim attemptId");
  assertNonEmpty(input.workerId, "claim workerId");
}

function assertAttemptTransitionInput(input: AttemptTransitionInput): void {
  assertNonEmpty(input.attemptId, "attempt id");
  assertNonEmpty(input.workerId, "attempt workerId");
}

function assertAttemptReplay(attempt: AttemptRecord, input: ClaimForDispatchInput): void {
  if (
    attempt.actionId !== input.actionId
    || attempt.actionRevision !== input.revision
    || attempt.actionDigest !== input.digest
    || attempt.workerId !== input.workerId
  ) {
    throw new Error(`attempt identity collision: ${attempt.id}`);
  }
}

function assertAttemptWorker(attempt: AttemptRecord, workerId: string): void {
  if (attempt.workerId !== workerId) {
    throw new Error(`attempt is owned by another worker: ${attempt.id}`);
  }
}

function assertAttemptOwnsCurrentAction(
  attempt: AttemptRecord,
  action: ActionRecord,
  state: Extract<ActionState, "claimed_pre_effect" | "effect_started">,
): void {
  if (
    action.revision !== attempt.actionRevision
    || action.digest !== attempt.actionDigest
    || action.activeAttemptId !== attempt.id
    || action.state !== state
  ) {
    throw new Error(`attempt no longer owns the current action revision: ${attempt.id}`);
  }
}

function assertCurrentAction(action: ActionRecord, revision: number, digest: string): void {
  if (action.revision !== revision) {
    throw new Error(`stale action revision: expected ${revision}, current ${action.revision}`);
  }
  if (action.digest !== digest) {
    throw new Error(`stale action digest for revision ${revision}: ${action.id}`);
  }
}

function assertOwnerProvenance(provenance: EvidenceProvenance): void {
  assertProvenance(provenance);
  if (provenance.principal !== "owner") {
    throw new Error(`${provenance.principal} evidence cannot configure owner followups`);
  }
}

function assertProvenance(provenance: EvidenceProvenance): void {
  if (
    provenance.principal !== "owner"
    && provenance.principal !== "third_party"
    && provenance.principal !== "system"
  ) {
    throw new Error("evidence principal is invalid");
  }
  assertNonEmpty(provenance.channel, "evidence channel");
  assertNonEmpty(provenance.subject, "evidence subject");
  assertNonEmpty(provenance.evidenceId, "evidence evidenceId");
}

function sameProvenance(left: EvidenceProvenance, right: EvidenceProvenance): boolean {
  return left.principal === right.principal
    && left.channel === right.channel
    && left.subject === right.subject
    && left.evidenceId === right.evidenceId;
}

function assertEffectClass(value: EffectClass): void {
  switch (value) {
    case "ordinary_local_edit":
    case "ordinary_local_install":
    case "delete_existing":
    case "bulk_existing_user_assets":
    case "core_setting_change":
    case "account_rights_change":
    case "cost_increase":
    case "external_message":
    case "external_mutation":
    case "uncovered":
      return;
    default:
      throw new Error("action effectClass is invalid");
  }
}

function assertWorkState(value: WorkState): void {
  if (value !== "open" && value !== "completed" && value !== "cancelled") {
    throw new Error("assistant work state is invalid");
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
}

function addMilliseconds(timestamp: string, milliseconds: number, label: string): string {
  const value = Date.parse(timestamp) + milliseconds;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is outside the safe timestamp range`);
  }
  return new Date(value).toISOString();
}

function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
}

function parseJson(value: string, label: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
  if (!isJsonValue(parsed)) {
    throw new Error(`${label} is not a JSON value`);
  }
  return parsed;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  return Object.values(value as Readonly<Record<string, unknown>>).every(isJsonValue);
}

function nullableJson(value: JsonValue | undefined): string | null {
  return value === undefined ? null : canonicalJson(value);
}
