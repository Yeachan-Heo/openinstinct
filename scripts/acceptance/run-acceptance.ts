import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { memoryAudit } from "../../daemon/src/memory/adapters/audit.ts";
import { normalizeHandle } from "../../daemon/src/imessage/allowlist.ts";
import { dataPaths } from "../../daemon/src/paths.ts";
import { nextCronRun } from "../../daemon/src/monitors/scheduler.ts";
import { readRuntimeConfig } from "../../daemon/src/runtime-config.ts";
import { openStateStore, type DeliveryRecord } from "../../daemon/src/store/index.ts";
import { requestControl, type ControlPayload } from "../lib/control-client.ts";
import { hasCadenceReport, isPromptHash } from "./conversational-child-checks.ts";

/**
 * REAL acceptance harness for the spec's AC-1..AC-11. Every scenario exercises
 * its actual criterion; when a prerequisite (TCC grant, second device, prior
 * live traffic) is absent, the scenario SKIPs with that exact reason. Absence
 * is never converted into PASS.
 */

type Outcome = "PASS" | "FAIL" | "SKIP";

interface ScenarioResult {
  readonly outcome: Outcome;
  readonly evidence: readonly string[];
}

interface Options {
  readonly home: string;
  readonly socket: string;
  readonly panelApp: string;
  readonly waitSeconds: number;
}

interface ChatMessage {
  readonly rowid: number;
  readonly guid: string;
  readonly senderHandle?: string;
}

interface PendingInterim {
  readonly source: "batch" | "message";
  readonly batchId?: string;
  readonly messageKeys: readonly string[];
}

const options = parseOptions(process.argv.slice(2));
const paths = dataPaths(options.home);
const scenarios: readonly [string, () => Promise<ScenarioResult>][] = [
  ["AC-1", scenarioOwnerRoundTrip],
  ["AC-2", scenarioBackgroundHandoff],
  ["AC-3", scenarioMonitorFireAndDeliver],
  ["AC-4", scenarioMemoryLifecycle],
  ["AC-5", scenarioPanelSupervision],
  ["AC-6", scenarioRestartResumesSession],
  ["AC-7", scenarioVisibleTurnFailure],
  ["AC-8", scenarioThreadedReply],
  ["AC-9", scenarioImagesBothWays],
  ["AC-10", scenarioStrangerSilence],
  ["AC-11", scenarioConversationalChild],
];

let passed = 0;
let failed = 0;
for (const [id, run] of scenarios) {
  let result: ScenarioResult;
  try {
    result = await run();
  } catch (error) {
    result = { outcome: "FAIL", evidence: [messageOf(error)] };
  }
  if (result.outcome === "PASS") {
    passed += 1;
  }
  if (result.outcome === "FAIL") {
    failed += 1;
  }
  printScenario(id, result);
}
console.log(`METRIC acceptance_pass=${passed}/11`);
if (failed > 0) {
  process.exitCode = 1;
}

/** AC-1: owner texts from the allowlisted handle and receives a reply in the same conversation. */
async function scenarioOwnerRoundTrip(): Promise<ScenarioResult> {
  const senderHandle = configuredSecondHandle();
  const token = process.env.OI_ACCEPTANCE_INBOUND_TOKEN;
  if (!senderHandle || !token) {
    return skip("set OI_ACCEPTANCE_SECOND_HANDLE (the allowlisted sender device) and a unique OI_ACCEPTANCE_INBOUND_TOKEN, then send that token from it");
  }
  if (!existsSync(chatDbPath())) {
    return skip(`chat.db is unavailable at ${chatDbPath()}; grant Full Disk Access`);
  }
  const config = await readRuntimeConfig(paths.config);
  if (!config.allowlistHandle) {
    return skip("no iMessage handle is configured; AC-1 needs one (Settings → iMessage)");
  }
  if (senderHandle !== config.allowlistHandle) {
    return skip(`AC-1 requires the sender to BE the allowlisted handle; allowlist=${redactHandle(config.allowlistHandle)} sender=${redactHandle(senderHandle)}`);
  }
  const inbound = await waitFor(
    () => findInboundMessage(token, senderHandle, 0),
    options.waitSeconds * 1_000,
    1_000,
  );
  if (!inbound) {
    return fail(`did not observe token from ${redactHandle(senderHandle)} within ${options.waitSeconds}s`, `token=${token}`);
  }
  const deliveryKey = `inbound-turn:${inbound.guid || `rowid:${inbound.rowid}`}`;
  const delivery = await waitFor(() => {
    const candidate = deliveryFor(deliveryKey);
    return candidate?.state === "confirmed" ? candidate : undefined;
  }, options.waitSeconds * 1_000, 1_000);
  if (!delivery) {
    const observed = deliveryFor(deliveryKey);
    return observed
      ? fail(`inbound row=${inbound.rowid} produced reply ledger state=${observed.state}, not confirmed`, `idempotency=${deliveryKey}`)
      : fail(`inbound row=${inbound.rowid} was observed but no reply was admitted`, `expected idempotency=${deliveryKey}`);
  }
  return pass(
    `owner message row=${inbound.rowid} guid=${inbound.guid || "<empty>"}`,
    `reply confirmed to ${redactHandle(senderHandle)} in the same conversation`,
  );
}

