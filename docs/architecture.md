# OpenInstinct architecture

One macOS launchd daemon (`openinstinctd`, a Bun runtime running
`daemon/src/main.ts`), one menu-bar app, one tiny Accessibility helper. All state
under `~/.openinstinct`. No root, SIP on, no third-party binaries other than `gjc`.

```
~/.openinstinct/
  bin/openinstinctd      bun runtime (copied, keeps its TCC identity across installs)
  bin/oi-presence        typing / read-receipt helper (Swift, AX)
  bin/bun → openinstinctd  so the vendored gjc shim (#!/usr/bin/env bun) resolves
  lib/                   daemon source + node_modules, copied by install.sh
  config.json            optional owner handle, name, model, limits

  env                    provider keys (0600), loaded before any SDK import
  state.db               SQLite: cursors, deliveries, children, monitors, receipts, assistant work, notifications
  session/               cwd of the main SDK session (never the repo)
  children/{work,sessions,journal}/
  memory/                git repo, gajae-way layout
  chrome-profile/        the agent's own Chrome user-data-dir
  secrets/               credentials the owner texted (0600 per service)
  logs/daemon.ndjson     structured log, rotated by retention
  run/control.sock       NDJSON control socket (0600)
```

## Boot and lanes

`env-bootstrap.ts` is the first import: it loads `~/.openinstinct/env` into
`process.env` *before* `@gajae-code/coding-agent` is evaluated, because the SDK
injects its own auto-imported credentials at module load and the owner's file
must win. Then `startDaemon()`:

1. **Bootstrap machine** probes `config` and AI credentials. Credentials are the
   only core-lane gate. A missing or malformed `config.json` does not block
   startup: `core-config.ts` applies per-scope product defaults and logs the
   fallback. Full Disk Access (`chat.db`) is a required baseline probed even for
   Chat-only use. A failed, denied, or unknown FDA probe reports limited OS capabilities
   without stopping the core. FDA is a one-time macOS TCC switch: the owner enables
   it in System Settings, and only a real successful probe establishes access.
   The runtime cannot self-grant it. Optional Messages permission probes run for a
   configured owner handle. It re-probes every 5 s and publishes status on the socket.
2. **Store** opens `state.db` (migrations in `store/migrations.ts`).
3. **Control server** listens on the socket immediately, including while the
   core is waiting for credentials, so the panel can show why.
4. When the credentials probe passes (or is unknown), the **core lane** starts:
   the main session, child lifecycle, monitor scheduler/triggers/propagation,
   memory closure, and retention. The Chat hub is available in every bootstrap
   state that the control server can serve.

Bootstrap states are `starting`, `credentials_blocked`, `running`, and
`degraded`. `credentials_blocked` means the core is stopped until an AI account
or managed API key is available. `running` means the core is eligible; it does
not require an iMessage handle. `degraded` means a probe or core start threw;
the existing lanes are left untouched and the next 5-second evaluation retries
the core start.

The core and iMessage lanes have separate lifetimes:

- The **core lane** owns the shared SDK session, children, monitors, memory, and
  chat surface. It gates only on AI credentials and can run with no iMessage
  configuration.
- The **optional iMessage lane** owns the chat.db watcher, delivery service,
  Messages sender, and presence path. It attaches when the core is running, an
  owner handle is configured, and the Full Disk Access probe passes. Automation
  is probed only in this configured path and is surfaced in `status.get`; it is
  needed for Messages sending, while Accessibility controls typing/read
  presence. The lane detaches when the handle is absent, FDA is denied or has a
  probe error, attach fails, the core stops, or the daemon shuts down.

Lane convergence runs at boot, on each 5-second re-probe (for example, after a
permission grant), and immediately after an owner-handle or credential setting
change. No daemon restart is needed to attach, detach, or switch numbers. Every
handle replacement or removal retires the old handle first: the lane is detached,
the session is reloaded, and pending/in-flight ledger rows for that old handle
are expired before a new lane can attach. A same-handle permission detach keeps
those rows for replay; a turn that started detached remains chat-only for its
whole life.

### Log events for lane and routing diagnosis

The primary NDJSON log records these lifecycle and routing events:

- `core_lane_started` and `core_lane_stopped` mark the shared core lifetime.
- `imessage_lane_attached`, `imessage_lane_detached`, and
  `imessage_lane_attach_failed` describe optional iMessage convergence.
- `delivery_skipped_no_imessage_lane` records an owner-bound effect dropped
  because the lane was detached or its generation changed.
