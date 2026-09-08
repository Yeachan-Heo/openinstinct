import { randomUUID } from "node:crypto";

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.ts";
import { createAssistantWorkRepository, type AssistantWorkRepository } from "./assistant-work.ts";

export class SchemaVersionError extends Error {
  public constructor(version: number) {
    super(`state.db schema version ${version} is newer than supported version ${LATEST_SCHEMA_VERSION}`);
    this.name = "SchemaVersionError";
  }
}

export class IntegrityCheckError extends Error {
  public constructor(result: string) {
    super(`state.db integrity_check failed: ${result}`);
    this.name = "IntegrityCheckError";
  }
}

interface MigrationRow {
  readonly version: number;
}

interface SchemaObjectRow {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

interface CountRow {
  readonly count: number;
}

interface IntegrityRow {
  readonly integrity_check: string;
}


interface ForeignKeyCheckRow {
  readonly table: string;
  readonly parent: string;
}
interface MetaRow {
  readonly value: string;
}

export type DeliveryState = "pending" | "inflight" | "confirmed" | "failed_ambiguous" | "expired";
export type DeliveryKind = "text" | "file";

export type ChildState = "requested" | "admitted" | "running" | "idle" | "cold" | "completed" | "failed" | "timeout" | "cancelled" | "orphaned" | "terminated";
export type ChildKind = "task_tool" | "daemon";
export type ChildPriority = "conversational" | "monitor";
export type ChildOrigin = "owner" | "monitor" | "memory";
export type ReceiptState = "persisted" | "delivered";

export type InterimBatchState = "assigned" | "injected" | "delivered";
export type InterimBatchMode = "steer" | "turn";
export type InterimBatchOutcome = "owner_text" | "silent" | "reply_lost";

export interface InterimMessageInput {
  readonly id: string;
  readonly childId: string;
  readonly idempotencyKey: string;
  readonly body: string;
  readonly truncated: boolean;
}

export interface InterimMessageRecord {
  readonly id: string;
  readonly childId: string;
  readonly title: string;
  readonly idempotencyKey: string;
  readonly body: string;
  readonly truncated: boolean;
  readonly batchId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InterimBatchRecord {
  readonly id: string;
  readonly state: InterimBatchState;
  readonly attempt: number;
  readonly prompt: string;
  readonly omitted: Readonly<Record<string, number>>;
  readonly mode?: InterimBatchMode;
  readonly ownerTurnId?: string;
  readonly deliveryId?: string;
  readonly outcome?: InterimBatchOutcome;
  readonly createdAt: string;
  readonly injectedAt?: string;
  readonly deliveredAt?: string;
  readonly updatedAt: string;
}

export interface AssignedInterimBatch {
  readonly batch: InterimBatchRecord;
  readonly messages: readonly InterimMessageRecord[];
}

export interface ChildInput {
  readonly id: string;
  readonly kind: ChildKind;
  readonly priority: ChildPriority;
  readonly origin: ChildOrigin;
  readonly title: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface ChildTerminalInput {
  readonly state: Extract<ChildState, "completed" | "failed" | "timeout" | "cancelled">;
  readonly journalPath: string;
  readonly terminalChecksum: string;
  readonly terminalSummary: string;
  readonly errorCode?: string;
  readonly sessionFile?: string;
}

export interface ChildRecord {
  readonly id: string;
  readonly state: ChildState;
  readonly kind: ChildKind;
  readonly origin: ChildOrigin;
  readonly title: string;
  readonly prompt: string;
  readonly priority: ChildPriority;
  readonly timeoutMs: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
  readonly journalPath?: string;
  readonly terminalChecksum?: string;
  readonly terminalSummary?: string;
  readonly errorCode?: string;
  readonly sessionFile?: string;
  readonly startedAt?: string;
  readonly lastActivityAt?: string;
  readonly lastAssistantText?: string;
  /** Latest context-token reading from the child's session, when known. */
  readonly tokens?: number;
  readonly toolCalls: number;
  readonly turnSeq: number;
  readonly interimOmitted: number;
}

export interface ReceiptInput {
  readonly id: string;
  readonly childId: string;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly projection: string;
  readonly artifactPath?: string;
}

export interface ReceiptRecord {
  readonly id: string;
  readonly childId: string;
  readonly state: ReceiptState;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly projection: string;
  readonly artifactPath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type MemoryIntentKind = "capture" | "maintenance";
export type MemoryIntentState = "queued" | "written" | "committed" | "receipted" | "quarantined";

export interface MemoryIntentInput {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly kind: MemoryIntentKind;
  readonly payloadJson: string;
}

export interface MemoryIntentRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly kind: MemoryIntentKind;
  readonly payloadJson: string;
  readonly state: MemoryIntentState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly commitHash?: string;
  readonly quarantineReason?: string;
}

export interface MetaEntry {
  readonly key: string;
  readonly value: string;
}

export interface MonitorStoredInput {
  readonly id: string;
  readonly enabled: boolean;
  readonly specJson: string;
}

export interface MonitorStoredRecord {
  readonly id: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly specJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastFiredAt?: string;
}

export type MonitorEventStage = "admitted" | "batched" | "dispatched" | "authored" | "delivered" | "failed";

export interface MonitorEventInput {
  readonly id: string;
  readonly monitorId: string;
  readonly idempotencyKey: string;
  readonly eventType: string;
  readonly payloadJson: string;
  readonly burstKey: string;
  readonly catchUp: boolean;
}

export interface MonitorEventRecord {
  readonly id: string;
  readonly monitorId: string;
  readonly stage: MonitorEventStage;
  readonly idempotencyKey: string;
  readonly eventType: string;
  readonly payloadJson: string;
  readonly burstKey: string;
  readonly catchUp: boolean;
  readonly epoch: number;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly childId?: string;
  readonly deliveryId?: string;
  readonly deliveryIntentKey?: string;
  readonly leaseOwner?: string;
  readonly leaseId?: string;
  readonly leaseExpiresAt?: string;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
}

export interface MonitorEventLease {
  readonly id: string;
  readonly owner: string;
  readonly leaseId: string;
  readonly epoch: number;
}

export interface MonitorEventTransition {
  readonly lease: MonitorEventLease;
  readonly expectedStage: MonitorEventStage;
  readonly nextStage: MonitorEventStage;
  readonly now: string;
  readonly releaseLease?: boolean;
  readonly childId?: string;
  readonly deliveryId?: string;
  readonly deliveryIntentKey?: string;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
}

interface ChildRow {
  readonly id: string;
  readonly state: ChildState;
  readonly kind: ChildKind;
  readonly title: string;
  readonly prompt: string;
  readonly priority: ChildPriority;
  readonly origin: ChildOrigin;
  readonly timeout_ms: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly terminal_at: string | null;
  readonly journal_path: string | null;
  readonly terminal_checksum: string | null;
  readonly terminal_summary: string | null;
  readonly error_code: string | null;
  readonly session_file: string | null;
  readonly started_at: string | null;
  readonly last_activity_at: string | null;
  readonly last_assistant_text: string | null;
  readonly tokens: number | null;
  readonly tool_calls: number;
  readonly turn_seq: number;
  readonly interim_omitted: number;
}

interface ReceiptRow {
  readonly id: string;
  readonly child_id: string;
  readonly state: ReceiptState;
  readonly idempotency_key: string;
  readonly projection: string;
  readonly content_hash: string;
  readonly artifact_path: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface InterimMessageRow {
  readonly id: string;
  readonly child_id: string;
  readonly title: string;
  readonly idempotency_key: string;
  readonly body: string;
  readonly truncated: number;
  readonly batch_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface InterimBatchRow {
  readonly id: string;
  readonly state: InterimBatchState;
  readonly mode: InterimBatchMode | null;
  readonly attempt: number;
  readonly prompt: string;
  readonly omitted_json: string;
  readonly owner_turn_id: string | null;
  readonly delivery_id: string | null;
  readonly outcome: InterimBatchOutcome | null;
  readonly created_at: string;
  readonly injected_at: string | null;
  readonly delivered_at: string | null;
  readonly updated_at: string;
}

interface MemoryIntentRow {
  readonly id: string;
  readonly idempotency_key: string;
  readonly kind: MemoryIntentKind;
  readonly payload_json: string;
  readonly state: MemoryIntentState;
  readonly commit_hash: string | null;
  readonly quarantine_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MonitorStoredRow {
  readonly id: string;
  readonly enabled: number;
  readonly revision: number;
  readonly spec_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_fired_at: string | null;
}

interface MonitorEventRow {
  readonly id: string;
  readonly monitor_id: string;
  readonly stage: MonitorEventStage;
  readonly idempotency_key: string;
  readonly event_type: string;
  readonly payload_json: string;
  readonly burst_key: string;
  readonly catch_up: number;
  readonly child_id: string | null;
  readonly delivery_id: string | null;
  readonly delivery_intent_key: string | null;
  readonly lease_owner: string | null;
  readonly lease_id: string | null;
  readonly lease_expires_at: string | null;
  readonly epoch: number;
  readonly attempts: number;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const MONITOR_COLUMNS = `
  id, enabled, revision, spec_json, created_at, updated_at, last_fired_at
`;

const MONITOR_EVENT_COLUMNS = `
  id, monitor_id, stage, idempotency_key, event_type, payload_json, burst_key, catch_up,
  child_id, delivery_id, delivery_intent_key, lease_owner, lease_id, lease_expires_at,
  epoch, attempts, last_error_code, last_error_message, created_at, updated_at
`;

const CHILD_COLUMNS = `
  id, state, kind, title, prompt, timeout_ms, created_at, updated_at, terminal_at,
  journal_path, terminal_checksum, terminal_summary, error_code, session_file, priority,
  started_at, last_activity_at, last_assistant_text, tokens, tool_calls, origin, turn_seq, interim_omitted
`;

const RECEIPT_COLUMNS = `
  id, child_id, state, idempotency_key, projection, artifact_path, content_hash, created_at, updated_at
`;
const QUALIFIED_RECEIPT_COLUMNS = `
  receipts.id, receipts.child_id, receipts.state, receipts.idempotency_key, receipts.projection,
  receipts.artifact_path, receipts.content_hash, receipts.created_at, receipts.updated_at
`;

const INTERIM_BATCH_COLUMNS = `
  id, state, mode, attempt, prompt, omitted_json, owner_turn_id, delivery_id, outcome,
  created_at, injected_at, delivered_at, updated_at
`;
const QUALIFIED_INTERIM_MESSAGE_COLUMNS = `
  child_interim_messages.id, child_interim_messages.child_id, children.title,
  child_interim_messages.idempotency_key, child_interim_messages.body, child_interim_messages.truncated,
  child_interim_messages.batch_id, child_interim_messages.created_at, child_interim_messages.updated_at
`;

const MEMORY_INTENT_COLUMNS = `
  id, idempotency_key, kind, payload_json, state, commit_hash, quarantine_reason, created_at, updated_at
`;

export interface DeliveryInput {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly handle: string;
  readonly kind: DeliveryKind;
  readonly body?: string;
  readonly filePath?: string;
  readonly replyToGuid?: string;
  readonly quotedText?: string;
  readonly childId?: string;
}

export interface DeliveryRecord {
  readonly id: string;
  readonly childId?: string;
  readonly state: DeliveryState;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly nextAttemptAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly kind: DeliveryKind;
  readonly handle: string;
  readonly body?: string;
  readonly filePath?: string;
  readonly replyToGuid?: string;
  readonly quotedText?: string;
  readonly degraded: boolean;
  readonly redelivered: boolean;
  readonly inflightAt?: string;
  readonly confirmedAt?: string;
  readonly externalMessageId?: string;
  readonly threadId?: string;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
}

interface DeliveryRow {
  readonly id: string;
  readonly child_id: string | null;
  readonly state: DeliveryState;
  readonly idempotency_key: string;
  readonly attempts: number;
  readonly next_attempt_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly delivery_kind: DeliveryKind;
  readonly handle: string;
  readonly body: string | null;
  readonly file_path: string | null;
  readonly reply_to_guid: string | null;
  readonly quoted_text: string | null;
  readonly degraded: number;
  readonly redelivered: number;
  readonly inflight_at: string | null;
  readonly confirmed_at: string | null;
  readonly external_message_id: string | null;
  readonly thread_id: string | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
}

const DELIVERY_COLUMNS = `
  id, child_id, state, idempotency_key, attempts, next_attempt_at, created_at, updated_at,
  delivery_kind, handle, body, file_path, reply_to_guid, quoted_text, degraded, redelivered,
  inflight_at, confirmed_at, external_message_id, thread_id, last_error_code, last_error_message
`;

/**
 * The store module is the sole owner of the state.db SQLite connection. No
 * module outside daemon/src/store may import bun:sqlite or access state.db
 * directly; later repositories belong behind methods on this class. Back up
 * with `sqlite3 state.db ".backup backup.db"` only while the daemon is paused.
 * Version 2 adds delivery payload, routing, settlement, and redelivery columns.
 * Version 3 adds child terminal evidence and durable receipt admission fields.
 * Version 4 normalizes child terminal states, adds scheduler priority, receipt content hashes, and orphan recovery.
 * Version 5 adds typed monitor specs, cron fire cursors, staged monitor events, leases, and delivery intent fencing.
 * Version 6 adds durable memory closure intents, commit evidence, and quarantine state.
 * Version 9 adds the durable assistant-work ledger and atomic pre-effect claims.
 * Callers may only manipulate persisted state through the methods below.
 */
export class StateStore {
  public readonly assistantWork: AssistantWorkRepository;

  private constructor(
    public readonly path: string,
    private readonly db: Database,
  ) {
    this.assistantWork = createAssistantWorkRepository(db);
  }

  public static open(path: string): StateStore {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new Database(path);

    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      ensureMigrationLedger(db);
      runMigrations(db);
      runIntegrityCheck(db);
      return new StateStore(path, db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  public close(): void {
    this.db.close();
  }

  public migrationVersions(): number[] {
    return (this.db.query("SELECT version FROM schema_migrations ORDER BY version").all() as MigrationRow[])
      .map((row) => row.version);
  }

  public schemaTables(): string[] {
    return (this.db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { readonly name: string }[]).map((row) => row.name);
  }

  public getMeta(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as MetaRow | null;
    return row?.value;
  }

  public setMeta(key: string, value: string): void {
    this.db.query(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, new Date().toISOString());
  }

  public deleteMeta(key: string): void {
    this.db.query("DELETE FROM meta WHERE key = ?").run(key);
  }

  public listMeta(prefix = ""): MetaEntry[] {
    if (typeof prefix !== "string") {
      throw new Error("meta prefix must be a string");
    }
    const escaped = prefix.replace(/[\\%_]/g, "\\$&");
    return (this.db.query(
      "SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\' ORDER BY key",
    ).all(`${escaped}%`) as Array<{ readonly key: string; readonly value: string }>);
  }

  public admitMemoryIntent(input: MemoryIntentInput, now: string): MemoryIntentRecord {
    assertMemoryIntentInput(input);
    assertTimestamp(now, "memory intent admission now");
    this.db.query(
      `INSERT INTO memory_intents (
        id, idempotency_key, kind, payload_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run(input.id, input.idempotencyKey, input.kind, input.payloadJson, now, now);
    const intent = this.getMemoryIntentByIdempotencyKey(input.idempotencyKey);
    if (!intent) {
      throw new Error(`memory intent admission was not persisted: ${input.idempotencyKey}`);
    }
    return intent;
  }

  public getMemoryIntent(id: string): MemoryIntentRecord | undefined {
    const row = this.db.query(`SELECT ${MEMORY_INTENT_COLUMNS} FROM memory_intents WHERE id = ?`)
      .get(id) as MemoryIntentRow | null;
    return row === null ? undefined : toMemoryIntentRecord(row);
  }

  public getMemoryIntentByIdempotencyKey(idempotencyKey: string): MemoryIntentRecord | undefined {
    const row = this.db.query(`SELECT ${MEMORY_INTENT_COLUMNS} FROM memory_intents WHERE idempotency_key = ?`)
      .get(idempotencyKey) as MemoryIntentRow | null;
    return row === null ? undefined : toMemoryIntentRecord(row);
  }

  public listMemoryIntents(): MemoryIntentRecord[] {
    return (this.db.query(`SELECT ${MEMORY_INTENT_COLUMNS} FROM memory_intents ORDER BY created_at, ROWID`)
      .all() as MemoryIntentRow[]).map(toMemoryIntentRecord);
  }

  public markMemoryIntentWritten(id: string, now: string): MemoryIntentRecord {
    return this.advanceMemoryIntent(id, "queued", "written", now);
  }

  public markMemoryIntentCommitted(id: string, commitHash: string, now: string): MemoryIntentRecord {
    if (!/^[a-f0-9]{40,64}$/.test(commitHash)) {
      throw new Error("memory intent commitHash is invalid");
    }
    return this.advanceMemoryIntent(id, "written", "committed", now, { commitHash });
  }

  public markMemoryIntentReceipted(id: string, now: string): MemoryIntentRecord {
    return this.advanceMemoryIntent(id, "committed", "receipted", now);
  }

  public quarantineMemoryIntent(id: string, reason: string, now: string): MemoryIntentRecord {
    assertNonEmpty(id, "memory intent id");
    assertNonEmpty(reason, "memory intent quarantine reason");
    assertTimestamp(now, "memory intent quarantine now");
    this.db.query(
      `UPDATE memory_intents
       SET state = 'quarantined', quarantine_reason = ?, updated_at = ?
       WHERE id = ? AND state NOT IN ('receipted', 'quarantined')`,
    ).run(reason, now, id);
    const intent = this.getMemoryIntent(id);
    if (!intent) {
      throw new Error(`unknown memory intent: ${id}`);
    }
    if (intent.state !== "quarantined") {
      throw new Error(`memory intent cannot be quarantined from ${intent.state}: ${id}`);
    }
    return intent;
  }

  private advanceMemoryIntent(
    id: string,
    expected: MemoryIntentState,
    next: MemoryIntentState,
    now: string,
    details: { readonly commitHash?: string } = {},
  ): MemoryIntentRecord {
    assertNonEmpty(id, "memory intent id");
    assertTimestamp(now, "memory intent transition now");
    const result = this.db.query(
      `UPDATE memory_intents
       SET state = ?, commit_hash = COALESCE(?, commit_hash), updated_at = ?
       WHERE id = ? AND state = ?`,
    ).run(next, details.commitHash ?? null, now, id, expected);
    const intent = this.getMemoryIntent(id);
    if (!intent) {
      throw new Error(`unknown memory intent: ${id}`);
    }
    if (result.changes === 0 && intent.state !== next) {
      throw new Error(`memory intent cannot enter ${next} from ${intent.state}: ${id}`);
    }
    return intent;
  }

  public getChatCursor(): number | undefined {
    const value = this.getMeta("imessage.cursor");
    if (value === undefined || !/^\d+$/.test(value)) {
      return undefined;
    }
    const cursor = Number(value);
    return Number.isSafeInteger(cursor) ? cursor : undefined;
  }

  public setChatCursor(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("chat cursor must be a non-negative safe integer");
    }
    this.setMeta("imessage.cursor", String(cursor));
  }

  public admitDelivery(input: DeliveryInput, now: string): DeliveryRecord {
    this.db.query(
      `INSERT INTO deliveries (
        id, child_id, state, idempotency_key, attempts, next_attempt_at, created_at, updated_at,
        delivery_kind, handle, body, file_path, reply_to_guid, quoted_text
      ) VALUES (?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run(
      input.id,
      input.childId ?? null,
      input.idempotencyKey,
      now,
      now,
      now,
      input.kind,
      input.handle,
      input.body ?? null,
      input.filePath ?? null,
      input.replyToGuid ?? null,
      input.quotedText ?? null,
    );

    const admitted = this.getDeliveryByIdempotencyKey(input.idempotencyKey);
    if (!admitted) {
      throw new Error(`delivery admission was not persisted: ${input.idempotencyKey}`);
    }
    return admitted;
  }

  public getDelivery(id: string): DeliveryRecord | undefined {
    const row = this.db.query(`SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE id = ?`).get(id) as DeliveryRow | null;
    return row === null ? undefined : toDeliveryRecord(row);
  }

  public getDeliveryByIdempotencyKey(idempotencyKey: string): DeliveryRecord | undefined {
    const row = this.db.query(`SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE idempotency_key = ?`)
      .get(idempotencyKey) as DeliveryRow | null;
    return row === null ? undefined : toDeliveryRecord(row);
  }

  public listDeliveries(): DeliveryRecord[] {
    return (this.db.query(`SELECT ${DELIVERY_COLUMNS} FROM deliveries ORDER BY created_at, ROWID`).all() as DeliveryRow[])
      .map(toDeliveryRecord);
  }

  /** True once any reply has been confirmed as sent to the owner: first contact happened. */
  public hasConfirmedDelivery(): boolean {
    const row = this.db.query("SELECT 1 AS one FROM deliveries WHERE state = 'confirmed' LIMIT 1").get() as { readonly one: number } | null;
    return row !== null;
  }

  public listDueDeliveries(now: string, limit = 100): DeliveryRecord[] {
    return (this.db.query(
      `SELECT ${DELIVERY_COLUMNS}
       FROM deliveries
       WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at, ROWID
       LIMIT ?`,
    ).all(now, limit) as DeliveryRow[]).map(toDeliveryRecord);
  }

  public claimDelivery(id: string, now: string): DeliveryRecord | undefined {
    const result = this.db.query(
      `UPDATE deliveries
       SET state = 'inflight', attempts = attempts + 1, inflight_at = ?, updated_at = ?
       WHERE id = ? AND state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
    ).run(now, now, id, now);
    if (result.changes === 0) {
      return undefined;
    }
    return this.getDelivery(id);
  }

  public markDeliveryDegraded(id: string, now: string): void {
    this.db.query(
      "UPDATE deliveries SET degraded = 1, updated_at = ? WHERE id = ? AND state = 'inflight'",
    ).run(now, id);
  }

  public confirmDelivery(
    id: string,
    receipt: { readonly messageId: string; readonly threadId?: string },
    now: string,
  ): void {
    this.db.query(
      `UPDATE deliveries
       SET state = 'confirmed', confirmed_at = ?, external_message_id = ?, thread_id = ?, updated_at = ?
       WHERE id = ? AND state = 'inflight'`,
    ).run(now, receipt.messageId, receipt.threadId ?? null, now, id);
  }

  public retryDelivery(
    id: string,
    nextAttemptAt: string,
    error: { readonly code: string; readonly message: string },
    now: string,
  ): void {
    this.db.query(
      `UPDATE deliveries
       SET state = 'pending', next_attempt_at = ?, inflight_at = NULL,
           last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE id = ? AND state = 'inflight'`,
    ).run(nextAttemptAt, error.code, error.message, now, id);
  }

  public failDeliveryAmbiguous(
    id: string,
    error: { readonly code: string; readonly message: string },
    now: string,
  ): void {
    this.db.query(
      `UPDATE deliveries
       SET state = 'failed_ambiguous', last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE id = ? AND state = 'inflight'`,
    ).run(error.code, error.message, now, id);
  }

  public expireDelivery(
    id: string,
    error: { readonly code: string; readonly message: string },
    now: string,
  ): void {
    this.db.query(
      `UPDATE deliveries
       SET state = 'expired', last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE id = ? AND state = 'inflight'`,
    ).run(error.code, error.message, now, id);
  }

  public expirePendingDeliveriesForHandle(
    handle: string,
    error: { readonly code: string; readonly message: string },
    now: string,
  ): number {
    const result = this.db.query(
      `UPDATE deliveries
       SET state = 'expired', last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE handle = ? AND state IN ('pending', 'inflight')`,
    ).run(error.code, error.message, now, handle);
    return result.changes;
  }

  public requeueStaleInflightDeliveries(before: string, now: string): number {
    const result = this.db.query(
      `UPDATE deliveries
       SET state = 'pending', redelivered = 1, next_attempt_at = ?, inflight_at = NULL, updated_at = ?
       WHERE state = 'inflight' AND inflight_at IS NOT NULL AND inflight_at < ?`,
    ).run(now, now, before);
    return result.changes;
  }

  /** Deletes settled outbound ledger rows that are no longer referenced by monitor evidence. */
  public pruneSettledDeliveries(before: string): number {
    assertTimestamp(before, "delivery retention cutoff");
    const result = this.db.query(
      `DELETE FROM deliveries
       WHERE state IN ('confirmed', 'failed_ambiguous', 'expired')
         AND COALESCE(confirmed_at, updated_at) < ?
         AND NOT EXISTS (SELECT 1 FROM monitor_events WHERE monitor_events.delivery_id = deliveries.id)`,
    ).run(before);
    return result.changes;
  }

  public createMonitor(input: MonitorStoredInput, now: string): MonitorStoredRecord {
    assertMonitorStoredInput(input);
    this.db.query(
      `INSERT INTO monitors (id, enabled, revision, spec_json, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?)`,
    ).run(input.id, input.enabled ? 1 : 0, input.specJson, now, now);
    const monitor = this.getMonitor(input.id);
    if (!monitor) {
      throw new Error(`monitor registration was not persisted: ${input.id}`);
    }
    return monitor;
  }

  public getMonitor(id: string): MonitorStoredRecord | undefined {
    const row = this.db.query(`SELECT ${MONITOR_COLUMNS} FROM monitors WHERE id = ?`).get(id) as MonitorStoredRow | null;
    return row === null ? undefined : toMonitorStoredRecord(row);
  }

  public listMonitors(): MonitorStoredRecord[] {
    return (this.db.query(`SELECT ${MONITOR_COLUMNS} FROM monitors ORDER BY created_at, ROWID`).all() as MonitorStoredRow[])
      .map(toMonitorStoredRecord);
  }

  public updateMonitor(
    id: string,
    expectedRevision: number,
    input: MonitorStoredInput,
    now: string,
  ): MonitorStoredRecord | undefined {
    assertMonitorStoredInput(input);
    assertPositiveInteger(expectedRevision, "expectedRevision");
    const result = this.db.query(
      `UPDATE monitors
       SET enabled = ?, spec_json = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    ).run(input.enabled ? 1 : 0, input.specJson, now, id, expectedRevision);
    return result.changes === 0 ? undefined : this.getMonitor(id);
  }

  public toggleMonitor(id: string, enabled: boolean, expectedRevision: number, now: string): MonitorStoredRecord | undefined {
    assertNonEmpty(id, "monitor id");
    assertPositiveInteger(expectedRevision, "expectedRevision");
    const result = this.db.query(
      `UPDATE monitors
       SET enabled = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    ).run(enabled ? 1 : 0, now, id, expectedRevision);
    return result.changes === 0 ? undefined : this.getMonitor(id);
  }

  /**
   * Revision-fenced hard delete. Terminal event history goes with the monitor
   * (it is retention-pruned anyway); in-flight events block deletion so a
   * running child is never orphaned.
   */
  public deleteMonitor(id: string, expectedRevision: number): "deleted" | "conflict" | "busy" {
    assertNonEmpty(id, "monitor id");
    assertPositiveInteger(expectedRevision, "expectedRevision");
    return this.db.transaction(() => {
      // A firing that is still running a child must not be orphaned. Events
      // that only await owner delivery (authored) or never got dispatched
      // (admitted/batched) are abandoned with the monitor: mark them failed.
      const busy = this.db.query(
        "SELECT count(*) AS n FROM monitor_events WHERE monitor_id = ? AND stage = 'dispatched'",
      ).get(id) as { readonly n: number };
      if (busy.n > 0) {
        return "busy" as const;
      }
      this.db.query(
        "UPDATE monitor_events SET stage = 'failed', last_error_code = 'monitor_deleted', last_error_message = 'monitor deleted before delivery', lease_owner = NULL, lease_id = NULL WHERE monitor_id = ? AND stage NOT IN ('delivered', 'failed')",
      ).run(id);
      const owned = this.db.query("SELECT revision FROM monitors WHERE id = ?").get(id) as { readonly revision: number } | null;
      if (!owned || owned.revision !== expectedRevision) {
        return "conflict" as const;
      }
      this.db.query("DELETE FROM monitor_events WHERE monitor_id = ?").run(id);
      this.db.query("DELETE FROM monitors WHERE id = ?").run(id);
      return "deleted" as const;
    })();
  }

  public markMonitorFired(id: string, firedAt: string, now: string): void {
    assertNonEmpty(id, "monitor id");
    assertTimestamp(firedAt, "monitor firedAt");
    this.db.query("UPDATE monitors SET last_fired_at = ?, updated_at = ? WHERE id = ?")
      .run(firedAt, now, id);
  }

  public admitMonitorEvent(input: MonitorEventInput, now: string): MonitorEventRecord {
    assertMonitorEventInput(input);
    this.db.query(
      `INSERT INTO monitor_events (
        id, monitor_id, stage, idempotency_key, event_type, payload_json, burst_key, catch_up,
        epoch, attempts, created_at, updated_at
      ) VALUES (?, ?, 'admitted', ?, ?, ?, ?, ?, 0, 0, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run(
      input.id,
      input.monitorId,
      input.idempotencyKey,
      input.eventType,
      input.payloadJson,
      input.burstKey,
      input.catchUp ? 1 : 0,
      now,
      now,
    );
    const event = this.getMonitorEventByIdempotencyKey(input.idempotencyKey);
    if (!event) {
      throw new Error(`monitor event admission was not persisted: ${input.idempotencyKey}`);
    }
    return event;
  }

  public coalesceMonitorEvent(input: MonitorEventInput, now: string): MonitorEventRecord {
    assertMonitorEventInput(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.query(
        `SELECT ${MONITOR_EVENT_COLUMNS}
         FROM monitor_events
         WHERE monitor_id = ? AND burst_key = ? AND stage = 'admitted'
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY created_at, ROWID
         LIMIT 1`,
      ).get(input.monitorId, input.burstKey, now) as MonitorEventRow | null;
      if (existing) {
        this.db.query(
          `UPDATE monitor_events
           SET event_type = ?, payload_json = ?, catch_up = CASE WHEN catch_up = 1 OR ? = 1 THEN 1 ELSE 0 END,
               updated_at = ?
           WHERE id = ?`,
        ).run(input.eventType, input.payloadJson, input.catchUp ? 1 : 0, now, existing.id);
        const event = this.getMonitorEvent(existing.id);
        if (!event) {
          throw new Error(`coalesced monitor event disappeared: ${existing.id}`);
        }
        this.db.exec("COMMIT");
        return event;
      }
      const event = this.admitMonitorEvent(input, now);
      this.db.exec("COMMIT");
      return event;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public getMonitorEvent(id: string): MonitorEventRecord | undefined {
    const row = this.db.query(`SELECT ${MONITOR_EVENT_COLUMNS} FROM monitor_events WHERE id = ?`).get(id) as MonitorEventRow | null;
    return row === null ? undefined : toMonitorEventRecord(row);
  }

  public getMonitorEventByIdempotencyKey(idempotencyKey: string): MonitorEventRecord | undefined {
    const row = this.db.query(`SELECT ${MONITOR_EVENT_COLUMNS} FROM monitor_events WHERE idempotency_key = ?`)
      .get(idempotencyKey) as MonitorEventRow | null;
    return row === null ? undefined : toMonitorEventRecord(row);
  }

  public getMonitorEventByChildId(childId: string): MonitorEventRecord | undefined {
    const row = this.db.query(`SELECT ${MONITOR_EVENT_COLUMNS} FROM monitor_events WHERE child_id = ?`)
      .get(childId) as MonitorEventRow | null;
    return row === null ? undefined : toMonitorEventRecord(row);
  }

  public listMonitorEvents(): MonitorEventRecord[] {
    return (this.db.query(`SELECT ${MONITOR_EVENT_COLUMNS} FROM monitor_events ORDER BY created_at, ROWID`).all() as MonitorEventRow[])
      .map(toMonitorEventRecord);
  }

  public listClaimableMonitorEvents(now: string, limit = 100): MonitorEventRecord[] {
    assertPositiveInteger(limit, "monitor event limit");
    return (this.db.query(
      `SELECT ${MONITOR_EVENT_COLUMNS}
       FROM monitor_events
       WHERE stage IN ('admitted', 'batched', 'authored')
         AND attempts < 3
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY created_at, ROWID
       LIMIT ?`,
    ).all(now, limit) as MonitorEventRow[]).map(toMonitorEventRecord);
  }

  public listDispatchedMonitorEvents(): MonitorEventRecord[] {
    return (this.db.query(
      `SELECT ${MONITOR_EVENT_COLUMNS} FROM monitor_events WHERE stage = 'dispatched' ORDER BY created_at, ROWID`,
    ).all() as MonitorEventRow[]).map(toMonitorEventRecord);
  }

  public claimMonitorEvent(
    id: string,
    allowedStages: readonly MonitorEventStage[],
    owner: string,
    leaseId: string,
    leaseExpiresAt: string,
    now: string,
  ): MonitorEventRecord | undefined {
    assertNonEmpty(id, "monitor event id");
    assertNonEmpty(owner, "monitor event lease owner");
    assertNonEmpty(leaseId, "monitor event lease id");
    assertTimestamp(leaseExpiresAt, "monitor event lease expiry");
    if (allowedStages.length === 0) {
      throw new Error("monitor event claim requires an allowed stage");
    }
    for (const stage of allowedStages) {
      assertMonitorEventStage(stage);
    }
    const stages = allowedStages.map((stage) => `'${stage}'`).join(", ");
    const result = this.db.query(
      `UPDATE monitor_events
       SET lease_owner = ?, lease_id = ?, lease_expires_at = ?, epoch = epoch + 1,
           attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND stage IN (${stages}) AND attempts < 3
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    ).run(owner, leaseId, leaseExpiresAt, now, id, now);
    return result.changes === 0 ? undefined : this.getMonitorEvent(id);
  }

  public transitionMonitorEvent(input: MonitorEventTransition): MonitorEventRecord | undefined {
    assertMonitorEventStage(input.expectedStage);
    assertMonitorEventStage(input.nextStage);
    assertTimestamp(input.now, "monitor event transition now");
    assertNonEmpty(input.lease.id, "monitor event lease id");
    assertNonEmpty(input.lease.owner, "monitor event lease owner");
    assertNonEmpty(input.lease.leaseId, "monitor event lease token");
    if (!Number.isSafeInteger(input.lease.epoch) || input.lease.epoch < 1) {
      throw new Error("monitor event lease epoch is invalid");
    }
    const release = input.releaseLease === true ? 1 : 0;
    const result = this.db.query(
      `UPDATE monitor_events
       SET stage = ?,
           child_id = COALESCE(?, child_id),
           delivery_id = COALESCE(?, delivery_id),
           delivery_intent_key = COALESCE(?, delivery_intent_key),
           last_error_code = COALESCE(?, last_error_code),
           last_error_message = COALESCE(?, last_error_message),
           lease_owner = CASE WHEN ? = 1 THEN NULL ELSE lease_owner END,
           lease_id = CASE WHEN ? = 1 THEN NULL ELSE lease_id END,
           lease_expires_at = CASE WHEN ? = 1 THEN NULL ELSE lease_expires_at END,
           updated_at = ?
       WHERE id = ? AND stage = ? AND lease_owner = ? AND lease_id = ? AND epoch = ?`,
    ).run(
      input.nextStage,
      input.childId ?? null,
      input.deliveryId ?? null,
      input.deliveryIntentKey ?? null,
      input.lastErrorCode ?? null,
      input.lastErrorMessage ?? null,
      release,
      release,
      release,
      input.now,
      input.lease.id,
      input.expectedStage,
      input.lease.owner,
      input.lease.leaseId,
      input.lease.epoch,
    );
    return result.changes === 0 ? undefined : this.getMonitorEvent(input.lease.id);
  }

  public failMonitorEvent(lease: MonitorEventLease, now: string, code: string, message: string): MonitorEventRecord | undefined {
    assertTimestamp(now, "monitor event failure now");
    assertNonEmpty(code, "monitor event failure code");
    assertNonEmpty(message, "monitor event failure message");
    const result = this.db.query(
      `UPDATE monitor_events
       SET stage = CASE WHEN attempts >= 3 THEN 'failed' ELSE stage END,
           last_error_code = ?, last_error_message = ?,
           lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND lease_id = ? AND epoch = ?`,
    ).run(code, message, now, lease.id, lease.owner, lease.leaseId, lease.epoch);
    return result.changes === 0 ? undefined : this.getMonitorEvent(lease.id);
  }

  public failExhaustedAuthoredMonitorEvents(now: string): number {
    assertTimestamp(now, "monitor event exhausted triage now");
    const result = this.db.query(`
      UPDATE monitor_events
      SET stage = 'failed', last_error_code = 'triage_exhausted',
          last_error_message = 'main-session triage retry exhausted before restart',
          lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE stage = 'authored' AND attempts >= 3
    `).run(now);
    return result.changes;
  }

  /** Deletes terminal monitor-event evidence after its configured retention window. */
  public pruneTerminalMonitorEvents(before: string): number {
    assertTimestamp(before, "monitor-event retention cutoff");
    const result = this.db.query(
      "DELETE FROM monitor_events WHERE stage IN ('delivered', 'failed') AND updated_at < ?",
    ).run(before);
    return result.changes;
  }

  public createChild(input: ChildInput, now: string): ChildRecord {
    assertChildInput(input);
    assertTimestamp(now, "child registration now");
    this.db.query(
      `INSERT INTO children (id, state, kind, created_at, updated_at, timeout_ms, title, prompt, priority, origin)
       VALUES (?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.kind, now, now, input.timeoutMs, input.title, input.prompt, input.priority, input.origin);
    const child = this.getChild(input.id);
    if (!child) {
      throw new Error(`child registration was not persisted: ${input.id}`);
    }
    return child;
  }

  public getChild(id: string): ChildRecord | undefined {
    const row = this.db.query(`SELECT ${CHILD_COLUMNS} FROM children WHERE id = ?`).get(id) as ChildRow | null;
    return row === null ? undefined : toChildRecord(row);
  }

  public listChildren(): ChildRecord[] {
    return (this.db.query(`SELECT ${CHILD_COLUMNS} FROM children ORDER BY created_at, ROWID`).all() as ChildRow[])
      .map(toChildRecord);
  }

  public listLiveChildren(limit?: number): ChildRecord[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error("live child limit must be a positive safe integer");
    }
    const query = `SELECT ${CHILD_COLUMNS}
      FROM children
      WHERE state IN ('requested', 'admitted', 'running', 'idle', 'cold')
      ORDER BY COALESCE(last_activity_at, updated_at) DESC, ROWID DESC${limit === undefined ? "" : " LIMIT ?"}`;
    return (this.db.query(query).all(...(limit === undefined ? [] : [limit])) as ChildRow[]).map(toChildRecord);
  }

  public countLiveChildren(): number {
    const row = this.db.query(
      "SELECT COUNT(*) AS count FROM children WHERE state IN ('requested', 'admitted', 'running', 'idle', 'cold')",
    ).get() as { readonly count: number };
    return row.count;
  }

  public listEvictableChildren(): ChildRecord[] {
    return (this.db.query(`SELECT ${CHILD_COLUMNS}
      FROM children
      WHERE state IN ('idle', 'cold')
      ORDER BY COALESCE(last_activity_at, updated_at) ASC, ROWID ASC`).all() as ChildRow[]).map(toChildRecord);
  }

  public markChildAdmitted(id: string, now: string): ChildRecord {
    const result = this.db.query(
      `UPDATE children
       SET state = 'admitted', updated_at = ?
       WHERE id = ? AND state = 'requested'`,
    ).run(now, id);
    const child = this.getChild(id);
    if (!child) {
      throw new Error(`unknown child: ${id}`);
    }
    if (result.changes === 0 && child.state !== "admitted") {
      throw new Error(`child cannot enter admitted from ${child.state}: ${id}`);
    }
    return child;
  }

  /** Live progress from the child's session: tokens in context and tool calls so far. */
  public updateChildProgress(
    id: string,
    progress: { readonly tokens?: number; readonly toolCalls?: number },
    now = new Date().toISOString(),
  ): ChildRecord {
    assertTimestamp(now, "child progress now");
    this.db.query(
      `UPDATE children
       SET tokens = COALESCE(?, tokens), tool_calls = COALESCE(?, tool_calls),
           last_activity_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(progress.tokens ?? null, progress.toolCalls ?? null, now, now, id);
    const child = this.getChild(id);
    if (!child) {
      throw new Error(`unknown child: ${id}`);
    }
    return child;
  }

  public markChildRunning(id: string, now: string): ChildRecord {
    const result = this.db.query(
      `UPDATE children
       SET state = 'running', updated_at = ?, started_at = COALESCE(started_at, ?), last_activity_at = ?
       WHERE id = ? AND state IN ('requested', 'admitted', 'idle', 'cold')`,
    ).run(now, now, now, id);
    const child = this.getChild(id);
    if (!child) {
      throw new Error(`unknown child: ${id}`);
    }
    if (result.changes === 0 && child.state !== "running") {
      throw new Error(`child cannot enter running from ${child.state}: ${id}`);
    }
    return child;
  }

  public markChildIdle(
    id: string,
    input: { readonly sessionFile?: string; readonly lastAssistantText?: string; readonly turnSeq: number },
    now: string,
  ): ChildRecord {
    assertChildIdleInput(input);
    assertTimestamp(now, "child idle now");
    const result = this.db.query(
      `UPDATE children
       SET state = 'idle', updated_at = ?, session_file = COALESCE(?, session_file),
           last_assistant_text = ?, turn_seq = ?, last_activity_at = ?
       WHERE id = ? AND state = 'running'`,
    ).run(now, input.sessionFile ?? null, input.lastAssistantText ?? null, input.turnSeq, now, id);
    const child = this.getChild(id);
    if (!child) {
      throw new Error(`unknown child: ${id}`);
    }
    if (result.changes === 0 && child.state !== "idle") {
      throw new Error(`child cannot enter idle from ${child.state}: ${id}`);
    }
    return child;
  }

  public markChildCold(id: string, now: string): ChildRecord {
    assertTimestamp(now, "child cold now");
    const result = this.db.query(
      `UPDATE children SET state = 'cold', updated_at = ? WHERE id = ? AND state = 'idle'`,
    ).run(now, id);
    const child = this.getChild(id);
    if (!child) {
      throw new Error(`unknown child: ${id}`);
    }
    if (result.changes === 0 && child.state !== "cold") {
      throw new Error(`child cannot enter cold from ${child.state}: ${id}`);
    }
    return child;
  }

  public markChildTerminated(id: string, reason: "released" | "idle_timeout" | "evicted", now: string): ChildRecord {
    return this.markChildTerminatedFrom(id, reason, now, "idle_cold");
  }

  /** Release can end an admitted request before it has acquired a running slot. */
  public markQueuedChildTerminated(id: string, reason: "released", now: string): ChildRecord {
    return this.markChildTerminatedFrom(id, reason, now, "queued");
  }

  private markChildTerminatedFrom(
    id: string,
    reason: "released" | "idle_timeout" | "evicted",
    now: string,
    source: "idle_cold" | "queued",
  ): ChildRecord {
    assertTimestamp(now, "child terminated now");
    const states = source === "queued" ? "'requested', 'admitted'" : "'idle', 'cold'";
    const result = this.db.query(
      `UPDATE children
       SET state = 'terminated', terminal_at = ?, terminal_summary = ?, updated_at = ?
       WHERE id = ? AND state IN (${states})`,
    ).run(now, reason, now, id);
    const child = this.getChild(id);
    if (!child) {
      throw new Error(`unknown child: ${id}`);
    }
    if (result.changes === 0 && child.state !== "terminated") {
      throw new Error(`child cannot enter terminated from ${child.state}: ${id}`);
    }
    return child;
  }

  public markChildTerminal(id: string, terminal: ChildTerminalInput, now: string): ChildRecord {
    assertChildTerminalInput(terminal);
    const result = this.db.query(
      `UPDATE children
       SET state = ?, terminal_at = ?, updated_at = ?, journal_path = ?, terminal_checksum = ?,
           terminal_summary = ?, error_code = ?, session_file = ?
       WHERE id = ? AND state IN ('requested', 'admitted', 'running')`,
    ).run(
      terminal.state,
      now,
      now,
      terminal.journalPath,
      terminal.terminalChecksum,
      terminal.terminalSummary,
      terminal.errorCode ?? null,
      terminal.sessionFile ?? null,
      id,
    );
    const child = this.getChild(id);
    if (!child) {
      throw new Error(`unknown child: ${id}`);
    }
    if (result.changes === 0
      && (child.terminalChecksum !== terminal.terminalChecksum || child.state !== terminal.state)) {
      throw new Error(`child already has different terminal evidence: ${id}`);
    }
    return child;
  }

  public markChildOrphaned(id: string, now: string): ChildRecord {
    const result = this.db.query(
      `UPDATE children
       SET state = 'orphaned', terminal_at = ?, updated_at = ?, error_code = 'orphaned'
       WHERE id = ? AND state IN ('requested', 'admitted', 'running', 'idle', 'cold')`,
    ).run(now, now, id);
    const child = this.getChild(id);
    if (!child) {
      throw new Error(`unknown child: ${id}`);
    }
    if (result.changes === 0 && child.state !== "orphaned") {
      throw new Error(`child cannot become orphaned from ${child.state}: ${id}`);
    }
    return child;
  }

  public admitInterimMessage(input: InterimMessageInput, now: string): InterimMessageRecord {
    assertInterimMessageInput(input);
    assertTimestamp(now, "interim message admission now");
    this.db.query(
      `INSERT INTO child_interim_messages (
        id, child_id, idempotency_key, body, truncated, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run(
      input.id,
      input.childId,
      input.idempotencyKey,
      input.body,
      input.truncated ? 1 : 0,
      now,
      now,
    );
    const message = this.getInterimMessageByIdempotencyKey(input.idempotencyKey);
    if (!message) {
      throw new Error(`interim message admission was not persisted: ${input.idempotencyKey}`);
    }
    return message;
  }

  public getInterimMessageByIdempotencyKey(idempotencyKey: string): InterimMessageRecord | undefined {
    assertNonEmpty(idempotencyKey, "interim message idempotencyKey");
    const row = this.db.query(
      `SELECT ${QUALIFIED_INTERIM_MESSAGE_COLUMNS}
       FROM child_interim_messages JOIN children ON children.id = child_interim_messages.child_id
       WHERE child_interim_messages.idempotency_key = ?`,
    ).get(idempotencyKey) as InterimMessageRow | null;
    return row === null ? undefined : toInterimMessageRecord(row);
  }

  public listUnbatchedInterim(): InterimMessageRecord[] {
    return (this.db.query(
      `SELECT ${QUALIFIED_INTERIM_MESSAGE_COLUMNS}
       FROM child_interim_messages JOIN children ON children.id = child_interim_messages.child_id
       WHERE child_interim_messages.batch_id IS NULL
       ORDER BY child_interim_messages.created_at, child_interim_messages.ROWID`,
    ).all() as InterimMessageRow[]).map(toInterimMessageRecord);
  }

  public listInterimMessages(childId?: string): InterimMessageRecord[] {
    const clause = childId === undefined ? "" : " WHERE child_interim_messages.child_id = ?";
    return (this.db.query(
      `SELECT ${QUALIFIED_INTERIM_MESSAGE_COLUMNS}
       FROM child_interim_messages JOIN children ON children.id = child_interim_messages.child_id${clause}
       ORDER BY child_interim_messages.created_at, child_interim_messages.ROWID`,
    ).all(...(childId === undefined ? [] : [childId])) as InterimMessageRow[]).map(toInterimMessageRecord);
  }

  public assignInterimBatch(now: string): AssignedInterimBatch | undefined {
    assertTimestamp(now, "interim batch assignment now");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.query(
        `SELECT ${INTERIM_BATCH_COLUMNS}
         FROM child_interim_batches WHERE state = 'assigned' ORDER BY created_at, ROWID LIMIT 1`,
      ).get() as InterimBatchRow | null;
      if (existing) {
        const batch = toInterimBatchRecord(existing);
        const messages = this.listInterimMessagesForBatch(batch.id);
        this.db.exec("COMMIT");
        return { batch, messages };
      }

      const messages = this.listUnbatchedInterim();
      const omittedRows = this.db.query(
        `SELECT id, title, interim_omitted FROM children
         WHERE interim_omitted > 0
         ORDER BY COALESCE(last_activity_at, updated_at), ROWID`,
      ).all() as Array<{ readonly id: string; readonly title: string; readonly interim_omitted: number }>;
      if (messages.length === 0 && omittedRows.length === 0) {
        this.db.exec("COMMIT");
        return undefined;
      }

      const omitted: Record<string, number> = {};
      const titles = new Map<string, string>();
      for (const row of omittedRows) {
        titles.set(row.id, row.title);
        omitted[row.id] = row.interim_omitted;
      }
      for (const message of messages) {
        if (titles.has(message.childId)) {
          continue;
        }
        titles.set(message.childId, message.title);
        const child = this.getChild(message.childId);
        if (!child) {
          throw new Error(`unknown interim child: ${message.childId}`);
        }
        if (child.interimOmitted > 0) {
          omitted[message.childId] = child.interimOmitted;
        }
      }

      const id = randomUUID();
      const prompt = composeInterimBatchPrompt(id, messages, omitted, titles);
      this.db.query(
        `INSERT INTO child_interim_batches (
          id, state, attempt, prompt, omitted_json, created_at, updated_at
        ) VALUES (?, 'assigned', 0, ?, ?, ?, ?)`,
      ).run(id, prompt, JSON.stringify(omitted), now, now);
      if (messages.length > 0) {
        this.db.query(
          `UPDATE child_interim_messages SET batch_id = ?, updated_at = ?
           WHERE batch_id IS NULL AND id IN (${messages.map(() => "?").join(", ")})`,
        ).run(id, now, ...messages.map((message) => message.id));
      }
      for (const childId of titles.keys()) {
        this.db.query("UPDATE children SET interim_omitted = 0, updated_at = ? WHERE id = ?").run(now, childId);
      }

      const batch = this.getInterimBatch(id);
      if (!batch) {
        throw new Error(`interim batch assignment was not persisted: ${id}`);
      }
      const assignedMessages = this.listInterimMessagesForBatch(id);
      this.db.exec("COMMIT");
      return { batch, messages: assignedMessages };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public getInterimBatch(id: string): InterimBatchRecord | undefined {
    assertNonEmpty(id, "interim batch id");
    const row = this.db.query(`SELECT ${INTERIM_BATCH_COLUMNS} FROM child_interim_batches WHERE id = ?`)
      .get(id) as InterimBatchRow | null;
    return row === null ? undefined : toInterimBatchRecord(row);
  }

  public listInterimBatches(state?: InterimBatchState): InterimBatchRecord[] {
    if (state !== undefined && state !== "assigned" && state !== "injected" && state !== "delivered") {
      throw new Error("interim batch state is invalid");
    }
    const clause = state === undefined ? "" : " WHERE state = ?";
    return (this.db.query(
      `SELECT ${INTERIM_BATCH_COLUMNS} FROM child_interim_batches${clause} ORDER BY created_at, ROWID`,
    ).all(...(state === undefined ? [] : [state])) as InterimBatchRow[]).map(toInterimBatchRecord);
  }

  public markInterimBatchInjected(
    id: string,
    mode: InterimBatchMode,
    now: string,
    ownerTurnId?: string,
  ): InterimBatchRecord {
    assertNonEmpty(id, "interim batch id");
    assertTimestamp(now, "interim batch injection now");
    this.db.query(
      `UPDATE child_interim_batches
       SET state = 'injected', mode = ?, attempt = attempt + 1, owner_turn_id = ?, injected_at = ?, updated_at = ?
       WHERE id = ? AND state IN ('assigned', 'injected')`,
    ).run(mode, ownerTurnId ?? null, now, now, id);
    const batch = this.getInterimBatch(id);
    if (!batch) {
      throw new Error(`unknown interim batch: ${id}`);
    }
    if (batch.state !== "injected") {
      throw new Error(`interim batch cannot be injected from ${batch.state}: ${id}`);
    }
    return batch;
  }

  public markInterimBatchDelivered(
    id: string,
    input: { readonly deliveryId?: string; readonly outcome: InterimBatchOutcome },
    now: string,
  ): InterimBatchRecord {
    assertNonEmpty(id, "interim batch id");
    assertTimestamp(now, "interim batch delivery now");
    this.db.query(
      `UPDATE child_interim_batches
       SET state = 'delivered', delivery_id = ?, outcome = ?, delivered_at = ?, updated_at = ?
       WHERE id = ? AND state = 'injected'`,
    ).run(input.deliveryId ?? null, input.outcome, now, now, id);
    const batch = this.getInterimBatch(id);
    if (!batch) {
      throw new Error(`unknown interim batch: ${id}`);
    }
    if (batch.state !== "delivered") {
      throw new Error(`interim batch cannot be delivered from ${batch.state}: ${id}`);
    }
    return batch;
  }

  public incrementInterimOmitted(childId: string, now: string): number {
    assertNonEmpty(childId, "interim childId");
    assertTimestamp(now, "interim omission now");
    const result = this.db.query(
      "UPDATE children SET interim_omitted = interim_omitted + 1, updated_at = ? WHERE id = ?",
    ).run(now, childId);
    const child = this.getChild(childId);
    if (!child || result.changes === 0) {
      throw new Error(`unknown interim child: ${childId}`);
    }
    return child.interimOmitted;
  }


  public pruneDeliveredInterim(before: string): number {
    assertTimestamp(before, "interim retention cutoff");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const messages = this.db.query(
        `DELETE FROM child_interim_messages
         WHERE batch_id IN (
           SELECT id FROM child_interim_batches WHERE state = 'delivered' AND delivered_at IS NOT NULL AND delivered_at < ?
         )`,
      ).run(before).changes;
      const batches = this.db.query(
        "DELETE FROM child_interim_batches WHERE state = 'delivered' AND delivered_at IS NOT NULL AND delivered_at < ?",
      ).run(before).changes;
      this.db.exec("COMMIT");
      return messages + batches;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private listInterimMessagesForBatch(batchId: string): InterimMessageRecord[] {
    return (this.db.query(
      `SELECT ${QUALIFIED_INTERIM_MESSAGE_COLUMNS}
       FROM child_interim_messages JOIN children ON children.id = child_interim_messages.child_id
       WHERE child_interim_messages.batch_id = ?
       ORDER BY child_interim_messages.created_at, child_interim_messages.ROWID`,
    ).all(batchId) as InterimMessageRow[]).map(toInterimMessageRecord);
  }

  public admitReceipt(input: ReceiptInput, now: string): ReceiptRecord {
    assertReceiptInput(input);
    this.db.query(
      `INSERT INTO receipts (
        id, child_id, state, idempotency_key, projection, artifact_path, content_hash, created_at, updated_at
      ) VALUES (?, ?, 'persisted', ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`,
    ).run(
      input.id,
      input.childId,
      input.idempotencyKey,
      input.projection,
      input.artifactPath ?? null,
      input.contentHash,
      now,
      now,
    );
    const receipt = this.getReceiptByIdempotencyKey(input.idempotencyKey)
      ?? this.getReceiptByChildContentHash(input.childId, input.contentHash);
    if (!receipt) {
      throw new Error(`receipt admission was not persisted: ${input.idempotencyKey}`);
    }
    return receipt;
  }

  public admitChildTerminalReceipt(
    childId: string,
    terminal: ChildTerminalInput,
    receipt: ReceiptInput,
    now: string,
  ): { readonly child: ChildRecord; readonly receipt: ReceiptRecord } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const child = this.markChildTerminal(childId, terminal, now);
      const admittedReceipt = this.admitReceipt(receipt, now);
      this.db.exec("COMMIT");
      return { child, receipt: admittedReceipt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public admitChildTurnReceipt(
    childId: string,
    idle: { readonly sessionFile?: string; readonly lastAssistantText?: string; readonly turnSeq: number },
    receipt: ReceiptInput,
    now: string,
  ): { readonly child: ChildRecord; readonly receipt: ReceiptRecord } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const child = this.markChildIdle(childId, idle, now);
      const admittedReceipt = this.admitReceipt(receipt, now);
      this.db.exec("COMMIT");
      return { child, receipt: admittedReceipt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public admitChildOrphanReceipt(
    childId: string,
    receipt: ReceiptInput,
    now: string,
  ): { readonly child: ChildRecord; readonly receipt: ReceiptRecord } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const child = this.markChildOrphaned(childId, now);
      const admittedReceipt = this.admitReceipt(receipt, now);
      this.db.exec("COMMIT");
      return { child, receipt: admittedReceipt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public getReceipt(id: string): ReceiptRecord | undefined {
    const row = this.db.query(`SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE id = ?`).get(id) as ReceiptRow | null;
    return row === null ? undefined : toReceiptRecord(row);
  }

  public getReceiptByChildContentHash(childId: string, contentHash: string): ReceiptRecord | undefined {
    const row = this.db.query(
      `SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE child_id = ? AND content_hash = ?`,
    ).get(childId, contentHash) as ReceiptRow | null;
    return row === null ? undefined : toReceiptRecord(row);
  }

  public getReceiptByIdempotencyKey(idempotencyKey: string): ReceiptRecord | undefined {
    const row = this.db.query(`SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE idempotency_key = ?`)
      .get(idempotencyKey) as ReceiptRow | null;
    return row === null ? undefined : toReceiptRecord(row);
  }

  public listReceipts(): ReceiptRecord[] {
    return (this.db.query(`SELECT ${RECEIPT_COLUMNS} FROM receipts ORDER BY created_at, ROWID`).all() as ReceiptRow[])
      .map(toReceiptRecord);
  }

  public listPersistedReceipts(
    filter?: { readonly origin?: ChildOrigin | readonly ChildOrigin[] },
    limit = 100,
  ): ReceiptRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("persisted receipt limit must be a positive safe integer");
    }
    const origins = filter?.origin === undefined ? undefined : (Array.isArray(filter.origin) ? filter.origin : [filter.origin]);
    if (origins?.length === 0) {
      return [];
    }
    if (origins?.some((origin) => origin !== "owner" && origin !== "monitor" && origin !== "memory")) {
      throw new Error("receipt origin is invalid");
    }
    const originClause = origins === undefined ? "" : ` AND children.origin IN (${origins.map(() => "?").join(", ")})`;
    return (this.db.query(
      `SELECT ${QUALIFIED_RECEIPT_COLUMNS}
       FROM receipts JOIN children ON children.id = receipts.child_id
       WHERE receipts.state = 'persisted'${originClause}
       ORDER BY receipts.created_at, receipts.ROWID
       LIMIT ?`,
    ).all(...(origins ?? []), limit) as ReceiptRow[]).map(toReceiptRecord);
  }

  public markReceiptDelivered(id: string, now: string): ReceiptRecord {
    this.db.query(
      "UPDATE receipts SET state = 'delivered', updated_at = ? WHERE id = ? AND state = 'persisted'",
    ).run(now, id);
    const receipt = this.getReceipt(id);
    if (!receipt) {
      throw new Error(`unknown receipt: ${id}`);
    }
    return receipt;
  }

  public markPersistedReceiptsForChildDelivered(childId: string, now: string): number {
    assertNonEmpty(childId, "receipt childId");
    assertTimestamp(now, "receipt delivery now");
    const result = this.db.query(
      "UPDATE receipts SET state = 'delivered', updated_at = ? WHERE child_id = ? AND state = 'persisted'",
    ).run(now, childId);
    return result.changes;
  }

  /** Deletes delivered child receipts after their configured retention window. */
  public pruneDeliveredReceipts(before: string): number {
    assertTimestamp(before, "receipt retention cutoff");
    const result = this.db.query("DELETE FROM receipts WHERE state = 'delivered' AND updated_at < ?").run(before);
    return result.changes;
  }
}

function toDeliveryRecord(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    ...(row.child_id === null ? {} : { childId: row.child_id }),
    state: row.state,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    kind: row.delivery_kind,
    handle: row.handle,
    ...(row.body === null ? {} : { body: row.body }),
    ...(row.file_path === null ? {} : { filePath: row.file_path }),
    ...(row.reply_to_guid === null ? {} : { replyToGuid: row.reply_to_guid }),
    ...(row.quoted_text === null ? {} : { quotedText: row.quoted_text }),
    degraded: row.degraded === 1,
    redelivered: row.redelivered === 1,
    ...(row.inflight_at === null ? {} : { inflightAt: row.inflight_at }),
    ...(row.confirmed_at === null ? {} : { confirmedAt: row.confirmed_at }),
    ...(row.external_message_id === null ? {} : { externalMessageId: row.external_message_id }),
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.last_error_message === null ? {} : { lastErrorMessage: row.last_error_message }),
  };
}

function toMonitorStoredRecord(row: MonitorStoredRow): MonitorStoredRecord {
  return {
    id: row.id,
    enabled: row.enabled === 1,
    revision: row.revision,
    specJson: row.spec_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_fired_at === null ? {} : { lastFiredAt: row.last_fired_at }),
  };
}

function toMonitorEventRecord(row: MonitorEventRow): MonitorEventRecord {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    stage: row.stage,
    idempotencyKey: row.idempotency_key,
    eventType: row.event_type,
    payloadJson: row.payload_json,
    burstKey: row.burst_key,
    catchUp: row.catch_up === 1,
    epoch: row.epoch,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.child_id === null ? {} : { childId: row.child_id }),
    ...(row.delivery_id === null ? {} : { deliveryId: row.delivery_id }),
    ...(row.delivery_intent_key === null ? {} : { deliveryIntentKey: row.delivery_intent_key }),
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_id === null ? {} : { leaseId: row.lease_id }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.last_error_message === null ? {} : { lastErrorMessage: row.last_error_message }),
  };
}

function toChildRecord(row: ChildRow): ChildRecord {
  return {
    id: row.id,
    state: row.state,
    kind: row.kind,
    origin: row.origin,
    title: row.title,
    prompt: row.prompt,
    priority: row.priority,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
    ...(row.journal_path === null ? {} : { journalPath: row.journal_path }),
    ...(row.terminal_checksum === null ? {} : { terminalChecksum: row.terminal_checksum }),
    ...(row.terminal_summary === null ? {} : { terminalSummary: row.terminal_summary }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.session_file === null ? {} : { sessionFile: row.session_file }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.last_activity_at === null ? {} : { lastActivityAt: row.last_activity_at }),
    ...(row.last_assistant_text === null ? {} : { lastAssistantText: row.last_assistant_text }),
    ...(row.tokens === null ? {} : { tokens: row.tokens }),
    toolCalls: row.tool_calls,
    turnSeq: row.turn_seq,
    interimOmitted: row.interim_omitted,
  };
}

function toReceiptRecord(row: ReceiptRow): ReceiptRecord {
  return {
    id: row.id,
    childId: row.child_id,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    contentHash: row.content_hash,
    projection: row.projection,
    ...(row.artifact_path === null ? {} : { artifactPath: row.artifact_path }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toInterimMessageRecord(row: InterimMessageRow): InterimMessageRecord {
  return {
    id: row.id,
    childId: row.child_id,
    title: row.title,
    idempotencyKey: row.idempotency_key,
    body: row.body,
    truncated: row.truncated === 1,
    ...(row.batch_id === null ? {} : { batchId: row.batch_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toInterimBatchRecord(row: InterimBatchRow): InterimBatchRecord {
  return {
    id: row.id,
    state: row.state,
    attempt: row.attempt,
    prompt: row.prompt,
    omitted: parseInterimOmitted(row.omitted_json),
    ...(row.mode === null ? {} : { mode: row.mode }),
    ...(row.owner_turn_id === null ? {} : { ownerTurnId: row.owner_turn_id }),
    ...(row.delivery_id === null ? {} : { deliveryId: row.delivery_id }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    createdAt: row.created_at,
    ...(row.injected_at === null ? {} : { injectedAt: row.injected_at }),
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    updatedAt: row.updated_at,
  };
}

function parseInterimOmitted(value: string): Readonly<Record<string, number>> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("interim omitted_json is invalid");
  }
  const omitted: Record<string, number> = {};
  for (const [childId, count] of Object.entries(parsed)) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error("interim omitted_json count is invalid");
    }
    omitted[childId] = count;
  }
  return omitted;
}

function composeInterimBatchPrompt(
  id: string,
  messages: readonly InterimMessageRecord[],
  omitted: Readonly<Record<string, number>>,
  titles: ReadonlyMap<string, string>,
): string {
  const lines = [`[interim-batch ${id}]`];
  for (const message of messages) {
    lines.push(`Background task “${message.title}” (${message.childId}) reports:`);
    lines.push(message.body);
  }
  for (const [childId, count] of Object.entries(omitted)) {
    const title = titles.get(childId) ?? childId;
    lines.push(`(${count} earlier update${count === 1 ? "" : "s"} from “${title}” ${count === 1 ? "was" : "were"} dropped by the rate limit)`);
  }
  return lines.join("\n");
}


function toMemoryIntentRecord(row: MemoryIntentRow): MemoryIntentRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    payloadJson: row.payload_json,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.commit_hash === null ? {} : { commitHash: row.commit_hash }),
    ...(row.quarantine_reason === null ? {} : { quarantineReason: row.quarantine_reason }),
  };
}

function assertInterimMessageInput(input: InterimMessageInput): void {
  assertNonEmpty(input.id, "interim message id");
  assertNonEmpty(input.childId, "interim message childId");
  assertNonEmpty(input.idempotencyKey, "interim message idempotencyKey");
  if (typeof input.body !== "string") {
    throw new Error("interim message body must be a string");
  }
  if (typeof input.truncated !== "boolean") {
    throw new Error("interim message truncated must be boolean");
  }
}
function assertMonitorStoredInput(input: MonitorStoredInput): void {
  assertNonEmpty(input.id, "monitor id");
  if (typeof input.enabled !== "boolean") {
    throw new Error("monitor enabled must be boolean");
  }
  assertJsonObject(input.specJson, "monitor specJson");
}

function assertMemoryIntentInput(input: MemoryIntentInput): void {
  assertNonEmpty(input.id, "memory intent id");
  assertNonEmpty(input.idempotencyKey, "memory intent idempotencyKey");
  if (input.kind !== "capture" && input.kind !== "maintenance") {
    throw new Error("memory intent kind is invalid");
  }
  assertJsonObject(input.payloadJson, "memory intent payloadJson");
}

function assertMonitorEventInput(input: MonitorEventInput): void {
  assertNonEmpty(input.id, "monitor event id");
  assertNonEmpty(input.monitorId, "monitor event monitorId");
  assertNonEmpty(input.idempotencyKey, "monitor event idempotencyKey");
  assertNonEmpty(input.eventType, "monitor event eventType");
  assertJsonValue(input.payloadJson, "monitor event payloadJson");
  assertNonEmpty(input.burstKey, "monitor event burstKey");
  if (typeof input.catchUp !== "boolean") {
    throw new Error("monitor event catchUp must be boolean");
  }
}

function assertMonitorEventStage(value: MonitorEventStage): void {
  if (value !== "admitted" && value !== "batched" && value !== "dispatched"
    && value !== "authored" && value !== "delivered" && value !== "failed") {
    throw new Error("monitor event stage is invalid");
  }
}

function assertJsonObject(value: string, label: string): void {
  assertNonEmpty(value, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be JSON`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must encode an object`);
  }
}

function assertJsonValue(value: string, label: string): void {
  assertNonEmpty(value, label);
  try {
    JSON.parse(value);
  } catch {
    throw new Error(`${label} must be JSON`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertChildInput(input: ChildInput): void {
  assertNonEmpty(input.id, "child id");
  if (input.kind !== "task_tool" && input.kind !== "daemon") {
    throw new Error("child kind is invalid");
  }
  if (input.priority !== "conversational" && input.priority !== "monitor") {
    throw new Error("child priority is invalid");
  }
  if (input.origin !== "owner" && input.origin !== "monitor" && input.origin !== "memory") {
    throw new Error("child origin is invalid");
  }
  assertNonEmpty(input.title, "child title");
  assertNonEmpty(input.prompt, "child prompt");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("child timeoutMs must be a positive safe integer");
  }
}

function assertChildIdleInput(input: { readonly sessionFile?: string; readonly lastAssistantText?: string; readonly turnSeq: number }): void {
  if (!Number.isSafeInteger(input.turnSeq) || input.turnSeq < 1) {
    throw new Error("child turnSeq must be a positive safe integer");
  }
  if (input.sessionFile !== undefined) {
    assertNonEmpty(input.sessionFile, "child sessionFile");
  }
  if (input.lastAssistantText !== undefined && typeof input.lastAssistantText !== "string") {
    throw new Error("child lastAssistantText must be a string");
  }
}

function assertChildTerminalInput(input: ChildTerminalInput): void {
  if (!isTerminalChildState(input.state)) {
    throw new Error("child terminal state is invalid");
  }
  assertNonEmpty(input.journalPath, "child journalPath");
  if (!/^[a-f0-9]{64}$/.test(input.terminalChecksum)) {
    throw new Error("child terminalChecksum is invalid");
  }
  assertNonEmpty(input.terminalSummary, "child terminalSummary");
  if (input.errorCode !== undefined) {
    assertNonEmpty(input.errorCode, "child errorCode");
  }
  if (input.sessionFile !== undefined) {
    assertNonEmpty(input.sessionFile, "child sessionFile");
  }
}

function assertReceiptInput(input: ReceiptInput): void {
  assertNonEmpty(input.id, "receipt id");
  assertNonEmpty(input.childId, "receipt childId");
  assertNonEmpty(input.idempotencyKey, "receipt idempotencyKey");
  assertNonEmpty(input.projection, "receipt projection");
  assertContentHash(input.contentHash);
  if (new TextEncoder().encode(input.projection).byteLength > 1_024) {
    throw new Error("receipt projection exceeds 1024 bytes");
  }
  if (input.artifactPath !== undefined) {
    assertNonEmpty(input.artifactPath, "receipt artifactPath");
  }
}

function isTerminalChildState(value: ChildState): value is ChildTerminalInput["state"] {
  return value === "completed" || value === "failed" || value === "timeout" || value === "cancelled";
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertContentHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("receipt contentHash is invalid");
  }
}

function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function ensureMigrationLedger(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      applied_at TEXT NOT NULL
    )
  `);
}

const schemaFingerprintByVersion = new Map<number, readonly string[]>();

function schemaFingerprint(db: Database): readonly string[] {
  return (db.query(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
  `).all() as SchemaObjectRow[])
    .map((row) => `${row.type}:${row.name}:${normalizeSchemaSql(row.sql!)}`)
    .sort();
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

function expectedSchemaFingerprint(version: number): readonly string[] {
  const cached = schemaFingerprintByVersion.get(version);
  if (cached !== undefined) {
    return cached;
  }

  const expected = new Database(":memory:");
  try {
    expected.exec("PRAGMA foreign_keys = OFF");
    ensureMigrationLedger(expected);
    for (const migration of MIGRATIONS) {
      if (migration.version > version) {
        break;
      }
      expected.exec(migration.sql);
      expected.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, "1970-01-01T00:00:00.000Z");
    }
    const fingerprint = schemaFingerprint(expected);
    schemaFingerprintByVersion.set(version, fingerprint);
    return fingerprint;
  } finally {
    expected.close();
  }
}

/**
 * Validate every claimed contiguous migration prefix before extending it. This
 * preserves fail-closed schema-8 handling while allowing the additive v9
 * assistant-work migration to retain all existing conversational-child data.
 * The caller holds the migration write lock for the complete validation.
 */
function validateClaimedSchemaPrefix(db: Database, appliedRows: readonly MigrationRow[]): void {
  const newest = appliedRows.at(-1)?.version ?? 0;
  if (newest > LATEST_SCHEMA_VERSION) {
    throw new SchemaVersionError(newest);
  }

  const expectedVersions = MIGRATIONS.slice(0, appliedRows.length)
    .map((migration) => migration.version)
    .join(",");
  const actualVersions = appliedRows.map((row) => row.version).join(",");
  if (
    actualVersions !== expectedVersions
    || schemaFingerprint(db).join("\n") !== expectedSchemaFingerprint(newest).join("\n")
  ) {
    throw new SchemaVersionError(newest || LATEST_SCHEMA_VERSION);
  }
}

function runMigrations(db: Database): void {
  const initialAppliedRows = db.query(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all() as MigrationRow[];
  const initialApplied = new Set(initialAppliedRows.map((row) => row.version));
  const initialPending = MIGRATIONS.filter((migration) => !initialApplied.has(migration.version));
  const requiresForeignKeysDisabled = initialPending.some(
    (migration) => migration.requiresForeignKeysDisabled === true,
  );
  if (requiresForeignKeysDisabled) {
    db.exec("PRAGMA foreign_keys = OFF");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const appliedRows = db.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all() as MigrationRow[];
    validateClaimedSchemaPrefix(db, appliedRows);
    const applied = new Set(appliedRows.map((row) => row.version));
    const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version));
    for (const migration of pending) {
      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    if (requiresForeignKeysDisabled) {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

function runIntegrityCheck(db: Database): void {
  const rows = db.query("PRAGMA integrity_check").all() as IntegrityRow[];
  const failure = rows.find((row) => row.integrity_check !== "ok");
  if (failure) {
    throw new IntegrityCheckError(failure.integrity_check);
  }
  const foreignKeyFailure = (db.query("PRAGMA foreign_key_check").all() as ForeignKeyCheckRow[])[0];
  if (foreignKeyFailure) {
    throw new IntegrityCheckError(`foreign key violation: ${foreignKeyFailure.table} -> ${foreignKeyFailure.parent}`);
  }
}

export function openStateStore(path: string): StateStore {
  return StateStore.open(path);
}