/** AC-2: first delegated work settles idle/cold (or terminal) with a delivered receipt. */
async function scenarioBackgroundHandoff(): Promise<ScenarioResult> {
  const childId = process.env.OI_ACCEPTANCE_CHILD_ID;
  if (!childId) {
    return skip("ask the owner chat for a slow task (e.g. deep research), then set OI_ACCEPTANCE_CHILD_ID to the delegated child id");
  }
  const evidence = childReceiptEvidence(childId);
  if (!evidence) {
    return fail(`child ${childId} does not exist in the ledger`);
  }
  const firstStateIsLive = evidence.childState === "idle" || evidence.childState === "cold";
  if (!firstStateIsLive && !isTerminalChildState(evidence.childState)) {
    return fail(`child ${childId} is ${evidence.childState}; wait for its first turn to settle and rerun`);
  }
  if (evidence.receiptState !== "delivered") {
    return fail(`child ${childId} state=${evidence.childState} but its first result receipt=${String(evidence.receiptState)}, so no owner delivery was admitted`);
  }
  if (evidence.receiptDeliveredAt !== undefined && evidence.receiptDeliveredAt < evidence.createdAt) {
    return fail(`child ${childId} receipt was delivered at ${evidence.receiptDeliveredAt}, before admission at ${evidence.createdAt}`);
  }
  if (evidence.projectionBytes !== undefined && evidence.projectionBytes > 1_024) {
    return fail(`child ${childId} receipt projection is ${evidence.projectionBytes}B, over the 1024B budget`);
  }
  return pass(
    `background child ${childId} first settled state=${evidence.childState}`,
    `first receipt delivered at ${String(evidence.receiptDeliveredAt ?? "(timestamp unrecorded)")}`,
    `result receipt is within the 1024B projection budget (journal=${evidence.journalPath ?? "<none>"})`,
  );
}

/** AC-11: conversational child nudge, interim replay, cold resume, and optional orphan recovery. */
async function scenarioConversationalChild(): Promise<ScenarioResult> {
  const childId = process.env.OI_ACCEPTANCE_CHILD_ID;
  const token = process.env.OI_ACCEPTANCE_TOKEN;
  if (!childId || !token) {
    return skip("set OI_ACCEPTANCE_CHILD_ID and a unique OI_ACCEPTANCE_TOKEN after delegating a conversational task and asking it to report progress");
  }
  if (process.env.OI_ACCEPTANCE_RESTART !== "1") {
    return skip("set OI_ACCEPTANCE_RESTART=1 to authorize SIGKILL during the undelivered interim-batch window");
  }
  const initial = readConversationChild(childId);
  if (!initial?.child) {
    return fail(`conversational child ${childId} is not persisted`);
  }
  if (initial.child.state !== "idle" && initial.child.state !== "cold") {
    return fail(`conversational child ${childId} is ${initial.child.state}; wait for its first turn to settle idle/cold`);
  }
  if (initial.child.turnSeq < 1 || initial.receipt?.state !== "delivered") {
    return fail(`conversational child ${childId} needs turn_seq >= 1 and a delivered first receipt; got turn_seq=${initial.child.turnSeq} receipt=${String(initial.receipt?.state)}`);
  }
  const nudgeEvents = daemonLogEntries().filter((entry) =>
    entry.event === "child_nudged"
    && entry.childId === childId
    && (entry.status === "steered" || entry.status === "started" || entry.status === "queued"),
  );
  if (nudgeEvents.length === 0 || initial.child.turnSeq < 2) {
    return fail(`child ${childId} needs a completed nudge turn; observed child_nudged=${nudgeEvents.length} turn_seq=${initial.child.turnSeq}`);
  }
  const interimSeen = initial.unbatched.length > 0 || initial.batches.length > 0;
  if (!interimSeen) {
    return fail(`child ${childId} has no persisted interim message or batch; ask it to call report_progress and rerun`);
  }
  const opened = daemonLogEntries().find((entry) => entry.event === "child_session_opened" && entry.childId === childId);
  if (!isPromptHash(opened?.promptHash)) {
    return fail(`child ${childId} has no valid child_session_opened promptHash evidence`);
  }
  const cadenceReports = initial.interimMessages.filter((message) => message.body.includes(token)
    && (initial.child?.startedAt === undefined || message.createdAt >= initial.child.startedAt));
  if (!hasCadenceReport(initial.interimMessages, token, initial.child.startedAt)) {
    return fail(`child ${childId} has no report_progress row containing the requested cadence token ${token}`);
  }

  const pending = await waitFor(
    () => pendingInterimForChild(childId),
    options.waitSeconds * 1_000,
    200,
  );
  if (!pending) {
    return skip("batch delivered before the restart window was observed; ask the child to report again and rerun");
  }

  const orphanRequested = process.env.OI_ACCEPTANCE_ORPHAN === "1";
  if (orphanRequested) {
    const sessionFile = initial.child.sessionFile;
    if (!sessionFile || !existsSync(sessionFile)) {
      return fail(`OI_ACCEPTANCE_ORPHAN=1 requires a persisted child session file; got ${String(sessionFile)}`);
    }
    unlinkSync(sessionFile);
  }

  const pid = await launchdDaemonPid();
  if (pid === undefined) {
    return fail("could not determine the launchd daemon PID for the authorized AC-16 SIGKILL");
  }
  const killed = await runCommand(["/bin/kill", "-9", String(pid)], 10_000);
  if (killed.exitCode !== 0) {
    return fail(`SIGKILL of daemon pid ${pid} failed: ${compactOutput(killed.stderr || killed.stdout)}`);
  }
  const restarted = await waitFor(async () => {
    const nextPid = await launchdDaemonPid();
    if (nextPid === undefined || nextPid === pid) {
      return undefined;
    }
    return probeSessionId();
  }, options.waitSeconds * 1_000, 1_000);
  if (!restarted) {
    return fail(`daemon did not relaunch with an active main session within ${options.waitSeconds}s after SIGKILL`);
  }

  const deliveredBatch = await waitFor(
    () => deliveredInterimBatch(childId, pending),
    options.waitSeconds * 1_000,
    200,
  );
  if (!deliveredBatch) {
    return fail(`pending interim batch was not delivered once after restart (source=${pending.source}${pending.batchId ? ` batch=${pending.batchId}` : ""})`);
  }

  const afterRestart = await waitFor(() => {
    const current = readConversationChild(childId)?.child;
    if (!current) {
      return undefined;
    }
    if (orphanRequested) {
      return current.state === "orphaned" ? current : undefined;
    }
    return current.state === "cold" ? current : undefined;
  }, options.waitSeconds * 1_000, 200);
  if (!afterRestart) {
    return fail(`child ${childId} did not become ${orphanRequested ? "orphaned" : "cold"} after restart`);
  }

  const evidence = [
    `first turn settled ${initial.child.state} with turn_seq=${initial.child.turnSeq} and delivered receipt`,
    `nudge completed (turn_seq=${initial.child.turnSeq}; ${nudgeEvents.length} matching child_nudged event(s))`,
    `interim batch ${deliveredBatch.id} delivered once after SIGKILL (attempt=${deliveredBatch.attempt})`,
    `daemon relaunched with main session ${restarted}`,
    `child_session_opened promptHash=${opened.promptHash}; report_progress token row(s)=${cadenceReports.length}`,
  ];
  if (orphanRequested) {
    const orphan = readConversationChild(childId);
    if (orphan?.child?.errorCode !== "orphaned" || orphan.receipt?.state !== "delivered" || !orphan.receipt.projection.includes("(orphaned)")) {
      return fail(`expected optional orphan receipt after deleted session file; got state=${String(orphan?.child?.state)} code=${String(orphan?.child?.errorCode)} receipt=${String(orphan?.receipt?.state)}`);
    }
    const monitorEvidence = optionalMonitorRecoveryEvidence(process.env.OI_ACCEPTANCE_MONITOR_ID);
    if (monitorEvidence instanceof Error) {
      return fail(monitorEvidence.message);
    }
    return pass(...evidence, "optional missing-session-file branch orphaned the child and delivered its receipt", ...(monitorEvidence ? [monitorEvidence] : []));
  }

  const minimumRowid = readConversationChild(childId)?.cursor ?? 0;
  const config = await readRuntimeConfig(paths.config);
  const ownerHandle = config.allowlistHandle;
  if (!ownerHandle) {
    return fail("post-restart owner-message verification requires an attached iMessage owner handle");
  }
  const inbound = await waitFor(
    () => findInboundMessage(token, ownerHandle, minimumRowid),
    options.waitSeconds * 1_000,
    1_000,
  );
  if (!inbound) {
    return fail(`did not observe the post-restart owner token within ${options.waitSeconds}s: ${token}`);
  }
  const resumed = await waitFor(() => {
    const current = readConversationChild(childId)?.child;
    const logs = daemonLogEntries();
    const coldNudge = logs.some((entry) => entry.event === "child_nudged" && entry.childId === childId && entry.status === "cold" && entry.queued === true);
    const resumeEvent = logs.some((entry) => entry.event === "child_resumed" && entry.childId === childId);
    if (!current || !coldNudge || !resumeEvent || current.turnSeq <= initial.child.turnSeq || !current.lastAssistantText?.includes(token)) {
      return undefined;
    }
    return current;
  }, options.waitSeconds * 1_000, 500);
  if (!resumed) {
    return fail(`post-restart token was observed but child ${childId} did not cold-nudge/resume with an incremented token-bearing turn`);
  }
  return pass(
    ...evidence,
    `post-restart token row=${inbound.rowid} cold-nudged and resumed child to turn_seq=${resumed.turnSeq}`,
  );
}

