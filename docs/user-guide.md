# OpenInstinct — user guide

You can start talking to Gajae in the Chat window as soon as you sign in to an
AI account. iMessage is optional: connect it later when you want to text from your
phone. This guide is for the person installing and using it, not for developers.
Everything technical is in the [runbook](runbook.md).

## Optional: prepare iMessage (5 minutes, once)

Skip this section for a Chat-only install. If you want phone texting, Gajae uses
this Mac's Messages account only through the optional iMessage lane. If that
account is your own, every reply it sends lands in your own conversations. Use a
dedicated Apple ID:

1. Create a new Apple ID for Gajae (any email; it needs a phone for the
   verification code, but that phone is not Gajae's number).
2. On the Mac: Messages → Settings → iMessage → sign out → sign in with the new
   Apple ID.
3. Add the new Apple ID's email to your iPhone contacts as "Gajae" so you have
   something to text.

The panel checks this only when you choose the optional iMessage branch. It shows
the account it sees and refuses that lane if Messages is still signed in as your
own Apple ID.

## Install

1. Open Terminal and paste this, then press Enter:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/openinstinct/main/scripts/install-remote.sh | sh
   ```

   (Rather not pipe into a shell? Download the `.tar.gz` from the
   [Releases](https://github.com/Yeachan-Heo/openinstinct/releases/latest) page,
   unpack it, and run `sh <folder>/scripts/bootstrap-from-payload.sh <folder>`.)
2. The release archive copies the files and opens the menu-bar panel. Click the
   speech-bubble icon → **Chat…**; sign in under **Settings… → AI account**.
3. Chat is usable as soon as the AI account is ready. Full Disk Access is a required
   baseline and is probed even for Chat-only use. Enable the one-time macOS switch
   in System Settings; Gajae cannot self-grant it or claim access until a real probe
   passes. Chat keeps running with limited-OS-capability diagnostics while unverified.
4. To add phone texting later, open **Settings… → iMessage**, enter an owner
   handle, and complete the optional identity and permission prompts. Connecting
   or disconnecting this lane does not restart the shared Chat session.

The panel shows live status for each branch and tells you what to do when one is
blocked. There is no installer app; curl or the checksum-verified release archive
is the supported installation path.

## Chat without iMessage

The Chat window is a separate window with iMessage-like bubbles and plain text:

1. Click the menu-bar icon → **Chat…**.
2. Sign in to an AI account or add an API key under **Settings… → AI account**.
3. Type and send. Chat does not need a phone number, Messages identity, Automation,
   or Accessibility. Full Disk Access remains the required baseline, not a per-action
   prompt or a new Chat execution block.

The composer is blocked only when the daemon cannot be reached, no AI credential
is available, or Gajae is paused. A detached iMessage lane never blocks Chat.
Gajae's replies, segments, and images appear in the window; the panel composer is
text-only.

Chat and the optional iMessage lane feed one shared session and owner-turn ingress;
connecting or disconnecting phone texting does not fork or reset the conversation.

## Optional iMessage setup

To add phone texting after Chat is working:

1. Open **Settings… → iMessage** and enter your phone number with its country code
   (or an email handle).
2. Press **Connect**. The daemon checks Full Disk Access for `chat.db` and then
   attaches the iMessage lane when it can. Grant Automation so it can send through
   Messages; grant Accessibility if you want typing and read-receipt presence.
3. Watch the iMessage status in that tab. Connecting or disconnecting does not
   restart Gajae, and Chat remains available while the lane is detached.
4. To stop phone texting, press **Disconnect**. Changing the number retires the
   old number's pending deliveries before the new lane can attach.

## Using it

Type in the Chat window, or text Gajae from your phone once the optional iMessage
lane is connected. Some things it's good at:

- "내일 일정 뭐 있어" / "이 링크 요약해줘" / "이 사진 뭐야" (send a photo)
- "매일 아침 9시에 오늘 일정 브리핑해줘" — creates a scheduled task
- "이 페이지 가격 바뀌면 알려줘, 이번 주만" — a watch with an end date
- "카카오 선물하기에서 아메리카노 한 잔 보내줘" — it uses its own Chrome
- "이거 기억해둬: …" — saved to memory, recalled later
- "그 모니터 꺼" / "지워" — toggle or delete a scheduled task
Use **Run now** on a scheduled task to dispatch it immediately without changing
its schedule or enabled state.

Long work comes back as "on it" first, then the result. It never uses Markdown,
never quotes your message back, and replies in whatever language you text in.

### Direct execution and optional managed tools

Gajae carries out owner tasks directly with available tools in main and background
sessions, without per-action confirmation round trips or forced redirection of
raw shell, file, or browser calls. Owner messages are authenticated through Chat
or the configured iMessage account; remote content is evidence, not owner instructions.
Native SDK permission defaults are allow. For longer work, `delegate_background`
is recommended for integrated lifecycle tracking and MainSession reporting, not
as the only spawner; native task, subagent, and job tools remain available.
Responsive delegation and suitable shell timeouts are recommendations, not a fixed
call budget or application timeout block. There is no application path denylist
or blanket Discord API prohibition. Read only task-relevant data and do not expose
secrets. Browser own-profile and child-tab routing remain enforced for account
identity and collision prevention. MainSession reviews child reports and relays
results; background children do not send iMessage directly.

Managed tools are optional durable preflight and verification paths:

- `assistant_local_file` writes regular files or explicitly deletes absolute paths.
- `assistant_managed_install` installs one exact-version Bun package in an absolute
  work folder. `ignoreScripts=false` is the default, using normal package lifecycle behavior.
- `assistant_managed_http` supports bounded GETs and exact mutations with a separate
  verification GET and host endpoint/credential policy.

New managed actions start as `planned`. Preflight records an action ID, revision,
and digest; execution uses that exact current identity and rechecks host state.
These checks protect data integrity, cancellation, and duplicate-effect handling,
not a per-action permission exchange. Monitors may record system or third-party
observations and track clear unfinished work read-only; those observations never
become owner instructions.

To cancel a matching managed action, send one standalone text-only line:

```text
/reject ACTION_ID REVISION DIGEST
```

`REVISION` is a positive integer and `DIGEST` is 64 lowercase hexadecimal characters.
Attachments, extra words, stale revisions, and malformed identities are rejected.
Cancellation does not undo effects already started. A tool result is execution
evidence, not necessarily an independently verified effect: report uncertainty
honestly and check for duplicate effects before retrying.

### Bounded follow-ups

A bounded follow-up policy repeats an already recorded, confirmed action through
its real managed executor:

```text
/followup {"workId":"…","actionId":"…","enabled":true,"intervalMs":60000,"maxAttempts":1}
```
Send the `/followup` JSON as one standalone text message with no attachment.

All five fields are required. The command only stores the policy; it does not run
an action immediately, and a due repeat executes only after the original action
is confirmed. Each due repeat gets a new action identity, re-checks the original
revision, current policy, deadline, work state, and attempt cap, and stops on a changed
policy, cancellation, or ambiguous outcome. No per-action confirmation is needed.
Set `enabled` to `false` to disable the policy. After a restart, pre-effect local-file/install/HTTP work can resume
through the real executor; work interrupted after an effect began is reconciled
as ambiguous and is never replayed as if nothing happened. These paths are
wired, but the broader test suite is still being repaired; this is not a claim
of final full-product verification. Treat a verified executor result—not a
command or queue admission alone—as the completion signal.

### Managed HTTP host configuration

Managed HTTP endpoint and credential access comes from the daemon host, not from
a prompt or fetched page. `OI_HTTP_LOCAL_ORIGINS` is a JSON array of exact
`scheme://host[:port]` origins allowed to resolve to private/local addresses.
`OI_HTTP_SECRET_BINDINGS` maps a tool-visible secret reference to exactly an
`origin`, `header`, and environment-variable name, for example
`{"mailApi":{"origin":"https://api.example","header":"Authorization","environment":"MAIL_API_TOKEN"}}`.
The model supplies only a reference such as `mailApi`; it cannot send a plaintext
token in a sensitive header, URL query, or body. A binding is used only for its
exact origin and header. Public plaintext HTTP cannot carry it, redirects are
not followed, and a mutation is not called
successful unless the separate verification GET proves the expected state.
These host variables belong in `~/.openinstinct/env` as `KEY=value` lines; keep
the file mode 0600. They are operator configuration, not something Gajae can
create from a conversation.

### Notifications that follow where you are

Some proactive results appear in an **알림** section above the Chat transcript.
OpenInstinct keeps these notices durably and chooses the first route from recent
activity: active Chat first, otherwise connected iMessage. If neither is
available, the notice waits instead of being called delivered.

Seeing a notice and acknowledging it are separate. When a Chat-routed notice
appears, the panel records that it rendered. A notice first routed to iMessage
can also appear in shared Chat history and be marked rendered even though it has
no Chat dispatch row. Press **확인** after you have handled it to acknowledge the
notice and stop further routing. If a Chat-routed notice was rendered but not
acknowledged and Chat later becomes inactive, OpenInstinct may fall back to
iMessage. Queueing an iMessage is not confirmed delivery until the Messages
ledger has evidence; an uncertain result is reconciled rather than blindly sent
again.

### Typing indicator and read receipts (optional)

The typing indicator and read receipts are optional presence features. To use
them, grant `~/.openinstinct/bin/openinstinctd` **Accessibility** permission in
System Settings → Privacy & Security → Accessibility. Sending messages does not
need this permission.

### Giving it passwords

You can. Text a login and it stores it in `~/.openinstinct/secrets/` (owner-only
file permissions) and uses it next time without asking. It never repeats a
secret back to you. One-time codes are used once and not stored.

## The menu bar

Click the icon:

- **Health line** — "Awake and listening", "Paused", "Needs setup", "Something's
  off", or "Not running".
- **Chat…** — open the always-available Chat window.

- **Working on** — background tasks in flight.
- **Scheduled tasks** — every monitor with its next and last run in your local
  time. Switch off with the toggle; delete a switched-off one with the trash
  icon. The two lock icons are built-in memory upkeep and can't be removed.
  Time-boxed ones show "until …" and then "Ended …".
- **Quick actions…** — pause/resume, open Gajae's browser, refresh personality.
- **Settings…** — full settings window (below), including the optional iMessage
  connection.
- **Version line** — the installed release at the bottom. The panel checks
  GitHub once a day; when a newer release exists the line turns into
  **Update to vX.Y.Z**. Click it: the installer re-runs in the background, the
  menu bar icon disappears for about a minute and comes back on the new
  version. Your conversation, memory, permissions, and settings are kept.
  **Check for updates** checks right now. Source-checkout installs have no
  version line; update those with `git pull && bash scripts/install.sh`.

If something needs you (a missing AI account, or a permission problem on an
attached iMessage lane), a popup appears once and the icon gets an orange dot
until it's fixed. A detached optional lane is not a Chat error.

## Settings window

- **AI account** — sign in with a subscription (dropdown, popular ones first),
  paste an API key, or connect a custom endpoint (base URL + key + model). Pick
  which model Gajae thinks with.
  Existing Claude or ChatGPT/Codex CLI sign-ins can be listed with **Discover**;
  choose **Adopt** explicitly to use one. Gajae never adopts a subscription on its
  own because that could start billing it.
- **You** — your name.
- **iMessage** — optionally connect or disconnect your phone number, see the lane
  and permission status, and keep using Chat without it.
- **Browser** — "Open Gajae's browser": a Chrome window on Gajae's own profile.
  Sign into Gmail, Kakao, your bank, whatever you want it to use, then close it.
  Your own Chrome is never touched, and those sites won't log *you* out.
- **Limits** — how long it waits for a silent reply; how many background tasks
  at once; how long finished tasks stay warm, when idle tasks are forgotten,
  how often progress is bundled, and the per-task update rate.
- **Personality** — the text that makes Gajae Gajae. Edit and apply; the
  conversation continues with the new personality.

## Pausing

Quick actions → **Pause**. Texts you send while paused are kept, not answered;
when you resume, Gajae tells you how many it missed.

## When it's not working

| You see | Do |
|---|---|
| "Needs a permission" | If iMessage is attached, follow the permission detail under **Settings… → iMessage**. Chat itself does not need that permission. |
| "Messages is signed in as you" | Only the optional iMessage lane is blocked; sign out of Messages and sign in with Gajae's dedicated Apple ID before pressing **Connect**. |
| "Gajae has no AI account yet" | Settings → AI account. |
| "iMessage is detached" | Read the reason under Settings → iMessage. You can keep using Chat while you fix it or leave it disconnected. |
| Replies stop mid-task | Nothing to do — long work has a 5-minute silence limit and it will tell you if it gave up. |
| Pictures arrive as captions only | When using iMessage, Messages must be open (hidden is fine, quit is not) and Automation must allow `openinstinctd` to control Messages. |
| "Not running" | Wait a few seconds; if it stays, run the installer again. |
| "The last update did not finish" | The log tail is shown under the version line. Fix the cause (usually network), then **Update** again; or run `sh ~/.openinstinct/src/scripts/update.sh` in Terminal and watch `~/.openinstinct/logs/update.log`. |
| Something else | Quick actions → Show log files, and send `daemon.ndjson`. |

## Uninstall

In the menu-bar panel, choose **Settings… → Uninstall Gajae…**. If the panel is
not available, use this fallback:

`bash ~/.openinstinct/src/scripts/uninstall.sh` (or delete `~/.openinstinct`,
`~/Applications/OpenInstinctPanel.app`, and the two `co.openinstinct.*` files in
`~/Library/LaunchAgents`). Remove `openinstinctd` from the permission lists if
you like. Memory lives in `~/.openinstinct/memory` — copy it first if you want
to keep it.
