# OpenInstinct operator runbook

For end users see the [user guide](user-guide.md); for how it is built see
[architecture](architecture.md). This file is the operational reference.

OpenInstinct keeps all operator state below `~/.openinstinct`. The launch daemon is
`~/.openinstinct/bin/openinstinctd`; its control socket is
`~/.openinstinct/run/control.sock` and its primary log is
`~/.openinstinct/logs/daemon.ndjson`.

## Optional iMessage identity (read this before connecting iMessage)

With SIP on, the only send path on macOS 26 is the Messages app of the logged-in
macOS user. The optional iMessage lane therefore uses that user's Messages
account. Never run it against the Messages account you use personally: every reply
it sends lands in your own conversations, threaded onto your own messages. A
Chat-only install can skip this entire section.

The supported shape is one: this Mac's Messages is signed in with a dedicated
Apple ID created for the agent (Messages → Settings → iMessage → sign out → sign
in). The owner's iPhone is unaffected; the owner simply stops using Messages on
this Mac. The menu-bar panel shows the alias it sees and refuses to run while
Messages is signed in as the owner's own Apple ID (`identity_blocked`).

Running the agent under a second macOS user is possible (it needs its own
`~/.openinstinct`, its own TCC grants, and that session logged in at all times)
but is not the documented path: macOS 26 offers no programmatic session switch
and FileVault rules out auto-login, so the shape does not survive a reboot
unattended.

Not viable: a macOS VM (iMessage activation fails on virtual serials), or texting
yourself from the same account (`is_from_me` rows are dropped by design). A fresh
Apple ID needs a trusted phone for verification and can take up to 24 h to
activate iMessage.

Safety nets that hold regardless of account: the first boot against a chat.db
anchors the read cursor at the newest row and replays nothing; empty/tapback rows
never become turns; and after two consecutive turn failures further failure
notices go to `daemon.ndjson` instead of the owner's inbox.

## First installation and permissions

Full Disk Access for `~/.openinstinct/bin/openinstinctd` is the baseline OS
capability for every installation, including Chat-only use. Enable it once in
System Settings → Privacy & Security → Full Disk Access. OpenInstinct checks
actual access and reports missing access without blocking otherwise-ready Chat;
it cannot grant macOS TCC permissions to itself. Optional iMessage setup is a
separate branch. Runtime tools do not require per-action application confirmation.

### End-user installation

1. `curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/openinstinct/main/scripts/install-remote.sh | sh`
   resolves the latest release archive, verifies its `.sha256`, extracts it, and
   runs `scripts/bootstrap-from-payload.sh`. Equivalent by hand: download
   `openinstinct-<version>-darwin-<arch>.tar.gz` from Releases, `tar -xzf` it,
   then `sh <dir>/scripts/bootstrap-from-payload.sh <dir>`.
2. That copies the files and opens the menu-bar panel. Chat is ready as soon as
   an AI account is available; use **Settings → AI account** to sign in with an
   existing subscription, paste a key, or configure a custom endpoint. The
   panel's live setup UI shows the optional iMessage branch separately.
3. To add phone texting, open **Settings → iMessage**, enter an owner handle, and
   follow the identity and permission prompts described above. A Chat-only install
   skips this branch entirely.

The panel shows live status for every step and explains what to do when one is
blocked. There is no installer app; the release archive and curl entry point are
the supported installation path.

### Developer installation path

0. Provider credentials. The core lane starts as soon as an AI account or managed
   API key is available. The daemon runs under launchd with no login shell, so API
   keys exported in `.zshrc` never reach it. Put them in `~/.openinstinct/env` as
   `KEY=value` lines and `chmod 600` it; the daemon loads that file at startup
   (refusing it if group/world readable) and logs `env_file_loaded` with the key
   names only. Which keys are needed follows the `apiKeyEnv` of the provider
   behind `mainSessionModel` in `~/.gjc/agent/models.yml`. Panel **Settings → AI
   account** can do the same.

