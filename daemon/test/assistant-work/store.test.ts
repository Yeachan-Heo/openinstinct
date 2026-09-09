import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EFFECT_CLASSES,
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

  test("keeps action identity stable, rejects stale revisions, and separates recontact ordinals", () => {
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
      expect(revised).toMatchObject({ id: initial.id, revision: 2, state: "planned" });
      expect(revised.digest).not.toBe(initial.digest);

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
        attemptId: stableAttemptId(revised.id, revised.revision, "current"),
        workerId: "worker-a",
      }, T3)).toMatchObject({ kind: "claimed" });

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

describe("assistant-work autonomous atomic dispatch", () => {
  test("unsupported stored action states fail clearly without rewriting data or admitting attempts", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const work = admitWork(initial, "historical").work;
    const pending = initial.assistantWork.proposeAction(externalMessageAction(work.id, "pending"), T0);
    const ready = initial.assistantWork.proposeAction(externalMessageAction(work.id, "ready"), T0);
    const started = initial.assistantWork.proposeAction(externalMessageAction(work.id, "attempt"), T0);
    const attemptInput = { actionId: started.id, revision: started.revision, digest: started.digest,
      attemptId: "historical-attempt", workerId: "old-worker" };
    initial.assistantWork.claimForDispatch(attemptInput, T0);
    initial.close();
    const database = new Database(path);
    try {
      database.query("UPDATE assistant_work_actions SET state = ? WHERE id = ?").run("approval_pending", pending.id);
      database.query("UPDATE assistant_work_actions SET state = ? WHERE id = ?").run("authorized", ready.id);
      database.query("UPDATE assistant_work_attempts SET authorization_source = 'owner_rule', authorization_id = 'historical-rule', authorization_revision = 1 WHERE id = ?").run(attemptInput.attemptId);
    } finally { database.close(); }
    const reopened = openStateStore(path);
    try {
      const listing = reopened.assistantWork.listActions(work.id);
      expect(listing.actions.map((action) => action.id)).toEqual([started.id]);
      expect(listing.unsupported).toEqual([
        { kind: "unsupported_action_state", actionId: pending.id, workId: work.id,
          state: "approval_pending", revision: pending.revision, digest: pending.digest },
        { kind: "unsupported_action_state", actionId: ready.id, workId: work.id,
          state: "authorized", revision: ready.revision, digest: ready.digest },
      ]);
      expect(reopened.assistantWork.listActions()).toEqual(listing);
      const healthyWork = admitWork(reopened, "healthy-unrelated").work;
      const healthy = reopened.assistantWork.proposeAction(externalMessageAction(healthyWork.id), T1);
      expect(reopened.assistantWork.listActions(healthyWork.id)).toEqual({ actions: [healthy], unsupported: [] });
      expect(reopened.assistantWork.claimForDispatch({ actionId: healthy.id, revision: healthy.revision,
        digest: healthy.digest, attemptId: "healthy-dispatch", workerId: "new-worker" }, T1))
        .toMatchObject({ kind: "claimed" });
      for (const action of [pending, ready]) {
        expect(() => reopened.assistantWork.getAction(action.id)).toThrow("unsupported assistant action state");
        expect(() => reopened.assistantWork.claimForDispatch({ actionId: action.id, revision: action.revision,
          digest: action.digest, attemptId: `${action.id}-dispatch`, workerId: "new-worker" }, T1))
          .toThrow("unsupported assistant action state");
        expect(reopened.assistantWork.listAttempts(action.id)).toHaveLength(0);
      }
      expect(reopened.assistantWork.recoverAttempt({ attemptId: attemptInput.attemptId, workerId: "new-worker" }, T1))
        .toMatchObject({ kind: "resume_pre_effect", attempt: { id: attemptInput.attemptId, recoveryCount: 1 } });
      expect(reopened.assistantWork.listAttempts(started.id)).toHaveLength(1);
    } finally { reopened.close(); }
    const preserved = new Database(path, { readonly: true });
    try {
      expect(preserved.query("SELECT state, current_digest FROM assistant_work_actions WHERE id = ?").get(pending.id))
        .toEqual({ state: "approval_pending", current_digest: pending.digest });
      expect(preserved.query("SELECT state, current_digest FROM assistant_work_actions WHERE id = ?").get(ready.id))
        .toEqual({ state: "authorized", current_digest: ready.digest });
      expect(preserved.query("SELECT count(*) AS count FROM assistant_work_actions WHERE work_id = ?").get(work.id))
        .toEqual({ count: 3 });
    } finally { preserved.close(); }
  });

  test("cancelling a claimed delete fences effect start and recovery", () => {
    const store = openStateStore(stateDbPath());
    try {
      const work = admitWork(store, "cancel-claimed").work;
      const action = store.assistantWork.proposeAction({ ...externalMessageAction(work.id), effectClass: "delete_existing" }, T0);
      const input = { actionId: action.id, revision: action.revision, digest: action.digest,
        attemptId: "cancelled-attempt", workerId: "worker" };
      store.assistantWork.claimForDispatch(input, T0);
      store.assistantWork.cancelAction({ ...input, reason: "withdrawn" }, T1);
      expect(() => store.assistantWork.markEffectStarted(input, T2)).toThrow("external effect must not be invoked or repeated");
      expect(store.assistantWork.recoverAttempt(input, T2)).toMatchObject({ kind: "terminal_no_replay", attempt: { state: "cancelled" } });
      expect(store.assistantWork.listAttempts(action.id)).toHaveLength(1);
    } finally { store.close(); }
  });
  test("all supported effects dispatch without grants and only one connection wins", () => {
    const path = stateDbPath();
    const first = openStateStore(path);
    const second = openStateStore(path);
    try {
      const work = admitWork(first, "supported").work;
      for (const effectClass of EFFECT_CLASSES.filter((value) => value !== "uncovered")) {
        const action = first.assistantWork.proposeAction({
          ...externalMessageAction(work.id, effectClass), effectClass,
        }, T0);
        const input = { actionId: action.id, revision: action.revision, digest: action.digest,
          attemptId: stableAttemptId(action.id, action.revision, "winner"), workerId: "worker-a" };
        expect(first.assistantWork.claimForDispatch(input, T1)).toMatchObject({ kind: "claimed", resumed: false });
        expect(second.assistantWork.claimForDispatch({ ...input, attemptId: `${input.attemptId}-other`, workerId: "worker-b" }, T1))
          .toMatchObject({ kind: "rejected", reason: "already_claimed" });
        expect(first.assistantWork.claimForDispatch(input, T1)).toMatchObject({ kind: "claimed", resumed: true });
        first.assistantWork.markEffectStarted(input, T1);
        first.assistantWork.confirmAttempt({ ...input, outcome: { receipt: effectClass } }, T2);
        expect(second.assistantWork.claimForDispatch({ ...input, attemptId: `${input.attemptId}-duplicate` }, T3))
          .toMatchObject({ kind: "rejected", reason: "confirmed" });
        expect(first.assistantWork.listAttempts(action.id)).toHaveLength(1);
      }
    } finally { second.close(); first.close(); }
  });

  test("stale digests, cancellation, deadlines and terminal work still prevent effects", () => {
    const store = openStateStore(stateDbPath());
    try {
      const work = admitWork(store, "bounds").work;
      for (const reason of ["stale_digest", "cancelled", "expired", "terminal"] as const) {
        const action = store.assistantWork.proposeAction({
          ...externalMessageAction(work.id, reason),
          ...(reason === "expired" ? { deadlineAt: T1 } : {}),
        }, T0);
        const input = { actionId: action.id, revision: action.revision, digest: action.digest,
          attemptId: stableAttemptId(action.id, action.revision, reason), workerId: "worker" };
        if (reason === "cancelled") store.assistantWork.cancelAction({ ...input, reason: "withdrawn" }, T0);
        if (reason === "terminal") store.assistantWork.setWorkState(work.id, "completed", T0);
        expect(store.assistantWork.claimForDispatch({ ...input, ...(reason === "stale_digest" ? { digest: "0".repeat(64) } : {}) }, T1))
          .toMatchObject({ kind: "rejected", reason });
        expect(store.assistantWork.listAttempts(action.id)).toHaveLength(0);
      }
    } finally { store.close(); }
  });

  test("uncovered material stays blocked rather than waiting for permission", () => {
    const store = openStateStore(stateDbPath());
    try {
      const work = admitWork(store, "uncovered").work;
      const action = store.assistantWork.proposeAction({ workId: work.id, semanticKey: "unknown",
        effectClass: "uncovered", action: "unknown", payload: {}, blockedEvidence: { reason: "unsupported" } }, T0);
      expect(store.assistantWork.claimForDispatch({ actionId: action.id, revision: action.revision, digest: action.digest,
        attemptId: "uncovered-attempt", workerId: "worker" }, T1)).toMatchObject({ kind: "rejected", reason: "blocked" });
    } finally { store.close(); }
  });
});

describe("assistant-work crash boundaries", () => {
  test("deadline expiry fences both direct effect start and pre-effect recovery", () => {
    const store = openStateStore(stateDbPath());
    try {
      const work = admitWork(store, "deadline").work;
      const action = store.assistantWork.proposeAction({ ...externalMessageAction(work.id), deadlineAt: T2 }, T0);
      const input = { actionId: action.id, revision: action.revision, digest: action.digest,
        attemptId: "deadline-attempt", workerId: "worker" };
      expect(store.assistantWork.claimForDispatch(input, T1)).toMatchObject({ kind: "claimed" });
      expect(() => store.assistantWork.markEffectStarted(input, T2)).toThrow("deadline");
      expect(store.assistantWork.claimForDispatch(input, T2)).toMatchObject({ kind: "rejected", reason: "expired" });
      expect(store.assistantWork.recoverAttempt(input, T2)).toMatchObject({ kind: "terminal_no_replay",
        action: { state: "expired" }, attempt: { state: "cancelled", outcome: { reason: "deadline_expired" } } });
    } finally { store.close(); }
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