- `deliveries_expired_for_handle` records pending/in-flight rows retired with an
  old owner handle.
- `config_missing_defaults_applied` and `config_invalid_defaults_applied` record
  configuration fallback while keeping the core eligible.
- `session_reloaded` records a session reload (including lane/persona changes).
- `router_initial_user_skipped` records the SDK router ignoring a run's own
  initial user message when attributing queued steering.

## Inbound: iMessage and Chat → shared owner turn

The iMessage adapter still polls `chat.db` through `imessage/reader.ts` (read-only,
WAL) from a ROWID cursor. The cursor is bound to a fingerprint of the database
(path + earliest guid); on first contact or identity change it anchors at
`max(ROWID)` and replays nothing — the one-time incident that texted 21 failures
into the owner's own inbox is why. Bodies come from `text` or, on modern
Messages, from the `attributedBody` typedstream (`decodeAttributedBody`). Only
the configured handle is accepted; everything else is dropped silently. Empty /
tapback / U+FFFC-only rows never become turns. This adapter also reads inbound
attachments (≤ 8 MiB) and supplies `PromptImage[]`.

The panel's `chat.send` control verb is the other thin adapter. It accepts text
from the separate Chat window, tags the prompt with `[sent from the Chat window]`
for transcript source recovery, and does not touch `chat.db`, the allowlist, or
Messages presence.

Both adapters call the source-agnostic `OwnerTurnIngress`. It emits the owner
echo, then applies the same pause suppression, steer-when-busy admission, failure
breaker, memory capture, segment flushing, and final handling for either source.
The source only changes routing: iMessage can mark read and use live Messages
presence; panel turns use Chat hub presence. Typing is per-turn presence, not a
periodic status message.

## The main session

`sdk-session/main-session.ts` wraps one `createAgentSession` from the SDK,
reopened over the same transcript file on every daemon start (`SessionManager`).
It is never respawned per message.

- **Serial queue**: turns, reloads, and compactions run one at a time.
- **Steering**: `interruptMode=wait`, `steeringMode=all` — the in-flight tool
  call finishes, then all queued owner texts enter together.
- **Segments**: assistant text is flushed to the owner at every tool-call start
  and every assistant `message_end`, so a turn that thinks–acts–thinks sends
  several short texts instead of one wall at the end. Only owner turns stream;
  internal turns (receipt follow-ups, monitor triage) are silent.
- **Image forwarding**: a `read` of an image path by the agent admits that file
  as an attachment to the owner.
- **Watchdog**: inactivity-based (default 300 s of *no* SDK events), reset by
  streaming, tool calls, and steers. On timeout: abort, or dispose + recreate over
  the same transcript.
- **Compaction**: SDK auto-compaction is off; the daemon compacts at ≥ 50 %
  context after a turn settles.
- **Reload** (`session.reload`): dispose + recreate over the same transcript so
  a changed system prompt takes effect without losing history.
- **System prompt** = gjc defaults, untouched → `persona/GAJAE_SOUL.md` (the
  character, versioned) → `persona/RUNTIME.md` (where it is: iMessage, plain
  text, delegation rules, monitor rules, Chrome profile; `{{ownerHandle}}` etc.
  substituted from config).
- **Custom tools**: `delegate_background`, `send_image`, `child_nudge`,
  `child_status`, `monitor_author`, `memory_search`, `memory_capture`,
  `memory_audit`, `assistant_work_observe`, `assistant_service_monitor`,
  `assistant_local_file`, `assistant_work_status`, `assistant_managed_install`,
  and `assistant_managed_http`. Task/conversational children receive the managed
  local-file tool; monitor children receive observation and read-only
  service-monitor tools. Raw tool calls execute directly without an application
  approval interceptor.
- **Extensions**: `browser/enforce.ts` preserves the dedicated Chrome profile and
  child-tab routing for account identity and concurrent-tab collision prevention.
  Other SDK hard-enforcer restrictions are removed: native permission defaults are
  allow, with no application path denylist, blanket Discord API prohibition,
  main-shell timeout restriction, fixed tool-call budget, or task/subagent/job ban.
  OS and service permissions still apply; task-relevant access does not justify
  exposing secrets.
- **Responsive delegation**: MainSession recommends `delegate_background` for long
  work because it integrates child lifecycle, progress, and receipt reporting.
  It is not the only available spawner. Native task/subagent/job tools remain usable,
  and suitable timeouts or asynchronous shell execution are task-level choices.
  MainSession continues to review and relay child reports rather than letting
  background workers send iMessage directly.

