import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import type {
  ActionRecord,
  AttemptRecord,
  ClaimRejectionReason,
  JsonValue,
} from "./model.ts";
import {
  inspectLocalFilePlan,
  localContentDigest,
  localPathInventoryToJson,
  MANAGED_LOCAL_FILE_ACTION,
  parseLocalFilePlan,
  type LocalFilePlan,
  type LocalFilePlanInspection,
  type LocalPathInventoryEntry,
  type PreparedLocalFileOperation,
} from "./local-effects.ts";
import type { AssistantWorkRepository } from "../store/assistant-work.ts";

export interface ExecuteManagedLocalFileActionInput {
  readonly repository: AssistantWorkRepository;
  readonly actionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly now?: () => string;
}

export type ManagedLocalFilePreflightRejectionReason =
  | "unsupported_action"
  | "invalid_plan"
  | "inspection_failed"
  | "effect_class_mismatch";

export type ManagedLocalFileExecutionResult =
  | {
    readonly kind: "rejected";
    readonly reason: ClaimRejectionReason;
    readonly action?: ActionRecord;
    readonly attempt?: AttemptRecord;
  }
  | {
    readonly kind: "preflight_rejected";
    readonly reason: ManagedLocalFilePreflightRejectionReason;
    readonly action: ActionRecord;
    readonly message: string;
    readonly requiredEffectClass?: LocalFilePlanInspection["effectClass"];
    readonly inventory?: readonly LocalPathInventoryEntry[];
  }
  | {
    readonly kind: "confirmed" | "definitive_failed" | "ambiguous";
    readonly action: ActionRecord;
    readonly attempt: AttemptRecord;
    readonly evidence: JsonValue;
  };

export type ManagedLocalFileExecutionStage = "claim" | "effect_start" | "confirmation" | "settlement";

export class ManagedLocalFileExecutionError extends Error {
  public constructor(
    public readonly stage: ManagedLocalFileExecutionStage,
    public readonly effectMayHaveOccurred: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedLocalFileExecutionError";
  }
}

interface ApplyFailure {
  readonly error: unknown;
  readonly noEffectProven: boolean;
  readonly operation: PreparedLocalFileOperation;
  readonly cleanupErrors?: readonly JsonValue[];
}

/**
 * Executes one exact action revision. There is no retry loop: the durable claim
 * is followed by effect_started, one filesystem pass, evidence reconciliation,
 * and a single terminal settlement. If terminal settlement itself cannot be
 * persisted, the unresolved effect_started attempt is left for reconcile-only
 * recovery rather than replay.
 */