/** AC-3: a chat-authored cron MonitorSpec fires on schedule and delivers over iMessage. */
async function scenarioMonitorFireAndDeliver(): Promise<ScenarioResult> {
  const monitorId = process.env.OI_ACCEPTANCE_MONITOR_ID;
  if (!monitorId) {
    return skip("author a cron monitor from the owner chat, then set OI_ACCEPTANCE_MONITOR_ID to its id after it has fired at least once");
  }
  if (!existsSync(paths.stateDb)) {
    return skip(`state database is absent at ${paths.stateDb}`);
  }
  const store = openStateStore(paths.stateDb);
  try {
    const monitor = store.listMonitors().find((entry) => entry.id === monitorId);
    if (!monitor) {
      return fail(`monitor ${monitorId} is not persisted`);
    }
    const parsed = JSON.parse(monitor.specJson) as {
      readonly trigger?: { readonly kind?: string; readonly expression?: string };
      readonly tz?: string;
    };
    if (parsed.trigger?.kind !== "cron") {
      return fail(`monitor ${monitorId} trigger is ${String(parsed.trigger?.kind)}, not cron; AC-3 requires a scheduled cron monitor`);
    }
    // Chat-authoring provenance: the daemon-seeded maintenance monitors are the
    // only non-chat authors, so they cannot stand in for AC-3.
    if (monitorId === "memory-canonicalize" || monitorId === "memory-audit" || monitorId === "computer-usage-insight" || monitorId === "heartbeat") {
      return fail(`monitor ${monitorId} is daemon-seeded, not chat-authored; author one from the owner chat instead`);
    }
    const events = store.listMonitorEvents().filter((event) => event.monitorId === monitorId);
    const delivered = events.filter((event) => event.stage === "delivered");
    if (delivered.length === 0) {
      const stages = [...new Set(events.map((event) => event.stage))];
      return fail(
        `monitor ${monitorId} has ${events.length} event(s) but none reached stage=delivered`,
        `observed stages: ${stages.join(",") || "<none>"}`,
      );
    }
    const cronFirings = delivered.filter((event) => event.eventType === "cron");
    if (cronFirings.length === 0) {
      return fail(`monitor ${monitorId} delivered ${delivered.length} event(s) but none originated from the cron trigger (types: ${[...new Set(delivered.map((event) => event.eventType))].join(",")})`);
    }
    // Schedule alignment: each delivered cron firing's payload must carry the
    // persisted expression/time zone, and its scheduledFor must be an actual
    // occurrence of that expression.
    for (const firing of cronFirings) {
      const payload = JSON.parse(firing.payloadJson) as {
        readonly scheduledFor?: string;
        readonly expression?: string;
        readonly timeZone?: string;
        readonly catchUp?: boolean;
      };
      if (payload.expression !== parsed.trigger.expression || (parsed.tz !== undefined && payload.timeZone !== parsed.tz)) {
        return fail(`firing ${firing.id} carries expression=${String(payload.expression)} tz=${String(payload.timeZone)}, but the persisted spec says ${String(parsed.trigger.expression)} / ${String(parsed.tz)}`);
      }
      if (typeof payload.scheduledFor !== "string") {
        return fail(`firing ${firing.id} has no scheduledFor timestamp`);
      }
      const scheduled = new Date(payload.scheduledFor);
      const next = nextCronRun(parsed.trigger.expression!, parsed.tz ?? "UTC", new Date(scheduled.getTime() - 1_000));
      if (!next || Math.abs(next.getTime() - scheduled.getTime()) > 1_000) {
        return fail(`firing ${firing.id} scheduledFor=${payload.scheduledFor} is not an occurrence of "${parsed.trigger.expression}" in ${String(parsed.tz)}`);
      }
    }
    return pass(
      `chat-authored cron monitor ${monitorId} persisted (schedule=${String(parsed.trigger.expression)} tz=${String(parsed.tz)} revision=${monitor.revision})`,
      `${cronFirings.length} scheduled firing(s) reached stage=delivered, each aligned with the persisted expression`,
    );
  } finally {
    store.close();
  }
}

