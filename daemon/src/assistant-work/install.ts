import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { CustomTool } from "@gajae-code/coding-agent";
import { Type } from "@gajae-code/coding-agent/extensibility/typebox";

import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import {
  canonicalJson,
  stableAttemptId,
  type ActionRecord,
  type AttemptRecord,
  type ClaimRejectionReason,
  type EffectClass,
  type JsonValue,
  type ProposeActionInput,
} from "./model.ts";

export const MANAGED_INSTALL_ACTION = "install_user_local_bun_package";

const DEFAULT_WORKER_ID = "main-session:managed-install";
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
const PROCESS_GROUP_POLL_MS = 10;
const PROCESS_GROUP_QUIESCENCE_TIMEOUT_MS = 5_000;
const MANAGED_MANIFEST = `${JSON.stringify({
  name: "openinstinct-managed-tools",
  version: "0.0.0",
  private: true,
  openinstinctManagedToolRoot: 1,
}, null, 2)}\n`;
const MANAGED_MANIFEST_SHA256 = sha256(Buffer.from(MANAGED_MANIFEST));
const PACKAGE_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

export type ManagedInstallPackageSection = typeof PACKAGE_SECTIONS[number];
export type ManagedInstallEffectClass = Extract<
  EffectClass,
  "ordinary_local_install" | "core_setting_change" | "account_rights_change" | "bulk_existing_user_assets" | "external_mutation"
>;