1. Optional iMessage configuration. No config key is required for the core lane.
   To attach iMessage, write `~/.openinstinct/config.json` with one owner handle;
   phone numbers must include a country code and email handles are normalized to
   lowercase. A missing file is valid and gets product defaults. A malformed
   file or invalid scope gets that scope's defaults and a
   `config_invalid_defaults_applied` log entry, so it does not stop Chat.

   ```json
   {
     "allowlistHandle": "+15550000001",
     "ownerName": "you",
     "mainSessionModel": "anthropic/claude-sonnet-4-5",
     "presence": { "enabled": true, "idleSec": 8 }
   }
   ```

   Every key here is also editable from the panel's Settings window. The
   `allowlistHandle` key is the optional iMessage number, not a prerequisite for
   the Chat window.

2. Install from the repository root:

   ```sh
   bash scripts/install.sh
   ```

   This also builds the menu-bar panel, installs it to
   `~/Applications/OpenInstinctPanel.app`, and registers
   `co.openinstinct.panel` to run at login (it appears in the menu bar).

   This installs a stable Bun daemon executable at
   `~/.openinstinct/bin/openinstinctd` and a private production dependency copy
   at `~/.openinstinct/lib`, then installs
   `~/Library/LaunchAgents/co.openinstinct.daemon.plist`, bootstraps it, and
   kickstarts it. Re-run this command after a daemon update so TCC continues to
   reference the same stable executable path.

3. If you are connecting iMessage, in **System Settings → Privacy & Security →
   Full Disk Access**, press `+` and add `~/.openinstinct/bin/openinstinctd`.
   This lets the optional lane read `chat.db`; Chat does not need it. The lane
   re-probes every 5 seconds, so a daemon restart is not required after changing
   the grant.

4. If you are connecting iMessage, allow **Automation** for
   `openinstinctd` to control Messages when macOS asks (or in **Privacy &
   Security → Automation**). This is the permission that lets the sender text.

5. If you are connecting iMessage and want typing indicators or read receipts,
   grant **Accessibility** to `~/.openinstinct/bin/openinstinctd` (`oi-presence` runs
   as a child of the daemon). Without it, sending still works.

6. Build the menu-bar panel (install.sh does this when `swift` is present):

   ```sh
   bash scripts/build-panel.sh
   ```

   The bundle is `panel/.build/OpenInstinctPanel.app`. It checks the same private
   socket and has Pause/Resume controls; UI automation is deliberately not used
   for acceptance. Open **Chat…** to use the core chat surface even when iMessage
   is detached.

**Uninstall:** From the menu-bar panel choose **Settings… → Uninstall Gajae…**.
For the developer fallback, remove the launch agent, installed executable, and
runtime copy with:

```sh
bash scripts/uninstall.sh
```

This does not delete `~/.openinstinct/state.db`, logs, memory corpus, or the
configuration. Back up state intentionally before deleting it.

## Configuration limits

No configuration key is required for the core lane. `allowlistHandle` is optional
and only enables the iMessage lane. The following limits are read when the core
lane starts; omitted values use product defaults. A missing `config.json` applies
all defaults and logs `config_missing_defaults_applied`. If the file or one of its
scopes is malformed, that scope falls back to defaults and logs
`config_invalid_defaults_applied`; Chat still starts when credentials are ready.

```json
{
  "allowlistHandle": "+15550000001",
  "delivery": {
    "maxAttempts": 3,
    "retryBackoffMs": [5000, 25000, 125000],
    "timeoutMs": 90000
  },
  "children": {
    "maxConcurrent": 4,
    "conversationalTimeoutMs": 1800000,
    "daemonTimeoutMs": 1800000,
    "warmTtlMs": 600000,
    "idleTimeoutMs": 86400000,
    "maxLive": 16,
    "interimBatchMs": 3000,
    "interimRatePerMinute": 6,
    "interimMaxBytes": 1024,
    "statusListLimit": 20,
    "statusTextMaxBytes": 512,
    "toolLatencyGuardMs": 50
  },
  "mainTurnWatchdogMs": 300000
}
```