## Assistant work and managed effects

`assistant-work/` and `store/assistant-work.ts` implement a durable ledger for
work items, observations, canonical action revisions, attempts, and
owner notifications. `assistant_work_observe` accepts only `system` or
`third_party` provenance. A host-side assessment decides whether evidence is
irrelevant, an uncertain proposal, or clear unfinished work worth tracking;
the observation itself never authorizes an effect. `assistant_service_monitor`
can turn the clear case into a service-neutral read-only monitor at a 5-minute
cadence for important/ongoing work or 45 minutes otherwise. Its read-only rule
is cooperative policy, not OS-level confinement.

The optional durable managed paths are:

- `assistant_local_file` proposes or executes regular-file writes and explicit
  deletes at normalized absolute paths. Host preflight inventories the targets
  and derives the effect class; the model cannot label its own action safe.
- `assistant_managed_install` proposes or executes one exact-version Bun
  package in an absolute work directory. The host owns the Bun path and argv,
  defaults to `ignoreScripts=false` with normal package lifecycle behavior, and inventories the destination
  before and after the one spawn.
- `assistant_managed_http` performs a bounded GET or proposes/executes one exact
  POST, PUT, PATCH, or DELETE request. Mutations run once without redirects or
  automatic retry, then a separate GET verifies the expected remote state.
- `assistant_work_status` reads work, action, revision/digest, and attempt state;
  it cannot dispatch anything.

Main and background sessions execute owner tasks directly with available raw shell,
file, browser, and other tools, without per-action confirmation or forced managed
redirection. Managed tools are optional durable preflight and verified-effect paths.
A tool result remains execution evidence, not independent verification; uncertain
effects must not be reported as verified, and retries must account for duplicate effects.

Every new managed action starts as `planned` and is identified by an action ID, positive revision, and canonical
SHA-256 digest. Execution must present that exact triple. The executor
re-inspects host state before claim and again before mutation, persists
`effect_started` before invoking the effect, and settles with verified evidence.
An ambiguous post-effect result is reconcile-only: it is not blindly retried.
These identity and state checks preserve data integrity and cancellation, not an
application permission exchange. The runtime does not grant OS permissions.

`OwnerTurnIngress` authenticates direct owner messages through the local Chat socket
or configured iMessage allowlist. Exact cancellation uses a standalone, text-only line:

```text
/reject ACTION_ID REVISION DIGEST
```

The digest is 64 lowercase hexadecimal characters. Attachments, extra words,
unknown actions, and stale revisions/digests are rejected. `/reject` cancels the
matching current revision without starting a new effect; it cannot undo an effect
already started. Websites, messages, monitors, child reports, memory, tool outputs,
and model conclusions remain evidence rather than authenticated owner instructions.
Completion requires verified effects, not merely command acceptance or observed output.

### Follow-up policies and recovery

The authenticated owner can bind a bounded repeat policy to an already confirmed
action with another standalone, text-only command:

```text
/followup {"workId":"…","actionId":"…","enabled":true,"intervalMs":60000,"maxAttempts":1}
```

All five fields are required and extra fields are rejected. The policy captures
the action's current revision and digest, schedules nothing when disabled or
`maxAttempts` is zero, and never treats the command itself as a dispatch. Due
execution proceeds only after the original action is confirmed. The runtime
polls enabled policies, creates a new semantic action for each ordinal, rechecks
current policy/deadline/work state, enforces the attempt cap, and uses
the real local-file/install/HTTP executor selected from the persisted
action payload. A changed policy or action stops the old path; an ambiguous or
cancelled outcome stops further repeats. Derived actions start as `planned` and
proceed without per-action confirmation.

`AssistantWorkRuntime` also recovers on boot. A `claimed_pre_effect` attempt for
a supported local-file/install/HTTP action may resume through its real executor.
An interrupted `effect_started` attempt is marked reconcile-only/ambiguous and
is never replayed. Durable recovery reports
are passed through an internal MainSession turn before an owner notice is
admitted; no fabricated success is emitted. Completion requires a verified executor
result and surface-specific acceptance evidence, not merely a saved policy or
queue admission.

### Managed HTTP host policy