export interface ManagedInstallToolOptions {
  readonly repository: AssistantWorkRepository;
  /** Host-owned injection for tests. Production uses the running Bun executable. */
  readonly bunPath?: string;
  readonly workerId?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ManagedInstallPreflightInput {
  readonly workId: string;
  readonly semanticKey: string;
  /** A registry package pinned to an exact semantic version, for example pkg@1.2.3. */
  readonly packageSpec: string;
  /** Absolute, normalized, user-selected working directory. */
  readonly destination: string;
  /** Host-owned injection for tests. Production callers omit this. */
  readonly bunPath?: string;
  /** Defaults false so installs use the package manager's normal lifecycle behavior. */
  readonly ignoreScripts?: boolean;
  /** Host-owned ledger used to recognize a previously confirmed managed root. */
  readonly repository?: AssistantWorkRepository;
}

export interface ManagedInstallOptions {
  readonly exact: true;
  readonly ignoreScripts: boolean;
}

export interface ManagedInstallPlan {
  readonly version: 1;
  readonly manager: "bun";
  readonly managerPath: string;
  readonly packageSpec: string;
  readonly destination: string;
  readonly options: ManagedInstallOptions;
  readonly precondition: ManagedInstallInventory;
}

export interface ManagedInstallRootEntry {
  readonly name: string;
  readonly state: "file" | "directory" | "symlink" | "other";
}

export type ManagedInstallPackageJsonInventory =
  | { readonly state: "absent" }
  | {
    readonly state: "file";
    readonly sha256: string;
    readonly bytes: number;
    readonly validJson: boolean;
    readonly managedToolRoot: boolean;
  }
  | { readonly state: "unsupported" };

export interface ManagedInstallPackageEntry {
  readonly section: ManagedInstallPackageSection;
  readonly name: string;
  readonly value: string;
}

export type InstalledPackageInventory =
  | { readonly state: "absent" }
  | { readonly state: "unsupported" }
  | {
    readonly state: "file";
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly name: string | null;
    readonly version: string | null;
  };

export interface ManagedInstallInventory {
  readonly destination: string;
  readonly resolvedDestination: string;
  readonly existing: boolean;
  readonly dedicatedToolRoot: boolean;
  readonly entries: readonly ManagedInstallRootEntry[];
  readonly packageJson: ManagedInstallPackageJsonInventory;
  readonly packageEntry: ManagedInstallPackageEntry | null;
  readonly installedPackage: InstalledPackageInventory;
}

export interface ManagedInstallPreflightResult {
  readonly effectClass: ManagedInstallEffectClass;
  readonly plan: ManagedInstallPlan;
  readonly inventory: ManagedInstallInventory;
  readonly argv: readonly string[];
  readonly proposal: ProposeActionInput;
}

export interface ExecuteManagedInstallInput {
  readonly repository: AssistantWorkRepository;
  readonly actionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly attemptId: string;
  readonly workerId: string;
  /** Host-owned expected Bun path. Production defaults to process.execPath. */
  readonly bunPath?: string;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
}

export type ManagedInstallPreflightRejectionReason =
  | "unsupported_action"
  | "invalid_plan"
  | "inspection_failed"
  | "effect_class_mismatch";

export type ManagedInstallExecutionResult =
  | {
    readonly kind: "rejected";
    readonly reason: ClaimRejectionReason;
    readonly action?: ActionRecord;
    readonly attempt?: AttemptRecord;
  }
  | {
    readonly kind: "preflight_rejected";
    readonly reason: ManagedInstallPreflightRejectionReason;
    readonly action: ActionRecord;
    readonly message: string;
    readonly requiredEffectClass?: ManagedInstallEffectClass;
    readonly inventory?: ManagedInstallInventory;
  }
  | {
    readonly kind: "confirmed" | "definitive_failed" | "ambiguous";
    readonly action: ActionRecord;
    readonly attempt: AttemptRecord;
    readonly evidence: JsonValue;
  };

export type ManagedInstallExecutionStage = "claim" | "effect_start" | "confirmation" | "settlement";

export class ManagedInstallError extends Error {
  public constructor(
    public readonly code:
      | "invalid_plan"
      | "invalid_package_spec"
      | "invalid_destination"
      | "invalid_manager_path"
      | "inspection_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedInstallError";
  }
}

export class ManagedInstallExecutionError extends Error {
  public constructor(
    public readonly stage: ManagedInstallExecutionStage,
    public readonly effectMayHaveOccurred: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedInstallExecutionError";
  }
}

export interface ManagedInstallInspection {
  readonly inventory: ManagedInstallInventory;
  readonly effectClass: ManagedInstallEffectClass;
  readonly preconditionMatches: boolean;
}

interface PreparedDestination {
  readonly createdDestination: boolean;
  readonly createdManifest: boolean;
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly started: boolean;
  readonly cancelled: boolean;
  readonly processGroupQuiescent: boolean;
}

interface ManagedInstallToolParams {
  readonly operation: "propose" | "execute";
  readonly workId?: string;
  readonly semanticKey?: string;
  readonly packageSpec?: string;
  readonly destination?: string;
  readonly ignoreScripts?: boolean;
  readonly actionId?: string;
  readonly revision?: number;
  readonly digest?: string;
}

/**
 * Optional durable install tool for one exact package version and destination.
 * The host constructs argv and verifies the installed package metadata.
 * Lifecycle scripts use normal package-manager behavior unless explicitly disabled.
 */
export function createManagedInstallTool(options: ManagedInstallToolOptions): CustomTool {
  const now = options.now ?? (() => new Date());
  const workerId = requiredTrimmed(options.workerId ?? DEFAULT_WORKER_ID, "workerId");
  const bunPath = options.bunPath ?? process.execPath;
  const killGraceMs = positiveInteger(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, "killGraceMs");
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");

  return {
    name: "assistant_managed_install",
    label: "Managed Bun Package Install",
    strict: true,
    concurrency: "exclusive",
    description: "Propose or execute one exact-version Bun package install in an absolute work directory. Preflight records the destination and constructs argv. Execute the planned action immediately using its exact identity; package metadata is verified after execution.",
    parameters: Type.Object({
      operation: Type.Enum(["propose", "execute"]),
      workId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      semanticKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      packageSpec: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      destination: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
      ignoreScripts: Type.Optional(Type.Boolean()),
      actionId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
      digest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _onUpdate, _context, signal) {
      const input = params as ManagedInstallToolParams;
      if (input.operation === "propose") {
        rejectExecutionFieldsOnProposal(input);
        const preflight = await preflightManagedInstall({
          workId: requiredTrimmed(input.workId, "workId"),
          semanticKey: requiredTrimmed(input.semanticKey, "semanticKey"),
          packageSpec: requiredString(input.packageSpec, "packageSpec"),
          destination: requiredString(input.destination, "destination"),
          bunPath,
          ignoreScripts: input.ignoreScripts,
          repository: options.repository,
        });
        const action = options.repository.proposeAction(preflight.proposal, now().toISOString());
        return {
          content: [{ type: "text" as const, text: proposalText(action) }],
          details: {
            operation: "propose" as const,
            action: actionSummary(action),
            argv: preflight.argv,
            inventory: preflight.inventory,
            effectExecuted: false,
          },
        };
      }

      rejectProposalFieldsOnExecution(input);
      const actionId = requiredTrimmed(input.actionId, "actionId");
      const revision = requiredRevision(input.revision);
      const digest = requiredDigest(input.digest);
      const attemptId = stableAttemptId(actionId, revision, requiredTrimmed(toolCallId, "toolCallId"));
      const result = await executeManagedInstall({
        repository: options.repository,
        actionId,
        revision,
        digest,
        attemptId,
        workerId,
        bunPath,
        signal,
        now: () => now().toISOString(),
        env: options.env,
        killGraceMs,
        maxOutputBytes,
      });
      return {
        content: [{ type: "text" as const, text: executionText(result, actionId, revision) }],
        details: executionDetails(result, attemptId),
      };
    },
  };
}

/** Builds the only persisted material accepted by the managed Bun executor. */
export async function preflightManagedInstall(
  input: ManagedInstallPreflightInput,
): Promise<ManagedInstallPreflightResult> {
  const workId = requiredTrimmed(input.workId, "workId");
  const semanticKey = requiredTrimmed(input.semanticKey, "semanticKey");
  const packageSpec = normalizePackageSpec(input.packageSpec);
  const destination = normalizeDestination(input.destination);
  const managerPath = await verifyBunPath(input.bunPath ?? process.execPath);
  if (input.ignoreScripts !== undefined && typeof input.ignoreScripts !== "boolean") {
    throw new ManagedInstallError("invalid_plan", "ignoreScripts must be a boolean");
  }
  const options: ManagedInstallOptions = { exact: true, ignoreScripts: input.ignoreScripts ?? false };
  const inventory = recognizeDedicatedRoot(await inspectInstallDestination(destination, packageSpec), input.repository);
  const effectClass = classifyManagedInstall(inventory, options);
  const plan: ManagedInstallPlan = {
    version: 1,
    manager: "bun",
    managerPath,
    packageSpec,
    destination,
    options,
    precondition: inventory,
  };
  return {
    effectClass,
    plan,
    inventory,
    argv: installArgv(plan),
    proposal: {
      workId,
      semanticKey,
      effectClass,
      action: MANAGED_INSTALL_ACTION,
      payload: managedInstallPlanToJson(plan),
      scope: {
        kind: "managed_user_local_bun_install",
        manager: "bun",
        managerPath,
        packageSpec,
        destination,
        options: optionsToJson(options),
        inventory: inventoryToJson(inventory),
      },
    },
  };
}

/** Re-inventories persisted host material immediately before claim or spawn. */
export async function inspectManagedInstallPlan(
  plan: ManagedInstallPlan,
  repository?: AssistantWorkRepository,
): Promise<ManagedInstallInspection> {
  const inventory = recognizeDedicatedRoot(
    await inspectInstallDestination(plan.destination, plan.packageSpec),
    repository,
  );
  return {
    inventory,
    effectClass: classifyManagedInstall(inventory, plan.options),
    preconditionMatches: inventoryMatches(plan.precondition, inventory),
  };
}

/** Claims one exact revision, persists effect_started, and invokes Bun once. */
export async function executeManagedInstall(
  input: ExecuteManagedInstallInput,
): Promise<ManagedInstallExecutionResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const action = input.repository.getAction(input.actionId);
  if (!action) return { kind: "rejected", reason: "unknown_action" };
  if (action.revision !== input.revision) return { kind: "rejected", reason: "stale_revision", action };
  if (action.digest !== input.digest) return { kind: "rejected", reason: "stale_digest", action };
  if (action.action !== MANAGED_INSTALL_ACTION) {
    return { kind: "preflight_rejected", reason: "unsupported_action", action, message: `unsupported managed install action: ${action.action}` };
  }
  const terminalAttempt = input.repository.getAttempt(input.attemptId);
  if (terminalAttempt !== undefined) {
    if (
      terminalAttempt.actionId !== action.id
      || terminalAttempt.actionRevision !== action.revision
      || terminalAttempt.actionDigest !== action.digest
    ) {
      throw new ManagedInstallExecutionError("claim", false, "managed install attempt identity collides with different action material");
    }
    const reason = rejectionForAttempt(terminalAttempt.state);
    if (reason !== undefined) return { kind: "rejected", reason, action, attempt: terminalAttempt };
  }
  const terminalReason = rejectionForTerminalAction(action.state);
  if (terminalReason !== undefined) {
    const attempt = action.activeAttemptId === undefined
      ? undefined
      : input.repository.getAttempt(action.activeAttemptId);
    return {
      kind: "rejected",
      reason: terminalReason,
      action,
      ...(attempt === undefined ? {} : { attempt }),
    };
  }

  let plan: ManagedInstallPlan;
  try {
    plan = parseManagedInstallPlan(action.payload);
    const expectedManagerPath = await verifyBunPath(input.bunPath ?? process.execPath);
    if (plan.managerPath !== expectedManagerPath) {
      throw new ManagedInstallError("invalid_manager_path", "persisted Bun path does not match the host runtime");
    }
  } catch (error) {
    return { kind: "preflight_rejected", reason: "invalid_plan", action, message: errorMessage(error) };
  }

  let preclaim: ManagedInstallInspection;
  try {
    preclaim = await inspectManagedInstallPlan(plan, input.repository);
  } catch (error) {
    return { kind: "preflight_rejected", reason: "inspection_failed", action, message: errorMessage(error) };
  }
  if (preclaim.effectClass !== action.effectClass) {
    return {
      kind: "preflight_rejected",
      reason: "effect_class_mismatch",
      action,
      message: `host preflight requires ${preclaim.effectClass}, not ${action.effectClass}`,
      requiredEffectClass: preclaim.effectClass,
      inventory: preclaim.inventory,
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
    throw new ManagedInstallExecutionError("claim", false, "managed install claim failed", { cause: error });
  }
  if (claim.kind === "rejected") return claim;

  try {
    const started = input.repository.markEffectStarted({ attemptId: input.attemptId, workerId: input.workerId }, now());
    if (started.attempt.state !== "effect_started") {
      throw new Error(`unexpected attempt state after effect start: ${started.attempt.state}`);
    }
  } catch (error) {
    throw new ManagedInstallExecutionError(
      "effect_start",
      false,
      "effect_started could not be persisted; Bun was not invoked",
      { cause: error },
    );
  }

  if (!preclaim.preconditionMatches) {
    return settleDefinitive(input, noEffectEvidence("stale_install_precondition", plan, preclaim.inventory, now()), now);
  }
  if (input.signal?.aborted) {
    return settleDefinitive(input, noEffectEvidence("install_cancelled_before_spawn", plan, preclaim.inventory, now()), now);
  }

  let dispatch: ManagedInstallInspection;
  try {
    dispatch = await inspectManagedInstallPlan(plan, input.repository);
    await verifyBunPath(plan.managerPath);
  } catch (error) {
    return settleDefinitive(input, {
      code: "pre_spawn_inspection_failed",
      message: "host state could not be rechecked; Bun was not invoked",
      retryable: false,
      effectInvoked: false,
      error: errorToJson(error),
    }, now);
  }
  if (dispatch.effectClass !== action.effectClass || !dispatch.preconditionMatches) {
    return settleDefinitive(input, noEffectEvidence(
      dispatch.effectClass === action.effectClass ? "stale_install_precondition" : "effect_class_changed_before_spawn",
      plan,
      dispatch.inventory,
      now(),
    ), now);
  }

  let prepared: PreparedDestination;
  try {
    prepared = await prepareDestination(plan);
  } catch (error) {
    const final = await safeInventory(plan);
    const unchanged = noChangeProven(plan, final);
    const evidence = failureEvidence(
      unchanged ? "install_destination_prepare_failed" : "install_destination_prepare_ambiguous",
      error,
      plan,
      final,
      now(),
      !unchanged,
    );
    return unchanged ? settleDefinitive(input, evidence, now) : settleAmbiguous(input, evidence, now);
  }

  const outcome = await spawnInstall(plan, input.signal, {
    env: input.env,
    killGraceMs: positiveInteger(input.killGraceMs ?? DEFAULT_KILL_GRACE_MS, "killGraceMs"),
    maxOutputBytes: positiveInteger(input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes"),
  });
  let final = await safeInventory(plan);
  let cleanupSucceeded = true;

  if (!outcome.started || outcome.code !== 0 || outcome.cancelled) {
    if (outcome.processGroupQuiescent) {
      cleanupSucceeded = await cleanupUntouchedPreparation(plan, prepared, final);
      final = await safeInventory(plan);
    } else {
      cleanupSucceeded = false;
    }
  }
  const verifiedAt = now();
  const processEvidence = processToJson(plan, outcome);

  if (
    outcome.started
    && !outcome.cancelled
    && outcome.processGroupQuiescent
    && outcome.code === 0
    && final !== undefined
    && packageInstalled(plan, final)
  ) {
    const evidence: JsonValue = {
      kind: "managed_bun_install_receipt",
      version: 1,
      verifiedAt,
      packageSpec: plan.packageSpec,
      destination: plan.destination,
      process: processEvidence,
      inventory: inventoryToJson(final),
    };
    return settleConfirmed(input, evidence, now);
  }

  const unchanged = outcome.processGroupQuiescent && cleanupSucceeded && noChangeProven(plan, final);
  const evidence: JsonValue = {
    code: !outcome.started
      ? "install_spawn_failed"
      : outcome.cancelled
        ? outcome.processGroupQuiescent
          ? "install_cancelled_after_start"
          : "install_cancellation_cleanup_unconfirmed"
        : outcome.code === 0
          ? "install_metadata_verification_failed"
          : "install_process_failed",
    message: !outcome.started
      ? "Bun could not be started"
      : outcome.cancelled
        ? outcome.processGroupQuiescent
          ? "the bounded Bun process-group cleanup completed after cancellation"
          : "the Bun process group did not become quiescent within the bounded cancellation cleanup"
        : outcome.code === 0
          ? "Bun exited successfully, but package.json and installed package metadata did not confirm the request"
          : `Bun exited with ${String(outcome.code)} after process start`,
    retryable: false,
    effectInvoked: outcome.started,
    noChangeProven: unchanged,
    process: processEvidence,
    ...(outcome.error === undefined ? {} : { error: errorToJson(outcome.error) }),
    ...(final === undefined ? {} : { evidence: installEvidence(plan, final, verifiedAt) }),
  };
  return unchanged ? settleDefinitive(input, evidence, now) : settleAmbiguous(input, evidence, now);
}

export function parseManagedInstallPlan(payload: JsonValue): ManagedInstallPlan {
  const object = jsonObject(payload, "managed install payload");
  assertExactKeys(object, ["destination", "manager", "managerPath", "options", "packageSpec", "precondition", "version"], "managed install payload");
  if (object.version !== 1 || object.manager !== "bun") {
    throw new ManagedInstallError("invalid_plan", "managed install payload must be a Bun version 1 plan");
  }
  if (typeof object.managerPath !== "string" || typeof object.packageSpec !== "string" || typeof object.destination !== "string") {
    throw new ManagedInstallError("invalid_plan", "managed install plan contains invalid strings");
  }
  const options = parseOptions(object.options);
  const plan: ManagedInstallPlan = {
    version: 1,
    manager: "bun",
    managerPath: requireNormalizedAbsolutePath(object.managerPath, "managerPath"),
    packageSpec: normalizePackageSpec(object.packageSpec),
    destination: normalizeDestination(object.destination),
    options,
    precondition: parseInventory(object.precondition),
  };
  if (plan.precondition.destination !== plan.destination) {
    throw new ManagedInstallError("invalid_plan", "install inventory destination does not match the plan");
  }
  if (policyPath(basename(plan.precondition.resolvedDestination)) !== policyPath(basename(plan.destination))) {
    throw new ManagedInstallError("invalid_plan", "resolved install destination does not match the destination basename");
  }
  const packageName = packageNameFromSpec(plan.packageSpec);
  if (plan.precondition.packageEntry !== null && plan.precondition.packageEntry.name !== packageName) {
    throw new ManagedInstallError("invalid_plan", "install inventory package entry does not match packageSpec");
  }
  if (plan.precondition.installedPackage.state === "file") {
    const expectedMetadataPath = join(plan.destination, "node_modules", ...packageName.split("/"), "package.json");
    if (plan.precondition.installedPackage.path !== expectedMetadataPath) {
      throw new ManagedInstallError("invalid_plan", "installed package metadata path does not match packageSpec");
    }
  }
  return plan;
}

export function managedInstallPlanToJson(plan: ManagedInstallPlan): JsonValue {
  return {
    version: 1,
    manager: "bun",
    managerPath: plan.managerPath,
    packageSpec: plan.packageSpec,
    destination: plan.destination,
    options: optionsToJson(plan.options),
    precondition: inventoryToJson(plan.precondition),
  };
}

/** Exact argv passed to spawn; no shell string is accepted or constructed. */
export function installArgv(plan: ManagedInstallPlan): readonly string[] {
  return [
    plan.managerPath,
    "add",
    "--exact",
    ...(plan.options.ignoreScripts ? ["--ignore-scripts"] : []),
    "--cwd",
    plan.destination,
    plan.packageSpec,
  ];
}

// A marker is only structural evidence. A non-empty root becomes ordinary only
// after the durable ledger contains a confirmed managed install for that path;
// package contents or model-authored labels cannot establish that history.
function recognizeDedicatedRoot(
  inventory: ManagedInstallInventory,
  repository: AssistantWorkRepository | undefined,
): ManagedInstallInventory {
  if (!inventory.dedicatedToolRoot || !inventory.existing || inventory.entries.length === 0) return inventory;
  const confirmed = repository?.listActions().actions.some((action) => {
    if (action.action !== MANAGED_INSTALL_ACTION || action.state !== "confirmed") return false;
    try {
      const prior = parseManagedInstallPlan(action.payload);
      const physicalCandidate = !prior.precondition.existing
        || prior.precondition.entries.length === 0
        || (prior.precondition.packageJson.state === "file"
          && prior.precondition.packageJson.managedToolRoot
          && prior.precondition.entries.every(isManagedRootEntry));
      return prior.destination === inventory.destination
        && prior.precondition.dedicatedToolRoot
        && classifyManagedInstall(
          { ...prior.precondition, dedicatedToolRoot: physicalCandidate },
          prior.options,
        ) === "ordinary_local_install";
    } catch {
      return false;
    }
  }) ?? false;
  return confirmed ? inventory : { ...inventory, dedicatedToolRoot: false };
}

export function classifyManagedInstall(
  inventory: ManagedInstallInventory,
  options: ManagedInstallOptions = { exact: true, ignoreScripts: false },
): ManagedInstallEffectClass {
  if (isAccountRightsPath(inventory.destination) || isAccountRightsPath(inventory.resolvedDestination)) {
    return "account_rights_change";
  }
  if (isCorePath(inventory.destination) || isCorePath(inventory.resolvedDestination)) {
    return "core_setting_change";
  }
  if (!options.ignoreScripts) return "external_mutation";
  return inventory.dedicatedToolRoot ? "ordinary_local_install" : "bulk_existing_user_assets";
}

async function verifyBunPath(input: string): Promise<string> {
  const path = requireNormalizedAbsolutePath(input, "managerPath");
  try {
    const resolvedPath = await realpath(path);
    const stats = await lstat(resolvedPath);
    await access(resolvedPath, constants.X_OK);
    if (!stats.isFile()) throw new Error("not a regular file");
    return resolvedPath;
  } catch (error) {
    throw new ManagedInstallError("invalid_manager_path", `Bun path is not an executable regular file: ${path}`, { cause: error });
  }
}

async function inspectInstallDestination(destination: string, packageSpec: string): Promise<ManagedInstallInventory> {
  const path = normalizeDestination(destination);
  let existing = false;
  let resolvedDestination: string;
  let entries: readonly ManagedInstallRootEntry[] = [];
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new ManagedInstallError("invalid_destination", `install destination must be an actual directory or absent: ${path}`);
    }
    existing = true;
    resolvedDestination = await realpath(path);
    entries = (await readdir(path, { withFileTypes: true }))
      .map((entry) => ({ name: entry.name, state: direntState(entry) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      if (error instanceof ManagedInstallError) throw error;
      throw new ManagedInstallError("inspection_failed", `install destination could not be inspected: ${path}`, { cause: error });
    }
    const parent = dirname(path);
    try {
      const parentStats = await lstat(parent);
      if (!parentStats.isDirectory()) throw new Error("parent is not a directory");
      resolvedDestination = join(await realpath(parent), basename(path));
    } catch (parentError) {
      throw new ManagedInstallError("invalid_destination", `install destination parent is unavailable: ${parent}`, { cause: parentError });
    }
  }

  const manifest = await inspectManifest(path, packageSpec);
  const installedPackage = await inspectInstalledPackage(path, packageSpec);
  const dedicatedToolRoot = !existing
    || entries.length === 0
    || (manifest.inventory.state === "file"
      && manifest.inventory.managedToolRoot
      && entries.every(isManagedRootEntry));
  return {
    destination: path,
    resolvedDestination,
    existing,
    dedicatedToolRoot,
    entries,
    packageJson: manifest.inventory,
    packageEntry: manifest.packageEntry,
    installedPackage,
  };
}

async function inspectManifest(
  destination: string,
  packageSpec: string,
): Promise<{ readonly inventory: ManagedInstallPackageJsonInventory; readonly packageEntry: ManagedInstallPackageEntry | null }> {
  const path = join(destination, "package.json");
  let content: Buffer;
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) return { inventory: { state: "unsupported" }, packageEntry: null };
    content = await readFile(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { inventory: { state: "absent" }, packageEntry: null };
    throw new ManagedInstallError("inspection_failed", `package.json could not be inventoried: ${path}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const manifest = isRecord(parsed) ? parsed : undefined;
  const validJson = manifest !== undefined;
  const managedToolRoot = manifest?.openinstinctManagedToolRoot === 1;
  return {
    inventory: {
      state: "file",
      sha256: sha256(content),
      bytes: content.byteLength,
      validJson,
      managedToolRoot,
    },
    packageEntry: manifest === undefined ? null : findPackageEntry(manifest, packageNameFromSpec(packageSpec)),
  };
}

async function inspectInstalledPackage(destination: string, packageSpec: string): Promise<InstalledPackageInventory> {
  const name = packageNameFromSpec(packageSpec);
  const path = join(destination, "node_modules", ...name.split("/"), "package.json");
  let content: Buffer;
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) return { state: "unsupported" };
    content = await readFile(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { state: "absent" };
    throw new ManagedInstallError("inspection_failed", `installed package metadata could not be read: ${path}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    parsed = undefined;
  }
  return {
    state: "file",
    path,
    sha256: sha256(content),
    bytes: content.byteLength,
    name: isRecord(parsed) && typeof parsed.name === "string" ? parsed.name : null,
    version: isRecord(parsed) && typeof parsed.version === "string" ? parsed.version : null,
  };
}

function findPackageEntry(manifest: Record<string, unknown>, packageName: string): ManagedInstallPackageEntry | null {
  for (const section of PACKAGE_SECTIONS) {
    const dependencies = manifest[section];
    if (!isRecord(dependencies)) continue;
    const value = dependencies[packageName];
    if (typeof value === "string") return { section, name: packageName, value };
  }
  return null;
}

function packageInstalled(plan: ManagedInstallPlan, inventory: ManagedInstallInventory): boolean {
  const requested = parsePackageSpec(plan.packageSpec);
  return inventory.packageJson.state === "file"
    && inventory.packageJson.validJson
    && (!plan.precondition.dedicatedToolRoot || inventory.packageJson.managedToolRoot)
    && inventory.packageEntry?.name === requested.name
    && inventory.packageEntry.value === requested.version
    && inventory.installedPackage.state === "file"
    && inventory.installedPackage.name === requested.name
    && inventory.installedPackage.version === requested.version;
}

async function prepareDestination(plan: ManagedInstallPlan): Promise<PreparedDestination> {
  let createdDestination = false;
  let createdManifest = false;
  if (!plan.precondition.existing) {
    await mkdir(plan.destination, { mode: 0o700 });
    createdDestination = true;
  }
  if (plan.precondition.dedicatedToolRoot && plan.precondition.packageJson.state === "absent") {
    await writeFile(join(plan.destination, "package.json"), MANAGED_MANIFEST, { encoding: "utf8", flag: "wx", mode: 0o600 });
    createdManifest = true;
  }
  return { createdDestination, createdManifest };
}

async function cleanupUntouchedPreparation(
  plan: ManagedInstallPlan,
  prepared: PreparedDestination,
  inventory: ManagedInstallInventory | undefined,
): Promise<boolean> {
  if (!prepared.createdManifest || inventory === undefined) return true;
  if (
    inventory.packageJson.state !== "file"
    || inventory.packageJson.sha256 !== MANAGED_MANIFEST_SHA256
    || inventory.entries.length !== 1
    || inventory.entries[0]?.name !== "package.json"
    || inventory.entries[0].state !== "file"
  ) {
    return true;
  }
  try {
    await unlink(join(plan.destination, "package.json"));
    if (prepared.createdDestination) await rmdir(plan.destination);
    return true;
  } catch {
    return false;
  }
}

async function safeInventory(plan: ManagedInstallPlan): Promise<ManagedInstallInventory | undefined> {
  try {
    return await inspectInstallDestination(plan.destination, plan.packageSpec);
  } catch {
    return undefined;
  }
}

function noChangeProven(plan: ManagedInstallPlan, final: ManagedInstallInventory | undefined): boolean {
  const baselineWasEmpty = !plan.precondition.existing
    || (plan.precondition.entries.length === 0 && plan.precondition.packageJson.state === "absent");
  return plan.options.ignoreScripts
    && baselineWasEmpty
    && final !== undefined
    && inventoryMatches(plan.precondition, final);
}

async function spawnInstall(
  plan: ManagedInstallPlan,
  signal: AbortSignal | undefined,
  options: { readonly env?: NodeJS.ProcessEnv; readonly killGraceMs: number; readonly maxOutputBytes: number },
): Promise<ChildExit> {
  if (signal?.aborted) {
    return {
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      started: false,
      cancelled: true,
      processGroupQuiescent: true,
    };
  }
  const argv = installArgv(plan);
  return await new Promise((resolveChild) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: plan.destination,
        env: options.env ?? process.env,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolveChild({
        code: null,
        signal: null,
        error: asError(error),
        stdout: "",
        stderr: "",
        outputTruncated: false,
        started: false,
        cancelled: false,
        processGroupQuiescent: true,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let started = child.pid !== undefined;
    let cancelled = false;
    let settled = false;
    let cancellationCleanup: Promise<void> | undefined;
    let directOutcome: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: Error } | undefined;
    const pid = child.pid;
    const append = (current: string, chunk: Buffer): string => {
      const remaining = options.maxOutputBytes - Buffer.byteLength(current, "utf8");
      if (remaining <= 0) {
        outputTruncated = true;
        return current;
      }
      if (chunk.byteLength > remaining) outputTruncated = true;
      return `${current}${chunk.subarray(0, remaining).toString("utf8")}`;
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });

    const resolveOutcome = (
      outcome: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: Error },
      processGroupQuiescent: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolveChild({
        ...outcome,
        stdout,
        stderr,
        outputTruncated,
        started,
        cancelled,
        processGroupQuiescent,
      });
    };
    // The group leader can close after SIGTERM while descendants remain. Keep
    // cancellation ownership until the grace-period SIGKILL and an observed
    // process-group disappearance; direct-child close alone never settles it.
    const finishCancellation = async (): Promise<void> => {
      await delay(options.killGraceMs);
      killProcessGroup(pid, "SIGKILL", child.kill.bind(child));
      const processGroupQuiescent = await waitForProcessGroupExit(pid, PROCESS_GROUP_QUIESCENCE_TIMEOUT_MS);
      resolveOutcome(directOutcome ?? { code: null, signal: "SIGKILL" }, processGroupQuiescent);
    };
    const abort = (): void => {
      if (cancelled) return;
      cancelled = true;
      killProcessGroup(pid, "SIGTERM", child.kill.bind(child));
      cancellationCleanup ??= finishCancellation();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    const finishDirectChild = (outcome: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: Error }): void => {
      if (cancelled) {
        directOutcome = outcome;
        return;
      }
      resolveOutcome(outcome, true);
    };
    child.once("spawn", () => { started = true; });
    child.once("error", (error) => finishDirectChild({ code: null, signal: null, error }));
    child.once("close", (code, exitSignal) => finishDirectChild({ code, signal: exitSignal }));
  });
}

async function waitForProcessGroupExit(pid: number | undefined, timeoutMs: number): Promise<boolean> {
  if (!pid || pid <= 0) return true;
  if (process.platform === "win32") return false;
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(PROCESS_GROUP_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    return true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function killProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: (signal?: NodeJS.Signals | number) => boolean,
): void {
  if (!pid || pid <= 0) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
    } catch {
      // Absence is confirmed separately; never broaden a failed group signal.
    }
    return;
  }
  try {
    fallback(signal);
  } catch {
    // Never broaden cancellation into a name-based or global process kill.
  }
}