`retryBackoffMs` is the retry ladder in milliseconds. `maxAttempts` counts the
initial send attempt. The live child cap applies across conversational and
monitor children, with monitor priority retained; `maxLive` must be at least
`maxConcurrent`. All explicit caps and timeouts must be positive safe integers.

| Panel setting | Raw `children.*` key | Default | Valid range |
|---|---|---:|---|
| Keep finished tasks warm | `warmTtlMs` | 600 s | 60 s–24 h |
| Forget idle tasks | `idleTimeoutMs` | 24 h | 300 s–24 h |
| Live background tasks | `maxLive` | 16 | 1–64, at least `maxConcurrent` |
| Bundle task updates | `interimBatchMs` | 3 s | 1–60 s |
| Updates per task per minute | `interimRatePerMinute` | 6 | 1–60 |
| Progress update size | `interimMaxBytes` | 1024 B | 128–8192 B |
| Background task status list limit | `statusListLimit` | 20 | 1–100 |
| Background task status text | `statusTextMaxBytes` | 512 B | 128–8192 B |
| Background task tool latency alert threshold | `toolLatencyGuardMs` | 50 ms | 5–1000 ms |

Every `children.*` limit is restart-scoped. The panel writes milliseconds for
`*Ms` keys and restarts Gajae after saving; direct config edits need a daemon
restart as well.

## Gajae's own Chrome profile

The browser tool never touches the owner's personal Chrome. Every browser
call is pinned (via the runtime prompt) to `app.browser = "chrome"` with
`user_data_dir = ~/.openinstinct/chrome-profile`: a dedicated, persistent
profile that launches with a CDP port (Chrome 136+ only allows that on a
non-default data dir). Press "Open Gajae's browser" in the panel (or
`browser.open` on the socket) to open that profile visibly, sign into the
sites Gajae should use, and close the window — the logins persist across
runs and are isolated from your own sessions, so token-rotating sites (Kakao,
banks) no longer log you out. The prompt also pins one named tab ("main")
for sequential work to keep Chrome's footprint small.

## Presence (typing indicator, read receipts)

`~/.openinstinct/bin/oi-presence` (Swift, technique adapted from
beeper/platform-imessage, MIT) drives the running Messages.app through
Accessibility: `typing <handle> on|off` sets the compose draft, `read <handle>`
opens the thread and presses ⌘⇧U when it is unread. It has to bring Messages forward for ~300 ms, which steals focus, so it only
runs when you have not touched keyboard/mouse for `presence.idleSec` (default
8 s) — i.e. when you are on your phone, not at the Mac. Turn it off entirely
with `"presence": {"enabled": false}` in `config.json`. It needs `openinstinctd`
under Accessibility; without the grant or the binary, presence is a silent
no-op and sending is unaffected. Threaded replies are deliberately not
implemented — that path is the fragile one.

## Persona (the Gajae soul)

`daemon/src/persona/GAJAE_SOUL.md` is appended to the inherited gjc system
prompt for every main and child session. It is read from disk at session
creation, so editing it (bump the `soul-version` comment) and then pressing
"Refresh personality" in the panel — or sending `session.reload` on the
control socket — rebuilds the session over the same transcript without a
restart. The reply carries the live `soulVersion`.

## First-run for someone new to gjc

The release archive needs no prior gjc setup — it carries the `gjc` binary
pinned to the vendored SDK. After install, the panel's Settings → AI
account tab drives `gjc auth-broker login <provider>` (Claude or ChatGPT OAuth,
with a paste-the-code fallback when the browser callback cannot reach the
Mac) or stores an API key in `~/.openinstinct/env`. The first successful
sign-in picks a public default main model for that provider; the model
picker lists everything `gjc --list-models` can reach. Until an account works,
the daemon reports "Gajae has no AI account yet" and the panel offers Settings.

