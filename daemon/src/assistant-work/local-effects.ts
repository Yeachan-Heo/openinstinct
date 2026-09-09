import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { EffectClass, JsonValue, ProposeActionInput } from "./model.ts";

export const MANAGED_LOCAL_FILE_ACTION = "apply_local_file_plan";

export type LocalFileOperation =
  | { readonly operation: "write_file"; readonly path: string; readonly content: string }
  | { readonly operation: "delete_file"; readonly path: string };

interface LocalPathBase {
  readonly path: string;
  readonly parentPath: string;
  readonly resolvedPath: string;
  readonly resolvedParentPath: string;
}

export type LocalPathInventoryEntry =
  | (LocalPathBase & { readonly state: "absent"; readonly existingAsset: false })
  | (LocalPathBase & {
    readonly state: "file";
    readonly existingAsset: true;
    readonly sha256: string;
    readonly bytes: number;
    readonly mode: number;
  })
  | (LocalPathBase & {
    readonly state: "symlink";
    readonly existingAsset: true;
    readonly sha256: string;
    readonly bytes: number;
    readonly mode: number;
  })
  | (LocalPathBase & {
    readonly state: "directory" | "other";
    readonly existingAsset: true;
    readonly mode: number;
  });

export type LocalPathPrecondition = Extract<LocalPathInventoryEntry, { readonly state: "absent" | "file" }>;

export type PreparedLocalFileOperation =
  | {
    readonly operation: "write_file";
    readonly path: string;
    readonly content: string;
    readonly precondition: LocalPathPrecondition;
  }
  | {
    readonly operation: "delete_file";
    readonly path: string;
    readonly precondition: LocalPathPrecondition;
  };

export interface LocalFilePlan {
  readonly version: 1;
  readonly operations: readonly PreparedLocalFileOperation[];
}

export interface PreflightLocalFileActionInput {
  readonly workId: string;
  readonly semanticKey: string;
  readonly operations: readonly LocalFileOperation[];
}

export interface PreflightLocalFileActionResult {
  readonly effectClass: Extract<
    EffectClass,
    "ordinary_local_edit" | "delete_existing" | "bulk_existing_user_assets" | "core_setting_change" | "account_rights_change"
  >;
  readonly inventory: readonly LocalPathInventoryEntry[];
  readonly plan: LocalFilePlan;
  readonly proposal: ProposeActionInput;
}

export interface LocalFilePlanInspection {
  readonly effectClass: PreflightLocalFileActionResult["effectClass"];
  readonly inventory: readonly LocalPathInventoryEntry[];
  readonly preconditionsMatch: boolean;
  readonly mismatchedPaths: readonly string[];
}

export type LocalEffectPreflightErrorCode =
  | "invalid_plan"
  | "invalid_path"
  | "parent_unavailable"
  | "path_inspection_failed"
  | "path_changed_during_inventory"
  | "unsupported_target_type"
  | "duplicate_target";

export class LocalEffectPreflightError extends Error {
  public constructor(
    public readonly code: LocalEffectPreflightErrorCode,
    message: string,
    public readonly targetPath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalEffectPreflightError";
  }
}

/**
 * Builds the only payload accepted by the managed local-file executor. The
 * caller supplies intent (write/delete), while this host-side pass inventories
 * the actual paths and derives the effect class. A model-supplied class is
 * never accepted as input.
 *
 * This optional managed executor verifies regular-file changes and records results.
 * Native runtime tools remain available for other filesystem operations.
 */
export async function preflightLocalFileAction(
  input: PreflightLocalFileActionInput,
): Promise<PreflightLocalFileActionResult> {
  assertNonEmpty(input.workId, "workId");
  assertNonEmpty(input.semanticKey, "semanticKey");
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new LocalEffectPreflightError("invalid_plan", "local file plan must contain at least one operation");
  }

  const normalizedOperations = input.operations.map(normalizeOperation);
  assertNoDuplicateLexicalTargets(normalizedOperations);
  const inventory = await inspectOperations(normalizedOperations);
  assertNoDuplicateResolvedTargets(inventory);
  inventory.forEach(assertSupportedTarget);

  const operations = normalizedOperations.map((operation, index): PreparedLocalFileOperation => ({
    ...operation,
    precondition: inventory[index] as LocalPathPrecondition,
  }));
  const plan: LocalFilePlan = { version: 1, operations };
  const effectClass = classifyLocalFileEffect(operations, inventory);
  const proposal: ProposeActionInput = {
    workId: input.workId,
    semanticKey: input.semanticKey,
    effectClass,
    action: MANAGED_LOCAL_FILE_ACTION,
    payload: localFilePlanToJson(plan),
    scope: {
      kind: "managed_local_files",
      inventory: inventory.map(localPathInventoryToJson),
    },
  };

  return { effectClass, inventory, plan, proposal };
}