The managed HTTP tool is registered from `main.ts` with `configuredHttpAccess()`.
`OI_HTTP_LOCAL_ORIGINS` is a JSON array of exact `scheme://host[:port]` origins
and is the only way to allow private/local addresses; cloud metadata endpoints
remain blocked. `OI_HTTP_SECRET_BINDINGS` is a JSON object whose host-owned
entries contain exactly `origin`, `header`, and `environment`, for example
`{"mailApi":{"origin":"https://api.example","header":"Authorization","environment":"MAIL_API_TOKEN"}}`.
Tool calls carry a `secretRef` such as `mailApi`, never the secret value. The
daemon snapshots the named environment value and resolves it only when both the
exact origin and header match. Sensitive
headers, query parameters, and body keys cannot contain plaintext credentials.
Public plaintext HTTP cannot carry secret references, redirects are not
followed, DNS answers are validated and pinned for the connection, and an
unverified post-mutation result is `ambiguous`, not success.
Host operators place these values in the daemon's private `~/.openinstinct/env`
file (`KEY=value`, mode 0600); prompt content cannot edit the host policy.

### Adaptive owner notifications

Main-authored proactive notices are admitted under a stable ID, not treated as
delivered on creation. `ChatActivity` considers Chat active only when a fresh
sample says the window is frontmost and recent input is within two minutes. An
active Chat gets the initial route; otherwise an attached iMessage lane is used.
If neither route is available, the durable notice waits.

When Chat is the selected route, listing is not delivery: the route stays
`uncertain` until the panel confirms that the notice rendered. An iMessage-first
notice can also appear in shared Chat history and record `renderedAt` without a
Chat dispatch row. Render is still not owner acknowledgement: an unacknowledged
Chat-routed notice may fall back to iMessage after Chat becomes inactive. The
owner presses **확인** to acknowledge it and stop further routing. Likewise,
iMessage queue admission is not confirmation: that route remains `uncertain`
until the delivery ledger confirms the Messages row. Interrupted dispatches are
recovered as reconcile-only work, so uncertainty never triggers a blind resend.

The control surface is `assistant.notifications.list` (`{}`),
`assistant.notifications.rendered` (`{notificationId}`), and
`assistant.notifications.ack` (`{notificationId}`). Listing returns durable
`{id, text, acknowledged}` rows; the panel filters acknowledged rows from its
visible notice list.

## Outbound: ChatHub and optional iMessage delivery

`ChatHub` fans out owner echoes, assistant segments, final assistant messages,
images, and presence to control-socket subscribers. Every event has a monotonic
`seq` for the life of the daemon. `chat.history` reads the last 50 owner-facing
rows from the shared transcript, filters operator notes, receipt follow-ups, and
monitor triage, strips orientation text, and recovers the source from the
trailing `[sent from the Chat window]` marker. History returns a sequence
watermark and message-only tail so a subscriber can merge the snapshot with
live events without losing or duplicating rows.

`OwnerOutbox` is the single owner-bound iMessage boundary. With the optional
lane attached it pins the current handle and delegates owner-turn text and
images to the durable `DeliveryService` ledger, while read receipts and typing
use the attached Messages presence path. When detached, owner-turn output still
reaches ChatHub and direct iMessage admission/presence is skipped. Main-authored
proactive output instead enters the durable assistant-notification ledger: it
can render in active Chat, route to confirmed iMessage delivery, or wait without
being misreported as delivered. A per-turn binding captures the lane generation:
a turn that started detached never starts mirroring if the lane attaches
mid-turn, and a turn invalidated by detach drops its remaining iMessage effects.
Receipt, monitor, memory-audit, and operator-note output normally bypasses the
conversation bubble stream and uses the notification path; if an owner message
promotes an internal run, only output from that promotion onward is
owner-visible.

`delivery/service.ts` is the durable outbox in `state.db`: `admit()` writes a row
with an idempotency key; a flush loop sends with a bounded retry ladder and
records `confirmed` / `expired` / `failed_ambiguous`. Every text and caption is
passed through `toPlainText()` (Markdown stripped) — the prompt asks for plain
text, the sanitizer guarantees it.

`imessage/sender.ts` sends through Messages' own AppleScript bridge
(`send <text|file> to participant`). That bridge exposes nothing else, so replies
are flat (no reply-to), and typing / read are delegated to `oi-presence` when the
binary exists. Attachments are staged into `~/Pictures/OpenInstinct/` and
`mdimport`-ed first because `imagent` refuses files without Spotlight metadata.
The confirmer watches `chat.db` for the sent row.

`oi-presence` needs Messages frontmost for ~300 ms, so it only runs when you have
been idle for `presence.idleSec` (default 8 s) and hands focus back.

## Children