If a prior `gjc` or Codex CLI sign-in is already present, **Settings → AI account**
can call `accounts.discover` and list credentials available to this daemon.
Choose **Adopt** to use one; adoption is an explicit owner action and never
happens automatically because it may start billing an existing subscription.
The equivalent control verbs are `accounts.discover` and `accounts.adopt`.

## Check-in (heartbeat)

On first boot the daemon seeds a `heartbeat` cron monitor (default every 10
minutes; `heartbeatMinutes` in `config.json`, `0` to never seed). Its child
looks only for what is new since the last check-in — timed tasks in today's
notes, due items in `tasks/`, monitors whose last run failed, unread messages
on services signed into Gajae's Chrome — and texts one or two sentences only
when there is something; otherwise it stays silent (`[[no-owner-message]]`).
Toggle or delete it from the panel; a deleted heartbeat is not re-seeded.
Changing the interval takes effect on the next boot.

This is the proactive check-in monitor, not a per-turn typing heartbeat. Typing is
per-turn presence, not a periodic status message.

## Memory capture backfill

`memory.backfillCaptures` replays owner exchanges from the existing session
transcript into the daily capture axis. It preserves each exchange's original
timestamp, skips daemon-injected prompts, caps one pass, and matches existing
entries so re-running it is safe. The daemon parses the transcript; it is never
made available to an agent or child session as a tool-readable file.

## Daily proactive insight

On first boot the daemon seeds a `computer-usage-insight` cron monitor
(09:00 local, daily). A daemon child studies the last week of shell history,
git activity, Downloads/Desktop churn, calendar, and recently used apps and
texts up to three concrete automation proposals before being asked; it never
modifies anything. Disable it from the panel or via `monitors.toggle` if you
do not want it. The first run happens on onboarding day via boot catch-up.

## Monitor outcomes and deletion

Background components submit internal events and triage reports to the shared
internal Chat/MainSession. That path is the only owner-facing author and
communication authority; background workers never send iMessage directly.
A monitor firing never texts the owner directly. Its child's terminal report is
handed to the persistent main session as a triage turn: on failure Gajae
diagnoses it, may repair the monitor itself with `monitor_author` (update or
disable), records what it changed in memory, and then writes one plain-text line
to the owner — or stays silent for a transient, self-healed blip. Raw error
codes and payloads never reach the owner.

Disabled monitors can be deleted from the panel (trash icon) or from chat
("그 모니터 지워줘"). Deletion is revision-fenced and refused while a firing is
in flight (`monitor_busy`); disable it first and retry once it settles.

To run a check immediately without changing its schedule, use the panel's
**Run now** action or the `monitors.run` control verb. It dispatches the same
propagation path with a unique occurrence key, works for disabled and protected
monitors, and leaves the monitor's enabled state and schedule unchanged.

## Pause and resume

Use the menu-bar panel's **Pause** and **Resume** actions. Pause is durable in
`state.db`: owner messages advance the chat cursor without invoking a turn, and
monitor propagation retains work until resume. Resume restarts monitor runtime
refresh and drain work. Confirm either action in the panel status view, where
`session.paused` changes accordingly.

The control protocol verbs are `daemon.pause` and `daemon.resume`; operator
scripts and the panel always negotiate protocol v1 before using them. Do not
edit the `daemon.paused` metadata key directly.

## Bootstrap states and remediation

The core starts when the credentials probe is `passed` or `unknown`; an iMessage
handle is not required. A missing or malformed configuration is handled with
product defaults and does not block Chat.

| Control `bootstrap.state` | Typical reason | Remediation |
| --- | --- | --- |
| `starting` | Startup probes are in progress. | Wait for the next status refresh; inspect `daemon.ndjson` only if it remains here. |
| `credentials_blocked` | No AI account or managed API key is available. | Open **Settings → AI account** and sign in or add a key; the core lane starts after the next credentials refresh. |
| `running` | The core lane is eligible. The optional iMessage lane may be attached or detached independently. | Use the iMessage diagnosis table below for phone delivery; Chat is ready unless the session is paused. |
| `degraded` | A probe or core-lane start threw. | Read `status.get.bootstrap.remediation` and the matching `daemon.ndjson` event, correct the source condition, then wait for the next 5-second retry. |