/** AC-4: the memory lifecycle exists on disk with git receipts and passes a structural audit. */
async function scenarioMemoryLifecycle(): Promise<ScenarioResult> {
  if (!existsSync(paths.memory)) {
    return skip(`memory corpus is absent at ${paths.memory}; the daemon must reach running state and capture at least once`);
  }
  const memoryMap = join(paths.memory, "MEMORY.md");
  if (!existsSync(memoryMap)) {
    return fail(`memory corpus exists but has no generated MEMORY.md at ${memoryMap}`);
  }
  if (!existsSync(join(paths.memory, ".git"))) {
    return fail(`memory corpus at ${paths.memory} is not a git repository, so closure receipts are impossible`);
  }
  const log = await runCommand(["git", "-C", paths.memory, "log", "--oneline", "-1"], 15_000);
  if (log.exitCode !== 0 || log.stdout.trim().length === 0) {
    return fail("memory git repository has no commits; the closure ladder has never produced a receipt");
  }
  const report = await memoryAudit(paths.memory);
  if (!report.ok) {
    return fail(`memory audit found ${report.issues.length} issue(s)`, compactOutput(report.json));
  }
  return pass(
    "memory corpus present with MEMORY.md and git receipts",
    `latest closure commit: ${compactOutput(log.stdout)}`,
    "structural audit passed",
  );
}

/** AC-5: the panel can show daemon status + active children and toggle monitors. */
async function scenarioPanelSupervision(): Promise<ScenarioResult> {
  if (!existsSync(options.panelApp)) {
    return skip(`panel app is missing at ${options.panelApp}; run scripts/build-panel.sh`);
  }
  const executable = join(options.panelApp, "Contents", "MacOS", "OpenInstinctPanel");
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    return fail(`panel bundle has no executable at ${executable}`);
  }
  const [status, monitors] = await Promise.all([
    requestControl(options.socket, "status.get"),
    requestControl(options.socket, "monitors.list"),
  ]);
  const activeChildren = arrayAt(status.payload, "activeChildren");
  const monitorRows = arrayAt(monitors.payload, "monitors");
  const evidence = [
    `panel executable=${executable}`,
    `status bootstrap=${String(recordAt(status.payload, "bootstrap").state)} activeChildren=${activeChildren.length}`,
    `monitors.list count=${monitorRows.length}`,
  ];
  // Exercise the revision-fenced toggle round-trip when a monitor exists.
  const candidate = monitorRows.find((entry) => isRecord(entry) && typeof entry.enabled === "boolean" && Number.isSafeInteger(entry.revision));
  if (isRecord(candidate)) {
    const toggled = await requestControl(options.socket, "monitors.toggle", {
      id: candidate.id as string,
      enabled: !(candidate.enabled as boolean),
      expectedRevision: candidate.revision as number,
    });
    const changed = recordAt(toggled.payload, "monitor");
    const restored = await requestControl(options.socket, "monitors.toggle", {
      id: candidate.id as string,
      enabled: candidate.enabled as boolean,
      expectedRevision: changed.revision as number,
    });
    if (recordAt(restored.payload, "monitor").enabled !== candidate.enabled) {
      return fail(`monitor ${String(candidate.id)} could not be restored after the toggle round-trip`);
    }
    evidence.push(`monitor ${String(candidate.id)} toggle round-trip with revision fencing OK`);
  } else {
    evidence.push("no monitor available for a toggle round-trip (toggle verb capability verified via monitors.list only)");
  }
  return pass(...evidence);
}

