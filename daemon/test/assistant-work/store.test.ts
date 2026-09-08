import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorizationRequirementForEffect,
  stableAttemptId,
  stableObservationId,
  stableRecontactId,
  stableWorkId,
} from "../../src/assistant-work/model.ts";
import type {
  EvidenceProvenance,
  ProposeActionInput,
} from "../../src/assistant-work/model.ts";
import { openStateStore, SchemaVersionError } from "../../src/store/db.ts";
import { MIGRATIONS } from "../../src/store/migrations.ts";

const directories: string[] = [];
const OWNER: EvidenceProvenance = {
  principal: "owner",
  channel: "chat",
  subject: "owner-account",
  evidenceId: "owner-turn-1",
};
const THIRD_PARTY: EvidenceProvenance = {
  principal: "third_party",
  channel: "mail",
  subject: "sender@example.test",
  evidenceId: "mail-message-1",
};

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const T3 = "2026-01-01T00:03:00.000Z";

function stateDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "openinstinct-assistant-work-"));
  directories.push(directory);
  return join(directory, "state.db");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function admitWork(store: ReturnType<typeof openStateStore>, suffix = "one") {
  return store.assistantWork.admitObservation({
    source: "mail:fixture-account",
    occurrenceKey: `message-${suffix}`,
    workKey: `thread-${suffix}`,
    workTitle: `Follow up ${suffix}`,
    provenance: THIRD_PARTY,
    observedAt: T0,
    evidence: { messageId: `message-${suffix}`, body: "Please follow up" },
  }, T0);
}

function externalMessageAction(
  workId: string,
  semanticKey = "reply",
  overrides: Partial<Pick<ProposeActionInput, "recipient" | "topic" | "action">> = {},
): ProposeActionInput {
  return {
    workId,
    semanticKey,
    effectClass: "external_message",
    recipient: "person@example.test",
    topic: "contract-renewal",
    action: "send_follow_up",
    payload: { body: "Checking in" },
    ...overrides,
  };
}

function createV8State(path: string, prepare?: (database: Database) => void): void {
  const database = new Database(path);
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of MIGRATIONS.slice(0, 8)) {
      database.exec(migration.sql);
      database.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, T0);
    }
    prepare?.(database);
  } finally {
    database.close();
  }
}

