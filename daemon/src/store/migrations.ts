export interface Migration {
  readonly version: number;
  readonly sql: string;
  /** Table rebuilds require foreign-key enforcement to be paused before BEGIN. */
  readonly requiresForeignKeysDisabled?: boolean;
}

export const LATEST_SCHEMA_VERSION = 9;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE children (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('requested', 'admitted', 'running', 'completed', 'failed', 'timed_out', 'canceled')),
        kind TEXT NOT NULL CHECK (kind IN ('task_tool', 'daemon')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0)
      );

      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        child_id TEXT REFERENCES children(id),
        state TEXT NOT NULL CHECK (state IN ('pending', 'inflight', 'confirmed', 'failed_ambiguous', 'expired')),
        idempotency_key TEXT NOT NULL UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE monitors (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE monitor_events (
        id TEXT PRIMARY KEY,
        monitor_id TEXT NOT NULL REFERENCES monitors(id),
        stage TEXT NOT NULL CHECK (stage IN ('admitted', 'batched', 'session_selected', 'authored', 'memory_queued', 'delivered', 'reconciled', 'failed', 'failed_no_retry')),
        lease_owner TEXT,
        lease_id TEXT,
        lease_expires_at TEXT,
        epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE receipts (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL REFERENCES children(id),
        state TEXT NOT NULL CHECK (state IN ('persisted', 'delivered')),
        idempotency_key TEXT NOT NULL UNIQUE,
        projection TEXT NOT NULL,
        artifact_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE deliveries ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'text'
        CHECK (delivery_kind IN ('text', 'file'));
      ALTER TABLE deliveries ADD COLUMN handle TEXT NOT NULL DEFAULT '';
      ALTER TABLE deliveries ADD COLUMN body TEXT;
      ALTER TABLE deliveries ADD COLUMN file_path TEXT;
      ALTER TABLE deliveries ADD COLUMN reply_to_guid TEXT;
      ALTER TABLE deliveries ADD COLUMN quoted_text TEXT;
      ALTER TABLE deliveries ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1));
      ALTER TABLE deliveries ADD COLUMN redelivered INTEGER NOT NULL DEFAULT 0 CHECK (redelivered IN (0, 1));
      ALTER TABLE deliveries ADD COLUMN inflight_at TEXT;
      ALTER TABLE deliveries ADD COLUMN confirmed_at TEXT;
      ALTER TABLE deliveries ADD COLUMN external_message_id TEXT;
      ALTER TABLE deliveries ADD COLUMN thread_id TEXT;
      ALTER TABLE deliveries ADD COLUMN last_error_code TEXT;
      ALTER TABLE deliveries ADD COLUMN last_error_message TEXT;
      CREATE INDEX deliveries_due_idx ON deliveries (state, next_attempt_at, created_at);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE children ADD COLUMN title TEXT NOT NULL DEFAULT '';
      ALTER TABLE children ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
      ALTER TABLE children ADD COLUMN journal_path TEXT;
      ALTER TABLE children ADD COLUMN terminal_checksum TEXT;
      ALTER TABLE children ADD COLUMN terminal_summary TEXT;
      ALTER TABLE children ADD COLUMN error_code TEXT;
      ALTER TABLE children ADD COLUMN session_file TEXT;
      CREATE INDEX children_state_idx ON children (state, created_at);
      CREATE INDEX receipts_state_idx ON receipts (state, created_at);
    `,
  },
  {
    version: 4,
    requiresForeignKeysDisabled: true,
    sql: `
      CREATE TABLE children_v4 (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('requested', 'admitted', 'running', 'completed', 'failed', 'timeout', 'cancelled', 'orphaned')),
        kind TEXT NOT NULL CHECK (kind IN ('task_tool', 'daemon')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
        title TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        journal_path TEXT,
        terminal_checksum TEXT,
        terminal_summary TEXT,
        error_code TEXT,
        session_file TEXT,
        priority TEXT NOT NULL DEFAULT 'conversational' CHECK (priority IN ('conversational', 'monitor'))
      );
      INSERT INTO children_v4 (
        id, state, kind, created_at, updated_at, terminal_at, timeout_ms,
        title, prompt, journal_path, terminal_checksum, terminal_summary, error_code, session_file, priority
      ) SELECT
        id,
        CASE state
          WHEN 'timed_out' THEN 'timeout'
          WHEN 'canceled' THEN 'cancelled'
          ELSE state
        END,
        kind, created_at, updated_at, terminal_at, timeout_ms,
        title, prompt, journal_path, terminal_checksum, terminal_summary, error_code, session_file, 'conversational'
      FROM children;
      DROP TABLE children;
      ALTER TABLE children_v4 RENAME TO children;
      ALTER TABLE receipts ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
      CREATE INDEX children_state_idx ON children (state, priority, created_at);
      CREATE UNIQUE INDEX receipts_child_content_hash_idx
        ON receipts (child_id, content_hash) WHERE content_hash <> '';
    `,
  },
  {
    version: 5,
    requiresForeignKeysDisabled: true,
    sql: `
      ALTER TABLE monitors ADD COLUMN last_fired_at TEXT;
      CREATE TABLE monitor_events_v5 (
        id TEXT PRIMARY KEY,
        monitor_id TEXT NOT NULL REFERENCES monitors(id),
        stage TEXT NOT NULL CHECK (stage IN ('admitted', 'batched', 'dispatched', 'authored', 'delivered', 'failed')),
        idempotency_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        burst_key TEXT NOT NULL,
        catch_up INTEGER NOT NULL DEFAULT 0 CHECK (catch_up IN (0, 1)),
        child_id TEXT REFERENCES children(id),
        delivery_id TEXT REFERENCES deliveries(id),
        delivery_intent_key TEXT,
        lease_owner TEXT,
        lease_id TEXT,
        lease_expires_at TEXT,
        epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO monitor_events_v5 (
        id, monitor_id, stage, idempotency_key, event_type, payload_json, burst_key, catch_up,
        lease_owner, lease_id, lease_expires_at, epoch, attempts, created_at, updated_at
      ) SELECT
        id,
        monitor_id,
        CASE stage
          WHEN 'delivered' THEN 'delivered'
          WHEN 'reconciled' THEN 'delivered'
          WHEN 'failed' THEN 'failed'
          WHEN 'failed_no_retry' THEN 'failed'
          WHEN 'authored' THEN 'authored'
          WHEN 'memory_queued' THEN 'authored'
          WHEN 'session_selected' THEN 'batched'
          WHEN 'batched' THEN 'batched'
          ELSE 'admitted'
        END,
        'legacy:' || id,
        'legacy',
        '{}',
        id,
        0,
        lease_owner,
        lease_id,
        lease_expires_at,
        epoch,
        CASE WHEN attempts > 3 THEN 3 ELSE attempts END,
        created_at,
        updated_at
      FROM monitor_events;
      DROP TABLE monitor_events;
      ALTER TABLE monitor_events_v5 RENAME TO monitor_events;
      CREATE INDEX monitor_events_claimable_idx
        ON monitor_events (stage, lease_expires_at, attempts, created_at);
      CREATE INDEX monitor_events_child_idx ON monitor_events (child_id);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE memory_intents (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('capture', 'maintenance')),
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'written', 'committed', 'receipted', 'quarantined')),
        commit_hash TEXT,
        quarantine_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX memory_intents_state_idx ON memory_intents (state, created_at);
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE children ADD COLUMN started_at TEXT;
      ALTER TABLE children ADD COLUMN tokens INTEGER;
      ALTER TABLE children ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 8,
    requiresForeignKeysDisabled: true,
    sql: `
      CREATE TABLE children_v8 (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('requested','admitted','running','idle','cold','completed','failed','timeout','cancelled','orphaned','terminated')),
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
      INSERT INTO children_v8 (id, state, kind, created_at, updated_at, terminal_at, timeout_ms, title, prompt, journal_path,
        terminal_checksum, terminal_summary, error_code, session_file, priority, started_at, tokens, tool_calls, origin)
      SELECT id, state, kind, created_at, updated_at, terminal_at, timeout_ms, title, prompt, journal_path,
        terminal_checksum, terminal_summary, error_code, session_file, priority, started_at, tokens, tool_calls,
        CASE WHEN kind = 'daemon' AND title = 'Memory canonicalization' THEN 'memory'
             WHEN kind = 'daemon' THEN 'monitor' ELSE 'owner' END
      FROM children;
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
        created_at TEXT NOT NULL, injected_at TEXT, delivered_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE child_interim_messages (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL REFERENCES children(id),
        idempotency_key TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
        batch_id TEXT REFERENCES child_interim_batches(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX child_interim_unbatched_idx ON child_interim_messages (batch_id, created_at);
      CREATE INDEX child_interim_batches_state_idx ON child_interim_batches (state, created_at);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE assistant_work_works (
        id TEXT PRIMARY KEY,
        stable_key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'completed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE assistant_work_observations (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES assistant_work_works(id),
        source TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        provenance_principal TEXT NOT NULL CHECK (provenance_principal IN ('owner', 'third_party', 'system')),
        provenance_channel TEXT NOT NULL,
        provenance_subject TEXT NOT NULL,
        provenance_evidence_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (source, occurrence_key)
      );
      CREATE INDEX assistant_work_observations_work_idx
        ON assistant_work_observations (work_id, observed_at, created_at);

      CREATE TABLE assistant_work_actions (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES assistant_work_works(id),
        semantic_key TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK (current_revision > 0),
        current_digest TEXT NOT NULL CHECK (length(current_digest) = 64),
        state TEXT NOT NULL CHECK (state IN (
          'planned', 'approval_pending', 'authorized', 'claimed_pre_effect', 'effect_started',
          'confirmed', 'definitive_failed', 'ambiguous', 'cancelled', 'expired', 'blocked'
        )),
        active_attempt_id TEXT,
        cancelled_at TEXT,
        cancel_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (work_id, semantic_key)
      );
      CREATE INDEX assistant_work_actions_state_idx
        ON assistant_work_actions (state, updated_at, created_at);

      CREATE TABLE assistant_work_action_revisions (
        action_id TEXT NOT NULL REFERENCES assistant_work_actions(id),
        revision INTEGER NOT NULL CHECK (revision > 0),
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        effect_class TEXT NOT NULL CHECK (effect_class IN (
          'ordinary_local_edit', 'ordinary_local_install', 'delete_existing',
          'bulk_existing_user_assets', 'core_setting_change', 'account_rights_change',
          'cost_increase', 'external_message', 'external_mutation', 'uncovered'
        )),
        recipient TEXT,
        topic TEXT,
        action_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        scope_json TEXT,
        cost_json TEXT,
        deadline_at TEXT,
        blocked_evidence_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (action_id, revision),
        UNIQUE (action_id, revision, digest),
        CHECK (effect_class <> 'external_message' OR (recipient IS NOT NULL AND topic IS NOT NULL)),
        CHECK (effect_class <> 'uncovered' OR blocked_evidence_json IS NOT NULL),
        CHECK (effect_class = 'uncovered' OR blocked_evidence_json IS NULL)
      );

      CREATE TABLE assistant_work_owner_rules (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        state TEXT NOT NULL CHECK (state IN ('enabled', 'revoked')),
        effect_class TEXT NOT NULL CHECK (effect_class = 'external_message'),
        recipient TEXT NOT NULL,
        topic TEXT NOT NULL,
        action_key TEXT NOT NULL,
        provenance_principal TEXT NOT NULL CHECK (provenance_principal = 'owner'),
        provenance_channel TEXT NOT NULL,
        provenance_subject TEXT NOT NULL,
        provenance_evidence_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE (effect_class, recipient, topic, action_key)
      );
      CREATE INDEX assistant_work_owner_rules_match_idx
        ON assistant_work_owner_rules (state, effect_class, recipient, topic, action_key);

      CREATE TABLE assistant_work_explicit_approvals (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        action_revision INTEGER NOT NULL,
        action_digest TEXT NOT NULL CHECK (length(action_digest) = 64),
        state TEXT NOT NULL CHECK (state IN ('active', 'consumed', 'invalidated', 'revoked')),
        provenance_principal TEXT NOT NULL CHECK (provenance_principal = 'owner'),
        provenance_channel TEXT NOT NULL,
        provenance_subject TEXT NOT NULL,
        provenance_evidence_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_attempt_id TEXT,
        invalidated_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (action_id, action_revision, action_digest)
          REFERENCES assistant_work_action_revisions(action_id, revision, digest)
      );
      CREATE INDEX assistant_work_explicit_approvals_active_idx
        ON assistant_work_explicit_approvals (action_id, action_revision, action_digest, state, created_at);

      CREATE TABLE assistant_work_attempts (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        action_revision INTEGER NOT NULL,
        action_digest TEXT NOT NULL CHECK (length(action_digest) = 64),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        state TEXT NOT NULL CHECK (state IN (
          'claimed_pre_effect', 'effect_started', 'confirmed', 'definitive_failed', 'ambiguous', 'cancelled'
        )),
        worker_id TEXT NOT NULL,
        authorization_source TEXT NOT NULL CHECK (authorization_source IN ('local_policy', 'owner_rule', 'owner_explicit')),
        authorization_id TEXT,
        authorization_revision INTEGER,
        claimed_at TEXT NOT NULL,
        effect_started_at TEXT,
        settled_at TEXT,
        outcome_json TEXT,
        recovered_at TEXT,
        recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
        updated_at TEXT NOT NULL,
        UNIQUE (action_id, action_revision, sequence),
        FOREIGN KEY (action_id, action_revision, action_digest)
          REFERENCES assistant_work_action_revisions(action_id, revision, digest),
        CHECK (authorization_source <> 'owner_explicit' OR authorization_id IS NOT NULL),
        CHECK (authorization_source <> 'owner_rule' OR (authorization_id IS NOT NULL AND authorization_revision IS NOT NULL))
      );
      CREATE UNIQUE INDEX assistant_work_attempts_live_revision_idx
        ON assistant_work_attempts (action_id, action_revision)
        WHERE state IN ('claimed_pre_effect', 'effect_started', 'ambiguous', 'confirmed');
      CREATE INDEX assistant_work_attempts_recovery_idx
        ON assistant_work_attempts (state, claimed_at, action_id, sequence);

      CREATE TABLE assistant_work_recontacts (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        action_revision INTEGER NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        scheduled_at TEXT NOT NULL,
        context_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (action_id, action_revision, ordinal),
        FOREIGN KEY (action_id, action_revision)
          REFERENCES assistant_work_action_revisions(action_id, revision)
      );
      CREATE INDEX assistant_work_recontacts_due_idx
        ON assistant_work_recontacts (scheduled_at, action_id, action_revision, ordinal);

      CREATE TABLE assistant_work_followup_policies (
        work_id TEXT PRIMARY KEY REFERENCES assistant_work_works(id),
        action_id TEXT NOT NULL REFERENCES assistant_work_actions(id),
        action_revision INTEGER NOT NULL CHECK (action_revision > 0),
        action_digest TEXT NOT NULL CHECK (length(action_digest) = 64),
        revision INTEGER NOT NULL CHECK (revision > 0),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        interval_ms INTEGER NOT NULL CHECK (interval_ms > 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts >= 0),
        next_due_at TEXT,
        next_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (next_ordinal > 0),
        provenance_principal TEXT NOT NULL CHECK (provenance_principal = 'owner'),
        provenance_channel TEXT NOT NULL,
        provenance_subject TEXT NOT NULL,
        provenance_evidence_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (action_id, action_revision, action_digest)
          REFERENCES assistant_work_action_revisions(action_id, revision, digest)
      );
      CREATE INDEX assistant_work_followup_policies_due_idx
        ON assistant_work_followup_policies (enabled, next_due_at, work_id);

      CREATE TABLE assistant_work_followup_dispatches (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES assistant_work_works(id),
        policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        original_action_id TEXT NOT NULL REFERENCES assistant_work_actions(id),
        action_id TEXT NOT NULL REFERENCES assistant_work_actions(id),
        state TEXT NOT NULL CHECK (state IN ('due', 'claimed', 'completed', 'skipped')),
        due_at TEXT NOT NULL,
        worker_id TEXT,
        claimed_at TEXT,
        completed_at TEXT,
        outcome_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (work_id, policy_revision, ordinal),
        CHECK (state <> 'claimed' OR (worker_id IS NOT NULL AND claimed_at IS NOT NULL)),
        CHECK (state NOT IN ('completed', 'skipped') OR completed_at IS NOT NULL)
      );
      CREATE INDEX assistant_work_followup_dispatches_state_idx
        ON assistant_work_followup_dispatches (state, due_at, work_id, policy_revision, ordinal);

      CREATE TABLE assistant_work_reports (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        work_id TEXT REFERENCES assistant_work_works(id),
        action_id TEXT REFERENCES assistant_work_actions(id),
        attempt_id TEXT REFERENCES assistant_work_attempts(id),
        dispatch_id TEXT REFERENCES assistant_work_followup_dispatches(id),
        detail_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'admitted')),
        created_at TEXT NOT NULL,
        admitted_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (state <> 'admitted' OR admitted_at IS NOT NULL)
      );
      CREATE INDEX assistant_work_reports_state_idx
        ON assistant_work_reports (state, created_at, id);

      CREATE TABLE assistant_work_notifications (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        work_id TEXT REFERENCES assistant_work_works(id),
        action_id TEXT REFERENCES assistant_work_actions(id),
        rendered_at TEXT,
        owner_ack_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX assistant_work_notifications_work_idx
        ON assistant_work_notifications (work_id, created_at);
      CREATE INDEX assistant_work_notifications_action_idx
        ON assistant_work_notifications (action_id, created_at);

      CREATE TABLE assistant_work_notification_routes (
        notification_id TEXT NOT NULL REFERENCES assistant_work_notifications(id),
        route TEXT NOT NULL CHECK (route IN ('chat', 'imessage')),
        state TEXT NOT NULL CHECK (state IN (
          'reserved', 'dispatching', 'delivered', 'uncertain', 'failed_definitive'
        )),
        worker_id TEXT,
        reserved_at TEXT NOT NULL,
        dispatching_at TEXT,
        settled_at TEXT,
        external_id TEXT,
        detail_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (notification_id, route),
        CHECK (state NOT IN ('dispatching', 'delivered', 'uncertain', 'failed_definitive') OR worker_id IS NOT NULL),
        CHECK (state <> 'dispatching' OR dispatching_at IS NOT NULL),
        CHECK (state NOT IN ('delivered', 'uncertain', 'failed_definitive') OR settled_at IS NOT NULL)
      );
      CREATE INDEX assistant_work_notification_routes_recovery_idx
        ON assistant_work_notification_routes (state, dispatching_at, notification_id, route);
    `,
  },
];
