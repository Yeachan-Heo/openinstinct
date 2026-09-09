import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createManagedInstallTool,
  executeManagedInstall,
  installArgv,
  MANAGED_INSTALL_ACTION,
  managedInstallPlanToJson,
  parseManagedInstallPlan,
  preflightManagedInstall,
} from "../../src/assistant-work/install.ts";
import { stableAttemptId } from "../../src/assistant-work/model.ts";
import { openStateStore } from "../../src/store/db.ts";

const roots: string[] = [];
const FIXTURE = realpathSync(join(import.meta.dir, "../fixtures/assistant-work/package-manager.ts"));
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "openinstinct-managed-install-"));
  roots.push(path);
  return path;
}

function storeAt(path: string) {
  return openStateStore(join(path, "state.db"));
}

function admitWork(store: ReturnType<typeof openStateStore>, suffix: string) {
  return store.assistantWork.admitObservation({
    source: "test:managed-install",
    occurrenceKey: `observation-${suffix}`,
    workKey: `work-${suffix}`,
    workTitle: `Managed install ${suffix}`,
    provenance: {
      principal: "system",
      channel: "test",
      subject: "managed-install-fixture",
      evidenceId: `fixture-${suffix}`,
    },
    observedAt: T0,
    evidence: { fixture: suffix },
  }, T0).work;
}

function installEnv(path: string, mode?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OI_PACKAGE_MANAGER_LOG: join(path, "manager.argv.jsonl"),
    OI_PACKAGE_MANAGER_MODE: mode ?? "",
  };
}

async function propose(
  store: ReturnType<typeof openStateStore>,
  path: string,
  suffix: string,
  options: { readonly destination?: string; readonly ignoreScripts?: boolean } = {},
) {
  const work = admitWork(store, suffix);
  const preflight = await preflightManagedInstall({
    workId: work.id,
    semanticKey: `install-${suffix}`,
    packageSpec: "fixture-tool@1.2.3",
    destination: options.destination ?? join(path, `${suffix}-tools`),
    bunPath: FIXTURE,
    ignoreScripts: options.ignoreScripts,
    repository: store.assistantWork,
  });
  return { preflight, action: store.assistantWork.proposeAction(preflight.proposal, T0) };
}