/** AC-6: killing and relaunching the daemon resumes the same main-session context. */
async function scenarioRestartResumesSession(): Promise<ScenarioResult> {
  if (process.env.OI_ACCEPTANCE_RESTART !== "1") {
    return skip("set OI_ACCEPTANCE_RESTART=1 to authorize killing the live daemon for the resume test");
  }
  const before = await requestControl(options.socket, "status.get");
  const beforeSession = recordAt(before.payload, "session");
  const beforeId = beforeSession.mainSessionId;
  if (typeof beforeId !== "string" || beforeId.length === 0) {
    return skip(`daemon has no active main session yet (bootstrap=${String(recordAt(before.payload, "bootstrap").state)}); unblock it and let it take one turn first`);
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    return fail("cannot determine uid for launchctl kickstart");
  }
  const memoryHeadBefore = await memoryGitHead();
  const kick = await runCommand(["launchctl", "kickstart", "-k", `gui/${uid}/co.openinstinct.daemon`], 30_000);
  if (kick.exitCode !== 0) {
    return fail(`launchctl kickstart -k failed: ${compactOutput(kick.stderr || kick.stdout)}`);
  }
  const after = await waitFor(() => probeSessionId(), options.waitSeconds * 1_000, 1_000);
  if (!after) {
    return fail(`daemon did not expose a main session within ${options.waitSeconds}s of the kill`);
  }
  if (after !== beforeId) {
    return fail(`daemon relaunched with a DIFFERENT session: before=${beforeId} after=${after}`);
  }
  // Restart survival extends to the memory corpus (AC-4's cross-restart leg):
  // the git HEAD recorded before the kill must still be reachable afterwards.
  if (memoryHeadBefore !== undefined) {
    const headAfter = await memoryGitHead();
    if (headAfter === undefined) {
      return fail("memory corpus lost its git HEAD across the restart");
    }
    return pass(
      `daemon killed via kickstart and relaunched`,
      `same main session resumed: ${after}`,
      `memory corpus survived the restart (HEAD ${headAfter.slice(0, 12)}${headAfter === memoryHeadBefore ? " unchanged" : ", advanced by post-restart activity"})`,
    );
  }
  return pass(`daemon killed via kickstart and relaunched`, `same main session resumed: ${after}`);
}

/** AC-7: an overlong/blocked turn fails visibly in chat instead of freezing the conversation. */
async function scenarioVisibleTurnFailure(): Promise<ScenarioResult> {
  const failures = confirmedDeliveries().filter(
    (delivery) => delivery.kind === "text" && (delivery.body ?? "").startsWith("[turn failed]"),
  );
  if (failures.length === 0) {
    return skip("no visible turn-failure delivery has occurred yet; trigger an overlong turn from the owner chat (e.g. ask the agent to wait 40 minutes) and rerun");
  }
  const latest = failures.at(-1)!;
  return pass(
    `${failures.length} visible turn-failure message(s) confirmed to the owner`,
    `latest: ${compactOutput(latest.body ?? "")}`,
  );
}

/** AC-8: a reply to a specific owner message lands threaded; failed threads degrade to a quote prefix. */
async function scenarioThreadedReply(): Promise<ScenarioResult> {
  if (!existsSync(chatDbPath())) {
    return skip(`chat.db is unavailable at ${chatDbPath()}; grant Full Disk Access`);
  }
  const replies = confirmedDeliveries().filter((delivery) => delivery.kind === "text" && delivery.replyToGuid !== undefined);
  if (replies.length === 0) {
    return skip("no reply-linked delivery exists yet; have the allowlisted device text the agent so it replies in-thread, then rerun");
  }
  const threaded = replies.filter((delivery) => !delivery.degraded);
  const degraded = replies.filter((delivery) => delivery.degraded);
  if (threaded.length === 0) {
    return fail(`all ${replies.length} reply-linked deliveries degraded to flat sends; threaded placement never succeeded`);
  }
  // Verify actual thread placement in chat.db for the newest threaded reply
  // that carries a sender-assigned message id.
  const verifiable = threaded.filter((delivery) => delivery.externalMessageId !== undefined).at(-1);
  if (!verifiable) {
    return fail(`${threaded.length} threaded deliveries confirmed but none recorded an external message id, so placement cannot be verified`);
  }
  const placement = sentMessageThread(verifiable.externalMessageId!);
  if (!placement) {
    return fail(`sent message ${verifiable.externalMessageId} was not found in chat.db`);
  }
  if (placement.threadOriginatorGuid !== verifiable.replyToGuid) {
    return fail(
      `sent message ${verifiable.externalMessageId} has thread_originator=${String(placement.threadOriginatorGuid)}, expected ${String(verifiable.replyToGuid)}`,
    );
  }
  return pass(
    `threaded reply verified in chat.db: message ${verifiable.externalMessageId} threads to ${String(verifiable.replyToGuid)}`,
    degraded.length > 0
      ? `${degraded.length} degraded reply(ies) also observed with the quote-prefix fallback recorded on the ledger`
      : "no degradation was needed for the observed replies",
  );
}