function settleConfirmed(
  input: ExecuteManagedInstallInput,
  evidence: JsonValue,
  now: () => string,
): ManagedInstallExecutionResult {
  try {
    const transition = input.repository.confirmAttempt({
      attemptId: input.attemptId,
      workerId: input.workerId,
      outcome: {
        code: "managed_install_verified",
        message: "Bun exited successfully and both package metadata records matched",
        retryable: false,
        evidence,
      },
    }, now());
    return { kind: "confirmed", ...transition, evidence };
  } catch (error) {
    throw new ManagedInstallExecutionError("confirmation", true, "install was verified, but durable confirmation failed; do not replay it", { cause: error });
  }
}

function settleDefinitive(
  input: ExecuteManagedInstallInput,
  evidence: JsonValue,
  now: () => string,
): ManagedInstallExecutionResult {
  try {
    const transition = input.repository.failAttemptDefinitively({
      attemptId: input.attemptId,
      workerId: input.workerId,
      outcome: evidence,
    }, now());
    return { kind: "definitive_failed", ...transition, evidence };
  } catch (error) {
    throw new ManagedInstallExecutionError("settlement", false, "definitive install failure could not be persisted", { cause: error });
  }
}

function settleAmbiguous(
  input: ExecuteManagedInstallInput,
  evidence: JsonValue,
  now: () => string,
): ManagedInstallExecutionResult {
  try {
    const transition = input.repository.markAttemptAmbiguous({
      attemptId: input.attemptId,
      workerId: input.workerId,
      outcome: evidence,
    }, now());
    return { kind: "ambiguous", ...transition, evidence };
  } catch (error) {
    throw new ManagedInstallExecutionError("settlement", true, "ambiguous install outcome could not be persisted; do not replay it", { cause: error });
  }
}