`children/lifecycle.ts` admits conversational and monitor-priority work under a
concurrency cap (default 4) and a live-child cap (default 16). The live cap
counts every non-terminal child; it evicts the oldest idle or cold child before
rejecting a new admission when no evictable child remains. Production work uses
`sdk-inprocess.ts`, a separate SDK session with the same soul, browser guard,
and model pin. `gjc-external.ts` remains an explicit adapter for integrations
that provide one, not the default production runner. Terminal reports are
written to a journal and become **receipts**; receipts are folded into the main
session as follow-up turns (`children/receipts.ts`), projected to ≤ 1024 B.

`delegate_background` children (`kind: task_tool`) are conversational. Their
public durable lifecycle is `running → idle → cold → terminated`: idle children
keep a warm SDK session for the warm TTL, then dispose the object while retaining
the session-file transcript; a cold nudge reopens that transcript, while the
idle timeout terminates the child. Main-session `child_status` reads a precomputed
in-memory status snapshot, and `child_nudge` only updates an in-memory lifecycle
queue before scheduling the pump; neither tool enters SQLite or a child SDK
session at invocation time. Their latency alert threshold is detection telemetry,
not a preemption promise. Conversational children alone receive `report_progress`;
updates are durably stored, UTF-8 bounded, batched for 3 seconds by default,
rate-limited per child, and injected through an owner-turn steer or one internal
main turn.

Failures and restart orphans for every child kind bypass interim batching and
become durable receipts. Every receipt is fed to the shared internal
Chat/MainSession for an internal triage turn first. That path is the only
owner-facing author and communication authority: background components submit
internal events and triage reports, never send iMessage directly. The main agent
may retry, resume, redelegate, repair, clean state, or silently ignore;
only a judgment-needed result becomes one concise natural-language owner message.
Raw state tokens, provider error codes, stacks, paths, and receipt projections
remain internal evidence and never become owner text.

## Monitors

`monitors/store.ts` keeps specs in `state.db` with revision fencing. Triggers:
`cron` (with IANA tz and explicit DST rules), `watcher` (file roots), `webhook`
(token), `script` (interval, script root only). Optional `expiresAt` disables a
monitor at its end. `memory-canonicalize`, `memory-audit`, and
`computer-usage-insight` are seeded once; the first two are protected.

Firing → `propagation.ts` state machine: `admitted → batched → dispatched
(child) → authored → delivered`, lease-fenced, replay-safe across restarts.
"Authored" hands the child's terminal report to the **main session as a triage
turn**: Gajae diagnoses, may repair the monitor with `monitor_author`, and
writes the owner one plain line — or stays silent for a self-healed blip. Raw
error codes never reach the owner.

A manual `monitors.run` request follows the same propagation path immediately,
including for disabled and protected monitors; it uses a unique occurrence key so
on-demand checks cannot be swallowed by scheduled-run deduplication.

## Memory

`memory/vendor/` is gajae-way's memory engine byte-for-byte (registry, doctrine,
autolink, validator, BM25 retrieval), pinned in `PROVENANCE.md`. `adapters/`
supply the environment: every owner turn is queued as a capture intent, written
under `daily/`, and committed; canonicalization (6-hourly) promotes into
people/projects/decisions; the daily audit reports structural issues. Tools are
thin wrappers over the vendored functions.

Existing transcripts can be reconciled with the capture axis through the
`memory.backfillCaptures` control verb. The daemon pairs owner messages with the
assistant replies that follow, preserves their original timestamps, skips
injected prompts, and uses deterministic matching so a repeated backfill is safe.

## Control protocol