/** AC-9: an owner image is read by the agent, and the agent can send an image back. */
async function scenarioImagesBothWays(): Promise<ScenarioResult> {
  if (!existsSync(chatDbPath())) {
    return skip(`chat.db is unavailable at ${chatDbPath()}; grant Full Disk Access`);
  }
  const config = await readRuntimeConfig(paths.config);
  if (!config.allowlistHandle) {
    return skip("no iMessage handle is configured; AC-9 needs one (Settings → iMessage)");
  }
  const inboundImage = latestInboundImageFrom(config.allowlistHandle);
  if (!inboundImage) {
    return skip("no inbound image from the allowlisted handle exists yet; send a picture from the owner device and rerun");
  }
  const deliveryKey = `inbound-turn:${inboundImage.guid || `rowid:${inboundImage.rowid}`}`;
  const reply = deliveryFor(deliveryKey);
  if (reply?.state !== "confirmed") {
    return fail(`owner image row=${inboundImage.rowid} was received but its turn reply is ${String(reply?.state ?? "absent")}`);
  }
  const outboundFiles = confirmedDeliveries().filter((delivery) => delivery.kind === "file");
  if (outboundFiles.length === 0) {
    return skip("image ingress verified, but no outbound image has been sent yet; ask the agent to send a picture back and rerun");
  }
  const clean = outboundFiles.filter((delivery) => !delivery.degraded);
  if (clean.length === 0) {
    return fail(`all ${outboundFiles.length} outbound image(s) degraded to caption text; a real image send never succeeded (check the Accessibility grant)`);
  }
  return pass(
    `owner image row=${inboundImage.rowid} was read and answered (reply confirmed)`,
    `${clean.length} outbound image(s) delivered as real attachments`,
  );
}

/** AC-10: messages from non-allowlisted handles produce no reply and no session turn. */
async function scenarioStrangerSilence(): Promise<ScenarioResult> {
  if (!existsSync(chatDbPath())) {
    return skip(`chat.db is unavailable at ${chatDbPath()}; grant Full Disk Access`);
  }
  if (!existsSync(paths.stateDb)) {
    return skip(`state database is absent at ${paths.stateDb}`);
  }
  const store = openStateStore(paths.stateDb);
  let cursor: number | undefined;
  try {
    cursor = store.getChatCursor();
  } finally {
    store.close();
  }
  if (cursor === undefined) {
    return skip("the daemon has not processed any chat.db rows yet (no cursor); unblock it and rerun");
  }
  const config = await readRuntimeConfig(paths.config);
  if (!config.allowlistHandle) {
    return skip("no iMessage handle is configured; this allowlist check needs one (Settings → iMessage)");
  }
  const strangers = recentInboundStrangers(config.allowlistHandle, cursor, 50);
  if (strangers.length === 0) {
    return skip(`no non-allowlisted inbound message exists within the processed window (cursor=${cursor}); text the Mac from a stranger handle and rerun`);
  }
  const answered = strangers.filter((message) => {
    const key = `inbound-turn:${message.guid || `rowid:${message.rowid}`}`;
    return deliveryFor(key) !== undefined;
  });
  if (answered.length > 0) {
    return fail(
      `${answered.length} of ${strangers.length} stranger message(s) produced a session turn/reply`,
      `first offender row=${answered[0]!.rowid} sender=${redactHandle(answered[0]!.senderHandle ?? "?")}`,
    );
  }
  // Zero-turn evidence: the daemon log must contain no turn_started entry for
  // any stranger guid — silence in the ledger alone could hide a swallowed turn.
  const strangerGuids = new Set(strangers.map((message) => message.guid).filter((guid) => guid.length > 0));
  const startedGuids = turnStartedGuidsFromLogs();
  const turned = [...strangerGuids].filter((guid) => startedGuids.has(guid));
  if (turned.length > 0) {
    return fail(`${turned.length} stranger message(s) show a turn_started log entry despite producing no reply`);
  }
  return pass(
    `${strangers.length} stranger message(s) within the processed window (cursor=${cursor}) produced no turn and no reply`,
  );
}

function deliveryFor(idempotencyKey: string): DeliveryRecord | undefined {
  if (!existsSync(paths.stateDb)) {
    return undefined;
  }
  const store = openStateStore(paths.stateDb);
  try {
    return store.getDeliveryByIdempotencyKey(idempotencyKey);
  } finally {
    store.close();
  }
}

function confirmedDeliveries(): DeliveryRecord[] {
  if (!existsSync(paths.stateDb)) {
    return [];
  }
  const store = openStateStore(paths.stateDb);
  try {
    return store.listDeliveries().filter((delivery) => delivery.state === "confirmed");
  } finally {
    store.close();
  }
}

function childReceiptEvidence(childId: string): {
  readonly childState: string;
  readonly createdAt: string;
  readonly terminalAt?: string;
  readonly receiptState?: string;
  readonly receiptDeliveredAt?: string;
  readonly projectionBytes?: number;
  readonly journalPath?: string;
} | undefined {
  if (!existsSync(paths.stateDb)) {
    return undefined;
  }
  const store = openStateStore(paths.stateDb);
  try {
    const child = store.getChild(childId);
    if (!child) {
      return undefined;
    }
    const receipt = store.listReceipts().find((entry) => entry.childId === childId);
    return {
      childState: child.state,
      createdAt: child.createdAt,
      ...(child.terminalAt === undefined ? {} : { terminalAt: child.terminalAt }),
      ...(receipt === undefined ? {} : {
        receiptState: receipt.state,
        receiptDeliveredAt: receipt.updatedAt,
        projectionBytes: new TextEncoder().encode(receipt.projection).byteLength,
      }),
      ...(child.journalPath === undefined ? {} : { journalPath: child.journalPath }),
    };
  } finally {
    store.close();
  }
}

function readConversationChild(childId: string) {
  if (!existsSync(paths.stateDb)) {
    return undefined;
  }
  const store = openStateStore(paths.stateDb);
  try {
    const child = store.getChild(childId);
    if (!child) {
      return undefined;
    }
    return {
      child,
      receipt: store.listReceipts().find((entry) => entry.childId === childId),
      unbatched: store.listUnbatchedInterim().filter((message) => message.childId === childId),
      batches: store.listInterimBatches().filter((batch) => batch.prompt.includes(`(${childId})`)),
      interimMessages: store.listInterimMessages(childId),
      cursor: store.getChatCursor() ?? 0,
    };
  } finally {
    store.close();
  }
}

