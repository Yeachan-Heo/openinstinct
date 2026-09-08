import { createHash } from "node:crypto";

import type { CustomTool } from "@gajae-code/coding-agent";
import { Type } from "@gajae-code/coding-agent/extensibility/typebox";

import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import type { MonitorStore } from "../monitors/store.ts";
import { createServiceMonitorTool } from "./monitoring.ts";
import { assessObservation, type ObservationAssessment } from "./observation.ts";
import { createResponseCompletionTool } from "./response.ts";
import { executeManagedLocalFileAction } from "./execution.ts";
import {
  preflightLocalFileAction,
  type LocalFileOperation,
} from "./local-effects.ts";
import {
  stableAttemptId,
  type ActionRecord,
  type ActionState,
  type AttemptRecord,
  type EvidencePrincipal,
  type WorkRecord,
} from "./model.ts";

const DEFAULT_WORKER_ID = "main-session:managed-local-files";
const STATUS_LIMIT = 50;

export interface AssistantWorkToolOptions {
  readonly repository: AssistantWorkRepository;
  readonly workerId?: string;
  readonly now?: () => Date;
  readonly monitors?: MonitorStore;
  readonly onMonitorsChanged?: () => void | Promise<void>;
  readonly observationChannel?: string;
}

interface ObservationParams {
  readonly source: string;
  readonly occurrenceKey: string;
  readonly workKey: string;
  readonly workTitle: string;
  readonly evidencePrincipal: Extract<EvidencePrincipal, "third_party" | "system">;
  readonly evidenceSubject: string;
  readonly evidenceSummary: string;
  readonly evidenceReference?: string;
  readonly observedAt?: string;
  readonly involved?: boolean;
  readonly important?: boolean;
  readonly ongoing?: boolean;
  readonly confidence?: ObservationAssessment["confidence"];
  readonly unfinishedEvidence?: readonly string[];
}

interface LocalActionParams {
  readonly operation: "propose" | "execute";
  readonly workId?: string;
  readonly semanticKey?: string;
  readonly fileOperations?: readonly LocalFileOperation[];
  readonly actionId?: string;
  readonly revision?: number;
  readonly digest?: string;
}

interface StatusParams {
  readonly workId?: string;
  readonly actionId?: string;
  readonly state?: ActionState;
}

export function createAssistantWorkTools(options: AssistantWorkToolOptions): readonly CustomTool[] {
  return [
    createAssistantWorkObservationTool(options),
    createResponseCompletionTool(options.repository),
    createAssistantLocalFileTool(options),
    createAssistantWorkStatusTool(options),
    ...createAssistantMonitoringTools(options),
  ];
}

export function createAssistantMonitoringTools(options: AssistantWorkToolOptions): readonly CustomTool[] {
  return options.monitors === undefined
    ? []
    : [createServiceMonitorTool({ monitors: options.monitors, onChanged: options.onMonitorsChanged })];
}

/** Child-safe repository tools: evidence admission plus read-only service monitoring. */
export function createAssistantObservationTools(options: AssistantWorkToolOptions): readonly CustomTool[] {
  return [
    createAssistantWorkObservationTool(options),
    createResponseCompletionTool(options.repository),
    ...createAssistantMonitoringTools(options),
  ];
}