/** Re-inventories a persisted plan immediately before dispatch or mutation. */
export async function inspectLocalFilePlan(plan: LocalFilePlan): Promise<LocalFilePlanInspection> {
  if (plan.version !== 1 || plan.operations.length === 0) {
    throw new LocalEffectPreflightError("invalid_plan", "unsupported or empty local file plan");
  }
  const inventory = await inspectOperations(plan.operations);
  assertNoDuplicateResolvedTargets(inventory);
  inventory.forEach(assertSupportedTarget);
  const mismatchedPaths = plan.operations
    .filter((operation, index) => !localPathPreconditionMatches(operation.precondition, inventory[index]!))
    .map((operation) => operation.path);
  return {
    effectClass: classifyLocalFileEffect(plan.operations, inventory),
    inventory,
    preconditionsMatch: mismatchedPaths.length === 0,
    mismatchedPaths,
  };
}

export function classifyLocalFileEffect(
  operations: readonly PreparedLocalFileOperation[],
  inventory: readonly LocalPathInventoryEntry[],
): PreflightLocalFileActionResult["effectClass"] {
  if (operations.length === 0 || operations.length !== inventory.length) {
    throw new LocalEffectPreflightError("invalid_plan", "local file operation and inventory counts must match");
  }
  for (const [index, operation] of operations.entries()) {
    if (operation.path !== inventory[index]!.path) {
      throw new LocalEffectPreflightError("invalid_plan", `inventory path does not match operation: ${operation.path}`);
    }
  }

  if (inventory.some(isAccountRightsPath)) {
    return "account_rights_change";
  }
  if (inventory.some(isCoreSystemPath)) {
    return "core_setting_change";
  }
  if (operations.some((operation, index) => operation.operation === "delete_file" && inventory[index]!.existingAsset)) {
    return "delete_existing";
  }

  const existingAssetFolders = new Set(
    inventory.filter((entry) => entry.existingAsset).map((entry) => policyPath(entry.resolvedParentPath)),
  );
  if (existingAssetFolders.size > 1) {
    return "bulk_existing_user_assets";
  }
  return "ordinary_local_edit";
}

export function parseLocalFilePlan(payload: JsonValue): LocalFilePlan {
  const object = jsonObject(payload, "local file payload");
  assertExactKeys(object, ["operations", "version"], "local file payload");
  if (object.version !== 1 || !Array.isArray(object.operations) || object.operations.length === 0) {
    throw new LocalEffectPreflightError("invalid_plan", "local file payload must be a non-empty version 1 plan");
  }

  const operations = object.operations.map((value, index) => parsePreparedOperation(value, index));
  assertNoDuplicateLexicalTargets(operations);
  return { version: 1, operations };
}

export function localFilePlanToJson(plan: LocalFilePlan): JsonValue {
  return {
    version: 1,
    operations: plan.operations.map((operation) => ({
      operation: operation.operation,
      path: operation.path,
      ...(operation.operation === "write_file" ? { content: operation.content } : {}),
      precondition: localPathInventoryToJson(operation.precondition),
    })),
  };
}

export function localPathInventoryToJson(entry: LocalPathInventoryEntry): { readonly [key: string]: JsonValue } {
  return {
    path: entry.path,
    parentPath: entry.parentPath,
    resolvedPath: entry.resolvedPath,
    resolvedParentPath: entry.resolvedParentPath,
    state: entry.state,
    existingAsset: entry.existingAsset,
    ...(entry.state === "file" || entry.state === "symlink"
      ? { sha256: entry.sha256, bytes: entry.bytes, mode: entry.mode }
      : entry.state === "directory" || entry.state === "other"
        ? { mode: entry.mode }
        : {}),
  };
}