function noEffectEvidence(
  code: string,
  plan: ManagedInstallPlan,
  inventory: ManagedInstallInventory,
  verifiedAt: string,
): JsonValue {
  return {
    code,
    message: "the managed Bun process was not invoked",
    retryable: false,
    effectInvoked: false,
    evidence: installEvidence(plan, inventory, verifiedAt),
  };
}

function failureEvidence(
  code: string,
  error: unknown,
  plan: ManagedInstallPlan,
  inventory: ManagedInstallInventory | undefined,
  verifiedAt: string,
  effectInvoked = false,
): JsonValue {
  return {
    code,
    message: errorMessage(error),
    retryable: false,
    effectInvoked,
    error: errorToJson(error),
    ...(inventory === undefined ? {} : { evidence: installEvidence(plan, inventory, verifiedAt) }),
  };
}

function installEvidence(plan: ManagedInstallPlan, inventory: ManagedInstallInventory, verifiedAt: string): JsonValue {
  return {
    kind: "managed_bun_install_inventory",
    version: 1,
    verifiedAt,
    packageSpec: plan.packageSpec,
    destination: plan.destination,
    inventory: inventoryToJson(inventory),
  };
}

// Registry diagnostics can include credential-bearing URLs, so durable evidence
// records bounded byte counts and digests rather than raw process output.
function processToJson(plan: ManagedInstallPlan, outcome: ChildExit): JsonValue {
  return {
    manager: "bun",
    managerPath: plan.managerPath,
    argv: installArgv(plan),
    cwd: plan.destination,
    started: outcome.started,
    exitCode: outcome.code,
    signal: outcome.signal,
    cancelled: outcome.cancelled,
    processGroupQuiescent: outcome.processGroupQuiescent,
    outputTruncated: outcome.outputTruncated,
    stdoutBytes: Buffer.byteLength(outcome.stdout, "utf8"),
    stdoutSha256: sha256(Buffer.from(outcome.stdout, "utf8")),
    stderrBytes: Buffer.byteLength(outcome.stderr, "utf8"),
    stderrSha256: sha256(Buffer.from(outcome.stderr, "utf8")),
  };
}

