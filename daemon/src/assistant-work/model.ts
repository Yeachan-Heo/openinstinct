import { createHash } from "node:crypto";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type WorkState = "open" | "completed" | "cancelled";
export interface WorkRecord { readonly id: string; readonly stableKey: string; readonly title: string; readonly state: WorkState; readonly createdAt: string; readonly updatedAt: string }

export type EvidencePrincipal = "owner" | "third_party" | "system";
/** Durable provenance only; ingress must authenticate an actor before using principal=owner. */
export interface EvidenceProvenance { readonly principal: EvidencePrincipal; readonly channel: string; readonly subject: string; readonly evidenceId: string }

export interface AdmitObservationInput { readonly source: string; readonly occurrenceKey: string; readonly workKey: string; readonly workTitle: string; readonly provenance: EvidenceProvenance; readonly observedAt: string; readonly evidence: JsonValue }
export interface ObservationRecord { readonly id: string; readonly workId: string; readonly source: string; readonly occurrenceKey: string; readonly provenance: EvidenceProvenance; readonly observedAt: string; readonly evidence: JsonValue; readonly createdAt: string }
export interface ObservationAdmission { readonly created: boolean; readonly work: WorkRecord; readonly observation: ObservationRecord }

export const EFFECT_CLASSES = [
  "ordinary_local_edit", "ordinary_local_install", "delete_existing", "bulk_existing_user_assets",
  "core_setting_change", "account_rights_change", "cost_increase", "external_message",
  "external_mutation", "uncovered",
] as const;
export type EffectClass = typeof EFFECT_CLASSES[number];

export interface ActionMaterial {
  readonly effectClass: EffectClass;
  /** Caller-canonical recipient key included in the material digest. */
  readonly recipient?: string;
  /** Caller-canonical topic key included in the material digest. */
  readonly topic?: string;
  /** Caller-canonical action key included in the material digest. */
  readonly action: string;
  readonly payload: JsonValue;
  readonly scope?: JsonValue;
  readonly cost?: JsonValue;
  /** No default expiry is added; this applies only when the action defines one. */
  readonly deadlineAt?: string;
  readonly blockedEvidence?: JsonValue;
}
export interface ProposeActionInput extends ActionMaterial {
  readonly workId: string;
  /** Stable semantic-effect key within the work. */
  readonly semanticKey: string;
}
export const ACTION_STATES = ["planned", "claimed_pre_effect", "effect_started", "confirmed", "definitive_failed", "ambiguous", "cancelled", "expired", "blocked"] as const;
export type ActionState = typeof ACTION_STATES[number];
export function isActionState(state: string): state is ActionState {
  return ACTION_STATES.some((candidate) => candidate === state);
}
export interface ActionRecord extends ActionMaterial { readonly id: string; readonly workId: string; readonly semanticKey: string; readonly revision: number; readonly digest: string; readonly state: ActionState; readonly activeAttemptId?: string; readonly cancelledAt?: string; readonly cancelReason?: string; readonly createdAt: string; readonly updatedAt: string }
export interface UnsupportedActionStateDiagnostic {
  readonly kind: "unsupported_action_state";
  readonly actionId: string;
  readonly workId: string;
  readonly state: string;
  readonly revision: number;
  readonly digest: string;
}
export interface ActionListResult {
  readonly actions: ActionRecord[];
  readonly unsupported: UnsupportedActionStateDiagnostic[];
}

