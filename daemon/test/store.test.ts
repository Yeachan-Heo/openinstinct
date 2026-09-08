import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStateStore, SchemaVersionError } from "../src/store/index.ts";
import { MIGRATIONS } from "../src/store/migrations.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stateDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "openinstinct-store-"));
  directories.push(directory);
  return join(directory, "state.db");
}

function addAbandonedSchema8(path: string, withPendingBatch = false, coldState: "cold" | "COLD" = "cold"): void {
  const database = new Database(path);
  try {
    // The current released schema is v8. Rewind only its v8 objects/ledger row,
    // then install the historical abandoned v8 shape that recovery must detect.
    database.exec(`
      DROP TABLE child_interim_messages;
      DROP TABLE child_interim_batches;
      DROP INDEX children_live_idx;
      DELETE FROM schema_migrations WHERE version = 8;
    `);
    database.exec(`
      CREATE TABLE children_v8 (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('requested','admitted','running','idle','${coldState}','completed','failed','timeout','cancelled','orphaned','terminated')),
        kind TEXT NOT NULL CHECK (kind IN ('task_tool','daemon')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT,
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
        title TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',
        journal_path TEXT, terminal_checksum TEXT, terminal_summary TEXT, error_code TEXT, session_file TEXT,
        priority TEXT NOT NULL DEFAULT 'conversational' CHECK (priority IN ('conversational','monitor')),
        started_at TEXT, tokens INTEGER, tool_calls INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'owner' CHECK (origin IN ('owner','monitor','memory')),
        last_activity_at TEXT, last_assistant_text TEXT,
        turn_seq INTEGER NOT NULL DEFAULT 0,
        interim_omitted INTEGER NOT NULL DEFAULT 0 CHECK (interim_omitted >= 0)
      );
      DROP TABLE children;
      ALTER TABLE children_v8 RENAME TO children;
      CREATE INDEX children_state_idx ON children (state, priority, created_at);
      CREATE INDEX children_live_idx ON children (state, last_activity_at);
      CREATE TABLE child_interim_batches (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('assigned','injected','delivered')),
        mode TEXT CHECK (mode IN ('steer','turn')),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        prompt TEXT NOT NULL,
        omitted_json TEXT NOT NULL DEFAULT '{}',
        owner_turn_id TEXT,
        delivery_id TEXT REFERENCES deliveries(id),
        outcome TEXT CHECK (outcome IN ('owner_text','silent','reply_lost')),
        created_at TEXT NOT NULL,
        injected_at TEXT,
        delivered_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX child_interim_batches_state_idx ON child_interim_batches (state, created_at);
      CREATE TABLE child_interim_messages (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL REFERENCES children(id),
        idempotency_key TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
        batch_id TEXT REFERENCES child_interim_batches(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX child_interim_unbatched_idx ON child_interim_messages (batch_id, created_at);
    `);
    if (withPendingBatch) {
      database.query(`
        INSERT INTO child_interim_batches (id, state, prompt, created_at, updated_at)
        VALUES ('pending', 'assigned', 'preserve me', ?, ?)
      `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    }
    database.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(8, new Date().toISOString());
  } finally {
    database.close();
  }
}

describe("StateStore migrations", () => {
  test("migrates an empty database through v9 with action ledger tables", () => {
    const store = openStateStore(stateDbPath());
    try {
      expect(store.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(store.schemaTables()).toEqual([
        "assistant_work_action_revisions",
        "assistant_work_actions",
        "assistant_work_attempts",
        "assistant_work_explicit_approvals",
        "assistant_work_followup_dispatches",
        "assistant_work_followup_policies",
        "assistant_work_notification_routes",
        "assistant_work_notifications",
        "assistant_work_observations",
        "assistant_work_owner_rules",
        "assistant_work_recontacts",
        "assistant_work_reports",
        "assistant_work_works",
        "child_interim_batches",
        "child_interim_messages",
        "children",
        "deliveries",
        "memory_intents",
        "meta",
        "monitor_events",
        "monitors",
        "receipts",
        "schema_migrations",
      ]);
    } finally {
      store.close();
    }
  });

  test("re-runs migrations idempotently", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    initial.close();

    const reopened = openStateStore(path);
    try {
      expect(reopened.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    } finally {
      reopened.close();
    }
  });

  test("upgrades a v1 database through delivery, child lifecycle, and monitor propagation migrations", () => {
    const path = stateDbPath();
    const database = new Database(path);
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY CHECK (version > 0),
          applied_at TEXT NOT NULL
        )
      `);
      database.exec(MIGRATIONS[0]!.sql);
      database.query("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)")
        .run(new Date().toISOString());
    } finally {
      database.close();
    }

    const store = openStateStore(path);
    try {
      expect(store.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const admitted = store.admitDelivery({
        id: "delivery-v2",
        idempotencyKey: "v2-test",
        kind: "text",
        handle: "+821012345678",
        body: "migrated",
      }, "2026-01-01T00:00:00.000Z");
      expect(admitted).toMatchObject({ state: "pending", degraded: false, redelivered: false });
    } finally {
      store.close();
    }
  });

  test("rebuilds v3 child rows with normalized terminal states and receipt hashes", () => {
    const path = stateDbPath();
    const database = new Database(path);
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY CHECK (version > 0),
          applied_at TEXT NOT NULL
        )
      `);
      for (const migration of MIGRATIONS.slice(0, 3)) {
        database.exec(migration.sql);
        database.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
      }
      database.query(
        `INSERT INTO children (id, state, kind, created_at, updated_at, terminal_at, timeout_ms, title, prompt)
         VALUES (?, 'timed_out', 'daemon', ?, ?, ?, ?, ?, ?)`,
      ).run("legacy-child", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z", 1_000, "Memory canonicalization", "prompt");
      database.query(
        `INSERT INTO receipts (id, child_id, state, idempotency_key, projection, created_at, updated_at)
         VALUES (?, ?, 'persisted', ?, ?, ?, ?)`,
      ).run("legacy-receipt", "legacy-child", "legacy-key", "legacy projection", "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:01.000Z");
    } finally {
      database.close();
    }

    const store = openStateStore(path);
    try {
      expect(store.getChild("legacy-child")).toMatchObject({
        state: "timeout",
        priority: "conversational",
        origin: "memory",
      });
      expect(store.getReceipt("legacy-receipt")).toMatchObject({ contentHash: "" });
    } finally {
      store.close();
    }
  });

  test("accepts the historical schema v8 now that it is the released conversational-child schema", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    initial.setMeta("repair.sentinel", "preserved");
    initial.close();
    addAbandonedSchema8(path);

    const recovered = openStateStore(path);
    try {
      expect(recovered.migrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(recovered.schemaTables()).toContain("child_interim_batches");
      expect(recovered.schemaTables()).toContain("child_interim_messages");
      expect(recovered.getMeta("repair.sentinel")).toBe("preserved");
      expect(recovered.getMeta("store.abandoned_schema_8_recovered")).toBeUndefined();
    } finally {
      recovered.close();
    }
  });

  test("refuses an unfamiliar schema that reuses the abandoned v8 object names", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    initial.close();
    addAbandonedSchema8(path);

    const database = new Database(path);
    database.exec("ALTER TABLE child_interim_batches ADD COLUMN unfamiliar TEXT");
    database.close();

    expect(() => openStateStore(path)).toThrow(SchemaVersionError);
  });

  test("preserves string-literal case when fingerprinting the abandoned v8 schema", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    initial.close();
    addAbandonedSchema8(path, false, "COLD");

    const database = new Database(path);
    database.query(`
      INSERT INTO children (id, state, kind, created_at, updated_at, timeout_ms)
      VALUES ('uppercase-cold', 'COLD', 'daemon', ?, ?, 1000)
    `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database.close();

    expect(() => openStateStore(path)).toThrow(SchemaVersionError);

    const preserved = new Database(path);
    try {
      expect(preserved.query("SELECT state FROM children WHERE id = 'uppercase-cold'").get())
        .toEqual({ state: "COLD" });
      expect(preserved.query("SELECT max(version) AS version FROM schema_migrations").get())
        .toEqual({ version: 9 });
      expect(preserved.query(`
        SELECT count(*) AS count
        FROM sqlite_master
        WHERE name IN ('child_interim_batches', 'child_interim_messages')
      `).get()).toEqual({ count: 2 });
    } finally {
      preserved.close();
    }
  });

  test("refuses extra objects alongside the abandoned v8 schema", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    initial.close();
    addAbandonedSchema8(path);

    const database = new Database(path);
    database.exec("CREATE TABLE unfamiliar_v8_state (id TEXT PRIMARY KEY)");
    database.close();

    expect(() => openStateStore(path)).toThrow(SchemaVersionError);
  });

  test("refuses an abandoned v8 index name with unfamiliar semantics", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    initial.close();
    addAbandonedSchema8(path);

    const database = new Database(path);
    database.exec(`
      DROP INDEX child_interim_unbatched_idx;
      CREATE INDEX child_interim_unbatched_idx ON child_interim_messages (created_at);
    `);
    database.close();

    expect(() => openStateStore(path)).toThrow(SchemaVersionError);
  });

  test("preserves pending data in the now-supported schema v8", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    initial.close();
    addAbandonedSchema8(path, true);

    const reopened = openStateStore(path);
    try {
      expect(reopened.listInterimBatches("assigned")).toHaveLength(1);
      expect(reopened.listInterimBatches("assigned")[0]?.prompt).toBe("preserve me");
    } finally {
      reopened.close();
    }
  });

  test("preserves supported cold child lifecycle state in schema v8", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    initial.close();
    addAbandonedSchema8(path);

    const database = new Database(path);
    database.query(`
      INSERT INTO children (id, state, kind, created_at, updated_at, timeout_ms)
      VALUES ('cold-child', 'cold', 'daemon', ?, ?, 1000)
    `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database.close();

    const reopened = openStateStore(path);
    try {
      expect(reopened.getChild("cold-child")?.state).toBe("cold");
    } finally {
      reopened.close();
    }
  });

  test("refuses an abandoned v8 schema with a migration-ledger gap", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    initial.close();
    addAbandonedSchema8(path);

    const database = new Database(path);
    database.query("DELETE FROM schema_migrations WHERE version = 6").run();
    database.close();

    expect(() => openStateStore(path)).toThrow(SchemaVersionError);
  });

  test("persists v8 live-child transitions and origin-filtered receipts atomically", () => {
    const store = openStateStore(stateDbPath());
    const now = "2026-01-01T00:00:00.000Z";
    try {
      store.createChild({
        id: "owner-child",
        kind: "task_tool",
        priority: "conversational",
        origin: "owner",
        title: "Owner child",
        prompt: "work",
        timeoutMs: 1_000,
      }, now);
      store.markChildAdmitted("owner-child", now);
      store.markChildRunning("owner-child", now);
      const turn = store.admitChildTurnReceipt("owner-child", {
        sessionFile: "/tmp/owner-child.jsonl",
        lastAssistantText: "first turn",
        turnSeq: 1,
      }, {
        id: "owner-turn-receipt",
        childId: "owner-child",
        idempotencyKey: "child-turn:owner-child:1",
        contentHash: "a".repeat(64),
        projection: "Owner update",
        artifactPath: "/tmp/owner-child.jsonl",
      }, "2026-01-01T00:00:01.000Z");
      expect(turn.child).toMatchObject({ state: "idle", turnSeq: 1, lastAssistantText: "first turn" });
      expect(store.countLiveChildren()).toBe(1);
      expect(store.listLiveChildren()).toMatchObject([{ id: "owner-child", state: "idle" }]);
      expect(store.listPersistedReceipts({ origin: "owner" })).toMatchObject([{ id: "owner-turn-receipt" }]);
      expect(store.listPersistedReceipts({ origin: "monitor" })).toEqual([]);
      store.markChildCold("owner-child", "2026-01-01T00:00:02.000Z");
      expect(store.listEvictableChildren()).toMatchObject([{ id: "owner-child", state: "cold" }]);
      store.markChildTerminated("owner-child", "released", "2026-01-01T00:00:03.000Z");
      expect(store.getChild("owner-child")).toMatchObject({ state: "terminated", terminalSummary: "released" });
      expect(store.countLiveChildren()).toBe(0);

      store.createChild({
        id: "monitor-child",
        kind: "daemon",
        priority: "monitor",
        origin: "monitor",
        title: "Monitor child",
        prompt: "work",
        timeoutMs: 1_000,
      }, now);
      store.markChildAdmitted("monitor-child", now);
      store.markChildRunning("monitor-child", now);
      const orphan = store.admitChildOrphanReceipt("monitor-child", {
        id: "monitor-orphan-receipt",
        childId: "monitor-child",
        idempotencyKey: "child-orphan:monitor-child",
        contentHash: "b".repeat(64),
        projection: "Monitor orphaned",
      }, "2026-01-01T00:00:01.000Z");
      expect(orphan.child).toMatchObject({ state: "orphaned", errorCode: "orphaned" });
      expect(store.listPersistedReceipts({ origin: ["monitor"] })).toMatchObject([{ id: "monitor-orphan-receipt" }]);
    } finally {
      store.close();
    }
  });

  test("assigns interim messages and snapshots durable omissions in one transaction", () => {
    const store = openStateStore(stateDbPath());
    const now = "2026-01-01T00:00:00.000Z";
    try {
      store.createChild({
        id: "interim-child",
        kind: "task_tool",
        priority: "conversational",
        origin: "owner",
        title: "Interim child",
        prompt: "work",
        timeoutMs: 1_000,
      }, now);
      store.admitInterimMessage({
        id: "interim-message",
        childId: "interim-child",
        idempotencyKey: "interim:interim-child:call-1",
        body: "durable update",
        truncated: false,
      }, now);
      expect(store.incrementInterimOmitted("interim-child", now)).toBe(1);

      const assignment = store.assignInterimBatch("2026-01-01T00:00:01.000Z")!;
      expect(assignment.batch).toMatchObject({ state: "assigned", attempt: 0, omitted: { "interim-child": 1 } });
      expect(assignment.batch.prompt).toContain("[interim-batch ");
      expect(assignment.batch.prompt).toContain("durable update");
      expect(assignment.batch.prompt).toContain("1 earlier update from “Interim child” was dropped by the rate limit");
      expect(assignment.messages).toMatchObject([{ id: "interim-message", batchId: assignment.batch.id }]);
      expect(store.listUnbatchedInterim()).toEqual([]);
      expect(store.getChild("interim-child")?.interimOmitted).toBe(0);

      const injected = store.markInterimBatchInjected(assignment.batch.id, "turn", "2026-01-01T00:00:02.000Z");
      expect(injected).toMatchObject({ state: "injected", mode: "turn", attempt: 1 });
      store.admitDelivery({
        id: "interim-delivery",
        idempotencyKey: `interim-batch:${assignment.batch.id}`,
        kind: "text",
        handle: "+821012345678",
        body: "owner update",
      }, "2026-01-01T00:00:02.000Z");
      expect(store.markInterimBatchDelivered(assignment.batch.id, {
        deliveryId: "interim-delivery",
        outcome: "owner_text",
      }, "2026-01-01T00:00:03.000Z")).toMatchObject({ state: "delivered", outcome: "owner_text" });
    } finally {
      store.close();
    }
  });

  test("refuses a database newer than the supported schema", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    initial.close();

    const database = new Database(path);
    database.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(10, new Date().toISOString());
    database.close();

    expect(() => openStateStore(path)).toThrow(SchemaVersionError);
  });
});