### iMessage lane diagnosis

`status.get` exposes `imessage.state` and, when detached, `imessage.reason`,
`detail`, and the configured `handle`. Use the reason as the key:

| `status.get.imessage.reason` | Meaning | Operator action |
| --- | --- | --- |
| `no_owner_handle` | No phone/email handle is configured; Chat-only mode. | No action is needed for Chat. To add phone texting, open **Settings → iMessage**, enter the owner handle, and press **Connect**. |
| `fda_denied` | The daemon cannot read `chat.db` with Full Disk Access. | Grant FDA to `~/.openinstinct/bin/openinstinctd` under **Privacy & Security → Full Disk Access**. Wait for the 5-second re-probe; a restart is not required. |
| `fda_probe_error` | The FDA probe returned an error rather than a simple denial. | Read `probes.fda.reason` and `daemon.ndjson`; confirm the installed daemon path and that `~/Library/Messages/chat.db` is readable, then wait for the next probe. |
| `attach_failed` | Lane preflight or construction failed. | Inspect `imessage_lane_attach_failed` for its `message`, fix the reported Messages/Automation or path issue, and wait for the next retry. |
| `core_lane_down` | The shared session is not running, so iMessage cannot attach. | Check `bootstrap.state` and its remediation. Restore AI credentials for `credentials_blocked`, or inspect `core_lane_start_failed` for `degraded`; the controller retries automatically. |
| `starting` | The daemon is converging its lanes. | Wait for the next status refresh. If it persists, inspect `daemon.ndjson` for the boot and probe events. |
| `handle_changed` | The configured handle is being replaced. | Wait for convergence and verify the new handle in Settings. Pending rows for the old handle are expired before the replacement attaches. |
| `shutdown` | The daemon is stopping. | Let the launch agent finish. Start the daemon through the normal launchd/install path; do not attach a lane by hand. |

For detached-turn or proactive-drop evidence, search the primary log for
`delivery_skipped_no_imessage_lane`; those entries include the reason and turn
binding. Handle retirement is recorded as `deliveries_expired_for_handle`.

### Restart and shutdown

Stop, a signal, and `daemon.restart` now route through the same single, fenced
shutdown path: stop lane work, detach iMessage, stop the core, close the control
socket and store, then exit. Do not restart by killing only the watcher,
delivery service, or panel; the lifecycle controller owns the order.

For lifecycle diagnosis, search `daemon.ndjson` for `core_lane_started` and
`core_lane_stopped`, `imessage_lane_attached`, `imessage_lane_detached`, and
`imessage_lane_attach_failed`. Configuration fallback is recorded by
`config_missing_defaults_applied` or `config_invalid_defaults_applied`; session
reloads use `session_reloaded`; dropped owner-bound effects use
`delivery_skipped_no_imessage_lane`; handle retirement uses
`deliveries_expired_for_handle`. These events describe the shared core and the
optional lane without treating a detached iMessage lane as a Chat failure.

## Rollback

After this feature ships, roll the daemon and panel back **together** from the
same release archive. The `BootstrapState` and `status.get` changes are a paired
contract: a mismatched daemon/panel makes Swift decoding fail loudly and the panel
shows the daemon as offline.

A Chat-only install has no `allowlistHandle`. If it is rolled back to a pre-feature
daemon, that daemon expects the old required handle and remains in its previous
configuration-blocked state. The remedy is to write a valid handle into
`~/.openinstinct/config.json`, then restart through launchd; this restores the
pre-feature daemon's required configuration.

## Retention and log rotation

While `bootstrap.state` is `running`, the daemon runs retention once every 24
hours. It deletes settled delivery ledger rows, terminal monitor events, and
delivered child receipts older than seven days. It rotates
`daemon.ndjson` only after it exceeds 32 MiB, preserving `.1` through `.5`.