`control/schema.ts` defines the NDJSON frames (hello/negotiate, request,
response, error, event) and the verb list. Fixtures in
`daemon/test/fixtures/control/` are the golden source; `scripts/sync-control-fixtures.sh`
copies them into the Swift test target so the panel codec is byte-checked
against them. Notable verbs: `status.get` (bootstrap, session, children,
monitors, `attention`), `monitors.*` including `monitors.run`,
`daemon.pause/resume/restart`, `session.compact/reload`, `settings.get/set`,
`models.list` (cached 10 min; `{"refresh": true}` re-runs `gjc --list-models`
and restarts the TTL — the panel's reload button sends this), `accounts.*`,
`providers.custom` (writes a provider block into `~/.gjc/agent/models.yml`),
`browser.open`, and `memory.backfillCaptures`. Chat activity and durable notices
use `chat.activity`, `assistant.notifications.list`,
`assistant.notifications.rendered`, and `assistant.notifications.ack`. OAuth
account login uses `gjc auth-broker login`, with a paste-code fallback.

`accounts.discover` lists existing Claude, ChatGPT/Codex CLI credentials that can
be adopted; `accounts.adopt` changes the daemon's selected credential only after
the owner clicks **Adopt**. Adoption is never automatic because it may start
billing an existing subscription. `monitors.run` dispatches one immediate run
without changing the monitor's schedule or enabled state.

The Chat surface uses `chat.send` (`{text}`), `chat.history` (`{limit}`), and
`chat.subscribe` (`{}`). Subscriptions receive the opt-in `chat.message` and
`chat.presence` event topics. Every chat event payload carries a numeric,
monotonic `seq`; the final assistant `chat.message` for a turn carries
`final: true`. A `chat.history` response is `{messages, seq, tail, inFlight?,
truncated?, tailTruncated?}`, with `tail` containing message events only so a
client can merge history and live events without loss or duplication.

`status.get` also reports the top-level iMessage lane (`attached` or `detached`
with a reason, detail, and optional handle) and the credentials probe. FDA and
Automation probe entries are omitted entirely when no handle is configured.

## Panel

`panel/` is SwiftUI hosted in an explicit `NSStatusItem` + `NSPopover`
(`MenuBarExtra` does not materialise under launchd on macOS 26). It polls
`status.get`, renders health in plain words, and raises a one-time `NSAlert` for
`attention` items. The popover always exposes **Chat…**; it opens a separate
`ChatWindowController` `NSWindow` with iMessage-like bubbles and plain text only.
The composer is blocked only when the daemon is unreachable, credentials are
missing, or the session is paused — never because the optional iMessage lane is
detached. `SettingsWindow.swift` is a normal window with tabs, including an
iMessage tab for connect/disconnect and permission status; changing the handle
does not restart the daemon.

The Chat window also polls durable assistant notifications. Visible notices are
rendered above the transcript with **확인** acknowledgement controls; as a row
appears, the panel retries `rendered` until the daemon accepts it, while pressing
the button reports `ack`. `ChatActivityReporter` samples frontmost/recent-input
metadata every 5 seconds for adaptive Chat-versus-iMessage routing. It reads
elapsed input age only and does not install an event tap or inspect keystrokes.

The Account tab also lists OAuth/API-key accounts, offers explicit discovery and
**Adopt** for existing CLI credentials, and never adopts one without owner action.
The iMessage tab is an optional branch; its identity and TCC probes are shown only
when a handle is configured.

Launched at login via `co.openinstinct.panel` using `open -W` so it gets a proper
Aqua session.

## Install and packaging

`scripts/install.sh` copies the repo into `~/.openinstinct/lib`, installs prod
deps, keeps the daemon binary's inode unless bun changed (so TCC grants
survive), renders the launchd plist with a PATH that includes `~/.local/bin`,
and installs/launches the panel and presence helper.

`scripts/build-release.sh` compiles the panel and the presence helper, assembles
that payload with a bun runtime and the `gjc` binary pinned to the vendored SDK,
and emits `dist/openinstinct-<version>-darwin-<arch>.tar.gz` plus a `.sha256`.

`scripts/install-remote.sh` is the curl entry point: it resolves the release
asset, verifies the checksum, extracts the archive, and hands the directory to
`bootstrap-from-payload.sh`, which stages the source at `~/.openinstinct/src`
and calls `install.sh`. There is no installer app and no notarization step:
Gatekeeper only assesses files carrying `com.apple.quarantine`, which browsers
attach and curl does not, so an unsigned build installs and launches without an
approval prompt.

## Safety properties worth knowing

- Never replays history; never answers anyone but the owner; never sends from
  a personal Messages account by design of the setup instructions.
- Two consecutive turn failures → further failure notices go to the log, not
  the inbox.
- Secrets: env file 0600 and refused if looser; settings snapshot reports keys
  as set/unset only; credentials the owner texts are stored per-service and
  never echoed.
- The browser can only run on the agent's own Chrome profile (enforced, not
  advised).
- iMessage-bound effects use durable, idempotent delivery rows; Chat hub events are
  fire-and-forget and sequenced.
- System/third-party observations can propose or schedule read-only discovery,
  but cannot mint owner provenance or authorize a mutation.
- Optional managed effects use host preflight, exact revision/digest fencing,
  cancellation, execution records, and effect verification. Raw tools remain available
  directly; OS permissions are independently enforced by macOS.