describe("assistant-work durable identity", () => {
  test("upgrades a populated v8 database without losing incomplete conversational work", () => {
    const path = stateDbPath();
    createV8State(path, (database) => {
      database.query(`
        INSERT INTO children (
          id, state, kind, created_at, updated_at, timeout_ms, title, prompt, priority, origin,
          last_activity_at, last_assistant_text, turn_seq
        ) VALUES (?, 'idle', 'task_tool', ?, ?, 60000, ?, ?, 'conversational', 'owner', ?, ?, 1)
      `).run("v8-child", T0, T1, "Existing incomplete child", "continue", T1, "waiting for owner");
      database.query(`
        INSERT INTO child_interim_batches (id, state, prompt, created_at, updated_at)
        VALUES (?, 'assigned', ?, ?, ?)
      `).run("v8-batch", "preserve this pending batch", T1, T1);
      database.query(`
        INSERT INTO child_interim_messages (
          id, child_id, idempotency_key, body, truncated, batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)
      `).run("v8-message", "v8-child", "v8-message-key", "pending child update", "v8-batch", T1, T1);
    });

    const upgraded = openStateStore(path);
    try {
      expect(upgraded.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(upgraded.getChild("v8-child")).toMatchObject({
        state: "idle",
        origin: "owner",
        lastAssistantText: "waiting for owner",
        turnSeq: 1,
      });
      expect(upgraded.getInterimBatch("v8-batch")).toMatchObject({
        state: "assigned",
        prompt: "preserve this pending batch",
      });
      expect(upgraded.listInterimMessages("v8-child")).toMatchObject([{
        id: "v8-message",
        batchId: "v8-batch",
        body: "pending child update",
      }]);
      expect(upgraded.assistantWork.listWorks()).toEqual([]);
      expect(admitWork(upgraded, "after-v8-upgrade").created).toBe(true);
    } finally {
      upgraded.close();
    }

    const validated = openStateStore(path);
    try {
      expect(validated.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(validated.getChild("v8-child")).toMatchObject({ state: "idle" });
      expect(validated.assistantWork.listWorks()).toHaveLength(1);
    } finally {
      validated.close();
    }
  });

  test("rejects an altered claimed-v8 schema on the first open without applying v9", () => {
    const path = stateDbPath();
    createV8State(path, (database) => {
      database.exec("ALTER TABLE child_interim_batches ADD COLUMN unfamiliar TEXT");
    });

    expect(() => openStateStore(path)).toThrow(SchemaVersionError);

    const preserved = new Database(path, { readonly: true });
    try {
      expect(preserved.query("SELECT max(version) AS version FROM schema_migrations").get())
        .toEqual({ version: 8 });
      expect(preserved.query(`
        SELECT count(*) AS count
        FROM pragma_table_info('child_interim_batches')
        WHERE name = 'unfamiliar'
      `).get()).toEqual({ count: 1 });
      expect(preserved.query(`
        SELECT count(*) AS count FROM sqlite_master WHERE name = 'assistant_work_works'
      `).get()).toEqual({ count: 0 });
    } finally {
      preserved.close();
    }
  });

  test("rejects a claimed-v8 migration-ledger gap without changing the ledger or schema", () => {
    const path = stateDbPath();
    createV8State(path, (database) => {
      database.query("DELETE FROM schema_migrations WHERE version = 6").run();
    });

    expect(() => openStateStore(path)).toThrow(SchemaVersionError);

    const preserved = new Database(path, { readonly: true });
    try {
      expect(preserved.query(`
        SELECT group_concat(version, ',') AS versions
        FROM (SELECT version FROM schema_migrations ORDER BY version)
      `).get()).toEqual({ versions: "1,2,3,4,5,7,8" });
      expect(preserved.query(`
        SELECT count(*) AS count FROM sqlite_master WHERE name = 'assistant_work_works'
      `).get()).toEqual({ count: 0 });
    } finally {
      preserved.close();
    }
  });
  test("classifies autonomous, explicit-owner, rule-or-explicit, and blocked effects", () => {
    expect(authorizationRequirementForEffect("ordinary_local_edit")).toBe("local_policy");
    expect(authorizationRequirementForEffect("ordinary_local_install")).toBe("local_policy");
    for (const effectClass of [
      "delete_existing",
      "bulk_existing_user_assets",
      "core_setting_change",
      "account_rights_change",
      "cost_increase",
      "external_mutation",
    ] as const) {
      expect(authorizationRequirementForEffect(effectClass)).toBe("owner_explicit");
    }
    expect(authorizationRequirementForEffect("external_message")).toBe("owner_rule_or_explicit");
    expect(authorizationRequirementForEffect("uncovered")).toBe("blocked");
  });
  test("migrates through v9 and deduplicates a stable source occurrence without duplicating work", () => {
    const store = openStateStore(stateDbPath());
    try {
      const input = {
        source: "mail:fixture-account",
        occurrenceKey: "message-42",
        workKey: "thread-42",
        workTitle: "Renewal follow-up",
        provenance: THIRD_PARTY,
        observedAt: T0,
        evidence: { messageId: "message-42", labels: ["inbox"] },
      } as const;

      const first = store.assistantWork.admitObservation(input, T0);
      const replay = store.assistantWork.admitObservation(input, T1);

      expect(store.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(first.work.id).toBe(stableWorkId(input.workKey));
      expect(first.observation.id).toBe(stableObservationId(input.source, input.occurrenceKey));
      expect(replay.observation).toEqual(first.observation);
      expect(store.assistantWork.listWorks()).toHaveLength(1);
      expect(store.assistantWork.listObservations(first.work.id)).toHaveLength(1);

      const changedReplay = store.assistantWork.admitObservation({
        ...input,
        observedAt: T2,
        evidence: { messageId: "message-42", labels: ["changed"] },
      }, T2);
      expect(changedReplay).toMatchObject({
        created: false,
        observation: { evidence: { messageId: "message-42", labels: ["inbox"] }, observedAt: T0 },
      });
      expect(store.assistantWork.listObservations(first.work.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("keeps action identity stable, increments material revisions, invalidates stale approval, and separates recontact ordinals", () => {
    const store = openStateStore(stateDbPath());
    try {
      const work = admitWork(store).work;
      const initial = store.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "update-record",
        effectClass: "external_mutation",
        action: "update_record",
        payload: { value: "first" },
        scope: { service: "novel-service", record: "record-1" },
      }, T0);
      const approval = store.assistantWork.grantExplicitApproval({
        actionId: initial.id,
        revision: initial.revision,
        digest: initial.digest,
        provenance: OWNER,
      }, T1);

      const replay = store.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "update-record",
        effectClass: "external_mutation",
        action: "update_record",
        payload: { value: "first" },
        scope: { record: "record-1", service: "novel-service" },
      }, T1);
      expect(replay).toMatchObject({ id: initial.id, revision: 1, digest: initial.digest });

      const revised = store.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "update-record",
        effectClass: "external_mutation",
        action: "update_record",
        payload: { value: "second" },
        scope: { service: "novel-service", record: "record-1" },
      }, T2);
      expect(revised).toMatchObject({ id: initial.id, revision: 2, state: "approval_pending" });
      expect(revised.digest).not.toBe(initial.digest);
      expect(store.assistantWork.getExplicitApproval(approval.id)).toMatchObject({ state: "invalidated" });

      expect(store.assistantWork.claimForDispatch({
        actionId: initial.id,
        revision: initial.revision,
        digest: initial.digest,
        attemptId: stableAttemptId(initial.id, initial.revision, "stale-claim"),
        workerId: "worker-a",
      }, T3)).toMatchObject({ kind: "rejected", reason: "stale_revision" });
      expect(store.assistantWork.claimForDispatch({
        actionId: revised.id,
        revision: revised.revision,
        digest: revised.digest,
        attemptId: stableAttemptId(revised.id, revised.revision, "unapproved"),
        workerId: "worker-a",
      }, T3)).toMatchObject({ kind: "rejected", reason: "approval_required" });

      const firstRecontact = store.assistantWork.admitRecontact({
        actionId: revised.id,
        actionRevision: revised.revision,
        ordinal: 1,
        scheduledAt: "2026-01-02T00:00:00.000Z",
        context: { body: "Same reminder" },
      }, T3);
      const replayedRecontact = store.assistantWork.admitRecontact({
        actionId: revised.id,
        actionRevision: revised.revision,
        ordinal: 1,
        scheduledAt: "2026-01-02T00:00:00.000Z",
        context: { body: "Same reminder" },
      }, T3);
      const secondRecontact = store.assistantWork.admitRecontact({
        actionId: revised.id,
        actionRevision: revised.revision,
        ordinal: 2,
        scheduledAt: "2026-01-03T00:00:00.000Z",
        context: { body: "Same reminder" },
      }, T3);

      expect(firstRecontact.id).toBe(stableRecontactId(revised.id, revised.revision, 1));
      expect(replayedRecontact).toEqual(firstRecontact);
      expect(secondRecontact.id).not.toBe(firstRecontact.id);
      expect(store.assistantWork.listRecontacts(revised.id)).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe("assistant-work authority and atomic claim", () => {
  test("requires owner provenance and matches owner rules by recipient AND topic AND action", () => {
    const store = openStateStore(stateDbPath());
    try {
      expect(() => store.assistantWork.setOwnerRule({
        matcher: {
          effectClass: "external_message",
          recipient: "person@example.test",
          topic: "contract-renewal",
          action: "send_follow_up",
        },
        provenance: THIRD_PARTY,
      }, T0)).toThrow("third_party evidence cannot create owner authorization");

      const rule = store.assistantWork.setOwnerRule({
        matcher: {
          effectClass: "external_message",
          recipient: "person@example.test",
          topic: "contract-renewal",
          action: "send_follow_up",
        },
        provenance: OWNER,
      }, T0);
      const work = admitWork(store, "rules").work;

      const mismatches = [
        externalMessageAction(work.id, "wrong-recipient", { recipient: "other@example.test" }),
        externalMessageAction(work.id, "wrong-topic", { topic: "different-topic" }),
        externalMessageAction(work.id, "wrong-action", { action: "send_invoice" }),
      ];
      for (const [index, proposal] of mismatches.entries()) {
        const action = store.assistantWork.proposeAction(proposal, T1);
        expect(store.assistantWork.claimForDispatch({
          actionId: action.id,
          revision: action.revision,
          digest: action.digest,
          attemptId: stableAttemptId(action.id, action.revision, `mismatch-${index}`),
          workerId: "worker-a",
        }, T2)).toMatchObject({ kind: "rejected", reason: "approval_required" });
      }

      const matching = store.assistantWork.proposeAction(externalMessageAction(work.id, "matching"), T1);
      const claim = store.assistantWork.claimForDispatch({
        actionId: matching.id,
        revision: matching.revision,
        digest: matching.digest,
        attemptId: stableAttemptId(matching.id, matching.revision, "matching"),
        workerId: "worker-a",
      }, T2);
      expect(claim).toMatchObject({
        kind: "claimed",
        resumed: false,
        attempt: {
          state: "claimed_pre_effect",
          authorizationSource: "owner_rule",
          authorizationId: rule.id,
          authorizationRevision: rule.revision,
        },
      });
    } finally {
      store.close();
    }
  });

  test("consumes one explicit approval with the claim and lets only one StateStore connection win", () => {
    const path = stateDbPath();
    const first = openStateStore(path);
    const second = openStateStore(path);
    try {
      const work = admitWork(first, "concurrent").work;
      const action = first.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "delete-file",
        effectClass: "delete_existing",
        action: "delete_file",
        payload: { path: "/tmp/existing-user-file" },
        scope: { existing: true },
      }, T0);
      const approval = first.assistantWork.grantExplicitApproval({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        provenance: OWNER,
      }, T1);

      expect(() => first.assistantWork.grantExplicitApproval({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        provenance: { ...THIRD_PARTY, evidenceId: "malicious-approval" },
      }, T1)).toThrow("third_party evidence cannot create owner authorization");

      const winningAttemptId = stableAttemptId(action.id, action.revision, "winner");
      const winner = first.assistantWork.claimForDispatch({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId: winningAttemptId,
        workerId: "worker-a",
      }, T2);
      const replayedWinner = first.assistantWork.claimForDispatch({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId: winningAttemptId,
        workerId: "worker-a",
      }, T2);
      const loser = second.assistantWork.claimForDispatch({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId: stableAttemptId(action.id, action.revision, "loser"),
        workerId: "worker-b",
      }, T2);

      expect(winner).toMatchObject({
        kind: "claimed",
        attempt: { authorizationSource: "owner_explicit", authorizationId: approval.id },
      });
      expect(replayedWinner).toMatchObject({
        kind: "claimed",
        resumed: true,
        attempt: { id: winningAttemptId },
      });
      expect(loser).toMatchObject({
        kind: "rejected",
        reason: "already_claimed",
        attempt: { id: winningAttemptId },
      });
      expect(first.assistantWork.getExplicitApproval(approval.id)).toMatchObject({
        state: "consumed",
        consumedAttemptId: winningAttemptId,
      });
      expect(first.assistantWork.listAttempts(action.id)).toHaveLength(1);
    } finally {
      second.close();
      first.close();
    }
  });

  test("rechecks rule revocation, cancellation, and deadline inside claim", () => {
    const store = openStateStore(stateDbPath());
    try {
      const rule = store.assistantWork.setOwnerRule({
        matcher: {
          effectClass: "external_message",
          recipient: "person@example.test",
          topic: "contract-renewal",
          action: "send_follow_up",
        },
        provenance: OWNER,
      }, T0);
      const work = admitWork(store, "current-policy").work;
      const ruledAction = store.assistantWork.proposeAction(externalMessageAction(work.id, "revoked-rule"), T0);
      store.assistantWork.revokeOwnerRule(rule.id, rule.revision, { ...OWNER, evidenceId: "owner-turn-revoke" }, T1);
      expect(store.assistantWork.claimForDispatch({
        actionId: ruledAction.id,
        revision: ruledAction.revision,
        digest: ruledAction.digest,
        attemptId: stableAttemptId(ruledAction.id, ruledAction.revision, "revoked"),
        workerId: "worker-a",
      }, T2)).toMatchObject({ kind: "rejected", reason: "approval_required" });

      const cancelled = store.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "cancelled-delete",
        effectClass: "delete_existing",
        action: "delete_file",
        payload: { path: "/tmp/cancelled" },
      }, T0);
      store.assistantWork.grantExplicitApproval({
        actionId: cancelled.id,
        revision: cancelled.revision,
        digest: cancelled.digest,
        provenance: { ...OWNER, evidenceId: "owner-turn-cancelled" },
      }, T1);
      store.assistantWork.cancelAction({
        actionId: cancelled.id,
        revision: cancelled.revision,
        digest: cancelled.digest,
        reason: "source request was withdrawn",
      }, T2);
      expect(store.assistantWork.claimForDispatch({
        actionId: cancelled.id,
        revision: cancelled.revision,
        digest: cancelled.digest,
        attemptId: stableAttemptId(cancelled.id, cancelled.revision, "cancelled"),
        workerId: "worker-a",
      }, T2)).toMatchObject({ kind: "rejected", reason: "cancelled" });

      const expiring = store.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "expired-update",
        effectClass: "external_mutation",
        action: "submit_form",
        payload: { value: "expired" },
        deadlineAt: T2,
      }, T0);
      const expiryApproval = store.assistantWork.grantExplicitApproval({
        actionId: expiring.id,
        revision: expiring.revision,
        digest: expiring.digest,
        provenance: { ...OWNER, evidenceId: "owner-turn-expiring" },
      }, T1);
      expect(store.assistantWork.claimForDispatch({
        actionId: expiring.id,
        revision: expiring.revision,
        digest: expiring.digest,
        attemptId: stableAttemptId(expiring.id, expiring.revision, "expired"),
        workerId: "worker-a",
      }, T2)).toMatchObject({ kind: "rejected", reason: "expired" });
      expect(store.assistantWork.getExplicitApproval(expiryApproval.id)).toMatchObject({ state: "invalidated" });
    } finally {
      store.close();
    }
  });

  test("uses only ordinary local edit/install as autonomous policy and blocks uncovered paths with evidence", () => {
    const store = openStateStore(stateDbPath());
    try {
      const work = admitWork(store, "effect-classes").work;
      const install = store.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "install-package",
        effectClass: "ordinary_local_install",
        action: "install_package",
        payload: { package: "existing-approved-tool" },
        scope: { generatedOutputPaths: ["one", "two", "three"] },
      }, T0);
      expect(store.assistantWork.claimForDispatch({
        actionId: install.id,
        revision: install.revision,
        digest: install.digest,
        attemptId: stableAttemptId(install.id, install.revision, "local-install"),
        workerId: "worker-a",
      }, T1)).toMatchObject({
        kind: "claimed",
        attempt: { authorizationSource: "local_policy" },
      });

      const rights = store.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "grant-rights",
        effectClass: "account_rights_change",
        action: "grant_rights",
        payload: { right: "admin" },
      }, T0);
      expect(store.assistantWork.claimForDispatch({
        actionId: rights.id,
        revision: rights.revision,
        digest: rights.digest,
        attemptId: stableAttemptId(rights.id, rights.revision, "rights"),
        workerId: "worker-a",
      }, T1)).toMatchObject({ kind: "rejected", reason: "approval_required" });

      const uncovered = store.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "unmanaged-effect",
        effectClass: "uncovered",
        action: "invoke_unmanaged_path",
        payload: { path: "unknown" },
        blockedEvidence: { reason: "no cooperative effect hook" },
      }, T0);
      expect(uncovered).toMatchObject({ state: "blocked", blockedEvidence: { reason: "no cooperative effect hook" } });
      expect(store.assistantWork.claimForDispatch({
        actionId: uncovered.id,
        revision: uncovered.revision,
        digest: uncovered.digest,
        attemptId: stableAttemptId(uncovered.id, uncovered.revision, "blocked"),
        workerId: "worker-a",
      }, T1)).toMatchObject({ kind: "rejected", reason: "blocked" });
    } finally {
      store.close();
    }
  });
});

