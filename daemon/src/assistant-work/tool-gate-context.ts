import { createHash } from "node:crypto";

import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import {
  actionMaterialDigest,
  canonicalJson,
  stableAttemptId,
  type ActionRecord,
  type AttemptRecord,
  type AttemptTransitionRecord,
  type ClaimRejectionReason,
  type JsonValue,
} from "./model.ts";

export const MANAGED_OPAQUE_TOOL_ACTION = "managed_opaque_tool_call";

const TOOL_GATE_SOURCE = "assistant-work:opaque-tool-gate";
const TOOL_GATE_ATTEMPT_KEY = "approved-opaque-tool-call";

export interface ManagedOpaqueToolGateContextOptions {
  readonly repository: AssistantWorkRepository;
  /** Host-stable session/lane identity. It is hashed before persistence. */
  readonly contextId: string;
  readonly workerId?: string;
  readonly workTitle?: string;
  readonly now?: () => Date;
}

export type OpaqueToolAdmission =
  | {
    readonly kind: "allowed";
    readonly action: ActionRecord;
    readonly attempt: AttemptRecord;
    readonly inputDigest: string;
  }
  | {
    readonly kind: "rejected";
    readonly reason: ClaimRejectionReason;
    readonly action: ActionRecord;
    readonly attempt?: AttemptRecord;
    readonly inputDigest: string;
  };

export interface OpaqueToolResultInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: unknown;
  readonly details: unknown;
  readonly isError: boolean;
}

interface PendingOpaqueToolCall {
  readonly actionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly attemptId: string;
  readonly toolName: string;
  readonly inputDigest: string;
}

interface ParsedOpaqueToolAction {
  readonly toolName: string;
  readonly inputDigest: string;
  readonly contextDigest: string;
}

/**
 * Owns durable admission and result settlement for tool calls that the SDK still
 * executes. It is cooperative interception, not a shell or browser sandbox.
 */
export class ManagedOpaqueToolGateContext {
  private readonly repository: AssistantWorkRepository;
  private readonly contextDigest: string;
  private readonly workerId: string;
  private readonly workTitle: string;
  private readonly now: () => Date;
  private readonly pending = new Map<string, PendingOpaqueToolCall>();
  private workId: string | undefined;