export function localPathPreconditionMatches(
  expected: LocalPathPrecondition,
  actual: LocalPathInventoryEntry,
): boolean {
  if (
    expected.path !== actual.path
    || expected.parentPath !== actual.parentPath
    || expected.resolvedPath !== actual.resolvedPath
    || expected.resolvedParentPath !== actual.resolvedParentPath
    || expected.state !== actual.state
    || expected.existingAsset !== actual.existingAsset
  ) {
    return false;
  }
  if (expected.state === "absent") {
    return true;
  }
  return actual.state === "file"
    && expected.sha256 === actual.sha256
    && expected.bytes === actual.bytes
    && expected.mode === actual.mode;
}

export function localContentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function inspectOperations(
  operations: readonly Pick<PreparedLocalFileOperation, "path">[],
): Promise<readonly LocalPathInventoryEntry[]> {
  const inventory: LocalPathInventoryEntry[] = [];
  for (const operation of operations) {
    inventory.push(await inspectPath(operation.path));
  }
  return inventory;
}

async function inspectPath(inputPath: string): Promise<LocalPathInventoryEntry> {
  const path = normalizedAbsoluteTarget(inputPath);
  const parentPath = dirname(path);
  const name = basename(path);
  let resolvedParentPath: string;
  try {
    resolvedParentPath = await realpath(parentPath);
    const parent = await stat(resolvedParentPath);
    if (!parent.isDirectory()) {
      throw new Error("parent is not a directory");
    }
  } catch (error) {
    throw new LocalEffectPreflightError(
      "parent_unavailable",
      `local file parent is unavailable or is not a directory: ${parentPath}`,
      path,
      { cause: error },
    );
  }
  const resolvedPath = join(resolvedParentPath, name);
  const base = { path, parentPath, resolvedPath, resolvedParentPath } as const;

  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(resolvedPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { ...base, state: "absent", existingAsset: false };
    }
    throw new LocalEffectPreflightError(
      "path_inspection_failed",
      `local file path could not be inspected: ${path}`,
      path,
      { cause: error },
    );
  }

  if (before.isFile()) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!sameFileIdentity(before, opened)) {
        throw new LocalEffectPreflightError(
          "path_changed_during_inventory",
          `local file changed while it was being inventoried: ${path}`,
          path,
        );
      }
      const content = await handle.readFile();
      const after = await lstat(resolvedPath);
      if (!sameStableFile(opened, after)) {
        throw new LocalEffectPreflightError(
          "path_changed_during_inventory",
          `local file changed while it was being inventoried: ${path}`,
          path,
        );
      }
      return {
        ...base,
        state: "file",
        existingAsset: true,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
        mode: after.mode & 0o7777,
      };
    } catch (error) {
      if (error instanceof LocalEffectPreflightError) {
        throw error;
      }
      throw new LocalEffectPreflightError(
        "path_inspection_failed",
        `local file content could not be inventoried: ${path}`,
        path,
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  if (before.isSymbolicLink()) {
    try {
      const target = await readlink(resolvedPath);
      const after = await lstat(resolvedPath);
      if (!sameStableFile(before, after)) {
        throw new LocalEffectPreflightError(
          "path_changed_during_inventory",
          `symbolic link changed while it was being inventoried: ${path}`,
          path,
        );
      }
      return {
        ...base,
        state: "symlink",
        existingAsset: true,
        sha256: createHash("sha256").update(target, "utf8").digest("hex"),
        bytes: Buffer.byteLength(target, "utf8"),
        mode: after.mode & 0o7777,
      };
    } catch (error) {
      if (error instanceof LocalEffectPreflightError) {
        throw error;
      }
      throw new LocalEffectPreflightError(
        "path_inspection_failed",
        `symbolic link could not be inventoried: ${path}`,
        path,
        { cause: error },
      );
    }
  }

  return {
    ...base,
    state: before.isDirectory() ? "directory" : "other",
    existingAsset: true,
    mode: before.mode & 0o7777,
  };
}

function normalizeOperation(operation: LocalFileOperation, index: number): LocalFileOperation {
  if (!operation || typeof operation !== "object") {
    throw new LocalEffectPreflightError("invalid_plan", `local file operation ${index} must be an object`);
  }
  const path = normalizedAbsoluteTarget(operation.path);
  if (operation.operation === "write_file") {
    if (typeof operation.content !== "string") {
      throw new LocalEffectPreflightError("invalid_plan", `write operation ${index} content must be a string`, path);
    }
    return { operation: "write_file", path, content: operation.content };
  }
  if (operation.operation === "delete_file") {
    return { operation: "delete_file", path };
  }
  throw new LocalEffectPreflightError("invalid_plan", `unsupported local file operation at index ${index}`);
}

function parsePreparedOperation(value: JsonValue, index: number): PreparedLocalFileOperation {
  const object = jsonObject(value, `local file operation ${index}`);
  if (object.operation === "write_file") {
    assertExactKeys(object, ["content", "operation", "path", "precondition"], `write operation ${index}`);
    if (typeof object.path !== "string" || typeof object.content !== "string") {
      throw new LocalEffectPreflightError("invalid_plan", `write operation ${index} has invalid path or content`);
    }
    const path = requireNormalizedAbsoluteTarget(object.path);
    return {
      operation: "write_file",
      path,
      content: object.content,
      precondition: parsePrecondition(object.precondition, path, index),
    };
  }
  if (object.operation === "delete_file") {
    assertExactKeys(object, ["operation", "path", "precondition"], `delete operation ${index}`);
    if (typeof object.path !== "string") {
      throw new LocalEffectPreflightError("invalid_plan", `delete operation ${index} has an invalid path`);
    }
    const path = requireNormalizedAbsoluteTarget(object.path);
    return {
      operation: "delete_file",
      path,
      precondition: parsePrecondition(object.precondition, path, index),
    };
  }
  throw new LocalEffectPreflightError("invalid_plan", `unsupported local file operation at index ${index}`);
}

function parsePrecondition(value: JsonValue | undefined, path: string, index: number): LocalPathPrecondition {
  const object = jsonObject(value, `local file precondition ${index}`);
  const state = object.state;
  if (state === "absent") {
    assertExactKeys(
      object,
      ["existingAsset", "parentPath", "path", "resolvedParentPath", "resolvedPath", "state"],
      `absent precondition ${index}`,
    );
  } else if (state === "file") {
    assertExactKeys(
      object,
      ["bytes", "existingAsset", "mode", "parentPath", "path", "resolvedParentPath", "resolvedPath", "sha256", "state"],
      `file precondition ${index}`,
    );
  } else {
    throw new LocalEffectPreflightError("unsupported_target_type", `operation ${index} target must be absent or a regular file`, path);
  }

  if (
    object.path !== path
    || object.parentPath !== dirname(path)
    || typeof object.resolvedParentPath !== "string"
    || typeof object.resolvedPath !== "string"
  ) {
    throw new LocalEffectPreflightError("invalid_plan", `operation ${index} precondition paths are inconsistent`, path);
  }
  const resolvedParentPath = requireNormalizedAbsoluteTarget(object.resolvedParentPath, true);
  const resolvedPath = requireNormalizedAbsoluteTarget(object.resolvedPath);
  if (resolvedPath !== join(resolvedParentPath, basename(path))) {
    throw new LocalEffectPreflightError("invalid_plan", `operation ${index} resolved path is inconsistent`, path);
  }

  const base = {
    path,
    parentPath: dirname(path),
    resolvedPath,
    resolvedParentPath,
  } as const;
  if (state === "absent") {
    if (object.existingAsset !== false) {
      throw new LocalEffectPreflightError("invalid_plan", `operation ${index} absent precondition is invalid`, path);
    }
    return { ...base, state: "absent", existingAsset: false };
  }
  if (
    object.existingAsset !== true
    || typeof object.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(object.sha256)
    || !isNonNegativeInteger(object.bytes)
    || !isNonNegativeInteger(object.mode)
    || object.mode > 0o7777
  ) {
    throw new LocalEffectPreflightError("invalid_plan", `operation ${index} file precondition is invalid`, path);
  }
  return {
    ...base,
    state: "file",
    existingAsset: true,
    sha256: object.sha256,
    bytes: object.bytes,
    mode: object.mode,
  };
}

function normalizedAbsoluteTarget(path: string): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) {
    throw new LocalEffectPreflightError("invalid_path", "managed local file paths must be non-empty absolute paths");
  }
  const normalized = resolve(path);
  if (basename(normalized).length === 0) {
    throw new LocalEffectPreflightError("invalid_path", "filesystem roots cannot be managed local file targets", normalized);
  }
  return normalized;
}