function parseArgvLog(path: string): readonly (readonly string[])[] {
  return readFileSync(join(path, "manager.argv.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for managed install fixture");
    await Bun.sleep(5);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("managed user-local Bun installation", () => {
  test("preflights an exact argv-separated Bun plan and binds manager, package, destination, and options", async () => {
    chmodSync(FIXTURE, 0o700);
    const path = root();
    const destination = join(path, "tool root;not-shell");
    const store = storeAt(path);
    const work = admitWork(store, "argv");
    try {
      const preflight = await preflightManagedInstall({
        workId: work.id,
        semanticKey: "argv-plan",
        packageSpec: "@scope/fixture-tool@1.2.3",
        destination,
        bunPath: FIXTURE,
      });
      expect(preflight.effectClass).toBe("external_mutation");
      expect(preflight.argv).toEqual([
        FIXTURE,
        "add",
        "--exact",
        "--cwd",
        destination,
        "@scope/fixture-tool@1.2.3",
      ]);
      expect(preflight.proposal).toMatchObject({
        effectClass: "external_mutation",
        action: MANAGED_INSTALL_ACTION,
        payload: {
          manager: "bun",
          managerPath: FIXTURE,
          packageSpec: "@scope/fixture-tool@1.2.3",
          destination,
          options: { exact: true, ignoreScripts: false },
        },
      });
      const changedPackage = await preflightManagedInstall({
        workId: work.id,
        semanticKey: "argv-plan",
        packageSpec: "@scope/fixture-tool@1.2.4",
        destination,
        bunPath: FIXTURE,
      });
      const changedOptions = await preflightManagedInstall({
        workId: work.id,
        semanticKey: "argv-plan",
        packageSpec: "@scope/fixture-tool@1.2.3",
        destination,
        bunPath: FIXTURE,
        ignoreScripts: true,
      });
      const changedDestination = await preflightManagedInstall({
        workId: work.id,
        semanticKey: "argv-plan",
        packageSpec: "@scope/fixture-tool@1.2.3",
        destination: join(path, "other-tools"),
        bunPath: FIXTURE,
      });
      const copiedManager = join(path, "bun-fixture-copy");
      copyFileSync(FIXTURE, copiedManager);
      chmodSync(copiedManager, 0o700);
      const changedManager = await preflightManagedInstall({
        workId: work.id,
        semanticKey: "argv-plan",
        packageSpec: "@scope/fixture-tool@1.2.3",
        destination,
        bunPath: copiedManager,
      });
      const first = store.assistantWork.proposeAction(preflight.proposal, T0);
      const second = store.assistantWork.proposeAction(changedPackage.proposal, T1);
      const third = store.assistantWork.proposeAction(changedOptions.proposal, T2);
      const fourth = store.assistantWork.proposeAction(changedDestination.proposal, T2);
      const fifth = store.assistantWork.proposeAction(changedManager.proposal, T2);
      expect(new Set([first.digest, second.digest, third.digest, fourth.digest, fifth.digest]).size).toBe(5);
      expect(changedOptions.effectClass).toBe("ordinary_local_install");
      expect(changedOptions.argv).toContain("--ignore-scripts");
      expect(third.state).toBe("planned");
    } finally {
      store.close();
    }
  });

  test("strictly rejects traversal, shell-like package text, unpinned specs, and arbitrary manager material", async () => {
    chmodSync(FIXTURE, 0o700);
    const path = root();
    const store = storeAt(path);
    const work = admitWork(store, "strict");
    try {
      await expect(preflightManagedInstall({
        workId: work.id,
        semanticKey: "traversal",
        packageSpec: "fixture-tool@1.2.3",
        destination: `${path}/parent/../tools`,
        bunPath: FIXTURE,
      })).rejects.toThrow("normalized and contain no traversal");
      const actualDirectory = join(path, "actual-directory");
      mkdirSync(actualDirectory);
      const linkedDirectory = join(path, "linked-tools");
      symlinkSync(actualDirectory, linkedDirectory);
      await expect(preflightManagedInstall({
        workId: work.id,
        semanticKey: "symlink",
        packageSpec: "fixture-tool@1.2.3",
        destination: linkedDirectory,
        bunPath: FIXTURE,
      })).rejects.toThrow("must be an actual directory or absent");
      await expect(preflightManagedInstall({
        workId: work.id,
        semanticKey: "relative",
        packageSpec: "fixture-tool@1.2.3",
        destination: "relative-tools",
        bunPath: FIXTURE,
      })).rejects.toThrow("must be an absolute path");
      await expect(preflightManagedInstall({
        workId: work.id,
        semanticKey: "shell",
        packageSpec: "fixture-tool@1.2.3;touch-pwned",
        destination: join(path, "tools"),
        bunPath: FIXTURE,
      })).rejects.toThrow("exact semantic version");
      await expect(preflightManagedInstall({
        workId: work.id,
        semanticKey: "leading-zero-version",
        packageSpec: "fixture-tool@01.2.3",
        destination: join(path, "tools"),
        bunPath: FIXTURE,
      })).rejects.toThrow("exact semantic version");
      await expect(preflightManagedInstall({
        workId: work.id,
        semanticKey: "unpinned",
        packageSpec: "fixture-tool",
        destination: join(path, "tools"),
        bunPath: FIXTURE,
      })).rejects.toThrow("pin an exact version");
      await expect(preflightManagedInstall({
        workId: work.id,
        semanticKey: "url-source",
        packageSpec: "fixture-tool@https://example.invalid/tool.tgz",
        destination: join(path, "tools"),
        bunPath: FIXTURE,
      })).rejects.toThrow("exact semantic version");

      const preflight = await preflightManagedInstall({
        workId: work.id,
        semanticKey: "strict-payload",
        packageSpec: "fixture-tool@1.2.3",
        destination: join(path, "tools"),
        bunPath: FIXTURE,
      });
      expect(() => parseManagedInstallPlan({
        ...(managedInstallPlanToJson(preflight.plan) as unknown as Record<string, unknown>),
        shell: "rm -rf /",
      } as never)).toThrow("unsupported or missing fields");
      expect(() => parseManagedInstallPlan({
        ...(managedInstallPlanToJson(preflight.plan) as unknown as Record<string, unknown>),
        managerPath: "/bin/sh",
      } as never)).not.toThrow();
      const forged = store.assistantWork.proposeAction({
        ...preflight.proposal,
        payload: {
          ...(preflight.proposal.payload as unknown as Record<string, unknown>),
          managerPath: "/bin/sh",
        } as never,
      }, T0);
      await expect(executeManagedInstall({
        repository: store.assistantWork,
        actionId: forged.id,
        revision: forged.revision,
        digest: forged.digest,
        attemptId: stableAttemptId(forged.id, forged.revision, "forged-manager"),
        workerId: "install-worker",
        bunPath: FIXTURE,
        now: () => T1,
      })).resolves.toMatchObject({ kind: "preflight_rejected", reason: "invalid_plan" });
    } finally {
      store.close();
    }
  });

  test("installs into an existing mixed work directory and classifies core paths host-side", async () => {
    chmodSync(FIXTURE, 0o700);
    const path = root();
    const mixed = join(path, "project");
    mkdirSync(mixed);
    writeFileSync(join(mixed, "user-notes.txt"), "keep", "utf8");
    writeFileSync(join(mixed, "package.json"), JSON.stringify({ private: true }), "utf8");
    const store = storeAt(path);
    try {
      const work = admitWork(store, "mixed-project");
      const existing = await preflightManagedInstall({
        workId: work.id,
        semanticKey: "mixed-project",
        packageSpec: "fixture-tool@1.2.3",
        destination: mixed,
        bunPath: FIXTURE,
      });
      expect(existing.effectClass).toBe("external_mutation");
      const action = store.assistantWork.proposeAction(existing.proposal, T0);
      expect(action.state).toBe("planned");
      await expect(executeManagedInstall({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId: stableAttemptId(action.id, action.revision, "immediate-mixed-install"),
        workerId: "install-worker",
        bunPath: FIXTURE,
        env: installEnv(path),
        now: () => T1,
      })).resolves.toMatchObject({ kind: "confirmed", attempt: { state: "confirmed" } });
      expect(parseArgvLog(path)).toEqual([existing.argv.slice(1)]);
      expect(parseArgvLog(path)[0]).not.toContain("--ignore-scripts");
      expect(readFileSync(join(mixed, "node_modules", "fixture-tool", "installed.txt"), "utf8")).toBe("fixture install evidence\n");
      expect(readFileSync(join(mixed, "user-notes.txt"), "utf8")).toBe("keep");

      const modelLabeled = join(path, "model-labeled-tools");
      mkdirSync(modelLabeled);
      writeFileSync(join(modelLabeled, "package.json"), JSON.stringify({
        private: true,
        openinstinctManagedToolRoot: 1,
      }), "utf8");
      const labeled = await preflightManagedInstall({
        workId: work.id,
        semanticKey: "model-label",
        packageSpec: "fixture-tool@1.2.3",
        destination: modelLabeled,
        bunPath: FIXTURE,
        ignoreScripts: true,
        repository: store.assistantWork,
      });
      expect(labeled.effectClass).toBe("bulk_existing_user_assets");

      const core = await preflightManagedInstall({
        workId: work.id,
        semanticKey: "core",
        packageSpec: "fixture-tool@1.2.3",
        destination: "/usr/openinstinct-tools",
        bunPath: FIXTURE,
      });
      expect(core.effectClass).toBe("core_setting_change");

      const forged = store.assistantWork.proposeAction({ ...core.proposal, effectClass: "ordinary_local_install" }, T1);
      const forgedAttemptId = stableAttemptId(forged.id, forged.revision, "forged-class");
      await expect(executeManagedInstall({
        repository: store.assistantWork,
        actionId: forged.id,
        revision: forged.revision,
        digest: forged.digest,
        attemptId: forgedAttemptId,
        workerId: "install-worker",
        bunPath: FIXTURE,
        env: installEnv(path),
        now: () => T2,
      })).resolves.toMatchObject({
        kind: "preflight_rejected",
        reason: "effect_class_mismatch",
        requiredEffectClass: "core_setting_change",
      });
      expect(store.assistantWork.getAttempt(forgedAttemptId)).toBeUndefined();

      const keychains = join(path, "Library", "Keychains");
      mkdirSync(keychains, { recursive: true });
      const accountRights = await preflightManagedInstall({
        workId: work.id,
        semanticKey: "account-rights",
        packageSpec: "fixture-tool@1.2.3",
        destination: join(keychains, "tools"),
        bunPath: FIXTURE,
      });
      expect(accountRights.effectClass).toBe("account_rights_change");
      const accountAction = store.assistantWork.proposeAction(accountRights.proposal, T2);
      expect(accountAction.state).toBe("planned");

      const sshRoot = join(path, ".ssh", "authorized_keys");
      mkdirSync(sshRoot, { recursive: true });
      const sshRights = await preflightManagedInstall({
        workId: work.id,
        semanticKey: "ssh-rights",
        packageSpec: "fixture-tool@1.2.3",
        destination: join(sshRoot, "tools"),
        bunPath: FIXTURE,
      });
      expect(sshRights.effectClass).toBe("account_rights_change");
    } finally {
      store.close();
    }
  });

  test("durably starts one process, verifies real files and metadata, and confirms the attempt", async () => {
    chmodSync(FIXTURE, 0o700);
    const path = root();
    const destination = join(path, "installed-tools");
    const store = storeAt(path);
    try {
      const { preflight, action } = await propose(store, path, "installed", { destination, ignoreScripts: true });
      expect(action).toMatchObject({ state: "planned", effectClass: "ordinary_local_install" });
      const attemptId = stableAttemptId(action.id, action.revision, "install-once");
      const result = await executeManagedInstall({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId,
        workerId: "install-worker",
        bunPath: FIXTURE,
        env: installEnv(path),
        now: () => T1,
      });
      expect(result).toMatchObject({
        kind: "confirmed",
        action: { state: "confirmed" },
        attempt: { id: attemptId, state: "confirmed", effectStartedAt: T1 },
        evidence: {
          kind: "managed_bun_install_receipt",
          packageSpec: "fixture-tool@1.2.3",
          destination,
          process: {
            managerPath: FIXTURE,
            argv: installArgv(preflight.plan),
            cwd: destination,
            started: true,
            exitCode: 0,
          },
          inventory: {
            packageEntry: { section: "dependencies", name: "fixture-tool", value: "1.2.3" },
            installedPackage: { state: "file", name: "fixture-tool", version: "1.2.3" },
          },
        },
      });
      expect(readFileSync(join(destination, "node_modules", "fixture-tool", "installed.txt"), "utf8")).toBe("fixture install evidence\n");
      expect(parseArgvLog(path)).toEqual([installArgv(preflight.plan).slice(1)]);
      const withoutLedger = await preflightManagedInstall({
        workId: action.workId,
        semanticKey: "install-without-ledger",
        packageSpec: "second-fixture-tool@2.0.0",
        destination,
        bunPath: FIXTURE,
        ignoreScripts: true,
      });
      expect(withoutLedger.effectClass).toBe("bulk_existing_user_assets");
      const secondPackage = await preflightManagedInstall({
        workId: action.workId,
        semanticKey: "install-second-package",
        packageSpec: "second-fixture-tool@2.0.0",
        destination,
        bunPath: FIXTURE,
        ignoreScripts: true,
        repository: store.assistantWork,
      });
      expect(secondPackage).toMatchObject({
        effectClass: "ordinary_local_install",
        inventory: { existing: true, dedicatedToolRoot: true },
      });
      expect(store.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "confirmed",
        outcome: { code: "managed_install_verified" },
      });
      await expect(executeManagedInstall({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId,
        workerId: "install-worker",
        bunPath: FIXTURE,
        env: installEnv(path),
        now: () => T2,
      })).resolves.toMatchObject({ kind: "rejected", reason: "confirmed" });
      expect(parseArgvLog(path)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("settles nonzero after start definitively only when inventory proves no change and never retries", async () => {
    chmodSync(FIXTURE, 0o700);
    const path = root();
    const store = storeAt(path);
    try {
      const { action } = await propose(store, path, "failed-clean", { ignoreScripts: true });
      const attemptId = stableAttemptId(action.id, action.revision, "failed-clean");
      const result = await executeManagedInstall({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId,
        workerId: "install-worker",
        bunPath: FIXTURE,
        env: installEnv(path, "fail_before_change"),
        now: () => T1,
      });
      expect(result).toMatchObject({
        kind: "definitive_failed",
        attempt: {
          state: "definitive_failed",
          outcome: { code: "install_process_failed", effectInvoked: true, noChangeProven: true },
        },
      });
      expect(parseArgvLog(path)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("marks a changed nonzero install ambiguous and refuses a blind retry", async () => {
    chmodSync(FIXTURE, 0o700);
    const path = root();
    const destination = join(path, "ambiguous-tools");
    const store = storeAt(path);
    try {
      const { action } = await propose(store, path, "ambiguous", { destination });
      const attemptId = stableAttemptId(action.id, action.revision, "ambiguous");
      const first = await executeManagedInstall({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId,
        workerId: "install-worker",
        bunPath: FIXTURE,
        env: installEnv(path, "fail_after_change"),
        now: () => T1,
      });
      expect(first).toMatchObject({
        kind: "ambiguous",
        attempt: {
          state: "ambiguous",
          outcome: { code: "install_process_failed", effectInvoked: true, noChangeProven: false },
        },
      });
      const second = await executeManagedInstall({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId,
        workerId: "install-worker",
        bunPath: FIXTURE,
        env: installEnv(path, "fail_after_change"),
        now: () => T2,
      });
      expect(second).toMatchObject({
        kind: "rejected",
        reason: "ambiguous",
        attempt: { id: attemptId, state: "ambiguous" },
      });
      expect("inventory" in second).toBe(false);
      expect(parseArgvLog(path)).toHaveLength(1);
      expect(readFileSync(join(destination, "node_modules", "fixture-tool", "installed.txt"), "utf8")).toBe("fixture install evidence\n");
    } finally {
      store.close();
    }
  });

  test("waits for scoped process-group quiescence when the manager exits but a descendant ignores SIGTERM", async () => {
    chmodSync(FIXTURE, 0o700);
    const path = root();
    const destination = join(path, "cancelled-tools");
    const parentPidPath = join(path, "fixture-parent.pid");
    const childPidPath = join(path, "fixture-child.pid");
    const store = storeAt(path);
    const controller = new AbortController();
    let execution: ReturnType<typeof executeManagedInstall> | undefined;
    try {
      const { action } = await propose(store, path, "cancelled", { destination, ignoreScripts: true });
      execution = executeManagedInstall({
        repository: store.assistantWork,
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId: stableAttemptId(action.id, action.revision, "cancelled"),
        workerId: "install-worker",
        bunPath: FIXTURE,
        env: {
          ...installEnv(path, "hang"),
          OI_PACKAGE_MANAGER_PARENT_PID: parentPidPath,
          OI_PACKAGE_MANAGER_CHILD_PID: childPidPath,
        },
        signal: controller.signal,
        killGraceMs: 250,
        now: () => T1,
      });
      await waitFor(() => existsSync(parentPidPath) && existsSync(childPidPath), 5_000);
      const parentPid = Number(readFileSync(parentPidPath, "utf8"));
      const childPid = Number(readFileSync(childPidPath, "utf8"));
      expect(processExists(parentPid)).toBe(true);
      expect(processExists(childPid)).toBe(true);
      controller.abort();
      await waitFor(() => !processExists(parentPid));
      const settledAfterParentExit = await Promise.race([
        execution.then(() => true),
        Bun.sleep(25).then(() => false),
      ]);
      expect(settledAfterParentExit).toBe(false);
      expect(processExists(childPid)).toBe(true);

      const result = await execution;
      expect(result).toMatchObject({
        kind: "definitive_failed",
        attempt: {
          state: "definitive_failed",
          outcome: {
            code: "install_cancelled_after_start",
            noChangeProven: true,
            process: { processGroupQuiescent: true },
          },
        },
      });
      await waitFor(() => !processExists(childPid));
      expect(processExists(childPid)).toBe(false);
      expect(existsSync(destination)).toBe(false);
      expect(parseArgvLog(path)).toHaveLength(1);
    } finally {
      controller.abort();
      try { if (execution) await execution; } finally { store.close(); }
    }
  });

  test("tool API has strict proposal/execute separation and no caller authority fields", async () => {
    chmodSync(FIXTURE, 0o700);
    const path = root();
    const store = storeAt(path);
    try {
      const work = admitWork(store, "tool-api");
      const tool = createManagedInstallTool({
        repository: store.assistantWork,
        bunPath: FIXTURE,
        env: installEnv(path),
        now: () => new Date(T1),
      });
      expect(tool.name).toBe("assistant_managed_install");
      const parameterSchema = tool.parameters as unknown as {
        readonly toJSON: () => { readonly additionalProperties?: boolean; readonly properties?: Record<string, unknown> };
        readonly safeParse: (value: unknown) => { readonly success: boolean };
      };
      const schema = parameterSchema.toJSON();
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
        "actionId", "destination", "digest", "ignoreScripts", "operation", "packageSpec", "revision", "semanticKey", "workId",
      ].sort());
      expect(parameterSchema.safeParse({
        operation: "execute",
        actionId: "action",
        revision: 1,
        digest: "0".repeat(64),
        unexpectedAuthority: "owner",
      }).success).toBe(false);
      await expect(tool.execute("proposal-call", {
        operation: "propose",
        workId: work.id,
        semanticKey: "tool-install",
        packageSpec: "fixture-tool@1.2.3",
        destination: join(path, "tool-api-tools"),
      } as never, undefined, {} as never)).resolves.toMatchObject({
        details: { operation: "propose", effectExecuted: false, action: { state: "planned" } },
      });
      await expect(tool.execute("bad-execute", {
        operation: "execute",
        actionId: "action",
        revision: 1,
        digest: "0".repeat(64),
        packageSpec: "fixture-tool@1.2.3",
      } as never, undefined, {} as never)).rejects.toThrow("accepts only actionId, revision, and digest");
    } finally {
      store.close();
    }
  });
});

test("reopened dedicated-root preflight ignores unrelated obsolete action states", async () => {
  chmodSync(FIXTURE, 0o700);
  const path = root();
  const destination = join(path, "recognized-tools");
  const initial = storeAt(path);
  const { action } = await propose(initial, path, "recognized", { destination, ignoreScripts: true });
  const unrelated = await propose(initial, path, "obsolete-unrelated");
  try {
    expect(await executeManagedInstall({
      repository: initial.assistantWork, actionId: action.id, revision: action.revision, digest: action.digest,
      attemptId: stableAttemptId(action.id, action.revision, "recognized-install"), workerId: "install-worker",
      bunPath: FIXTURE, env: installEnv(path), now: () => T1,
    })).toMatchObject({ kind: "confirmed" });
  } finally { initial.close(); }
  const db = new Database(join(path, "state.db"));
  try { db.query("UPDATE assistant_work_actions SET state = 'approval_pending' WHERE id = ?").run(unrelated.action.id); }
  finally { db.close(); }
  const reopened = storeAt(path);
  try {
    const listing = reopened.assistantWork.listActions();
    expect(listing.actions).toContainEqual(expect.objectContaining({ id: action.id, state: "confirmed" }));
    expect(listing.unsupported).toMatchObject([{ actionId: unrelated.action.id, state: "approval_pending" }]);
    const next = await preflightManagedInstall({
      workId: action.workId, semanticKey: "recognized-next", packageSpec: "second-fixture-tool@2.0.0",
      destination, bunPath: FIXTURE, ignoreScripts: true, repository: reopened.assistantWork,
    });
    expect(next).toMatchObject({ effectClass: "ordinary_local_install", inventory: { dedicatedToolRoot: true, existing: true } });
    expect(readFileSync(join(destination, "node_modules", "fixture-tool", "installed.txt"), "utf8")).toBe("fixture install evidence\n");
    expect(parseArgvLog(path)).toHaveLength(1);
    expect(reopened.assistantWork.listAttempts(unrelated.action.id)).toHaveLength(0);
    expect(existsSync(unrelated.preflight.plan.destination)).toBe(false);
  } finally { reopened.close(); }
});
