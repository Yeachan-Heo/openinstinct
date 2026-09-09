import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stableNotificationId } from "../../daemon/src/assistant-work/model.ts";
import { setDaemonPaused } from "../../daemon/src/control/pause.ts";
import { bindChatCursor } from "../../daemon/src/imessage/reader.ts";
import { MonitorStore } from "../../daemon/src/monitors/store.ts";
import { dataPaths } from "../../daemon/src/paths.ts";
import { readPersistedOwnerReplies } from "../../daemon/src/sdk-session/main-session.ts";
import { openStateStore } from "../../daemon/src/store/index.ts";

const [action, drill, home, firstLog] = process.argv.slice(2);
if ((action !== "seed" && action !== "assert") || !drill || !home || !home.startsWith("/")) {
  throw new Error("usage: bun scripts/drills/fixture.ts seed|assert <drill> <absolute-home> [first-log]");
}

if (action === "seed") {
  seed(drill, home);
} else {
  try {
    assertRecovery(drill, home, firstLog);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function seed(drill: string, home: string): void {
  const paths = dataPaths(home);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  writeFileSync(paths.config, JSON.stringify({ allowlistHandle: "+15550000001" }));
  const inbound = drill === "mid-turn"
    ? "Hermetic mid-turn drill."
    : drill === "child-tools-while-held"
      ? '[[tool:child_status {}]] [[tool:child_nudge {"childId":"drill-child","op":"nudge","text":"hi"}]] [[tool:child_nudge {"childId":"drill-child","op":"release"}]]'
      : undefined;
  const chatPath = join(home, "Library", "Messages", "chat.db");
  createChatDb(chatPath, inbound);
  const store = openStateStore(paths.stateDb);
  try {
    switch (drill) {
      case "mid-turn":
        // The inbound row is written before boot; bind the cursor below it so
        // the reader replays it instead of anchoring at the present.
        bindChatCursor(store, join(home, "Library", "Messages", "chat.db"), 0);
        break;
      case "paused-state":
        break;
      case "mid-child":
        seedConversationalChild(store);
        seedDaemonChild(store);
        break;
      case "child-tools-while-held":
        seedConversationalChild(store);
        seedDaemonChild(store);
        break;
      case "mid-interim-batch":
        seedInterimMessage(store);
        break;
      case "post-journal-pre-receipt":
        seedJournalChild(store);
        break;
      case "mid-closure":
        store.admitMemoryIntent({
          id: "drill-intent",
          idempotencyKey: "drill-intent",
          kind: "capture",
          payloadJson: JSON.stringify({
            origin: { kind: "owner-chat", reference: "drill" },
            userText: "Hermetic closure drill input.",
            replyText: "Hermetic closure drill reply.",
          }),
        }, "2026-01-01T00:00:00.000Z");
        break;
      case "mid-propagation": {
        const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
        const monitor = monitors.create({
          id: "drill-monitor",
          name: "Hermetic drill monitor",
          trigger: { kind: "webhook", token: "D".repeat(24) },
          instruction: "Return a concise drill update.",
        });
        monitors.admitEvent(monitor, { eventType: "webhook", payload: { drill: true }, occurrenceKey: "drill-propagation" });
        break;
      }
      default:
        throw new Error(`unknown drill: ${drill}`);
    }
    if (inbound !== undefined) {
      bindChatCursor(store, chatPath, 0);
    }
    if (drill === "paused-state") {
      setDaemonPaused(store, true);
    }
  } finally {
    store.close();
  }
}

function assertRecovery(drill: string, home: string, firstLog: string | undefined): void {
  const paths = dataPaths(home);
  if (!existsSync(paths.stateDb)) {
    throw new Error("state.db is missing");
  }
  const store = openStateStore(paths.stateDb);
  try {
    switch (drill) {
      case "mid-turn": {
        const delivery = store.getDeliveryByIdempotencyKey("inbound-turn:drill-inbound-1");
        if (store.getChatCursor() !== 1 || (delivery !== undefined && delivery.state !== "confirmed")) {
          throw new Error(`expected consumed owner turn cursor=1 and no non-confirmed delivery, got cursor=${String(store.getChatCursor())} delivery=${String(delivery?.state)}`);
        }
        break;
      }
      case "mid-child": {
        assertOrphanReceipt(store, "drill-child");
        assertOrphanReceipt(store, "drill-daemon-child");
        const log = readNdjson(paths.daemonLog);
        const ownerTriaged = log.filter((entry) => entry.event === "follow_up_admitted" && entry.childId === "drill-child");
        const daemonTriaged = log.filter((entry) => entry.event === "uncorrelated_receipt_triaged" && entry.childId === "drill-daemon-child");
        if (ownerTriaged.length !== 1 || daemonTriaged.length !== 1) {
          throw new Error(`expected one parent-session triage per orphan, got owner=${ownerTriaged.length} daemon=${daemonTriaged.length}`);
        }
        break;
      }
      case "child-tools-while-held": {
        if (!firstLog) {
          throw new Error("child-tools-while-held assertion needs the first daemon log path");
        }
        assertChildToolsWhileHeld(store, paths.daemonLog, firstLog);
        break;
      }
      case "mid-interim-batch": {
        const batches = store.listInterimBatches();
        if (batches.length !== 1) {
          throw new Error(`expected exactly one interim batch, got ${batches.length}`);
        }
        const batch = batches[0]!;
        if (batch.state !== "delivered" || batch.attempt > 2) {
          throw new Error(`expected delivered interim batch with attempt <= 2, got state=${batch.state} attempt=${batch.attempt}`);
        }
        // Shared internal Chat is authoritative; iMessage attachment is optional.
        // A delivered batch with a single parent-session admission is sufficient.
        const deliveries = store.listDeliveries().filter((delivery) => delivery.idempotencyKey === `interim-batch:${batch.id}`);
        if (deliveries.length > 1 || deliveries.some((delivery) => delivery.state !== "confirmed")) {
          throw new Error(`expected at most one confirmed optional iMessage delivery for ${batch.id}, got count=${deliveries.length}`);
        }
        const replayed = readNdjson(paths.daemonLog)
          .filter((entry) => entry.event === "interim_replayed" && entry.batchId === batch.id);
        if (replayed.length !== 1) {
          throw new Error(`expected one interim replay for ${batch.id}, got ${replayed.length}`);
        }
        break;
      }
      case "post-journal-pre-receipt": {
        const child = store.getChild("drill-child");
        const receipt = store.listReceipts().find((entry) => entry.childId === "drill-child");
        if (child?.state !== "completed" || receipt?.state !== "delivered") {
          throw new Error(`expected journal recovery to complete child and deliver receipt, got child=${String(child?.state)} receipt=${String(receipt?.state)}`);
        }
        break;
      }
      case "mid-closure": {
        const intent = store.getMemoryIntent("drill-intent");
        if (intent?.state !== "receipted" || !existsSync(paths.memoryReceipts)) {
          throw new Error(`expected closure recovery to receipt intent, got ${String(intent?.state)}`);
        }
        break;
      }
      case "mid-propagation": {
        if (!firstLog || !readFileSync(firstLog, "utf8").includes("OI_DRILL_HOLD_REACHED mid-propagation")) {
          throw new Error("expected crash after owner-notification admission at mid-propagation");
        }
        const events = store.listMonitorEvents().filter((entry) => entry.monitorId === "drill-monitor");
        const event = events[0];
        if (events.length !== 1 || event?.stage !== "delivered" || !event.childId) {
          throw new Error(`expected one recovered delivered monitor event, got count=${events.length} stage=${String(event?.stage)}`);
        }
        const intentKey = `monitor-event:${event.id}`;
        const notificationId = stableNotificationId("main-session", intentKey);
        const replies = readPersistedOwnerReplies(store).filter((reply) => reply.idempotencyKey === intentKey);
        const notices = store.assistantWork.listNotifications();
        const notice = notices.find((entry) => entry.id === notificationId);
        if (event.deliveryIntentKey !== intentKey || replies.length !== 1 || replies[0]?.text !== "Hermetic drill reply."
          || notices.length !== 1 || !notice || notice.body !== replies[0]?.text) {
          throw new Error(`expected one durable MainSession reply and stable notification, got replies=${replies.length} notices=${notices.length} notification=${String(notice?.id)}`);
        }
        // No panel activity is seeded: adaptive routing must confirm iMessage,
        // not silently stop at Chat persistence or monitor stage completion.
        const routes = store.assistantWork.getNotificationWithRoutes(notificationId)?.routes ?? [];
        const deliveries = store.listDeliveries();
        const delivery = deliveries.find((entry) => entry.idempotencyKey === `assistant-notification:${notificationId}`);
        if (routes.length !== 1 || routes[0]?.route !== "imessage" || routes[0]?.state !== "delivered"
          || deliveries.length !== 1 || delivery?.state !== "confirmed" || delivery.attempts !== 1
          || delivery.body !== notice.body || routes[0]?.externalId !== delivery.id) {
          throw new Error(`expected exactly one confirmed notification send and reconciled iMessage route, got routes=${JSON.stringify(routes)} deliveries=${JSON.stringify(deliveries)}`);
        }
        const children = store.listChildren();
        const receipts = store.listReceipts();
        if (children.length !== 1 || children[0]?.id !== event.childId || children[0]?.state !== "completed"
          || receipts.length !== 1 || receipts[0]?.childId !== event.childId || receipts[0]?.state !== "delivered") {
          throw new Error(`expected one completed child and consumed receipt without redispatch, got children=${children.length} receipts=${receipts.length}`);
        }
        const delivered = readNdjson(paths.daemonLog)
          .filter((entry) => entry.event === "delivered" && entry.monitorEventId === event.id);
        if (delivered.length !== 1 || delivered[0]?.silent === true) {
          throw new Error(`expected one non-silent propagation settlement after recovery, got ${JSON.stringify(delivered)}`);
        }
        break;
      }
      case "paused-state":
        if (store.getMeta("daemon.paused") !== "true") {
          throw new Error("expected paused state to survive restart");
        }
        break;
      default:
        throw new Error(`unknown drill: ${drill}`);
    }
  } finally {
    store.close();
  }
}

function seedConversationalChild(store: ReturnType<typeof openStateStore>): void {
  const child = store.createChild({
    id: "drill-child",
    kind: "task_tool",
    priority: "conversational",
    origin: "owner",
    title: "Hermetic drill child",
    prompt: "Complete the hermetic drill.",
    timeoutMs: 60_000,
  }, "2026-01-01T00:00:00.000Z");
  store.markChildAdmitted(child.id, "2026-01-01T00:00:00.000Z");
}

function seedDaemonChild(store: ReturnType<typeof openStateStore>): void {
  const child = store.createChild({
    id: "drill-daemon-child",
    kind: "daemon",
    priority: "monitor",
    origin: "monitor",
    title: "Monitor: Hermetic drill monitor",
    prompt: "Complete the hermetic daemon drill.",
    timeoutMs: 60_000,
  }, "2026-01-01T00:00:00.000Z");
  store.markChildAdmitted(child.id, "2026-01-01T00:00:00.000Z");
}

function seedInterimMessage(store: ReturnType<typeof openStateStore>): void {
  const child = store.createChild({
    id: "drill-interim-child",
    kind: "task_tool",
    priority: "conversational",
    origin: "owner",
    title: "Hermetic interim drill child",
    prompt: "unused",
    timeoutMs: 60_000,
  }, "2026-01-01T00:00:00.000Z");
  store.markChildAdmitted(child.id, "2026-01-01T00:00:00.000Z");
  store.markQueuedChildTerminated(child.id, "released", "2026-01-01T00:00:00.000Z");
  store.admitInterimMessage({
    id: "drill-interim-message",
    childId: child.id,
    idempotencyKey: "interim:drill-interim-child:seed",
    body: "Hermetic interim drill update.",
    truncated: false,
  }, "2026-01-01T00:00:00.000Z");
}

function seedJournalChild(store: ReturnType<typeof openStateStore>): void {
  const child = store.createChild({
    id: "drill-child",
    kind: "daemon",
    priority: "monitor",
    origin: "owner",
    title: "Hermetic journal drill child",
    prompt: "Complete the hermetic journal drill.",
    timeoutMs: 60_000,
  }, "2026-01-01T00:00:00.000Z");
  store.markChildAdmitted(child.id, "2026-01-01T00:00:00.000Z");
}

function assertOrphanReceipt(store: ReturnType<typeof openStateStore>, childId: string) {
  const child = store.getChild(childId);
  const receipts = store.listReceipts().filter((receipt) => receipt.childId === childId);
  const receipt = receipts[0];
  if (child?.state !== "orphaned" || child.errorCode !== "orphaned" || receipts.length !== 1 || receipt?.state !== "delivered" || !receipt.projection.includes("(orphaned)")) {
    throw new Error(`expected ${childId} orphaned with one delivered orphan receipt, got state=${String(child?.state)} code=${String(child?.errorCode)} receipts=${receipts.length} receipt=${String(receipt?.state)}`);
  }
  return receipt;
}

function assertChildToolsWhileHeld(store: ReturnType<typeof openStateStore>, daemonLog: string, firstLog: string): void {
  const ownerDelivery = store.getDeliveryByIdempotencyKey("inbound-turn:drill-inbound-1");
  if (ownerDelivery?.state !== "confirmed") {
    throw new Error(`expected owner turn delivery while child was held, got ${String(ownerDelivery?.state)}`);
  }
  const first = readFileSync(firstLog, "utf8");
  const hold = /OI_DRILL_HOLD_REACHED mid-child (\S+)/.exec(first)?.[1];
  const holdMs = hold === undefined ? Number.NaN : Date.parse(hold);
  if (!Number.isFinite(holdMs)) {
    throw new Error("mid-child hold marker has no timestamp");
  }
  const starts = [...first.matchAll(/^OI_DRILL_TOOL_EXECUTION_START (\S+) (\S+) (\S+)$/gm)]
    .map((match) => ({ toolCallId: match[1]!, toolName: match[2]!, at: Date.parse(match[3]!) }));
  if (starts.length !== 3 || starts.some((start) => !Number.isFinite(start.at) || start.at < holdMs)) {
    throw new Error(`expected three tool starts after mid-child hold, got ${JSON.stringify(starts)}`);
  }
  const latency = readNdjson(daemonLog)
    .filter((entry) => entry.event === "tool_latency" && starts.some((start) => start.toolCallId === entry.toolCallId));
  if (latency.length !== 3 || latency.some((entry) => typeof entry.ms !== "number" || entry.ms > 50 || entry.ownerTurnId !== "drill-inbound-1")) {
    throw new Error(`expected three child tool latencies <= 50ms with ownerTurnId, got ${JSON.stringify(latency)}`);
  }
  const ends = [...first.matchAll(/^OI_DRILL_TOOL_EXECUTION_END (\S+) (\S+) (\S+) (.+)$/gm)]
    .map((match) => ({ toolCallId: match[1]!, toolName: match[2]!, at: Date.parse(match[3]!), result: JSON.parse(match[4]!) as Record<string, unknown> }));
  const status = ends.find((end) => end.toolName === "child_status")?.result;
  const nudges = ends.filter((end) => end.toolName === "child_nudge").map((end) => end.result);
  const statusDetails = recordAt(status, "details");
  const statusChildren = Array.isArray(statusDetails.children) ? statusDetails.children : [];
  const runningChild = statusChildren.some((entry) =>
    entry !== null
    && typeof entry === "object"
    && (entry as Record<string, unknown>).childId === "drill-child"
    && (entry as Record<string, unknown>).state === "running",
  );
  if (!runningChild) {
    throw new Error(`expected child_status to observe a running drill-child, got ${JSON.stringify(status)}`);
  }
  if (recordAt(nudges[0], "details").status !== "steered" || recordAt(nudges[1], "details").status !== "cancelling") {
    throw new Error(`expected nudge then immediate cancelling release, got ${JSON.stringify(nudges)}`);
  }
  const release = ends.find((end) => recordAt(end.result, "details").op === "release");
  const receipt = store.listReceipts().find((entry) => entry.childId === "drill-child");
  if (!release || (receipt && Date.parse(receipt.createdAt) <= release.at)) {
    throw new Error("release did not return cancelling before its terminal receipt existed");
  }
}

function readNdjson(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed !== null && !Array.isArray(parsed) && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function recordAt(value: unknown, key: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`drill tool result is not an object: ${JSON.stringify(value)}`);
  }
  const nested = (value as Record<string, unknown>)[key];
  if (nested === null || Array.isArray(nested) || typeof nested !== "object") {
    throw new Error(`drill tool result has no object ${key}: ${JSON.stringify(value)}`);
  }
  return nested as Record<string, unknown>;
}

function createChatDb(path: string, inboundText: string | undefined): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE handle (id TEXT NOT NULL);
      CREATE TABLE message (
        guid TEXT NOT NULL,
        handle_id INTEGER,
        text TEXT,
        attributedBody BLOB,
        is_from_me INTEGER NOT NULL,
        date INTEGER,
        thread_originator_guid TEXT,
        associated_message_guid TEXT
      );
      CREATE TABLE chat (guid TEXT NOT NULL);
      CREATE TABLE chat_message_join (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL);
      CREATE TABLE attachment (filename TEXT, mime_type TEXT, transfer_name TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER NOT NULL, attachment_id INTEGER NOT NULL);
    `);
    database.query("INSERT INTO handle (id) VALUES (?)").run("+15550000001");
    if (inboundText !== undefined) {
      database.query(
        "INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES (?, 1, ?, 0, ?)",
      ).run("drill-inbound-1", inboundText, 1);
    }
  } finally {
    database.close();
  }
}