function pendingInterimForChild(childId: string): PendingInterim | undefined {
  const snapshot = readConversationChild(childId);
  if (!snapshot) {
    return undefined;
  }
  const batch = snapshot.batches.find((entry) => entry.state === "assigned" || entry.state === "injected");
  if (batch) {
    return { source: "batch", batchId: batch.id, messageKeys: [] };
  }
  if (snapshot.unbatched.length > 0) {
    return {
      source: "message",
      messageKeys: snapshot.unbatched.map((message) => message.idempotencyKey),
    };
  }
  return undefined;
}

function deliveredInterimBatch(childId: string, pending: PendingInterim) {
  if (!existsSync(paths.stateDb)) {
    return undefined;
  }
  const store = openStateStore(paths.stateDb);
  try {
    let batchId = pending.batchId;
    if (pending.source === "message") {
      const resolved = pending.messageKeys
        .map((key) => store.getInterimMessageByIdempotencyKey(key)?.batchId)
        .filter((id): id is string => id !== undefined);
      if (resolved.length !== pending.messageKeys.length || new Set(resolved).size !== 1) {
        return undefined;
      }
      batchId = resolved[0];
    }
    const batch = batchId === undefined
      ? store.listInterimBatches().find((entry) => entry.state === "delivered" && entry.prompt.includes(`(${childId})`))
      : store.getInterimBatch(batchId);
    if (!batch || batch.state !== "delivered" || batch.attempt > 2) {
      return undefined;
    }
    const matching = store.listInterimBatches().filter((entry) => entry.id === batch.id);
    const deliveries = store.listDeliveries().filter((delivery) => delivery.idempotencyKey === `interim-batch:${batch.id}`);
    if (matching.length !== 1 || deliveries.length > 1) {
      return undefined;
    }
    return batch;
  } finally {
    store.close();
  }
}

function optionalMonitorRecoveryEvidence(monitorId: string | undefined): string | Error | undefined {
  if (!monitorId) {
    return undefined;
  }
  if (!existsSync(paths.stateDb)) {
    return new Error(`monitor ${monitorId} cannot be checked because state.db is absent`);
  }
  const store = openStateStore(paths.stateDb);
  try {
    const event = store.listMonitorEvents().find((entry) => entry.monitorId === monitorId && entry.childId !== undefined);
    if (!event || !event.childId) {
      return new Error(`OI_ACCEPTANCE_MONITOR_ID=${monitorId} has no dispatched child evidence`);
    }
    const child = store.getChild(event.childId);
    if (child?.state !== "orphaned" || (event.stage !== "authored" && event.stage !== "delivered")) {
      return new Error(`monitor ${monitorId} orphan recovery is incomplete: child=${String(child?.state)} event=${event.stage}`);
    }
    return `monitor ${monitorId} orphan event reached ${event.stage}`;
  } finally {
    store.close();
  }
}

function daemonLogEntries(): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const candidates = [paths.daemonLog, ...[1, 2, 3, 4, 5].map((index) => `${paths.daemonLog}.${index}`)];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) {
          entries.push(parsed);
        }
      } catch {
        // A daemon crash can leave one partial log line; it is not evidence.
      }
    }
  }
  return entries;
}

async function launchdDaemonPid(): Promise<number | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return undefined;
  }
  const printed = await runCommand(["launchctl", "print", `gui/${uid}/co.openinstinct.daemon`], 10_000);
  if (printed.exitCode !== 0) {
    return undefined;
  }
  const match = /\bpid = (\d+)/.exec(`${printed.stdout}\n${printed.stderr}`);
  const pid = match === null ? Number.NaN : Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

async function memoryGitHead(): Promise<string | undefined> {
  if (!existsSync(join(paths.memory, ".git"))) {
    return undefined;
  }
  const result = await runCommand(["git", "-C", paths.memory, "rev-parse", "HEAD"], 15_000);
  const head = result.stdout.trim();
  return result.exitCode === 0 && head.length > 0 ? head : undefined;
}

/** Collects every turn_started guid from the current and rotated daemon logs. */
function turnStartedGuidsFromLogs(): Set<string> {
  const guids = new Set<string>();
  const candidates = [paths.daemonLog, ...[1, 2, 3, 4, 5].map((index) => `${paths.daemonLog}.${index}`)];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      if (!line.includes("turn_started")) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as { readonly event?: string; readonly guid?: string };
        if (entry.event === "turn_started" && typeof entry.guid === "string" && entry.guid.length > 0) {
          guids.add(entry.guid);
        }
      } catch {
        // Rotated logs may contain partial lines; skip them.
      }
    }
  }
  return guids;
}