export async function executeManagedLocalFileAction(
  input: ExecuteManagedLocalFileActionInput,
): Promise<ManagedLocalFileExecutionResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const action = input.repository.getAction(input.actionId);
  if (!action) {
    return { kind: "rejected", reason: "unknown_action" };
  }
  if (action.revision !== input.revision) {
    return { kind: "rejected", reason: "stale_revision", action };
  }
  if (action.digest !== input.digest) {
    return { kind: "rejected", reason: "stale_digest", action };
  }
  if (action.action !== MANAGED_LOCAL_FILE_ACTION) {
    return {
      kind: "preflight_rejected",
      reason: "unsupported_action",
      action,
      message: `unsupported managed local action: ${action.action}`,
    };
  }

  let plan: LocalFilePlan;
  try {
    plan = parseLocalFilePlan(action.payload);
  } catch (error) {
    return {
      kind: "preflight_rejected",
      reason: "invalid_plan",
      action,
      message: errorMessage(error),
    };
  }

  let preclaimInspection: LocalFilePlanInspection;
  try {
    preclaimInspection = await inspectLocalFilePlan(plan);
  } catch (error) {
    return {
      kind: "preflight_rejected",
      reason: "inspection_failed",
      action,
      message: errorMessage(error),
    };
  }
  if (preclaimInspection.effectClass !== action.effectClass) {
    return {
      kind: "preflight_rejected",
      reason: "effect_class_mismatch",
      action,
      message: `host preflight requires ${preclaimInspection.effectClass}, not ${action.effectClass}`,
      requiredEffectClass: preclaimInspection.effectClass,
      inventory: preclaimInspection.inventory,
    };
  }

  let claim: ReturnType<AssistantWorkRepository["claimForDispatch"]>;
  try {
    claim = input.repository.claimForDispatch({
      actionId: input.actionId,
      revision: input.revision,
      digest: input.digest,
      attemptId: input.attemptId,
      workerId: input.workerId,
    }, now());
  } catch (error) {
    throw new ManagedLocalFileExecutionError("claim", false, "managed local action claim failed", { cause: error });
  }
  if (claim.kind === "rejected") {
    return claim;
  }

  let started: ReturnType<AssistantWorkRepository["markEffectStarted"]>;
  try {
    started = input.repository.markEffectStarted({
      attemptId: input.attemptId,
      workerId: input.workerId,
    }, now());
  } catch (error) {
    throw new ManagedLocalFileExecutionError(
      "effect_start",
      false,
      "effect_started could not be persisted; no filesystem operation was invoked",
      { cause: error },
    );
  }
  if (started.attempt.state !== "effect_started") {
    throw new ManagedLocalFileExecutionError(
      "effect_start",
      false,
      `unexpected attempt state after effect start: ${started.attempt.state}`,
    );
  }

  if (!preclaimInspection.preconditionsMatch) {
    const evidence = noEffectEvidence(
      "stale_local_precondition",
      plan,
      preclaimInspection.inventory,
      now(),
      { mismatchedPaths: preclaimInspection.mismatchedPaths },
    );
    return settleDefinitive(input.repository, input.attemptId, input.workerId, evidence, now);
  }

  let mutationInspection: LocalFilePlanInspection;
  try {
    mutationInspection = await inspectLocalFilePlan(plan);
  } catch (error) {
    const evidence = noEffectEvidence(
      "pre_mutation_inspection_failed",
      plan,
      undefined,
      now(),
      { error: errorToJson(error) },
    );
    return settleDefinitive(input.repository, input.attemptId, input.workerId, evidence, now);
  }
  if (mutationInspection.effectClass !== action.effectClass || !mutationInspection.preconditionsMatch) {
    const evidence = noEffectEvidence(
      mutationInspection.effectClass === action.effectClass
        ? "stale_local_precondition"
        : "effect_class_changed_before_mutation",
      plan,
      mutationInspection.inventory,
      now(),
      {
        actionEffectClass: action.effectClass,
        requiredEffectClass: mutationInspection.effectClass,
        mismatchedPaths: mutationInspection.mismatchedPaths,
      },
    );
    return settleDefinitive(input.repository, input.attemptId, input.workerId, evidence, now);
  }

  let completedMutations = 0;
  try {
    for (const [index, operation] of plan.operations.entries()) {
      if (desiredStateMatches(operation, mutationInspection.inventory[index]!)) {
        continue;
      }
      if (operation.operation === "write_file") {
        await applyWrite(operation);
      } else {
        await applyDelete(operation);
      }
      completedMutations += 1;
    }
  } catch (error) {
    const failure = normalizeApplyFailure(error, plan.operations[completedMutations]);
    return reconcileAfterApplyFailure(
      input.repository,
      input.attemptId,
      input.workerId,
      plan,
      failure,
      completedMutations,
      now,
    );
  }

  let verification: LocalFilePlanInspection;
  try {
    verification = await inspectLocalFilePlan(plan);
  } catch (error) {
    const evidence: JsonValue = {
      code: completedMutations === 0 ? "verification_failed_without_effect" : "local_effect_verification_ambiguous",
      message: errorMessage(error),
      retryable: false,
      completedMutations,
      error: errorToJson(error),
    };
    return completedMutations === 0
      ? settleDefinitive(input.repository, input.attemptId, input.workerId, evidence, now)
      : settleAmbiguous(input.repository, input.attemptId, input.workerId, evidence, now);
  }

  const verifiedAt = now();
  const evidence = receiptEvidence(plan, verification.inventory, verifiedAt);
  if (allDesiredStatesMatch(plan, verification.inventory)) {
    return settleConfirmed(input.repository, input.attemptId, input.workerId, evidence, now);
  }
  if (completedMutations === 0) {
    return settleDefinitive(
      input.repository,
      input.attemptId,
      input.workerId,
      {
        code: "desired_state_changed_without_executor_effect",
        message: "no filesystem mutation was needed or invoked, but final evidence no longer matches",
        retryable: false,
        evidence,
      },
      now,
    );
  }
  return settleAmbiguous(
    input.repository,
    input.attemptId,
    input.workerId,
    {
      code: "local_effect_verification_mismatch",
      message: "one or more paths did not match the intended final state after a filesystem mutation",
      retryable: false,
      completedMutations,
      evidence,
    },
    now,
  );
}