export type AttemptState = "claimed_pre_effect" | "effect_started" | "confirmed" | "definitive_failed" | "ambiguous" | "cancelled";
export interface AttemptRecord { readonly id: string; readonly actionId: string; readonly actionRevision: number; readonly actionDigest: string; readonly sequence: number; readonly state: AttemptState; readonly workerId: string; readonly claimedAt: string; readonly effectStartedAt?: string; readonly settledAt?: string; readonly outcome?: JsonValue; readonly recoveredAt?: string; readonly recoveryCount: number; readonly updatedAt: string }
export interface ClaimForDispatchInput {
  readonly actionId: string;
  readonly revision: number;
  readonly digest: string;
  /** Caller-stable for this dispatch claim; replaying admission reuses it. */
  readonly attemptId: string;
  readonly workerId: string;
}
export type ClaimRejectionReason = "unknown_action" | "stale_revision" | "stale_digest" | "blocked" | "cancelled" | "expired" | "already_claimed" | "effect_started" | "ambiguous" | "confirmed" | "terminal";
export type ClaimForDispatchResult = { readonly kind: "claimed"; readonly resumed: boolean; readonly action: ActionRecord; readonly attempt: AttemptRecord } | { readonly kind: "rejected"; readonly reason: ClaimRejectionReason; readonly action?: ActionRecord; readonly attempt?: AttemptRecord };
export interface AttemptTransitionInput { readonly attemptId: string; readonly workerId: string }
export interface SettleAttemptInput extends AttemptTransitionInput { readonly outcome: JsonValue }
export interface AttemptTransitionRecord { readonly action: ActionRecord; readonly attempt: AttemptRecord }
export type AttemptRecoveryResult = ({ readonly kind: "resume_pre_effect" } & AttemptTransitionRecord) | ({ readonly kind: "reconcile_only" } & AttemptTransitionRecord) | ({ readonly kind: "confirmed_no_replay" } & AttemptTransitionRecord) | ({ readonly kind: "terminal_no_replay" } & AttemptTransitionRecord);

export interface AdmitRecontactInput { readonly actionId: string; readonly actionRevision: number; readonly ordinal: number; readonly scheduledAt: string; readonly context?: JsonValue }
export interface RecontactRecord { readonly id: string; readonly actionId: string; readonly actionRevision: number; readonly ordinal: number; readonly scheduledAt: string; readonly context?: JsonValue; readonly createdAt: string }

export interface SetFollowupPolicyInput {
  readonly workId: string;
  readonly actionId: string;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly maxAttempts: number;
  readonly provenance: EvidenceProvenance;
}