function inventoryMatches(expected: ManagedInstallInventory, actual: ManagedInstallInventory): boolean {
  return canonicalJson(inventoryToJson(expected)) === canonicalJson(inventoryToJson(actual));
}

function inventoryToJson(inventory: ManagedInstallInventory): { readonly [key: string]: JsonValue } {
  return {
    destination: inventory.destination,
    resolvedDestination: inventory.resolvedDestination,
    existing: inventory.existing,
    dedicatedToolRoot: inventory.dedicatedToolRoot,
    entries: inventory.entries.map((entry) => ({ name: entry.name, state: entry.state })),
    packageJson: packageJsonToJson(inventory.packageJson),
    packageEntry: inventory.packageEntry === null ? null : {
      section: inventory.packageEntry.section,
      name: inventory.packageEntry.name,
      value: inventory.packageEntry.value,
    },
    installedPackage: installedPackageToJson(inventory.installedPackage),
  };
}

function packageJsonToJson(inventory: ManagedInstallPackageJsonInventory): JsonValue {
  if (inventory.state !== "file") return { state: inventory.state };
  return {
    state: "file",
    sha256: inventory.sha256,
    bytes: inventory.bytes,
    validJson: inventory.validJson,
    managedToolRoot: inventory.managedToolRoot,
  };
}