  public constructor(options: ManagedOpaqueToolGateContextOptions) {
    this.repository = options.repository;
    const contextId = requiredText(options.contextId, "tool gate contextId", 1_024);
    this.contextDigest = sha256Text(contextId);
    this.workerId = requiredText(
      options.workerId ?? `tool-gate:${this.contextDigest.slice(0, 24)}`,
      "tool gate workerId",
      512,
    );
    this.workTitle = requiredText(options.workTitle ?? "Managed opaque tool effects", "tool gate workTitle", 240);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Atomically consumes only a pre-existing owner approval and persists
   * effect_started before returning allowed. It never creates authority.
   */
  public async admit(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<OpaqueToolAdmission> {
    const callId = requiredText(toolCallId, "toolCallId", 512);
    const name = requiredToolName(toolName);
    const inputDigest = opaqueToolInputDigest(input);
    const at = this.timestamp();
    const action = this.repository.proposeAction({
      workId: this.ensureWork(at),
      semanticKey: opaqueToolSemanticKey(name, inputDigest),
      effectClass: "external_mutation",
      action: MANAGED_OPAQUE_TOOL_ACTION,
      payload: {
        version: 1,
        toolName: name,
        inputDigest,
      },
      scope: {
        kind: "managed_opaque_tool_call",
        contextDigest: this.contextDigest,
      },
    }, at);
    if (!isManagedOpaqueToolAction(action)) {
      throw new Error(`opaque tool action failed host validation: ${action.id}`);
    }

    const attemptId = stableAttemptId(action.id, action.revision, TOOL_GATE_ATTEMPT_KEY);
    const claim = this.repository.claimForDispatch({
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId,
      workerId: this.workerId,
    }, this.timestamp());
    if (claim.kind === "rejected") {
      return {
        kind: "rejected",
        reason: claim.reason,
        action: claim.action ?? action,
        ...(claim.attempt === undefined ? {} : { attempt: claim.attempt }),
        inputDigest,
      };
    }

    const started = this.repository.markEffectStarted({ attemptId, workerId: this.workerId }, this.timestamp());
    if (started.attempt.state !== "effect_started") {
      throw new Error(`opaque tool attempt did not enter effect_started: ${attemptId}`);
    }
    this.pending.set(callId, {
      actionId: started.action.id,
      revision: started.action.revision,
      digest: started.action.digest,
      attemptId,
      toolName: name,
      inputDigest,
    });
    return { kind: "allowed", action: started.action, attempt: started.attempt, inputDigest };
  }

  /**
   * A raw tool result is execution evidence, not independent verification.
   * Success, failure, and cancellation all settle conservatively as ambiguous.
   */
  public async recordResult(input: OpaqueToolResultInput): Promise<AttemptTransitionRecord | undefined> {
    const pending = this.pending.get(input.toolCallId);
    if (!pending) return undefined;
    this.pending.delete(input.toolCallId);

    const observedToolName = typeof input.toolName === "string" ? input.toolName : "";
    const observedInput = digestEvidenceValue(input.input);
    const content = digestEvidenceValue(input.content);
    const details = digestEvidenceValue(input.details === undefined ? null : input.details);
    const exactInput = observedToolName === pending.toolName
      && observedInput.captured
      && observedInput.digest === pending.inputDigest;
    const outcome: JsonValue = {
      code: exactInput ? "opaque_tool_result_unverified" : "opaque_tool_result_identity_mismatch",
      message: exactInput
        ? "the approved raw tool returned, but no independent verification was supplied"
        : "the raw tool result did not match the exact approved tool identity",
      retryable: false,
      effectInvoked: true,
      verified: false,
      toolName: pending.toolName,
      inputDigest: pending.inputDigest,
      observedToolName,
      observedInputDigest: observedInput.digest,
      observedInputCaptured: observedInput.captured,
      result: {
        isError: input.isError,
        contentDigest: content.digest,
        contentCaptured: content.captured,
        detailsDigest: details.digest,
        detailsCaptured: details.captured,
      },
    };
    return this.repository.markAttemptAmbiguous({
      attemptId: pending.attemptId,
      workerId: this.workerId,
      outcome,
    }, this.timestamp());
  }

  private ensureWork(now: string): string {
    if (this.workId !== undefined) return this.workId;
    const admission = this.repository.admitObservation({
      source: TOOL_GATE_SOURCE,
      occurrenceKey: this.contextDigest,
      workKey: `opaque-tool-gate:${this.contextDigest}`,
      workTitle: this.workTitle,
      provenance: {
        principal: "system",
        channel: "tool_gate",
        subject: "host-interceptor",
        evidenceId: `tool-gate:${this.contextDigest}`,
      },
      observedAt: now,
      evidence: {
        kind: "managed_opaque_tool_gate_context",
        contextDigest: this.contextDigest,
      },
    }, now);
    this.workId = admission.work.id;
    return admission.work.id;
  }

  private timestamp(): string {
    const value = this.now().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new Error("tool gate now must be a valid timestamp");
    return value;
  }
}

/** Approval-command recognition must validate the complete host material shape. */
export function isManagedOpaqueToolAction(action: ActionRecord): boolean {
  try {
    const parsed = parseManagedOpaqueToolAction(action);
    return action.effectClass === "external_mutation"
      && action.action === MANAGED_OPAQUE_TOOL_ACTION
      && action.semanticKey === opaqueToolSemanticKey(parsed.toolName, parsed.inputDigest)
      && action.recipient === undefined
      && action.topic === undefined
      && action.cost === undefined
      && action.deadlineAt === undefined
      && action.blockedEvidence === undefined
      && action.digest === actionMaterialDigest(action);
  } catch {
    return false;
  }
}

export function opaqueToolInputDigest(input: Record<string, unknown>): string {
  return sha256Text(canonicalJson(strictJsonValue(input, "tool input")));
}

export function opaqueToolSemanticKey(toolName: string, inputDigest: string): string {
  const name = requiredToolName(toolName);
  if (!isDigest(inputDigest)) throw new Error("opaque tool input digest must be lowercase sha256");
  return `opaque-tool:${sha256Text(canonicalJson({ toolName: name, inputDigest }))}`;
}

function parseManagedOpaqueToolAction(action: ActionRecord): ParsedOpaqueToolAction {
  const payload = jsonObject(action.payload, "opaque tool payload");
  assertExactKeys(payload, ["inputDigest", "toolName", "version"], "opaque tool payload");
  if (payload.version !== 1 || typeof payload.toolName !== "string" || typeof payload.inputDigest !== "string") {
    throw new Error("opaque tool payload is invalid");
  }
  const toolName = requiredToolName(payload.toolName);
  if (!isDigest(payload.inputDigest)) throw new Error("opaque tool payload inputDigest is invalid");

  const scope = jsonObject(action.scope, "opaque tool scope");
  assertExactKeys(scope, ["contextDigest", "kind"], "opaque tool scope");
  if (scope.kind !== "managed_opaque_tool_call" || typeof scope.contextDigest !== "string" || !isDigest(scope.contextDigest)) {
    throw new Error("opaque tool scope is invalid");
  }
  return { toolName, inputDigest: payload.inputDigest, contextDigest: scope.contextDigest };
}

function digestEvidenceValue(value: unknown): { readonly digest: string; readonly captured: boolean } {
  try {
    return { digest: sha256Text(canonicalJson(strictJsonValue(value, "tool result"))), captured: true };
  } catch (error) {
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const message = error instanceof Error ? error.message : String(error);
    return {
      digest: sha256Text(canonicalJson({ unavailable: true, type, message })),
      captured: false,
    };
  }
}

function strictJsonValue(value: unknown, label: string, stack = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new Error(`${label} is cyclic`);
    stack.add(value);
    const result = value.map((entry, index) => strictJsonValue(entry, `${label}[${index}]`, stack));
    stack.delete(value);
    return result;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error(`${label} contains a non-JSON value`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} contains a non-plain object`);
  }
  if (stack.has(value)) throw new Error(`${label} is cyclic`);
  stack.add(value);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    result[key] = strictJsonValue((value as Record<string, unknown>)[key], `${label}.${key}`, stack);
  }
  stack.delete(value);
  return result;
}

function jsonObject(value: JsonValue | undefined, label: string): { readonly [key: string]: JsonValue } {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as { readonly [key: string]: JsonValue };
}

function assertExactKeys(object: { readonly [key: string]: JsonValue }, expected: readonly string[], label: string): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function requiredToolName(value: string): string {
  return requiredText(value, "toolName", 256);
}

function requiredText(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty normalized string of at most ${maxLength} characters`);
  }
  return value;
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