function requireNormalizedAbsoluteTarget(path: string, allowRoot = false): string {
  const normalized = normalizedAbsoluteTargetAllowingRoot(path, allowRoot);
  if (path !== normalized) {
    throw new LocalEffectPreflightError("invalid_path", `managed local file path must be normalized: ${path}`, path);
  }
  return path;
}

function normalizedAbsoluteTargetAllowingRoot(path: string, allowRoot: boolean): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) {
    throw new LocalEffectPreflightError("invalid_path", "managed local file paths must be non-empty absolute paths");
  }
  const normalized = resolve(path);
  if (!allowRoot && basename(normalized).length === 0) {
    throw new LocalEffectPreflightError("invalid_path", "filesystem roots cannot be managed local file targets", normalized);
  }
  return normalized;
}

function assertNoDuplicateLexicalTargets(operations: readonly Pick<LocalFileOperation, "path">[]): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    const key = policyPath(operation.path);
    if (seen.has(key)) {
      throw new LocalEffectPreflightError("duplicate_target", `local file plan targets a path more than once: ${operation.path}`, operation.path);
    }
    seen.add(key);
  }
}

function assertNoDuplicateResolvedTargets(inventory: readonly LocalPathInventoryEntry[]): void {
  const seen = new Set<string>();
  for (const entry of inventory) {
    const key = policyPath(entry.resolvedPath);
    if (seen.has(key)) {
      throw new LocalEffectPreflightError("duplicate_target", `local file plan aliases one target more than once: ${entry.path}`, entry.path);
    }
    seen.add(key);
  }
}