/** Records evidence plus a host assessment; it never schedules or authorizes by itself. */
export function createAssistantWorkObservationTool(options: AssistantWorkToolOptions): CustomTool {
  const now = options.now ?? (() => new Date());
  const observationChannel = requiredTrimmed(options.observationChannel ?? "main_session_tool", "observationChannel");
  return {
    name: "assistant_work_observe",
    label: "Record Assistant Work",
    strict: true,
    concurrency: "shared",
    description: "Durably record one stable observation, its work item, and a host-evaluated involvement/importance/unfinished/confidence assessment. Uncertain input is proposal-only. This tool records only system or third-party provenance and never schedules, grants approval, or authorizes an effect.",
    parameters: Type.Object({
      source: Type.String({ minLength: 1, maxLength: 240 }),
      occurrenceKey: Type.String({ minLength: 1, maxLength: 512 }),
      workKey: Type.String({ minLength: 1, maxLength: 512 }),
      workTitle: Type.String({ minLength: 1, maxLength: 240 }),
      evidencePrincipal: Type.Enum(["third_party", "system"]),
      evidenceSubject: Type.String({ minLength: 1, maxLength: 512 }),
      evidenceSummary: Type.String({ minLength: 1, maxLength: 12_000 }),
      evidenceReference: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
      observedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      involved: Type.Boolean(),
      important: Type.Boolean(),
      ongoing: Type.Boolean(),
      confidence: Type.Enum(["clear", "uncertain"]),
      unfinishedEvidence: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 64 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const input = params as ObservationParams;
      const source = requiredTrimmed(input.source, "source");
      const occurrenceKey = requiredTrimmed(input.occurrenceKey, "occurrenceKey");
      const workKey = requiredTrimmed(input.workKey, "workKey");
      const workTitle = requiredTrimmed(input.workTitle, "workTitle");
      const subject = requiredTrimmed(input.evidenceSubject, "evidenceSubject");
      const summary = requiredTrimmed(input.evidenceSummary, "evidenceSummary");
      const principal = nonOwnerPrincipal(input.evidencePrincipal);
      const observedAt = input.observedAt === undefined ? now().toISOString() : validTimestamp(input.observedAt);
      const evidenceReference = input.evidenceReference === undefined
        ? undefined
        : requiredTrimmed(input.evidenceReference, "evidenceReference");
      const assessment = observationAssessment(input);
      const decision = assessObservation(assessment);
      if (decision.disposition !== "track" && decision.disposition !== "propose") {
        return {
          content: [{
            type: "text" as const,
            text: `Ignored observation ${source}/${occurrenceKey}: involvement or unfinished evidence was insufficient. No work, monitor, action, or approval was created.`,
          }],
          details: { created: false, decision },
        };
      }
      const admitted = options.repository.admitObservation({
        source,
        occurrenceKey,
        workKey,
        workTitle,
        provenance: {
          principal,
          channel: observationChannel,
          subject,
          evidenceId: observationEvidenceId(source, occurrenceKey),
        },
        observedAt,
        evidence: {
          summary,
          ...(evidenceReference === undefined ? {} : { reference: evidenceReference }),
          assessment: {
            involved: assessment.involved,
            important: assessment.important,
            ongoing: assessment.ongoing,
            confidence: assessment.confidence,
            unfinishedEvidence: [...assessment.unfinishedEvidence],
          },
          decision: { disposition: decision.disposition, intervalMs: decision.intervalMs },
        },
      }, now().toISOString());
      const status = admitted.created ? "Recorded" : "Already recorded";
      const dispositionText = decision.disposition === "propose"
        ? "The host assessment marked it as an uncertain proposal only; do not schedule or execute it automatically."
        : `The host assessment marked it trackable at ${decision.intervalMs === 300_000 ? "5-minute" : "30-minute"} cadence.`;
      return {
        content: [{
          type: "text" as const,
          text: `${status} observation ${admitted.observation.id} for work ${admitted.work.id}. ${dispositionText} This evidence does not authorize any action.`,
        }],
        details: {
          created: admitted.created,
          decision,
          observation: observationSummary(admitted.observation),
          work: workSummary(admitted.work),
        },
      };
    },
  };
}

/** Proposes or executes only the typed, host-preflighted regular-file slice. */
export function createAssistantLocalFileTool(options: AssistantWorkToolOptions): CustomTool {
  const now = options.now ?? (() => new Date());
  const workerId = requiredTrimmed(options.workerId ?? DEFAULT_WORKER_ID, "workerId");
  return {
    name: "assistant_local_file",
    label: "Managed Local File Action",
    strict: true,
    concurrency: "exclusive",
    description: "Propose or execute managed local regular-file writes and explicit deletes. Host preflight computes the effect class. Approval-required proposals do not execute; owner approval is available only through the authenticated /approve command, never through this tool.",
    parameters: Type.Object({
      operation: Type.Enum(["propose", "execute"]),
      workId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      semanticKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      fileOperations: Type.Optional(Type.Array(Type.Union([
        Type.Object({
          operation: Type.Literal("write_file"),
          path: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
          content: Type.String({ maxLength: 1_000_000 }),
        }, { additionalProperties: false }),
        Type.Object({
          operation: Type.Literal("delete_file"),
          path: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
        }, { additionalProperties: false }),
      ]), { minItems: 1, maxItems: 1_024 })),
      actionId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
      digest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    }, { additionalProperties: false }),
    async execute(toolCallId, params) {
      const input = params as LocalActionParams;
      if (input.operation === "propose") {
        const workId = requiredTrimmed(input.workId, "workId");
        const semanticKey = requiredTrimmed(input.semanticKey, "semanticKey");
        if (!Array.isArray(input.fileOperations) || input.fileOperations.length === 0) {
          throw new Error("fileOperations are required when proposing a local action");
        }
        rejectExecuteFieldsOnProposal(input);
        const preflight = await preflightLocalFileAction({
          workId,
          semanticKey,
          operations: input.fileOperations,
        });
        const action = options.repository.proposeAction(preflight.proposal, now().toISOString());
        return {
          content: [{ type: "text" as const, text: proposalText(action) }],
          details: {
            operation: "propose" as const,
            action: actionSummary(action),
            inventory: preflight.inventory,
            effectInvoked: false,
          },
        };
      }

      rejectProposalFieldsOnExecution(input);
      const actionId = requiredTrimmed(input.actionId, "actionId");
      const revision = requiredRevision(input.revision);
      const digest = requiredDigest(input.digest);
      const attemptId = stableAttemptId(actionId, revision, requiredTrimmed(toolCallId, "toolCallId"));
      const result = await executeManagedLocalFileAction({
        repository: options.repository,
        actionId,
        revision,
        digest,
        attemptId,
        workerId,
        now: () => now().toISOString(),
      });
      return {
        content: [{ type: "text" as const, text: executionText(result, actionId, revision, digest) }],
        details: executionDetails(result, attemptId),
      };
    },
  };
}

export function createAssistantWorkStatusTool(options: AssistantWorkToolOptions): CustomTool {
  return {
    name: "assistant_work_status",
    label: "Assistant Work Status",
    strict: true,
    concurrency: "shared",
    description: "List durable assistant work, action revision/digest/state, and attempt status. It is read-only and never approves or dispatches an action.",
    parameters: Type.Object({
      workId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      actionId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      state: Type.Optional(Type.Enum([
        "planned",
        "approval_pending",
        "authorized",
        "claimed_pre_effect",
        "effect_started",
        "confirmed",
        "definitive_failed",
        "ambiguous",
        "cancelled",
        "expired",
        "blocked",
      ])),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const input = params as StatusParams;
      if (input.workId !== undefined && input.actionId !== undefined) {
        throw new Error("assistant_work_status accepts workId or actionId, not both");
      }

      if (input.actionId !== undefined) {
        const actionId = requiredTrimmed(input.actionId, "actionId");
        const action = options.repository.getAction(actionId);
        if (!action) {
          throw new Error(`assistant action not found: ${actionId}`);
        }
        const attempts = options.repository.listAttempts(action.id).map(attemptSummary);
        return {
          content: [{ type: "text" as const, text: `${formatAction(action)}${formatAttempts(attempts)}` }],
          details: { action: actionSummary(action), attempts },
        };
      }

      const workId = input.workId === undefined ? undefined : requiredTrimmed(input.workId, "workId");
      const work = workId === undefined ? undefined : options.repository.getWork(workId);
      if (workId !== undefined && !work) {
        throw new Error(`assistant work not found: ${workId}`);
      }
      const matchingActions = options.repository.listActions(workId)
        .filter((action) => input.state === undefined || action.state === input.state);
      const allWorks = work === undefined ? options.repository.listWorks() : [work];
      const actions = matchingActions.slice(-STATUS_LIMIT);
      const works = allWorks.slice(-STATUS_LIMIT);
      const text = actions.length === 0
        ? works.length === 0
          ? "No assistant work is recorded."
          : `${works.map(formatWork).join("\n")}\nNo matching actions.`
        : `${works.map(formatWork).join("\n")}\n${actions.map(formatAction).join("\n")}`;
      return {
        content: [{ type: "text" as const, text }],
        details: {
          works: works.map(workSummary),
          actions: actions.map(actionSummary),
          truncated: matchingActions.length > actions.length || allWorks.length > works.length,
        },
      };
    },
  };
}

function proposalText(action: ActionRecord): string {
  const identity = `action ${action.id} revision ${action.revision} digest ${action.digest}`;
  if (action.state === "approval_pending") {
    return `Approval required for ${identity}. No effect has run. Send exactly: /approve ${action.id} ${action.revision} ${action.digest}`;
  }
  if (action.state === "authorized") {
    return `Prepared ${identity} under local policy. No effect has run. Execute it with assistant_local_file operation=execute using this exact actionId, revision, and digest.`;
  }
  if (action.state === "blocked") {
    return `Blocked ${identity}. No effect has run; this managed path is not covered.`;
  }
  return `${identity[0]!.toUpperCase()}${identity.slice(1)} already exists in state ${action.state}. This proposal invoked no new effect.`;
}

function executionText(
  result: Awaited<ReturnType<typeof executeManagedLocalFileAction>>,
  actionId: string,
  revision: number,
  digest: string,
): string {
  if (result.kind === "confirmed") {
    return `Confirmed action ${actionId} revision ${revision}. The managed local result was read back and verified.`;
  }
  if (result.kind === "ambiguous") {
    return `Action ${actionId} revision ${revision} is ambiguous after effect_started. Do not retry it; inspect assistant_work_status and reconcile the recorded evidence.`;
  }
  if (result.kind === "definitive_failed") {
    return `Action ${actionId} revision ${revision} failed definitively. It was not completed; inspect assistant_work_status before proposing a new revision.`;
  }
  if (result.kind === "preflight_rejected") {
    const required = result.requiredEffectClass === undefined ? "" : ` Host preflight now requires ${result.requiredEffectClass}.`;
    return `Did not dispatch action ${actionId} revision ${revision}: ${result.message}.${required} Re-propose from current filesystem evidence.`;
  }
  if (result.kind !== "rejected") {
    return `Did not dispatch action ${actionId} revision ${revision}: unexpected executor result. No new effect was invoked.`;
  }
  if (result.reason === "approval_required") {
    return `Approval required for action ${actionId} revision ${revision} digest ${digest}. No effect has run. Send exactly: /approve ${actionId} ${revision} ${digest}`;
  }
  return `Did not dispatch action ${actionId} revision ${revision}: ${result.reason}. No new effect was invoked.`;
}

function executionDetails(
  result: Awaited<ReturnType<typeof executeManagedLocalFileAction>>,
  attemptId: string,
): Record<string, unknown> {
  if (result.kind === "rejected") {
    return {
      operation: "execute",
      kind: result.kind,
      reason: result.reason,
      attemptId,
      ...(result.action === undefined ? {} : { action: actionSummary(result.action) }),
      ...(result.attempt === undefined ? {} : { attempt: attemptSummary(result.attempt) }),
    };
  }
  if (result.kind === "preflight_rejected") {
    return {
      operation: "execute",
      kind: result.kind,
      reason: result.reason,
      message: result.message,
      attemptId,
      action: actionSummary(result.action),
      ...(result.requiredEffectClass === undefined ? {} : { requiredEffectClass: result.requiredEffectClass }),
      ...(result.inventory === undefined ? {} : { inventory: result.inventory }),
    };
  }
  return {
    operation: "execute",
    kind: result.kind,
    attemptId,
    action: actionSummary(result.action),
    attempt: attemptSummary(result.attempt),
    evidence: result.evidence,
  };
}

function actionSummary(action: ActionRecord): Record<string, unknown> {
  return {
    id: action.id,
    workId: action.workId,
    semanticKey: action.semanticKey,
    revision: action.revision,
    digest: action.digest,
    state: action.state,
    effectClass: action.effectClass,
    action: action.action,
    ...(action.deadlineAt === undefined ? {} : { deadlineAt: action.deadlineAt }),
    ...(action.activeAttemptId === undefined ? {} : { activeAttemptId: action.activeAttemptId }),
    ...(action.cancelledAt === undefined ? {} : { cancelledAt: action.cancelledAt }),
    ...(action.cancelReason === undefined ? {} : { cancelReason: action.cancelReason }),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function attemptSummary(attempt: AttemptRecord): Record<string, unknown> {
  return {
    id: attempt.id,
    actionId: attempt.actionId,
    actionRevision: attempt.actionRevision,
    actionDigest: attempt.actionDigest,
    sequence: attempt.sequence,
    state: attempt.state,
    authorizationSource: attempt.authorizationSource,
    claimedAt: attempt.claimedAt,
    ...(attempt.effectStartedAt === undefined ? {} : { effectStartedAt: attempt.effectStartedAt }),
    ...(attempt.settledAt === undefined ? {} : { settledAt: attempt.settledAt }),
    ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome }),
    recoveryCount: attempt.recoveryCount,
    updatedAt: attempt.updatedAt,
  };
}

function observationSummary(observation: {
  readonly id: string;
  readonly workId: string;
  readonly source: string;
  readonly occurrenceKey: string;
  readonly provenance: { readonly principal: EvidencePrincipal; readonly channel: string; readonly subject: string; readonly evidenceId: string };
  readonly observedAt: string;
  readonly createdAt: string;
}): Record<string, unknown> {
  return {
    id: observation.id,
    workId: observation.workId,
    source: observation.source,
    occurrenceKey: observation.occurrenceKey,
    provenance: observation.provenance,
    observedAt: observation.observedAt,
    createdAt: observation.createdAt,
  };
}

function workSummary(work: WorkRecord): Record<string, unknown> {
  return {
    id: work.id,
    stableKey: work.stableKey,
    title: work.title,
    state: work.state,
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
  };
}

function formatWork(work: WorkRecord): string {
  return `Work ${work.id}: ${work.title} (${work.state}).`;
}

function formatAction(action: ActionRecord): string {
  return `Action ${action.id} revision ${action.revision} digest ${action.digest}: ${action.effectClass}, ${action.state}.`;
}

function formatAttempts(attempts: readonly Record<string, unknown>[]): string {
  return attempts.length === 0
    ? " No attempts."
    : ` Attempts: ${attempts.map((attempt) => `${String(attempt.id)}=${String(attempt.state)}`).join(", ")}.`;
}

function observationEvidenceId(source: string, occurrenceKey: string): string {
  return `assistant-work:observation:${createHash("sha256").update(source).update("\0").update(occurrenceKey).digest("hex")}`;
}

function nonOwnerPrincipal(value: EvidencePrincipal): Extract<EvidencePrincipal, "third_party" | "system"> {
  if (value !== "third_party" && value !== "system") {
    throw new Error("assistant_work_observe cannot record owner provenance");
  }
  return value;
}

function observationAssessment(input: ObservationParams): ObservationAssessment {
  // Missing facts cannot be upgraded into involvement or confident unfinished work.
  if (
    typeof input.involved !== "boolean"
    || typeof input.important !== "boolean"
    || typeof input.ongoing !== "boolean"
    || (input.confidence !== "clear" && input.confidence !== "uncertain")
    || !Array.isArray(input.unfinishedEvidence)
  ) {
    throw new Error("observation assessment fields must be supplied together");
  }
  return {
    involved: input.involved,
    important: input.important,
    ongoing: input.ongoing,
    confidence: input.confidence,
    unfinishedEvidence: input.unfinishedEvidence.map((value) => requiredTrimmed(value, "unfinishedEvidence")),
  };
}

function validTimestamp(value: string): string {
  const timestamp = requiredTrimmed(value, "observedAt");
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error("observedAt must be an ISO-8601 timestamp");
  }
  return timestamp;
}

function requiredTrimmed(value: string | undefined, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is required`);
  }
  if (trimmed.includes("\0")) {
    throw new Error(`${label} contains a NUL byte`);
  }
  return trimmed;
}

function requiredRevision(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("revision must be a positive integer");
  }
  return value as number;
}

function requiredDigest(value: string | undefined): string {
  const digest = requiredTrimmed(value, "digest");
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("digest must be a lowercase sha256 digest");
  }
  return digest;
}

function rejectExecuteFieldsOnProposal(input: LocalActionParams): void {
  if (input.actionId !== undefined || input.revision !== undefined || input.digest !== undefined) {
    throw new Error("proposal must not include actionId, revision, or digest");
  }
}

function rejectProposalFieldsOnExecution(input: LocalActionParams): void {
  if (input.workId !== undefined || input.semanticKey !== undefined || input.fileOperations !== undefined) {
    throw new Error("execution must not include workId, semanticKey, or fileOperations");
  }
}
