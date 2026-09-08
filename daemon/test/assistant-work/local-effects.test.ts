import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeManagedLocalFileAction } from "../../src/assistant-work/execution.ts";
import {
  classifyLocalFileEffect,
  preflightLocalFileAction,
} from "../../src/assistant-work/local-effects.ts";
import { stableAttemptId } from "../../src/assistant-work/model.ts";
import type { EvidenceProvenance } from "../../src/assistant-work/model.ts";
import { openStateStore } from "../../src/store/db.ts";

const directories: string[] = [];
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const OWNER: EvidenceProvenance = {
  principal: "owner",
  channel: "chat",
  subject: "owner-account",
  evidenceId: "owner-local-effect-approval",
};

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-local-effects-"));
  directories.push(root);
  return root;
}

function fixtureStore(root: string) {
  return openStateStore(join(root, "state.db"));
}

function admitWork(store: ReturnType<typeof openStateStore>, suffix: string) {
  return store.assistantWork.admitObservation({
    source: "test:local-effects",
    occurrenceKey: `observation-${suffix}`,
    workKey: `work-${suffix}`,
    workTitle: `Local effect ${suffix}`,
    provenance: {
      principal: "system",
      channel: "test",
      subject: "local-effects-fixture",
      evidenceId: `fixture-${suffix}`,
    },
    observedAt: T0,
    evidence: { fixture: suffix },
  }, T0).work;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed local file preflight and execution", () => {
  test("autonomously writes a regular local file and records an effect-started attempt", async () => {
    const root = fixtureRoot();
    const target = join(root, "notes.txt");
    writeFileSync(target, "before", "utf8");
    const store = fixtureStore(root);
    try {
      const work = admitWork(store, "ordinary-write");
      const preflight = await preflightLocalFileAction({
        workId: work.id,
        semanticKey: "update-notes",
        operations: [{ operation: "write_file", path: target, content: "after" }],
      });
      expect(preflight).toMatchObject({
        effectClass: "ordinary_local_edit",
        inventory: [{ path: target, state: "file", existingAsset: true }],
      });

      const action = store.assistantWork.proposeAction(preflight.proposal, T0);
      expect(action.state).toBe("authorized");
      const attemptId = stableAttemptId(action.id, action.revision, "ordinary-write");
      const result = await executeManagedLocalFileAction({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId,
        workerId: "local-worker",
        now: () => T1,
      });

      expect(result).toMatchObject({
        kind: "confirmed",
        action: { state: "confirmed" },
        attempt: { id: attemptId, state: "confirmed", authorizationSource: "local_policy", effectStartedAt: T1 },
      });
      expect(readFileSync(target, "utf8")).toBe("after");
      expect(store.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "confirmed",
        outcome: {
          code: "local_effect_verified",
          evidence: {
            kind: "managed_local_file_receipt",
            paths: [{ operation: "write_file", path: target, state: "file" }],
          },
        },
      });
    } finally {
      store.close();
    }
  });

  test("does not claim or delete an existing file without exact owner approval", async () => {
    const root = fixtureRoot();
    const target = join(root, "keep.txt");
    writeFileSync(target, "keep me", "utf8");
    const store = fixtureStore(root);
    try {
      const work = admitWork(store, "delete-denied");
      const preflight = await preflightLocalFileAction({
        workId: work.id,
        semanticKey: "delete-keep",
        operations: [{ operation: "delete_file", path: target }],
      });
      expect(preflight.effectClass).toBe("delete_existing");
      const action = store.assistantWork.proposeAction(preflight.proposal, T0);
      expect(action.state).toBe("approval_pending");

      const result = await executeManagedLocalFileAction({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId: stableAttemptId(action.id, action.revision, "delete-denied"),
        workerId: "local-worker",
        now: () => T1,
      });

      expect(result).toMatchObject({ kind: "rejected", reason: "approval_required" });
      expect(readFileSync(target, "utf8")).toBe("keep me");
      expect(store.assistantWork.listAttempts(action.id)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("rechecks effect class host-side instead of trusting an ordinary label in stored material", async () => {
    const root = fixtureRoot();
    const target = join(root, "protected.txt");
    writeFileSync(target, "protected", "utf8");
    const store = fixtureStore(root);
    try {
      const work = admitWork(store, "forged-class");
      const preflight = await preflightLocalFileAction({
        workId: work.id,
        semanticKey: "forged-delete",
        operations: [{ operation: "delete_file", path: target }],
      });
      const action = store.assistantWork.proposeAction({
        ...preflight.proposal,
        effectClass: "ordinary_local_edit",
      }, T0);

      const result = await executeManagedLocalFileAction({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId: stableAttemptId(action.id, action.revision, "forged-class"),
        workerId: "local-worker",
        now: () => T1,
      });

      expect(result).toMatchObject({
        kind: "preflight_rejected",
        reason: "effect_class_mismatch",
        requiredEffectClass: "delete_existing",
      });
      expect(readFileSync(target, "utf8")).toBe("protected");
      expect(store.assistantWork.listAttempts(action.id)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("rejects an old material revision and definitively fails a stale filesystem precondition without overwriting it", async () => {
    const root = fixtureRoot();
    const target = join(root, "revision.txt");
    writeFileSync(target, "original", "utf8");
    const store = fixtureStore(root);
    try {
      const work = admitWork(store, "stale-material");
      const firstPreflight = await preflightLocalFileAction({
        workId: work.id,
        semanticKey: "rewrite-revision",
        operations: [{ operation: "write_file", path: target, content: "first payload" }],
      });
      const first = store.assistantWork.proposeAction(firstPreflight.proposal, T0);
      const revisedPreflight = await preflightLocalFileAction({
        workId: work.id,
        semanticKey: "rewrite-revision",
        operations: [{ operation: "write_file", path: target, content: "revised payload" }],
      });
      const revised = store.assistantWork.proposeAction(revisedPreflight.proposal, T1);
      expect(revised).toMatchObject({ id: first.id, revision: first.revision + 1 });
      expect(revised.digest).not.toBe(first.digest);

      const staleMaterial = await executeManagedLocalFileAction({
        repository: store.assistantWork,
        actionId: first.id,
        revision: first.revision,
        digest: first.digest,
        attemptId: stableAttemptId(first.id, first.revision, "stale-material"),
        workerId: "local-worker",
        now: () => T2,
      });
      expect(staleMaterial).toMatchObject({ kind: "rejected", reason: "stale_revision" });
      expect(readFileSync(target, "utf8")).toBe("original");

      writeFileSync(target, "changed outside executor", "utf8");
      const attemptId = stableAttemptId(revised.id, revised.revision, "stale-precondition");
      const stalePrecondition = await executeManagedLocalFileAction({
        repository: store.assistantWork,
        actionId: revised.id,
        revision: revised.revision,
        digest: revised.digest,
        attemptId,
        workerId: "local-worker",
        now: () => T2,
      });
      expect(stalePrecondition).toMatchObject({
        kind: "definitive_failed",
        action: { state: "definitive_failed" },
        attempt: {
          id: attemptId,
          state: "definitive_failed",
          effectStartedAt: T2,
          outcome: { code: "stale_local_precondition", effectInvoked: false },
        },
      });
      expect(readFileSync(target, "utf8")).toBe("changed outside executor");
    } finally {
      store.close();
    }
  });

  test("confirms a write only with the digest read back from the actual file", async () => {
    const root = fixtureRoot();
    const target = join(root, "digest.txt");
    const content = "digest evidence\nwith unicode: 안녕\n";
    const expectedDigest = createHash("sha256").update(content, "utf8").digest("hex");
    const store = fixtureStore(root);
    try {
      const work = admitWork(store, "digest");
      const preflight = await preflightLocalFileAction({
        workId: work.id,
        semanticKey: "write-digest-fixture",
        operations: [{ operation: "write_file", path: target, content }],
      });
      expect(preflight.inventory[0]).toMatchObject({ state: "absent", existingAsset: false });
      const action = store.assistantWork.proposeAction(preflight.proposal, T0);
      const attemptId = stableAttemptId(action.id, action.revision, "digest");

      const result = await executeManagedLocalFileAction({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId,
        workerId: "local-worker",
        now: () => T1,
      });

      expect(result).toMatchObject({
        kind: "confirmed",
        evidence: {
          kind: "managed_local_file_receipt",
          paths: [{
            operation: "write_file",
            path: target,
            state: "file",
            sha256: expectedDigest,
            bytes: Buffer.byteLength(content, "utf8"),
          }],
        },
      });
      expect(createHash("sha256").update(readFileSync(target)).digest("hex")).toBe(expectedDigest);
    } finally {
      store.close();
    }
  });

  test("executes an explicitly approved delete and confirms actual absence", async () => {
    const root = fixtureRoot();
    const target = join(root, "approved-delete.txt");
    writeFileSync(target, "remove me", "utf8");
    const store = fixtureStore(root);
    try {
      const work = admitWork(store, "approved-delete");
      const preflight = await preflightLocalFileAction({
        workId: work.id,
        semanticKey: "approved-delete",
        operations: [{ operation: "delete_file", path: target }],
      });
      const action = store.assistantWork.proposeAction(preflight.proposal, T0);
      store.assistantWork.grantExplicitApproval({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        provenance: OWNER,
      }, T1);
      const attemptId = stableAttemptId(action.id, action.revision, "approved-delete");

      const result = await executeManagedLocalFileAction({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId,
        workerId: "local-worker",
        now: () => T2,
      });

      expect(result).toMatchObject({
        kind: "confirmed",
        attempt: { authorizationSource: "owner_explicit" },
        evidence: {
          kind: "managed_local_file_receipt",
          paths: [{ operation: "delete_file", path: target, state: "absent", existingAsset: false }],
        },
      });
      expect(existsSync(target)).toBe(false);
    } finally {
      store.close();
    }
  });

  test("requires approval for existing assets across folders but not for new files across folders", async () => {
    const root = fixtureRoot();
    const firstDirectory = join(root, "first");
    const secondDirectory = join(root, "second");
    mkdirSync(firstDirectory);
    mkdirSync(secondDirectory);
    const firstExisting = join(firstDirectory, "existing.txt");
    const secondExisting = join(secondDirectory, "existing.txt");
    writeFileSync(firstExisting, "first", "utf8");
    writeFileSync(secondExisting, "second", "utf8");
    const store = fixtureStore(root);
    try {
      const work = admitWork(store, "bulk-existing");
      const bulk = await preflightLocalFileAction({
        workId: work.id,
        semanticKey: "bulk-existing",
        operations: [
          { operation: "write_file", path: firstExisting, content: "changed first" },
          { operation: "write_file", path: secondExisting, content: "changed second" },
        ],
      });
      expect(bulk.effectClass).toBe("bulk_existing_user_assets");
      const bulkAction = store.assistantWork.proposeAction(bulk.proposal, T0);
      const rejected = await executeManagedLocalFileAction({
        repository: store.assistantWork,
        actionId: bulkAction.id,
        revision: bulkAction.revision,
        digest: bulkAction.digest,
        attemptId: stableAttemptId(bulkAction.id, bulkAction.revision, "bulk-existing"),
        workerId: "local-worker",
        now: () => T1,
      });
      expect(rejected).toMatchObject({ kind: "rejected", reason: "approval_required" });
      expect(readFileSync(firstExisting, "utf8")).toBe("first");
      expect(readFileSync(secondExisting, "utf8")).toBe("second");

      const newFiles = await preflightLocalFileAction({
        workId: work.id,
        semanticKey: "new-files",
        operations: [
          { operation: "write_file", path: join(firstDirectory, "new.txt"), content: "new first" },
          { operation: "write_file", path: join(secondDirectory, "new.txt"), content: "new second" },
        ],
      });
      expect(newFiles).toMatchObject({
        effectClass: "ordinary_local_edit",
        inventory: [
          { state: "absent", existingAsset: false },
          { state: "absent", existingAsset: false },
        ],
      });
    } finally {
      store.close();
    }
  });

  test("classifies core system file paths as owner-approved effects without touching them", () => {
    const path = "/System/Library/OpenInstinct/fixture.conf";
    const parentPath = "/System/Library/OpenInstinct";
    const precondition = {
      path,
      parentPath,
      resolvedPath: path,
      resolvedParentPath: parentPath,
      state: "absent",
      existingAsset: false,
    } as const;
    const operation = {
      operation: "write_file",
      path,
      content: "fixture",
      precondition,
    } as const;

    expect(classifyLocalFileEffect([operation], [precondition])).toBe("core_setting_change");
  });
});