describe("assistant-work crash boundaries", () => {
  test("rechecks owner-rule revision and deadline before resuming a pre-effect attempt", () => {
    const store = openStateStore(stateDbPath());
    try {
      const rule = store.assistantWork.setOwnerRule({
        matcher: {
          effectClass: "external_message",
          recipient: "person@example.test",
          topic: "contract-renewal",
          action: "send_follow_up",
        },
        provenance: OWNER,
      }, T0);
      const work = admitWork(store, "recovery-policy").work;
      const ruledAction = store.assistantWork.proposeAction(
        externalMessageAction(work.id, "recovery-rule"),
        T0,
      );
      const ruledAttemptId = stableAttemptId(ruledAction.id, ruledAction.revision, "recovery-rule");
      store.assistantWork.claimForDispatch({
        actionId: ruledAction.id,
        revision: ruledAction.revision,
        digest: ruledAction.digest,
        attemptId: ruledAttemptId,
        workerId: "worker-before-restart",
      }, T1);
      store.assistantWork.revokeOwnerRule(
        rule.id,
        rule.revision,
        { ...OWNER, evidenceId: "owner-turn-revoke-before-recovery" },
        T2,
      );

      const revokedRecovery = store.assistantWork.recoverAttempt({
        attemptId: ruledAttemptId,
        workerId: "worker-after-restart",
      }, T3);
      expect(revokedRecovery).toMatchObject({
        kind: "terminal_no_replay",
        action: { state: "approval_pending" },
        attempt: {
          state: "cancelled",
          workerId: "worker-before-restart",
          outcome: { reason: "authorization_no_longer_current" },
        },
      });
      expect(revokedRecovery.action.activeAttemptId).toBeUndefined();

      const expiringAction = store.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "recovery-deadline",
        effectClass: "ordinary_local_edit",
        action: "write_file",
        payload: { path: "/tmp/deadline", body: "content" },
        deadlineAt: T2,
      }, T0);
      const expiringAttemptId = stableAttemptId(expiringAction.id, expiringAction.revision, "recovery-deadline");
      store.assistantWork.claimForDispatch({
        actionId: expiringAction.id,
        revision: expiringAction.revision,
        digest: expiringAction.digest,
        attemptId: expiringAttemptId,
        workerId: "worker-before-restart",
      }, T1);

      const expiredRecovery = store.assistantWork.recoverAttempt({
        attemptId: expiringAttemptId,
        workerId: "worker-after-restart",
      }, T2);
      expect(expiredRecovery).toMatchObject({
        kind: "terminal_no_replay",
        action: { state: "expired" },
        attempt: {
          state: "cancelled",
          workerId: "worker-before-restart",
          outcome: { reason: "deadline_expired" },
        },
      });
      expect(expiredRecovery.action.activeAttemptId).toBeUndefined();
    } finally {
      store.close();
    }
  });
  test("recovers claimed_pre_effect with the same attempt but makes a started effect ambiguous without takeover", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const work = admitWork(initial, "recovery").work;
    const action = initial.assistantWork.proposeAction({
      workId: work.id,
      semanticKey: "approved-external-mutation",
      effectClass: "external_mutation",
      action: "update_record",
      payload: { service: "fixture", record: "record-1", value: "content" },
    }, T0);
    initial.assistantWork.grantExplicitApproval({
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      provenance: { ...OWNER, evidenceId: "owner-turn-recovery" },
    }, T0);
    const attemptId = stableAttemptId(action.id, action.revision, "recovery");
    expect(initial.assistantWork.claimForDispatch({
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId,
      workerId: "worker-before-restart",
    }, T1)).toMatchObject({ kind: "claimed", attempt: { state: "claimed_pre_effect" } });
    initial.close();

    const recovered = openStateStore(path);
    try {
      const preEffect = recovered.assistantWork.recoverAttempt({
        attemptId,
        workerId: "worker-after-restart",
      }, T2);
      expect(preEffect).toMatchObject({
        kind: "resume_pre_effect",
        attempt: { id: attemptId, state: "claimed_pre_effect", workerId: "worker-after-restart", recoveryCount: 1 },
      });

      const started = recovered.assistantWork.markEffectStarted({
        attemptId,
        workerId: "worker-after-restart",
      }, T2);
      expect(started).toMatchObject({
        action: { state: "effect_started" },
        attempt: { state: "effect_started", effectStartedAt: T2 },
      });
    } finally {
      recovered.close();
    }

    const afterStartedCrash = openStateStore(path);
    try {
      const ambiguous = afterStartedCrash.assistantWork.recoverAttempt({
        attemptId,
        workerId: "worker-must-not-take-over",
      }, T3);
      expect(ambiguous).toMatchObject({
        kind: "reconcile_only",
        action: { state: "ambiguous" },
        attempt: {
          state: "ambiguous",
          workerId: "worker-after-restart",
          outcome: { reason: "recovered_effect_started_without_outcome" },
        },
      });
      expect(afterStartedCrash.assistantWork.claimForDispatch({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId: stableAttemptId(action.id, action.revision, "must-not-resend"),
        workerId: "worker-must-not-take-over",
      }, T3)).toMatchObject({ kind: "rejected", reason: "ambiguous" });
      expect(afterStartedCrash.assistantWork.listAttempts(action.id)).toHaveLength(1);
    } finally {
      afterStartedCrash.close();
    }
  });

  test("persists effect_started before confirmation and never replays a confirmed revision", () => {
    const path = stateDbPath();
    const store = openStateStore(path);
    const work = admitWork(store, "confirmed").work;
    const action = store.assistantWork.proposeAction({
      workId: work.id,
      semanticKey: "confirmed-edit",
      effectClass: "ordinary_local_edit",
      action: "write_file",
      payload: { path: "/tmp/confirmed", body: "done" },
    }, T0);
    const attemptId = stableAttemptId(action.id, action.revision, "confirmed");
    store.assistantWork.claimForDispatch({
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId,
      workerId: "worker-a",
    }, T1);
    store.assistantWork.markEffectStarted({ attemptId, workerId: "worker-a" }, T2);
    store.close();

    const reopened = openStateStore(path);
    try {
      expect(reopened.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "effect_started",
        effectStartedAt: T2,
      });
      reopened.assistantWork.confirmAttempt({
        attemptId,
        workerId: "worker-a",
        outcome: { receipt: "local-content-hash" },
      }, T3);
      expect(reopened.assistantWork.recoverAttempt({
        attemptId,
        workerId: "worker-b",
      }, T3)).toMatchObject({ kind: "confirmed_no_replay", action: { state: "confirmed" } });
      expect(reopened.assistantWork.claimForDispatch({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId: stableAttemptId(action.id, action.revision, "confirmed-replay"),
        workerId: "worker-b",
      }, T3)).toMatchObject({ kind: "rejected", reason: "confirmed" });
      expect(() => reopened.assistantWork.markEffectStarted({
        attemptId,
        workerId: "worker-a",
      }, T3)).toThrow("external effect must not be invoked or repeated");
    } finally {
      reopened.close();
    }
  });
});