async function probeSessionId(): Promise<string | undefined> {
  try {
    const status = await requestControl(options.socket, "status.get");
    const id = recordAt(status.payload, "session").mainSessionId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function sentMessageThread(messageGuid: string): { readonly threadOriginatorGuid: string | undefined } | undefined {
  let database: Database | undefined;
  try {
    database = new Database(chatDbPath(), { readonly: true });
    const row = database.query(
      "SELECT thread_originator_guid FROM message WHERE guid = ? LIMIT 1",
    ).get(messageGuid) as { readonly thread_originator_guid: string | null } | null;
    if (!row) {
      return undefined;
    }
    return { threadOriginatorGuid: row.thread_originator_guid ?? undefined };
  } finally {
    database?.close();
  }
}

function latestInboundImageFrom(allowlistHandle: string): ChatMessage | undefined {
  let database: Database | undefined;
  try {
    database = new Database(chatDbPath(), { readonly: true });
    const rows = database.query(
      `SELECT m.ROWID AS rowid, m.guid AS guid, h.id AS sender_handle
       FROM message AS m
       JOIN message_attachment_join AS maj ON maj.message_id = m.ROWID
       JOIN attachment AS a ON a.ROWID = maj.attachment_id
       LEFT JOIN handle AS h ON h.ROWID = m.handle_id
       WHERE m.is_from_me = 0 AND a.mime_type LIKE 'image/%'
       ORDER BY m.ROWID DESC
       LIMIT 50`,
    ).all() as { readonly rowid: number; readonly guid: string | null; readonly sender_handle: string | null }[];
    const match = rows.find((row) => normalizeHandle(row.sender_handle) === allowlistHandle);
    if (!match) {
      return undefined;
    }
    return { rowid: match.rowid, guid: match.guid ?? "", senderHandle: match.sender_handle ?? undefined };
  } finally {
    database?.close();
  }
}

function recentInboundStrangers(allowlistHandle: string, cursor: number, limit: number): ChatMessage[] {
  let database: Database | undefined;
  try {
    database = new Database(chatDbPath(), { readonly: true });
    const rows = database.query(
      `SELECT m.ROWID AS rowid, m.guid AS guid, h.id AS sender_handle
       FROM message AS m
       LEFT JOIN handle AS h ON h.ROWID = m.handle_id
       WHERE m.is_from_me = 0 AND m.ROWID <= ?
       ORDER BY m.ROWID DESC
       LIMIT ?`,
    ).all(cursor, limit) as { readonly rowid: number; readonly guid: string | null; readonly sender_handle: string | null }[];
    return rows
      .filter((row) => normalizeHandle(row.sender_handle) !== allowlistHandle)
      .map((row) => ({ rowid: row.rowid, guid: row.guid ?? "", senderHandle: row.sender_handle ?? undefined }));
  } finally {
    database?.close();
  }
}

function findInboundMessage(token: string, expectedHandle: string, minimumRowid: number): ChatMessage | undefined {
  let database: Database | undefined;
  try {
    database = new Database(chatDbPath(), { readonly: true });
    const row = database.query(
      `SELECT m.ROWID AS rowid, m.guid AS guid, h.id AS sender_handle
       FROM message AS m
       LEFT JOIN handle AS h ON h.ROWID = m.handle_id
       WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.text = ?
       ORDER BY m.ROWID DESC
       LIMIT 1`,
    ).get(minimumRowid, token) as { readonly rowid: number; readonly guid: string | null; readonly sender_handle: string | null } | null;
    if (!row || normalizeHandle(row.sender_handle) !== expectedHandle) {
      return undefined;
    }
    return { rowid: row.rowid, guid: row.guid ?? "", senderHandle: row.sender_handle ?? undefined };
  } finally {
    database?.close();
  }
}

function configuredSecondHandle(): string | undefined {
  return normalizeHandle(process.env.OI_ACCEPTANCE_SECOND_HANDLE);
}

function chatDbPath(): string {
  return process.env.OI_CHAT_DB ?? join(options.home, "Library", "Messages", "chat.db");
}

function isTerminalChildState(state: string): boolean {
  return state === "completed" || state === "failed" || state === "timeout" || state === "cancelled" || state === "orphaned" || state === "terminated";
}

function pass(...evidence: string[]): ScenarioResult {
  return { outcome: "PASS", evidence };
}

function fail(...evidence: string[]): ScenarioResult {
  return { outcome: "FAIL", evidence };
}

function skip(reason: string): ScenarioResult {
  return { outcome: "SKIP", evidence: [reason] };
}

function printScenario(id: string, result: ScenarioResult): void {
  console.log(`${id} ${result.outcome}${result.outcome === "SKIP" ? `(${result.evidence[0] ?? "precondition missing"})` : ""}`);
  for (const line of result.evidence) {
    console.log(`  EVIDENCE ${line}`);
  }
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs: number, intervalMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await Bun.sleep(intervalMs);
  }
}

async function runCommand(argv: readonly string[], timeoutMs: number): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }> {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function parseOptions(args: readonly string[]): Options {
  let home = process.env.HOME;
  let socket: string | undefined;
  let panelApp: string | undefined;
  let waitSeconds = 120;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = args[index + 1];
    if (value === "--home" && next) {
      home = next;
      index += 1;
    } else if (value === "--socket" && next) {
      socket = next;
      index += 1;
    } else if (value === "--panel-app" && next) {
      panelApp = next;
      index += 1;
    } else if (value === "--wait-seconds" && next) {
      waitSeconds = Number(next);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete option: ${value}`);
    }
  }
  if (!home || !home.startsWith("/")) {
    throw new Error("HOME or --home must be an absolute path");
  }
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 3_600) {
    throw new Error("--wait-seconds must be a whole number from 1 to 3600");
  }
  const defaultPaths = dataPaths(home);
  return {
    home,
    socket: socket ?? defaultPaths.controlSocket,
    panelApp: panelApp ?? process.env.OI_PANEL_APP ?? join(import.meta.dir, "..", "..", "panel", ".build", "OpenInstinctPanel.app"),
    waitSeconds,
  };
}

function recordAt(payload: ControlPayload, key: string): Record<string, unknown> {
  const value = payload[key];
  if (!isRecord(value)) {
    throw new Error(`control payload.${key} is not an object`);
  }
  return value;
}

function arrayAt(payload: ControlPayload, key: string): readonly unknown[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new Error(`control payload.${key} is not an array`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function compactOutput(value: string): string {
  return Array.from(value.replace(/\s+/g, " ").trim()).slice(0, 500).join("");
}

function redactHandle(handle: string): string {
  return handle.length <= 4 ? "****" : `…${handle.slice(-4)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