`maintenance.run` is the manual control verb. It returns `ran`, three prune
counts, and `logRotated`. If the daemon is not running, it returns `ran: false`
and changes nothing. Invoke it through a protocol-v1 control client; do not
manually delete state rows or rotate an active NDJSON file.

## Failure drills

Run the hermetic recovery drills from the repository root:

```sh
bash scripts/drills/failure-drills.sh
```

The script uses a temporary `HOME`, `OI_DRILL_MODE=1`, deterministic fake
adapters, and `OI_DRILL_HOLD` seam markers. It kills and restarts a real
`bun daemon/src/main.ts` process for seven restart cases: mid-turn, mid-child,
post-journal/pre-receipt, mid-closure, mid-propagation, mid-interim-batch, and
paused-state. It then runs one live-only `child-tools-while-held` case without
restarting: the child turn stays held while the main-session status, nudge, and
release tools run and SDK-boundary latency telemetry is checked. These
`OI_DRILL_*` hooks are inert without the environment settings and must never be
put in the launch-agent plist.

## Soak procedure

Start the production daemon, then run:

```sh
bun scripts/soak/soak-monitor.ts --hours 24
```

Use `--pid <daemon-pid>` when `lsof` cannot identify a unique socket owner.
For a short local smoke run, use `--minutes 2`. Samples are appended every 60
seconds to `~/.openinstinct/logs/soak.ndjson`. The final gate table requires:

- RSS below 1.5 GiB;
- RSS growth below 50 MiB/hour;
- file-descriptor delta at most 10;
- `status.get` socket p99 below 250 ms; and
- terminal child completion rate at least 99%.

The final line is `METRIC soak_verdict=pass|fail`.

### Adapter-flip mandate after a soak failure

A failed gate is not waived by restarting and sampling again. Pause new owner
and monitor work, preserve the failing NDJSON/soak evidence and the selected
PID, switch the affected integration to its known-good alternate adapter under
the normal deployment change process, restart, and run a fresh 24-hour soak
from a clean baseline. Record the old adapter, replacement, failure gate, and
new soak metric in the incident record. Resume work only after a passing
verdict. OpenInstinct has no control-socket adapter flip verb; an undocumented
state-db edit is not an adapter flip.

## Live acceptance procedure

After granting TCC and preparing a second iMessage handle, run:

```sh
OI_ACCEPTANCE_SECOND_HANDLE='+15550000002' \
OI_ACCEPTANCE_SEND=1 \
bun scripts/acceptance/run-acceptance.ts
```

The harness prints `AC-1` through `AC-10`, evidence lines, and
`METRIC acceptance_pass=<n>/10`. It never treats absent prerequisites as a
pass. A scenario requiring a grant, a built panel, a second device, an explicit
operator-selected monitor, or a known child id prints `SKIP(reason)` instead.

For AC-7, choose a monitor that may be momentarily toggled and set
`OI_ACCEPTANCE_MONITOR_ID=<id>`; the harness restores its original state. For
AC-8, choose a unique token, set `OI_ACCEPTANCE_INBOUND_TOKEN=<token>`, and
send exactly that token from the second device while the harness waits. For
AC-9, ask the real owner chat to create a delegated background task, then set
`OI_ACCEPTANCE_CHILD_ID=<child-id>` after admission. `--wait-seconds N`,
`--socket PATH`, `--home PATH`, and `--panel-app PATH` make the harness
explicitly target the operator's intended instance.

## Memory quarantine recovery

A quarantined memory intent is retained as durable forensic evidence; do not
delete its state row, capture file, receipt, or Git history to make an audit
look clean. Pause the daemon, preserve `state.db`, `memory-receipts.jsonl`, and
the memory Git history, then fix the underlying storage, registry, or Git
condition identified in `daemon.ndjson`. Submit a corrected new owner capture
or maintenance request after resume; it receives a new idempotency key and
replays normally. Re-run the memory audit (AC-10) before declaring recovery.
The original quarantined row remains intentionally visible for incident review.