describe("StateStore delivery expiry", () => {
  test("expires pending and inflight rows for one handle without touching settled or other handles", () => {
    const path = stateDbPath();
    const store = openStateStore(path);
    const now = "2026-01-01T00:00:00.000Z";
    const handle = "+821012345678";
    const otherHandle = "+821012345679";
    const admit = (id: string, ownerHandle: string) => store.admitDelivery({
      id,
      idempotencyKey: `expiry:${id}`,
      kind: "text",
      handle: ownerHandle,
      body: id,
    }, now);

    try {
      const pending = admit("pending", handle);
      const inflight = admit("inflight", handle);
      store.claimDelivery(inflight.id, now);
      const confirmed = admit("confirmed", handle);
      store.claimDelivery(confirmed.id, now);
      store.confirmDelivery(confirmed.id, { messageId: "confirmed-message" }, now);
      const expired = admit("expired", handle);
      store.claimDelivery(expired.id, now);
      store.expireDelivery(expired.id, { code: "prior", message: "already expired" }, now);
      const other = admit("other-handle", otherHandle);

      const count = store.expirePendingDeliveriesForHandle(
        handle,
        { code: "handle_retired", message: "owner handle changed before delivery" },
        now,
      );

      expect(count).toBe(2);
      expect(store.getDelivery(pending.id)).toMatchObject({
        state: "expired",
        lastErrorCode: "handle_retired",
        lastErrorMessage: "owner handle changed before delivery",
      });
      expect(store.getDelivery(inflight.id)).toMatchObject({
        state: "expired",
        lastErrorCode: "handle_retired",
        lastErrorMessage: "owner handle changed before delivery",
      });
      expect(store.getDelivery(confirmed.id)).toMatchObject({ state: "confirmed" });
      expect(store.getDelivery(expired.id)).toMatchObject({
        state: "expired",
        lastErrorCode: "prior",
        lastErrorMessage: "already expired",
      });
      expect(store.getDelivery(other.id)).toMatchObject({ state: "pending", handle: otherHandle });
      expect(store.listDueDeliveries(now).map((delivery) => delivery.id)).toEqual([other.id]);
    } finally {
      store.close();
    }
  });
});