function installedPackageToJson(inventory: InstalledPackageInventory): JsonValue {
  if (inventory.state !== "file") return { state: inventory.state };
  return {
    state: "file",
    path: inventory.path,
    sha256: inventory.sha256,
    bytes: inventory.bytes,
    name: inventory.name,
    version: inventory.version,
  };
}

function optionsToJson(options: ManagedInstallOptions): { readonly [key: string]: JsonValue } {
  return { exact: true, ignoreScripts: options.ignoreScripts };
}

function parseInventory(value: JsonValue | undefined): ManagedInstallInventory {
  const object = jsonObject(value, "managed install inventory");
  assertExactKeys(
    object,
    ["dedicatedToolRoot", "destination", "entries", "existing", "installedPackage", "packageEntry", "packageJson", "resolvedDestination"],
    "managed install inventory",
  );
  if (
    typeof object.destination !== "string"
    || typeof object.resolvedDestination !== "string"
    || typeof object.existing !== "boolean"
    || typeof object.dedicatedToolRoot !== "boolean"
    || !Array.isArray(object.entries)
  ) {
    throw new ManagedInstallError("invalid_plan", "managed install inventory fields are invalid");
  }
  const entries = object.entries.map((entry, index) => parseRootEntry(entry, index));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.name.localeCompare(entries[index]!.name) >= 0) {
      throw new ManagedInstallError("invalid_plan", "managed install root entries must be unique and sorted");
    }
  }
  const packageJson = parsePackageJsonInventory(object.packageJson);
  const packageEntry = object.packageEntry === null ? null : parsePackageEntry(object.packageEntry);
  const installedPackage = parseInstalledPackage(object.installedPackage);
  if (!object.existing && (entries.length !== 0 || packageJson.state !== "absent" || installedPackage.state !== "absent")) {
    throw new ManagedInstallError("invalid_plan", "absent install inventory cannot contain package assets");
  }
  if (packageEntry !== null && packageJson.state !== "file") {
    throw new ManagedInstallError("invalid_plan", "package entry requires a package.json file");
  }
  return {
    destination: requireNormalizedAbsolutePath(object.destination, "inventory destination"),
    resolvedDestination: requireNormalizedAbsolutePath(object.resolvedDestination, "resolved inventory destination"),
    existing: object.existing,
    dedicatedToolRoot: object.dedicatedToolRoot,
    entries,
    packageJson,
    packageEntry,
    installedPackage,
  };
}