async function applyWrite(operation: Extract<PreparedLocalFileOperation, { readonly operation: "write_file" }>): Promise<void> {
  const temporaryPath = join(operation.precondition.resolvedParentPath, `.openinstinct-${randomUUID()}.tmp`);
  const mode = operation.precondition.state === "file" ? operation.precondition.mode & 0o777 : 0o600;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    await handle.writeFile(operation.content, "utf8");
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, operation.precondition.resolvedPath);
    temporaryCreated = false;
  } catch (error) {
    const cleanupErrors: JsonValue[] = [];
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        cleanupErrors.push(errorToJson(closeError));
      }
    }
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
        temporaryCreated = false;
      } catch (cleanupError) {
        if (!isErrno(cleanupError, "ENOENT")) {
          cleanupErrors.push(errorToJson(cleanupError));
        } else {
          temporaryCreated = false;
        }
      }
    }
    throw {
      error,
      noEffectProven: !temporaryCreated && cleanupErrors.length === 0,
      operation,
      cleanupErrors,
    } satisfies ApplyFailure & { readonly cleanupErrors: readonly JsonValue[] };
  }
}

async function applyDelete(operation: Extract<PreparedLocalFileOperation, { readonly operation: "delete_file" }>): Promise<void> {
  if (operation.precondition.state === "absent") {
    return;
  }
  try {
    await unlink(operation.precondition.resolvedPath);
  } catch (error) {
    throw { error, noEffectProven: true, operation } satisfies ApplyFailure;
  }
}

async function reconcileAfterApplyFailure(
  repository: AssistantWorkRepository,
  attemptId: string,
  workerId: string,
  plan: LocalFilePlan,
  failure: ApplyFailure,
  completedMutations: number,
  now: () => string,
): Promise<ManagedLocalFileExecutionResult> {
  let inspection: LocalFilePlanInspection | undefined;
  let inspectionError: unknown;
  try {
    inspection = await inspectLocalFilePlan(plan);
  } catch (error) {
    inspectionError = error;
  }

  const verifiedAt = now();
  const evidence: JsonValue = {
    code: "local_filesystem_operation_failed",
    message: errorMessage(failure.error),
    retryable: false,
    failedOperation: {
      operation: failure.operation.operation,
      path: failure.operation.path,
    },
    completedMutations,
    noEffectProven: failure.noEffectProven,
    error: errorToJson(failure.error),
    ...(failure.cleanupErrors === undefined ? {} : { cleanupErrors: failure.cleanupErrors }),
    ...(inspection
      ? { evidence: receiptEvidence(plan, inspection.inventory, verifiedAt) }
      : { verificationError: errorToJson(inspectionError) }),
  };

  if (inspection && failure.noEffectProven && allDesiredStatesMatch(plan, inspection.inventory)) {
    return settleConfirmed(repository, attemptId, workerId, {
      code: "local_effect_verified_after_operation_error",
      message: "the filesystem operation reported an error, but every intended final state was verified",
      retryable: false,
      evidence: receiptEvidence(plan, inspection.inventory, verifiedAt),
      error: errorToJson(failure.error),
    }, now);
  }
  if (completedMutations === 0 && failure.noEffectProven) {
    return settleDefinitive(repository, attemptId, workerId, evidence, now);
  }
  return settleAmbiguous(repository, attemptId, workerId, evidence, now);
}