function assertSupportedTarget(entry: LocalPathInventoryEntry): asserts entry is LocalPathPrecondition {
  if (entry.state !== "absent" && entry.state !== "file") {
    throw new LocalEffectPreflightError(
      "unsupported_target_type",
      `managed local file targets must be absent or regular files, not ${entry.state}: ${entry.path}`,
      entry.path,
    );
  }
}

const CORE_SYSTEM_ROOTS = [
  "/Applications",
  "/Library",
  "/System",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/private/etc",
  "/private/var/db",
  "/private/var/root",
  "/proc",
  "/root",
  "/sbin",
  "/sys",
  "/usr",
] as const;

function isCoreSystemPath(entry: LocalPathInventoryEntry): boolean {
  return [entry.path, entry.resolvedPath].some((candidate) => {
    if (dirname(candidate) === "/") {
      return true;
    }
    if (CORE_SYSTEM_ROOTS.some((root) => pathIsWithin(candidate, root))) {
      return true;
    }
    const normalized = policyPath(candidate);
    return normalized.includes("/library/launchagents/")
      || normalized.endsWith("/library/launchagents")
      || normalized.includes("/library/launchdaemons/")
      || normalized.endsWith("/library/launchdaemons");
  });
}

function isAccountRightsPath(entry: LocalPathInventoryEntry): boolean {
  return [entry.path, entry.resolvedPath].some((candidate) => {
    const normalized = policyPath(candidate);
    return normalized.endsWith("/.ssh/authorized_keys")
      || normalized.includes("/library/application support/com.apple.tcc/")
      || normalized.endsWith("/library/application support/com.apple.tcc")
      || normalized.includes("/library/keychains/")
      || normalized.endsWith("/library/keychains");
  });
}

function pathIsWithin(candidate: string, root: string): boolean {
  const comparedCandidate = policyPath(candidate);
  const comparedRoot = policyPath(root);
  const offset = relative(comparedRoot, comparedCandidate);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function policyPath(path: string): string {
  return process.platform === "darwin" ? path.toLocaleLowerCase("en-US") : path;
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && right.isFile();
}

function sameStableFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function jsonObject(value: JsonValue | undefined, label: string): { readonly [key: string]: JsonValue } {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalEffectPreflightError("invalid_plan", `${label} must be an object`);
  }
  return value as { readonly [key: string]: JsonValue };
}

function assertExactKeys(object: { readonly [key: string]: JsonValue }, expected: readonly string[], label: string): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new LocalEffectPreflightError("invalid_plan", `${label} contains unsupported or missing fields`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LocalEffectPreflightError("invalid_plan", `${label} must be a non-empty string`);
  }
}

function isNonNegativeInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