export interface FollowupPolicyRecord {
  readonly workId: string;
  readonly actionId: string;
  readonly actionRevision: number;
  readonly actionDigest: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly maxAttempts: number;
  readonly nextDueAt?: string;
  readonly nextOrdinal: number;
  readonly provenance: EvidenceProvenance;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FollowupDispatchRecord {
  readonly id: string;
  readonly workId: string;
  readonly policyRevision: number;
  readonly ordinal: number;
  readonly originalActionId: string;
  readonly actionId: string;
  readonly state: "due" | "claimed" | "completed" | "skipped";
  readonly dueAt: string;
  readonly workerId?: string;
  readonly claimedAt?: string;
  readonly completedAt?: string;
  readonly outcome?: JsonValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type FollowupDispatchOutcomeKind =
  | "confirmed"
  | "definitive_failed"
  | "ambiguous"
  | "rejected";

export interface FollowupDispatchOutcome {
  readonly kind: FollowupDispatchOutcomeKind;
  readonly detail: JsonValue;
}

export interface ClaimedFollowup {
  readonly policy: FollowupPolicyRecord;
  readonly dispatch: FollowupDispatchRecord;
  readonly originalAction: ActionRecord;
  readonly action: ActionRecord;
}

export type ClaimDueFollowupResult =
  | ({ readonly kind: "claimed" } & ClaimedFollowup)
  | {
      readonly kind: "none";
      readonly reason:
        | "missing_policy"
        | "disabled"
        | "not_due"
        | "cap_reached"
        | "policy_changed"
        | "expired"
        | "source_unconfirmed"
        | "active_effect"
        | "ambiguous"
        | "confirmed_no_replay"
        | "definitive_failed"
        | "work_terminal";
      readonly policy?: FollowupPolicyRecord;
      readonly dispatch?: FollowupDispatchRecord;
      readonly action?: ActionRecord;
    };

export interface CompleteFollowupInput {
  readonly dispatchId: string;
  readonly workerId: string;
  readonly outcome: FollowupDispatchOutcome;
}

export interface FollowupCompletion {
  readonly policy: FollowupPolicyRecord;
  readonly dispatch: FollowupDispatchRecord;
}

export function stableFollowupDispatchId(workId: string, policyRevision: number, ordinal: number): string {
  return stableId("followup", workId, String(policyRevision), String(ordinal));
}

export function followupSemanticKey(originalActionId: string, policyRevision: number, ordinal: number): string {
  return `followup:${originalActionId}:${policyRevision}:${ordinal}`;
}

export type NotificationRoute = "chat" | "imessage";
export type NotificationRouteState =
  | "reserved"
  | "dispatching"
  | "delivered"
  | "uncertain"
  | "failed_definitive";

export interface AdmitNotificationInput {
  /** Stable logical-notice identity; callers may derive it with stableNotificationId. */
  readonly id: string;
  readonly body: string;
  readonly workId?: string;
  readonly actionId?: string;
}

export interface NotificationRecord {
  readonly id: string;
  readonly body: string;
  readonly workId?: string;
  readonly actionId?: string;
  readonly renderedAt?: string;
  readonly ownerAckAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NotificationRouteRecord {
  readonly notificationId: string;
  readonly route: NotificationRoute;
  readonly state: NotificationRouteState;
  readonly workerId?: string;
  readonly reservedAt: string;
  readonly dispatchingAt?: string;
  readonly settledAt?: string;
  readonly externalId?: string;
  readonly detail?: JsonValue;
  readonly updatedAt: string;
}

export interface NotificationWithRoutes {
  readonly notification: NotificationRecord;
  readonly routes: readonly NotificationRouteRecord[];
}

export function stableNotificationId(source: string, occurrenceKey: string): string {
  return stableId("notification", source, occurrenceKey);
}

export type ReserveNotificationRouteResult =
  | {
      readonly kind: "reserved";
      readonly created: boolean;
      readonly notification: NotificationRecord;
      readonly route: NotificationRouteRecord;
    }
  | {
      readonly kind: "rejected";
      readonly reason: "unknown_notification" | "acknowledged";
      readonly notification?: NotificationRecord;
      readonly route?: NotificationRouteRecord;
    };

export type ClaimNotificationRouteResult =
  | {
      readonly kind: "claimed";
      readonly notification: NotificationRecord;
      readonly route: NotificationRouteRecord;
    }
  | {
      readonly kind: "rejected";
      readonly reason: "unknown_notification" | "unreserved" | "acknowledged" | "already_claimed" | "superseded" | "terminal";
      readonly notification?: NotificationRecord;
      readonly route?: NotificationRouteRecord;
    };

export interface SettleNotificationRouteInput {
  readonly notificationId: string;
  readonly route: NotificationRoute;
  readonly workerId: string;
  readonly externalId?: string;
  readonly detail?: JsonValue;
}

export interface NotificationRouteTransition {
  readonly notification: NotificationRecord;
  readonly route: NotificationRouteRecord;
}

export type NotificationRecoveryResult =
  | ({ readonly kind: "claimable" } & NotificationRouteTransition)
  | ({ readonly kind: "reconcile_only" } & NotificationRouteTransition)
  | ({ readonly kind: "terminal" } & NotificationRouteTransition);

export function stableObservationId(source: string, occurrenceKey: string): string { return stableId("observation", source, occurrenceKey) }
export function stableWorkId(workKey: string): string { return stableId("work", workKey) }
export function stableActionId(workId: string, semanticKey: string): string { return stableId("action", workId, semanticKey) }
export function stableRecontactId(actionId: string, revision: number, ordinal: number): string { return stableId("recontact", actionId, String(revision), String(ordinal)) }
export function stableAttemptId(actionId: string, revision: number, dispatchKey: string): string { return stableId("attempt", actionId, String(revision), dispatchKey) }

export function actionMaterialDigest(material: ActionMaterial): string {
  return sha256(canonicalJson({ effectClass: material.effectClass, recipient: material.recipient ?? null, topic: material.topic ?? null, action: material.action, payload: material.payload, scope: material.scope ?? null, cost: material.cost ?? null, deadlineAt: material.deadlineAt ?? null, blockedEvidence: material.blockedEvidence ?? null }));
}
export function canonicalJson(value: JsonValue): string { return JSON.stringify(canonicalize(value)) }
function stableId(kind: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("openinstinct-assistant-work\0"); hash.update(kind);
  for (const part of parts) { hash.update("\0"); hash.update(String(Buffer.byteLength(part, "utf8"))); hash.update(":"); hash.update(part) }
  return `aw:${kind}:${hash.digest("hex")}`;
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex") }
function canonicalize(value: JsonValue): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite"); return Object.is(value, -0) ? 0 : value }
  if (Array.isArray(value)) return value.map(canonicalize);
  const result: Record<string, JsonValue> = {};
  const object = value as { readonly [key: string]: JsonValue };
  for (const key of Object.keys(object).sort()) result[key] = canonicalize(object[key]!);
  return result;
}