function desiredStateMatches(operation: PreparedLocalFileOperation, actual: LocalPathInventoryEntry): boolean {
  if (operation.operation === "delete_file") {
    return actual.state === "absent";
  }
  return actual.state === "file"
    && actual.sha256 === localContentDigest(operation.content)
    && actual.bytes === Buffer.byteLength(operation.content, "utf8");
}

function allDesiredStatesMatch(
  plan: LocalFilePlan,
  inventory: readonly LocalPathInventoryEntry[],
): boolean {
  return inventory.length === plan.operations.length
    && plan.operations.every((operation, index) => desiredStateMatches(operation, inventory[index]!));
}

function receiptEvidence(
  plan: LocalFilePlan,
  inventory: readonly LocalPathInventoryEntry[],
  verifiedAt: string,
): JsonValue {
  return {
    kind: "managed_local_file_receipt",
    version: 1,
    verifiedAt,
    paths: plan.operations.map((operation, index) => ({
      operation: operation.operation,
      ...localPathInventoryToJson(inventory[index]!),
    })),
  };
}

function noEffectEvidence(
  code: string,
  plan: LocalFilePlan,
  inventory: readonly LocalPathInventoryEntry[] | undefined,
  verifiedAt: string,
  details: { readonly [key: string]: JsonValue },
): JsonValue {
  return {
    code,
    message: "the managed local effect was not invoked",
    retryable: false,
    effectInvoked: false,
    evidence: inventory
      ? receiptEvidence(plan, inventory, verifiedAt)
      : { kind: "managed_local_file_receipt", version: 1, verifiedAt, paths: [] },
    ...details,
  };
}

function settleConfirmed(
  repository: AssistantWorkRepository,
  attemptId: string,
  workerId: string,
  evidence: JsonValue,
  now: () => string,
): ManagedLocalFileExecutionResult {
  try {
    const transition = repository.confirmAttempt({
      attemptId,
      workerId,
      outcome: {
        code: "local_effect_verified",
        message: "all managed local file outcomes were verified",
        retryable: false,
        evidence,
      },
    }, now());
    return { kind: "confirmed", ...transition, evidence };
  } catch (error) {
    throw new ManagedLocalFileExecutionError(
      "confirmation",
      true,
      "local effect was verified, but durable confirmation failed; do not replay it",
      { cause: error },
    );
  }
}

function settleDefinitive(
  repository: AssistantWorkRepository,
  attemptId: string,
  workerId: string,
  evidence: JsonValue,
  now: () => string,
): ManagedLocalFileExecutionResult {
  try {
    const transition = repository.failAttemptDefinitively({ attemptId, workerId, outcome: evidence }, now());
    return { kind: "definitive_failed", ...transition, evidence };
  } catch (error) {
    throw new ManagedLocalFileExecutionError(
      "settlement",
      false,
      "no managed target effect occurred, but durable failure settlement failed",
      { cause: error },
    );
  }
}

function settleAmbiguous(
  repository: AssistantWorkRepository,
  attemptId: string,
  workerId: string,
  evidence: JsonValue,
  now: () => string,
): ManagedLocalFileExecutionResult {
  try {
    const transition = repository.markAttemptAmbiguous({ attemptId, workerId, outcome: evidence }, now());
    return { kind: "ambiguous", ...transition, evidence };
  } catch (error) {
    throw new ManagedLocalFileExecutionError(
      "settlement",
      true,
      "local effect outcome is ambiguous and durable settlement failed; do not replay it",
      { cause: error },
    );
  }
}

function normalizeApplyFailure(error: unknown, fallback: PreparedLocalFileOperation | undefined): ApplyFailure {
  if (
    typeof error === "object"
    && error !== null
    && "error" in error
    && "noEffectProven" in error
    && "operation" in error
    && typeof error.noEffectProven === "boolean"
  ) {
    return error as unknown as ApplyFailure;
  }
  if (!fallback) {
    throw new ManagedLocalFileExecutionError(
      "settlement",
      true,
      "local filesystem execution failed without operation identity; do not replay it",
      { cause: error },
    );
  }
  return { error, noEffectProven: false, operation: fallback };
}

function errorToJson(error: unknown): JsonValue {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
    };
  }
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return { message: error.message };
  }
  return { message: String(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