function parseRootEntry(value: JsonValue, index: number): ManagedInstallRootEntry {
  const object = jsonObject(value, `managed install root entry ${index}`);
  assertExactKeys(object, ["name", "state"], `managed install root entry ${index}`);
  if (typeof object.name !== "string" || object.name.length === 0 || object.name.includes("/") || !isRootEntryState(object.state)) {
    throw new ManagedInstallError("invalid_plan", `managed install root entry ${index} is invalid`);
  }
  return { name: object.name, state: object.state };
}

function parsePackageJsonInventory(value: JsonValue | undefined): ManagedInstallPackageJsonInventory {
  const object = jsonObject(value, "managed install package.json inventory");
  if (object.state === "absent" || object.state === "unsupported") {
    assertExactKeys(object, ["state"], "managed install package.json inventory");
    return { state: object.state };
  }
  assertExactKeys(object, ["bytes", "managedToolRoot", "sha256", "state", "validJson"], "managed install package.json inventory");
  if (
    object.state !== "file"
    || !isDigest(object.sha256)
    || !isNonNegativeInteger(object.bytes)
    || typeof object.validJson !== "boolean"
    || typeof object.managedToolRoot !== "boolean"
  ) {
    throw new ManagedInstallError("invalid_plan", "managed install package.json inventory is invalid");
  }
  return {
    state: "file",
    sha256: object.sha256,
    bytes: object.bytes,
    validJson: object.validJson,
    managedToolRoot: object.managedToolRoot,
  };
}

function parsePackageEntry(value: JsonValue): ManagedInstallPackageEntry {
  const object = jsonObject(value, "managed install package entry");
  assertExactKeys(object, ["name", "section", "value"], "managed install package entry");
  if (!isPackageSection(object.section) || typeof object.name !== "string" || typeof object.value !== "string") {
    throw new ManagedInstallError("invalid_plan", "managed install package entry is invalid");
  }
  return { section: object.section, name: object.name, value: object.value };
}

function parseInstalledPackage(value: JsonValue | undefined): InstalledPackageInventory {
  const object = jsonObject(value, "managed install installed package inventory");
  if (object.state === "absent" || object.state === "unsupported") {
    assertExactKeys(object, ["state"], "managed install installed package inventory");
    return { state: object.state };
  }
  assertExactKeys(object, ["bytes", "name", "path", "sha256", "state", "version"], "managed install installed package inventory");
  if (
    object.state !== "file"
    || typeof object.path !== "string"
    || !isDigest(object.sha256)
    || !isNonNegativeInteger(object.bytes)
    || (object.name !== null && typeof object.name !== "string")
    || (object.version !== null && typeof object.version !== "string")
  ) {
    throw new ManagedInstallError("invalid_plan", "managed install installed package inventory is invalid");
  }
  return {
    state: "file",
    path: requireNormalizedAbsolutePath(object.path, "installed package metadata path"),
    sha256: object.sha256,
    bytes: object.bytes,
    name: object.name,
    version: object.version,
  };
}

function parseOptions(value: JsonValue | undefined): ManagedInstallOptions {
  const object = jsonObject(value, "managed install options");
  assertExactKeys(object, ["exact", "ignoreScripts"], "managed install options");
  if (object.exact !== true || typeof object.ignoreScripts !== "boolean") {
    throw new ManagedInstallError("invalid_plan", "managed install options require exact=true and a boolean ignoreScripts");
  }
  return { exact: true, ignoreScripts: object.ignoreScripts };
}

function normalizePackageSpec(input: string): string {
  if (typeof input !== "string" || input !== input.trim()) {
    throw new ManagedInstallError("invalid_package_spec", "packageSpec must not contain surrounding whitespace");
  }
  const spec = input;
  if (spec.length === 0 || spec.length > 512 || spec.includes("\0") || /\s/.test(spec) || spec.startsWith("-")) {
    throw new ManagedInstallError("invalid_package_spec", "packageSpec must be one whitespace-free package@version token");
  }
  parsePackageSpec(spec);
  return spec;
}

function parsePackageSpec(spec: string): { readonly name: string; readonly version: string } {
  const separator = spec.startsWith("@") ? spec.indexOf("@", spec.indexOf("/") + 1) : spec.lastIndexOf("@");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new ManagedInstallError("invalid_package_spec", "packageSpec must pin an exact version, for example pkg@1.2.3");
  }
  const name = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  if (!/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(name)) {
    throw new ManagedInstallError("invalid_package_spec", `packageSpec has an invalid package name: ${spec}`);
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new ManagedInstallError("invalid_package_spec", `packageSpec must use an exact semantic version: ${spec}`);
  }
  return { name, version };
}

function packageNameFromSpec(spec: string): string {
  return parsePackageSpec(spec).name;
}

function normalizeDestination(input: string): string {
  if (typeof input !== "string" || input !== input.trim()) {
    throw new ManagedInstallError("invalid_destination", "destination must not contain surrounding whitespace");
  }
  const path = requireNormalizedAbsolutePath(input, "destination");
  if (basename(path).length === 0) {
    throw new ManagedInstallError("invalid_destination", "filesystem roots cannot be install destinations");
  }
  return path;
}

function requireNormalizedAbsolutePath(input: string, label: string): string {
  const code = label === "managerPath" ? "invalid_manager_path" : "invalid_destination";
  if (!isAbsolute(input) || input.includes("\0")) {
    throw new ManagedInstallError(code, `${label} must be an absolute path`);
  }
  const normalized = resolve(input);
  if (normalized !== input) {
    throw new ManagedInstallError(code, `${label} must be normalized and contain no traversal: ${input}`);
  }
  return input;
}

const CORE_ROOTS = [
  "/Applications", "/Library", "/System", "/bin", "/boot", "/dev", "/etc", "/opt", "/private/etc",
  "/private/var/db", "/private/var/root", "/proc", "/root", "/sbin", "/sys", "/usr",
] as const;

function isCorePath(path: string): boolean {
  if (CORE_ROOTS.some((root) => pathIsWithin(path, root))) return true;
  const normalized = policyPath(path);
  return normalized.includes("/library/launchagents/")
    || normalized.endsWith("/library/launchagents")
    || normalized.includes("/library/launchdaemons/")
    || normalized.endsWith("/library/launchdaemons");
}

function isAccountRightsPath(path: string): boolean {
  const normalized = policyPath(path);
  return normalized.includes("/.ssh/")
    || normalized.endsWith("/.ssh")
    || normalized.includes("/.gnupg/")
    || normalized.endsWith("/.gnupg")
    || normalized.includes("/library/application support/com.apple.tcc/")
    || normalized.endsWith("/library/application support/com.apple.tcc")
    || normalized.includes("/library/keychains/")
    || normalized.endsWith("/library/keychains");
}

function pathIsWithin(candidate: string, root: string): boolean {
  const offset = relative(policyPath(root), policyPath(candidate));
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function policyPath(path: string): string {
  return process.platform === "darwin" ? path.toLocaleLowerCase("en-US") : path;
}

function isManagedRootEntry(entry: ManagedInstallRootEntry): boolean {
  return (entry.name === "package.json" && entry.state === "file")
    || ((entry.name === "bun.lock" || entry.name === "bun.lockb") && entry.state === "file")
    || (entry.name === "node_modules" && entry.state === "directory");
}

function direntState(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): ManagedInstallRootEntry["state"] {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function rejectionForAttempt(state: AttemptRecord["state"]): ClaimRejectionReason | undefined {
  switch (state) {
    case "claimed_pre_effect":
      return undefined;
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

function rejectionForTerminalAction(state: ActionRecord["state"]): ClaimRejectionReason | undefined {
  switch (state) {
    case "planned":
    case "claimed_pre_effect":
      return undefined;
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
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

function proposalText(action: ActionRecord): string {
  const identity = `action ${action.id} revision ${action.revision} digest ${action.digest}`;
  if (action.state === "planned") {
    return `Prepared ${identity}. No install has run. Execute assistant_managed_install with operation=execute and this exact actionId, revision, and digest.`;
  }
  return `Recorded ${identity} in state ${action.state}. No install has run.`;
}

function executionText(result: ManagedInstallExecutionResult, actionId: string, revision: number): string {
  if (result.kind === "confirmed") return `Confirmed action ${actionId} revision ${revision}. Bun exited successfully and package metadata verified the install.`;
  if (result.kind === "ambiguous") return `Action ${actionId} revision ${revision} is ambiguous after effect_started. Do not retry it; reconcile the recorded inventory.`;
  if (result.kind === "definitive_failed") return `Action ${actionId} revision ${revision} failed definitively. No blind retry was attempted.`;
  if (result.kind === "preflight_rejected") return `Did not dispatch action ${actionId} revision ${revision}: ${result.message}. Re-propose from current host evidence.`;
  if (result.kind === "rejected") {
    return `Did not dispatch action ${actionId} revision ${revision}: ${result.reason}. No new install was invoked.`;
  }
  throw new Error(`Unexpected install result: ${result.kind}`);
}

function executionDetails(result: ManagedInstallExecutionResult, attemptId: string): Record<string, unknown> {
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
    ...(action.activeAttemptId === undefined ? {} : { activeAttemptId: action.activeAttemptId }),
  };
}

function attemptSummary(attempt: AttemptRecord): Record<string, unknown> {
  return {
    id: attempt.id,
    actionId: attempt.actionId,
    actionRevision: attempt.actionRevision,
    actionDigest: attempt.actionDigest,
    state: attempt.state,
    claimedAt: attempt.claimedAt,
    ...(attempt.effectStartedAt === undefined ? {} : { effectStartedAt: attempt.effectStartedAt }),
    ...(attempt.settledAt === undefined ? {} : { settledAt: attempt.settledAt }),
    ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome }),
  };
}

function rejectExecutionFieldsOnProposal(input: ManagedInstallToolParams): void {
  if (input.actionId !== undefined || input.revision !== undefined || input.digest !== undefined) {
    throw new Error("install proposal must not include actionId, revision, or digest");
  }
}

function rejectProposalFieldsOnExecution(input: ManagedInstallToolParams): void {
  if (
    input.workId !== undefined
    || input.semanticKey !== undefined
    || input.packageSpec !== undefined
    || input.destination !== undefined
    || input.ignoreScripts !== undefined
  ) {
    throw new Error("install execution accepts only actionId, revision, and digest");
  }
}

function requiredTrimmed(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredString(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requiredRevision(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("revision must be a positive integer");
  return value as number;
}

function requiredDigest(value: string | undefined): string {
  const digest = requiredTrimmed(value, "digest");
  if (!isDigest(digest)) throw new Error("digest must be a lowercase sha256 digest");
  return digest;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function jsonObject(value: JsonValue | undefined, label: string): { readonly [key: string]: JsonValue } {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedInstallError("invalid_plan", `${label} must be an object`);
  }
  return value as { readonly [key: string]: JsonValue };
}

function assertExactKeys(object: { readonly [key: string]: JsonValue }, expected: readonly string[], label: string): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ManagedInstallError("invalid_plan", `${label} contains unsupported or missing fields`);
  }
}

function isPackageSection(value: JsonValue | undefined): value is ManagedInstallPackageSection {
  return value === "dependencies" || value === "devDependencies" || value === "optionalDependencies" || value === "peerDependencies";
}

function isRootEntryState(value: JsonValue | undefined): value is ManagedInstallRootEntry["state"] {
  return value === "file" || value === "directory" || value === "symlink" || value === "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function isNonNegativeInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDigest(value: JsonValue | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorToJson(error: unknown): JsonValue {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) };
  }
  return { message: String(error) };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
