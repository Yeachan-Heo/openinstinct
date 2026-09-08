import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BootstrapProbes, ProbeResult } from "../src/bootstrap/states.ts";
import type { ConfigProbeResult } from "../src/bootstrap/probes.ts";
import type { DeliveryPort, DeliveryReceipt } from "../src/delivery/port.ts";
import { bindChatCursor } from "../src/imessage/reader.ts";
import { startDaemon, type DaemonRuntime } from "../src/main.ts";
import { dataPaths, type DataPaths } from "../src/paths.ts";
import {
  createSendImageTool,
  type MainAgentSession,
  type MainSessionFactory,
  type MainSessionFactoryInput,
  type PromptImage,
} from "../src/sdk-session/main-session.ts";
import { openStateStore, type StateStore } from "../src/store/index.ts";
import { PANEL_SOURCE_MARKER } from "../src/chat/hub.ts";

const OWNER = "+821012345678";
const roots: string[] = [];

class Deferred<T> {
  public readonly promise: Promise<T>;
  private readonly resolvePromise: (value: T) => void;

  public constructor() {
    const deferred = Promise.withResolvers<T>();
    this.promise = deferred.promise;
    this.resolvePromise = deferred.resolve;
  }

  public resolve(value: T): void {
    this.resolvePromise(value);
  }
}

type FakePlan = {
  readonly segments?: readonly string[];
  readonly finalText?: string;
  readonly imageReadPaths?: readonly string[];
};

type FakeSessionOptions = {
  readonly plan?: FakePlan;
  readonly continuationPlan?: FakePlan;
  readonly autoContinue?: boolean;
};

/**
 * Minimal SDK-shaped fake. It keeps user/assistant rows in the same shape used
 * by the history reader and emits the pinned agent/message events consumed by
 * MainSession's segment router.
 */
class FakeMainSession implements MainAgentSession {
  public readonly sessionFile = "/tmp/main-chat.jsonl";
  public readonly sessionId = "main-chat-session";
  public readonly messages: unknown[] = [];
  public readonly promptCalls: string[] = [];
  public readonly steerCalls: string[] = [];
  public readonly listeners = new Set<(event: unknown) => void>();
  public readonly promptStarted = new Deferred<void>();
  public readonly promptEnded = new Deferred<void>();
  public readonly continuationStarted = new Deferred<void>();
  public readonly continuationFirstDelta = new Deferred<void>();
  public promptGate: Deferred<void> | undefined;
  public promptEndGate: Deferred<void> | undefined;
  public continuationOpenGate: Deferred<void> | undefined;
  public waitSecondSteerForFirstDelta = false;
  public readonly timeline: string[] = [];
  public rejectNextSteer = false;
  public live = false;
  public planForPrompt: (text: string, index: number) => FakePlan;
  public continuationPlan: FakePlan;
  public readonly options: FakeSessionOptions;

  private readonly queue: string[] = [];
  private continuationScheduled = false;
  private continuationCount = 0;

  public constructor(options: FakeSessionOptions = {}) {
    this.options = options;
    this.planForPrompt = () => options.plan ?? { finalText: "reply" };
    this.continuationPlan = options.continuationPlan ?? { finalText: "continuation reply" };
  }

  public get continuationOpens(): number {
    return this.continuationCount;
  }

  public async prompt(text: string, _options?: { readonly images?: readonly PromptImage[] }): Promise<void> {
    const index = this.promptCalls.length;
    this.promptCalls.push(text);
    this.live = true;
    this.emit({ type: "agent_start" });
    this.pushUserMessage(text);
    this.promptStarted.resolve();
    if (this.promptGate !== undefined) {
      await this.promptGate.promise;
    }

    const plan = this.planForPrompt(text, index);
    this.consumeQueuedSteers();
    for (const segment of plan.segments ?? []) {
      this.consumeQueuedSteers();
      this.pushAssistantText(segment);
      this.emit({ type: "tool_execution_start", toolName: "bash", args: { command: "true" } });
    }
    for (const path of plan.imageReadPaths ?? []) {
      this.messages.push({ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path } }] });
      this.emit({ type: "tool_execution_start", toolName: "read", args: { path } });
    }
    this.consumeQueuedSteers();
    const finalText = plan.finalText ?? "";
    if (finalText.length > 0) {
      this.pushAssistantFinal(finalText);
    }

    if (this.promptEndGate !== undefined) {
      await this.promptEndGate.promise;
    }
    this.live = false;
    this.emit({ type: "agent_end" });
    this.promptEnded.resolve();
    if (this.queue.length > 0 && (this.options.autoContinue ?? true)) {
      this.scheduleContinuation();
    }
  }

  public async steer(text: string, _images?: PromptImage[]): Promise<void> {
    const steerNumber = this.steerCalls.length + 1;
    this.steerCalls.push(text);
    if (this.rejectNextSteer) {
      this.rejectNextSteer = false;
      throw new Error("steer rejected");
    }
    this.queue.push(text);
    if (!this.live && (this.options.autoContinue ?? true)) {
      this.scheduleContinuation();
    }
    if (this.waitSecondSteerForFirstDelta && steerNumber === 2) {
      await this.continuationFirstDelta.promise;
    }
    // Let concurrently submitted socket requests enqueue before the SDK's
    // scheduled continuation microtask opens. MainSession treats resolution as
    // admission; consumption is still represented by message_start below.
    await Promise.resolve();
    this.timeline.push(`steer:${text}`);
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async dispose(): Promise<void> {}

  public emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private scheduleContinuation(): void {
    if (this.continuationScheduled) {
      return;
    }
    this.continuationScheduled = true;
    queueMicrotask(() => {
      this.continuationScheduled = false;
      if (!this.live && this.queue.length > 0) {
        void this.runContinuation();
      }
    });
  }

  private async runContinuation(): Promise<void> {
    this.live = true;
    this.continuationCount += 1;
    this.emit({ type: "agent_start" });
    this.consumeQueuedSteers();
    this.continuationStarted.resolve();
    if (this.continuationOpenGate !== undefined) {
      await this.continuationOpenGate.promise;
    }

    const plan = this.continuationPlan;
    for (const segment of plan.segments ?? []) {
      this.consumeQueuedSteers();
      this.pushAssistantText(segment);
      this.emit({ type: "tool_execution_start", toolName: "bash", args: { command: "true" } });
      this.continuationFirstDelta.resolve();
    }
    for (const path of plan.imageReadPaths ?? []) {
      this.messages.push({ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path } }] });
      this.emit({ type: "tool_execution_start", toolName: "read", args: { path } });
    }
    this.consumeQueuedSteers();
    const finalText = plan.finalText ?? "";
    if (finalText.length > 0) {
      this.pushAssistantFinal(finalText);
    }
    this.live = false;
    this.emit({ type: "agent_end" });
    if (this.queue.length > 0 && (this.options.autoContinue ?? true)) {
      this.scheduleContinuation();
    }
  }

  private consumeQueuedSteers(): void {
    for (const text of this.queue.splice(0)) {
      this.pushUserMessage(text);
    }
  }

  private pushUserMessage(text: string): void {
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    this.emit({ type: "message_start", message: { role: "user" } });
    this.emit({ type: "message_end", message: { role: "user" } });
  }

  private pushAssistantText(text: string): void {
    this.messages.push({ role: "assistant", content: [{ type: "text", text }] });
    if (this.continuationCount > 0) {
      this.timeline.push(`delta:${text}`);
    }
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  }

  private pushAssistantFinal(text: string): void {
    this.messages.push({ role: "assistant", content: [{ type: "text", text }] });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  }
}

class FakeFactory implements MainSessionFactory {
  public readonly creates: MainSessionFactoryInput[] = [];

  public constructor(private readonly session: FakeMainSession) {}

  public async create(input: MainSessionFactoryInput): Promise<MainAgentSession> {
    this.creates.push(input);
    return this.session;
  }
}

class FakePort implements DeliveryPort {
  public readonly sent: Array<{ readonly handle: string; readonly text: string }> = [];
  public readonly files: Array<{ readonly handle: string; readonly path: string }> = [];
  public readonly reads: string[] = [];
  public readonly typing: Array<{ readonly handle: string; readonly on: boolean }> = [];
  public throwText = false;

  public async sendText(handle: string, text: string): Promise<DeliveryReceipt> {
    if (this.throwText) {
      const error = Object.assign(new Error("Messages sendText failed"), { code: "send_failed", ambiguous: false });
      throw error;
    }
    this.sent.push({ handle, text });
    return { messageId: `text-${this.sent.length}` };
  }

  public async sendReply(_guid: string, text: string): Promise<DeliveryReceipt> {
    return this.sendText(OWNER, text);
  }

  public async sendFile(handle: string, path: string): Promise<DeliveryReceipt> {
    this.files.push({ handle, path });
    return { messageId: `file-${this.files.length}` };
  }

  public async markRead(handle: string): Promise<void> {
    this.reads.push(handle);
  }

  public async setTyping(handle: string, on: boolean): Promise<void> {
    this.typing.push({ handle, on });
  }
}

interface ProbeControl {
  probes: BootstrapProbes;
  config: ConfigProbeResult;
  credentials: ProbeResult;
  fda: ProbeResult;
  accessibility: ProbeResult;
  fdaCalls: number;
}

function controlledProbes(handle?: string): ProbeControl {
  const control: ProbeControl = {
    config: { status: "passed", ...(handle === undefined ? {} : { allowlistHandle: handle }) },
    credentials: { status: "passed" },
    fda: { status: "passed" },
    accessibility: { status: "passed" },
    fdaCalls: 0,
    probes: undefined as never,
  };
  control.probes = {
    config: async () => control.config,
    credentials: async () => control.credentials,
    fda: async () => {
      control.fdaCalls += 1;
      return control.fda;
    },
    accessibility: async () => control.accessibility,
  };
  return control;
}

function pathsFor(root: string): DataPaths {
  const paths = dataPaths(join(root, "home"));
  mkdirSync(paths.root, { recursive: true });
  return paths;
}

function createChatDb(path: string, handle = OWNER): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  try {
    db.exec(`
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
    db.query("INSERT INTO handle (id) VALUES (?)").run(handle);
    db.query("INSERT INTO chat (guid) VALUES (?)").run("chat-1");
  } finally {
    db.close();
  }
}

function insertMessage(path: string, guid: string, text: string, handleId = 1): number {
  const db = new Database(path);
  try {
    db.query("INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES (?, ?, ?, 0, ?)")
      .run(guid, handleId, text, Date.now());
    const row = db.query("SELECT max(ROWID) AS rowid FROM message").get() as { readonly rowid: number };
    db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)").run(row.rowid);
    return row.rowid;
  } finally {
    db.close();
  }
}


function logEntries(paths: DataPaths): Record<string, unknown>[] {
  if (!existsSync(paths.daemonLog)) {
    return [];
  }
  return readFileSync(paths.daemonLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for daemon chat state");
    }
    await Bun.sleep(10);
  }
}

async function waitForStatus(
  runtime: DaemonRuntime,
  predicate: (payload: Record<string, unknown>) => boolean,
  timeoutMs = 4_000,
): Promise<Record<string, unknown>> {
  let payload = await statusPayload(runtime);
  const deadline = Date.now() + timeoutMs;
  while (!predicate(payload)) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for daemon status");
    }
    await Bun.sleep(10);
    payload = await statusPayload(runtime);
  }
  return payload;
}

async function statusPayload(runtime: DaemonRuntime): Promise<Record<string, unknown>> {
  const connection = await connectControl(runtime.paths.controlSocket);
  try {
    return (await request(connection, "status", "status.get", {})).payload as Record<string, unknown>;
  } finally {
    connection.socket.destroy();
  }
}

interface FrameReader {
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
}

interface Connection {
  readonly socket: Socket;
  readonly reader: FrameReader;
  readonly events: Record<string, unknown>[];
}

function makeReader(socket: Socket): FrameReader {
  let buffered = "";
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<{
    readonly resolve: (frame: Record<string, unknown>) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];
  let ended = false;
  let socketError: Error | undefined;

  const settle = (): void => {
    while (frames.length > 0 && waiters.length > 0) {
      const frame = frames.shift();
      const waiter = waiters.shift();
      if (frame === undefined || waiter === undefined) {
        return;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
    if ((ended || socketError !== undefined) && waiters.length > 0) {
      const error = socketError ?? new Error("socket ended");
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (waiter === undefined) {
          break;
        }
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      frames.push(JSON.parse(line) as Record<string, unknown>);
    }
    settle();
  });
  socket.on("end", () => {
    ended = true;
    settle();
  });
  socket.on("error", (error) => {
    socketError = error;
    settle();
  });

  return {
    next(timeoutMs = 2_000): Promise<Record<string, unknown>> {
      const frame = frames.shift();
      if (frame !== undefined) {
        return Promise.resolve(frame);
      }
      if (ended || socketError !== undefined) {
        return Promise.reject(socketError ?? new Error("socket ended"));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error("timed out waiting for frame"));
        }, timeoutMs);
        waiters.push({ resolve, reject, timer });
      });
    },
  };
}

async function connectControl(path: string): Promise<Connection> {
  const socket = createConnection({ path });
  await once(socket, "connect");
  const reader = makeReader(socket);
  socket.write(`${JSON.stringify({ type: "hello", v: 1, client: "main-chat-test" })}\n`);
  expect((await reader.next()).type).toBe("negotiated");
  return { socket, reader, events: [] };
}

function writeRequest(connection: Connection, id: string, verb: string, payload: Record<string, unknown>): void {
  connection.socket.write(`${JSON.stringify({ type: "request", id, verb, payload })}\n`);
}

async function request(
  connection: Connection,
  id: string,
  verb: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  writeRequest(connection, id, verb, payload);
  while (true) {
    const frame = await connection.reader.next();
    if (frame.type === "event") {
      connection.events.push(frame);
      continue;
    }
    if (frame.id === id) {
      return frame;
    }
  }
}

async function waitForEvent(
  connection: Connection,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 4_000,
): Promise<Record<string, unknown>> {
  const existing = connection.events.find(predicate);
  if (existing !== undefined) {
    return existing;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await connection.reader.next(Math.max(1, deadline - Date.now()));
    if (frame.type !== "event") {
      continue;
    }
    connection.events.push(frame);
    if (predicate(frame)) {
      return frame;
    }
  }
  throw new Error("timed out waiting for chat event");
}

async function boot(input: {
  readonly root?: string;

  readonly handle?: string;
  readonly configObject?: Record<string, unknown>;
  readonly chatDb?: boolean;
  readonly session?: FakeMainSession;
  readonly port?: FakePort;
  readonly maxAttempts?: number;
} = {}): Promise<{
  readonly root: string;
  readonly paths: DataPaths;
  readonly chatDbPath: string;
  readonly runtime: DaemonRuntime;
  readonly session: FakeMainSession;
  readonly factory: FakeFactory;
  readonly port: FakePort;
  readonly probes: ProbeControl;
}> {
  const root = input.root ?? mkdtempSync(join(tmpdir(), "openinstinct-main-chat-"));
  if (!roots.includes(root)) {
    roots.push(root);
  }
  const paths = pathsFor(root);
  const handle = input.handle;
  const configObject = input.configObject ?? (handle === undefined ? {} : {
    allowlistHandle: handle,
    ...(input.maxAttempts === undefined ? {} : { delivery: { maxAttempts: input.maxAttempts, retryBackoffMs: [1] } }),
  });
  writeFileSync(paths.config, JSON.stringify(configObject));
  const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
  let initialCursor = 0;
  if (input.chatDb ?? handle !== undefined) {
    createChatDb(chatDbPath, handle ?? OWNER);
    initialCursor = insertMessage(chatDbPath, "chat-db-seed", "seed row");
  }
  const session = input.session ?? new FakeMainSession();
  const factory = new FakeFactory(session);
  const port = input.port ?? new FakePort();
  const probes = controlledProbes(handle);
  if (handle !== undefined && !existsSync(chatDbPath)) {
    createChatDb(chatDbPath, handle);
    initialCursor = insertMessage(chatDbPath, "chat-db-seed", "seed row");
  }
  if (existsSync(chatDbPath)) {
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, initialCursor);
    seeded.close();
  }

  const runtime = await startDaemon({
    paths,
    probes: probes.probes,
    chatDbPath,
    sender: port,
    mainSessionFactory: factory,
    reprobeIntervalMs: 25,
    maintenanceIntervalMs: 60_000,
    turnWatchdogMs: 5_000,
    exit: () => undefined,
  });
  return { root, paths, chatDbPath, runtime, session, factory, port, probes };
}

async function stopHarness(runtime: DaemonRuntime, socket?: Socket): Promise<void> {
  socket?.destroy();
  await runtime.stop();
}

function messages(connection: Connection): Record<string, unknown>[] {
  return connection.events
    .filter((frame) => frame.topic === "chat.message")
    .map((frame) => frame.payload as Record<string, unknown>);
}

function assistants(connection: Connection): Record<string, unknown>[] {
  return messages(connection).filter((message) => message.role === "assistant");
}

function owners(connection: Connection): Record<string, unknown>[] {
  return messages(connection).filter((message) => message.role === "owner");
}

function payloadOf(frame: Record<string, unknown>): Record<string, unknown> {
  return frame.payload as Record<string, unknown>;
}

function eventTurnId(message: Record<string, unknown>): string | undefined {
  return typeof message.turnId === "string" ? message.turnId : undefined;
}

function deliveryRows(runtime: DaemonRuntime): ReturnType<StateStore["listDeliveries"]> {
  return runtime.store.listDeliveries();
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WI-19 attached chat lane", () => {
  test("chat.send echoes the owner, streams segments and mirrors the final reply without iMessage typing", async () => {
    const session = new FakeMainSession({ plan: { finalText: "attached reply" } });
    const harness = await boot({ handle: OWNER, session });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      expect(await request(connection, "subscribe", "chat.subscribe", {})).toMatchObject({
        type: "response",
        payload: { subscribed: true },
      });
      const sent = await request(connection, "send", "chat.send", { text: "panel question" });
      expect(sent).toMatchObject({ type: "response", payload: { outcome: "started" } });
      await waitForEvent(connection, (frame) => frame.topic === "chat.message" && payloadOf(frame).final === true);

      const owner = owners(connection).find((message) => message.text === "panel question");
      const final = assistants(connection).find((message) => message.final === true);
      expect(owner).toMatchObject({ role: "owner", source: "panel", text: "panel question" });
      expect(final).toMatchObject({ role: "assistant", text: "attached reply", final: true });
      expect(harness.port.typing).toEqual([]);
      expect(harness.port.sent).toEqual([{ handle: OWNER, text: "attached reply" }]);
      expect(deliveryRows(harness.runtime)).toEqual([
        expect.objectContaining({ handle: OWNER, kind: "text", body: "attached reply", quotedText: "panel question", state: "confirmed" }),
      ]);
      expect(String(session.promptCalls[0])).toContain(PANEL_SOURCE_MARKER);
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("AC-3 matrix admits two segments and one final for panel and iMessage origins", async () => {
    const session = new FakeMainSession({
      plan: { segments: ["segment one", "segment two"], finalText: "final reply" },
    });
    session.planForPrompt = (_text, index) => index === 0
      ? { segments: ["panel segment one", "panel segment two"], finalText: "panel final reply" }
      : { segments: ["imessage segment one", "imessage segment two"], finalText: "imessage final reply" };
    const harness = await boot({ handle: OWNER, session });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe", "chat.subscribe", {});
      const panel = await request(connection, "panel", "chat.send", { text: "panel matrix" });
      const panelTurnId = String(payloadOf(panel).turnId);
      await waitForEvent(connection, (frame) => payloadOf(frame).turnId === panelTurnId && payloadOf(frame).final === true);
      const panelMessages = assistants(connection).filter((message) => message.turnId === panelTurnId);
      expect(panelMessages).toHaveLength(3);
      expect(panelMessages.filter((message) => message.final === true)).toHaveLength(1);
      expect(deliveryRows(harness.runtime)).toHaveLength(3);

      const rowid = insertMessage(harness.chatDbPath, "imessage-matrix", "imessage matrix");
      await waitForEvent(connection, (frame) => payloadOf(frame).turnId === "imessage-matrix" && payloadOf(frame).final === true);
      expect(harness.runtime.store.getChatCursor()).toBe(rowid);
      const imessageMessages = assistants(connection).filter((message) => message.turnId === "imessage-matrix");
      expect(imessageMessages).toHaveLength(3);
      expect(imessageMessages.filter((message) => message.final === true)).toHaveLength(1);
      expect(deliveryRows(harness.runtime)).toHaveLength(6);
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("merges a panel steer into a busy iMessage turn and records one merged ledger reply", async () => {
    const session = new FakeMainSession({ plan: { finalText: "merged reply" } });
    session.promptGate = new Deferred<void>();
    const harness = await boot({ handle: OWNER, session });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe", "chat.subscribe", {});
      insertMessage(harness.chatDbPath, "busy-imessage", "phone first");
      await waitFor(() => session.promptCalls.length === 1);
      const steer = request(connection, "steer", "chat.send", { text: "panel steer" });
      const response = await steer;
      expect(response).toMatchObject({ type: "response", payload: expect.objectContaining({ outcome: "steered" }) });
      session.promptGate?.resolve();
      await waitForEvent(connection, (frame) => payloadOf(frame).turnId === "busy-imessage" && payloadOf(frame).final === true);
      expect(owners(connection).filter((message) => message.text === "panel steer")).toHaveLength(1);
      expect(harness.runtime.store.listDeliveries().filter((row) => row.idempotencyKey === "inbound-turn:busy-imessage")).toHaveLength(1);
      expect(harness.runtime.store.listDeliveries().find((row) => row.idempotencyKey === "inbound-turn:busy-imessage")).toMatchObject({ quotedText: "phone first", state: "confirmed" });
      expect(logEntries(harness.paths)).toContainEqual(expect.objectContaining({ event: "turn_merged_steers", turnId: "busy-imessage", steered: [expect.any(String)] }));
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("paused chat sends are counted, return suppressed_paused, and notify once on resume", async () => {
    const harness = await boot({ handle: OWNER, session: new FakeMainSession({ plan: { finalText: "One owner message arrived while I was paused; resend it if it still matters." } }) });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe", "chat.subscribe", {});
      expect(await request(connection, "pause", "daemon.pause", {})).toMatchObject({ payload: { paused: true } });
      const suppressed = await request(connection, "send-paused", "chat.send", { text: "paused question" });
      expect(suppressed).toMatchObject({ type: "response", payload: { outcome: "suppressed_paused" } });
      expect(harness.runtime.store.getMeta("daemon.paused.suppressed_count")).toBe("1");
      expect(owners(connection)).toHaveLength(0);
      await request(connection, "resume", "daemon.resume", {});
      await waitFor(() => harness.port.sent.length === 1);
      expect(harness.port.sent).toEqual([{ handle: OWNER, text: expect.stringContaining("One owner message") }]);
      await Bun.sleep(50);
      expect(harness.port.sent).toHaveLength(1);
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("a stopped core lane maps chat.send to internal_error", async () => {
    const harness = await boot({ handle: OWNER, session: new FakeMainSession() });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe", "chat.subscribe", {});
      harness.probes.credentials = { status: "missing", reason: "credentials disappeared" };
      await waitForStatus(harness.runtime, (payload) => payload.bootstrap !== undefined && (payload.bootstrap as Record<string, unknown>).state === "credentials_blocked");
      const response = await request(connection, "stopped", "chat.send", { text: "not running" });
      expect(response).toEqual({
        type: "error",
        id: "stopped",
        ok: false,
        code: "internal_error",
        message: "main session is not running",
      });
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("AC-16 expires a failed mirror row without changing chat events", async () => {
    const session = new FakeMainSession({ plan: { finalText: "visible despite mirror failure" } });
    const port = new FakePort();
    port.throwText = true;
    const harness = await boot({ handle: OWNER, session, port, maxAttempts: 1 });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe", "chat.subscribe", {});
      const response = await request(connection, "failed-mirror", "chat.send", { text: "mirror failure" });
      expect(response).toMatchObject({ type: "response", payload: { outcome: "started" } });
      await waitForEvent(connection, (frame) => frame.topic === "chat.message" && payloadOf(frame).final === true);
      await waitFor(() => deliveryRows(harness.runtime).some((row) => row.state === "expired"));
      expect(owners(connection)).toHaveLength(1);
      expect(assistants(connection)).toHaveLength(1);
      expect(deliveryRows(harness.runtime)).toEqual([
        expect.objectContaining({ state: "expired", body: "visible despite mirror failure" }),
      ]);
      expect(logEntries(harness.paths)).toContainEqual(expect.objectContaining({ event: "expired" }));
      expect(harness.port.sent).toEqual([]);
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("AC-5 forwards image_read events and admits an attached file row; send_image reports its queued contract", async () => {
    const imagePath = "/tmp/chat-read.png";
    const session = new FakeMainSession({ plan: { imageReadPaths: [imagePath], finalText: "image answer" } });
    const harness = await boot({ handle: OWNER, session });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe", "chat.subscribe", {});
      await request(connection, "image", "chat.send", { text: "look at this" });
      await waitForEvent(connection, (frame) => {
        const payload = payloadOf(frame);
        return frame.topic === "chat.message" && payload.image !== undefined;
      });
      const image = messages(connection).find((message) => message.image !== undefined);
      expect(image).toMatchObject({ role: "assistant", image: { path: imagePath, caption: `(looking at ${imagePath.split("/").at(-1)})` } });
      await waitFor(() => harness.port.files.some((file) => file.path === imagePath));
      expect(deliveryRows(harness.runtime)).toContainEqual(expect.objectContaining({ kind: "file", filePath: imagePath, state: "confirmed" }));
      expect(logEntries(harness.paths)).toContainEqual(expect.objectContaining({ event: "image_read_forwarded", path: imagePath, lane: "attached" }));

      const tool = createSendImageTool(() => ({ kind: "queued", deliveryId: "tool-delivery" }));
      const result = await tool.execute("send-image", { filePath: "/tmp/tool.png", caption: "tool image" }, undefined, {} as never);
      expect(result.details).toEqual({ kind: "queued", deliveryId: "tool-delivery" });
      expect(JSON.stringify(result.content)).toContain("Image queued for delivery as tool-delivery");
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("same-tick panel and iMessage admissions preserve per-row source and strip the panel marker from history", async () => {
    const session = new FakeMainSession({ plan: { finalText: "same-tick reply" } });
    const harness = await boot({ handle: OWNER, session });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe", "chat.subscribe", {});
      const panelResponse = request(connection, "panel-pair", "chat.send", { text: "panel pair" });
      insertMessage(harness.chatDbPath, "imessage-pair", "phone pair");
      const panel = await panelResponse;
      expect(panel).toMatchObject({ payload: { outcome: "started" } });
      await waitForEvent(connection, (frame) => frame.topic === "chat.message" && payloadOf(frame).role === "owner" && payloadOf(frame).text === "phone pair");
      await waitFor(() => JSON.stringify(session.messages).includes("phone pair"));
      const history = await request(connection, "history-pair", "chat.history", { limit: 50 });
      const payload = payloadOf(history);
      const historyOwners = (payload.messages as Array<Record<string, unknown>>).filter((message) => message.role === "owner");
      expect(historyOwners).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "panel", text: "panel pair" }),
        expect.objectContaining({ source: "imessage", text: "phone pair" }),
      ]));
      expect(historyOwners).toHaveLength(2);
      expect(JSON.stringify(payload.messages)).not.toContain(PANEL_SOURCE_MARKER);
      const panelLive = owners(connection).filter((message) => message.text === "panel pair");
      expect(panelLive).toHaveLength(1);
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("active Chat routes an internal reply to one durable panel notice without a duplicate live bubble", async () => {
    const session = new FakeMainSession({ plan: { finalText: "attached background reply" } });
    const harness = await boot({ handle: OWNER, session });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe-background", "chat.subscribe", {});
      expect(await request(connection, "active-background", "chat.activity", { frontmost: true, lastInputAgeSeconds: 0 }))
        .toMatchObject({ type: "response", payload: { recorded: true } });

      const response = await request(connection, "notify-background", "session.notify", { text: "background status" });
      expect(response).toMatchObject({
        type: "response",
        payload: { reply: "attached background reply", admitted: true, delivered: false },
      });
      // Admission does not prove either route has reached the owner.
      const notificationId = String(payloadOf(response).notificationId);
      expect(notificationId.length).toBeGreaterThan(0);
      await waitFor(() => harness.runtime.store.assistantWork.getNotificationRoute(notificationId, "chat")?.state === "uncertain");
      expect(harness.runtime.store.assistantWork.getNotificationRoute(notificationId, "imessage")).toBeUndefined();

      expect(harness.port.sent).toEqual([]);
      expect(assistants(connection).filter((message) => message.text === "attached background reply")).toHaveLength(0);
      const listed = payloadOf(await request(connection, "background-list", "assistant.notifications.list", {}));
      expect(listed.notifications).toContainEqual({
        id: notificationId,
        text: "attached background reply",
        acknowledged: false,
      });
      const history = payloadOf(await request(connection, "background-history", "chat.history", { limit: 50 }));
      expect((history.messages as Array<Record<string, unknown>>).filter((message) => message.text === "attached background reply")).toHaveLength(1);

      expect(await request(connection, "background-rendered", "assistant.notifications.rendered", { notificationId }))
        .toMatchObject({ type: "response", payload: { rendered: true } });
      expect(harness.runtime.store.assistantWork.getNotification(notificationId)).toMatchObject({ renderedAt: expect.any(String) });
      expect(harness.runtime.store.assistantWork.getNotificationRoute(notificationId, "chat")).toMatchObject({ state: "delivered" });
      expect(harness.runtime.store.assistantWork.getNotification(notificationId)?.ownerAckAt).toBeUndefined();
      const afterRender = payloadOf(await request(connection, "background-list-rendered", "assistant.notifications.list", {}));
      expect(afterRender.notifications).toContainEqual({
        id: notificationId,
        text: "attached background reply",
        acknowledged: false,
      });

      expect(await request(connection, "background-ack", "assistant.notifications.ack", { notificationId }))
        .toMatchObject({ type: "response", payload: { acknowledged: true } });
      expect(harness.runtime.store.assistantWork.getNotification(notificationId)?.ownerAckAt).toEqual(expect.any(String));
      const afterAck = payloadOf(await request(connection, "background-list-acked", "assistant.notifications.list", {}));
      expect(afterAck.notifications).toContainEqual({
        id: notificationId,
        text: "attached background reply",
        acknowledged: true,
      });
      expect(assistants(connection).filter((message) => message.text === "attached background reply")).toHaveLength(0);
      expect(harness.runtime.store.assistantWork.getNotificationRoute(notificationId, "imessage")).toBeUndefined();
      expect(harness.port.sent).toEqual([]);
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });
});

describe("status.get model surface", () => {
  test("publishes the configured model and fast-mode flags once the core lane is up", async () => {
    const harness = await boot({ configObject: { mainSessionModel: "openai/gpt-5" } });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      const status = payloadOf(await request(connection, "status", "status.get", {}));
      expect(status.session).toMatchObject({
        state: "active",
        mainSessionModel: "openai/gpt-5",
        fastModeAvailable: false,
        fastModeEnabled: false,
      });
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });
});

describe("WI-19 detached chat lane", () => {
  test("boots without an owner handle and serves chat verbs without touching FakePort or TCC probes", async () => {
    const harness = await boot({ configObject: {} });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      const status = payloadOf(await request(connection, "status", "status.get", {}));
      expect(status.imessage).toMatchObject({ state: "detached", reason: "no_owner_handle" });
      expect(harness.probes.fdaCalls).toBe(0);
      await request(connection, "subscribe", "chat.subscribe", {});
      const response = await request(connection, "send", "chat.send", { text: "chat only" });
      expect(response).toMatchObject({ type: "response", payload: { outcome: "started" } });
      await waitForEvent(connection, (frame) => frame.topic === "chat.message" && payloadOf(frame).final === true);
      expect(harness.port.sent).toEqual([]);
      expect(harness.port.files).toEqual([]);
      expect(harness.port.typing).toEqual([]);
      expect(deliveryRows(harness.runtime)).toHaveLength(0);
      const history = payloadOf(await request(connection, "history", "chat.history", { limit: 50 }));
      expect(history.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "owner", source: "panel", text: "chat only" }),
        expect.objectContaining({ role: "assistant", text: "reply" }),
      ]));
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("detached images produce chat_only image events with no ledger row", async () => {
    const imagePath = "/tmp/detached-read.png";
    const harness = await boot({ configObject: {}, session: new FakeMainSession({ plan: { imageReadPaths: [imagePath], finalText: "detached answer" } }) });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe", "chat.subscribe", {});
      await request(connection, "image", "chat.send", { text: "detached image" });
      await waitForEvent(connection, (frame) => frame.topic === "chat.message" && payloadOf(frame).image !== undefined);
      expect(messages(connection).find((message) => message.image !== undefined)).toMatchObject({ image: { path: imagePath } });
      expect(deliveryRows(harness.runtime)).toHaveLength(0);
      expect(logEntries(harness.paths)).toContainEqual(expect.objectContaining({ event: "delivery_skipped_no_imessage_lane", reason: "detached_at_turn_start" }));
      const tool = createSendImageTool(() => ({ kind: "chat_only" }));
      const result = await tool.execute("detached-image", { filePath: imagePath, caption: "detached image" }, undefined, {} as never);
      expect(result.details).toEqual({ kind: "chat_only" });
      expect(JSON.stringify(result.content)).toContain("iMessage is not connected");
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("a detached turn stays chat-only across a mid-turn attach, while the next turn mirrors with quotedText", async () => {
    const firstGate = new Deferred<void>();
    const session = new FakeMainSession({ plan: { finalText: "detached first reply" } });
    session.planForPrompt = (_text, index) => index === 0 ? { finalText: "detached first reply" } : { finalText: "next reply" };
    session.promptGate = firstGate;
    const harness = await boot({ configObject: {}, session });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe", "chat.subscribe", {});
      const first = await request(connection, "first", "chat.send", { text: "detached first" });
      expect(first).toMatchObject({ payload: { outcome: "started" } });
      await waitFor(() => session.promptCalls.length === 1);

      createChatDb(harness.chatDbPath, OWNER);
      harness.probes.config = { status: "passed", allowlistHandle: OWNER };
      harness.probes.fda = { status: "passed" };
      const settings = await request(connection, "attach", "settings.set", { patch: { ownerHandle: OWNER } });
      expect(settings).toMatchObject({ payload: { ok: true } });
      await waitForStatus(harness.runtime, (payload) => (payload.imessage as Record<string, unknown>).state === "attached");
      firstGate.resolve();
      await waitForEvent(connection, (frame) => payloadOf(frame).turnId !== undefined && payloadOf(frame).final === true);
      expect(deliveryRows(harness.runtime)).toHaveLength(0);

      session.promptGate = undefined;
      const next = await request(connection, "next", "chat.send", { text: "attached next" });
      expect(next).toMatchObject({ payload: { outcome: "started" } });
      await waitForEvent(connection, (frame) => payloadOf(frame).final === true && payloadOf(frame).text === "next reply");
      await waitFor(() => harness.port.sent.length === 1);
      expect(harness.port.sent).toEqual([{ handle: OWNER, text: "next reply" }]);
      expect(deliveryRows(harness.runtime)).toContainEqual(expect.objectContaining({ kind: "text", body: "next reply", quotedText: "attached next", state: "confirmed" }));
      const status = payloadOf(await request(connection, "attached-status", "status.get", {}));
      expect(status.imessage).toEqual(expect.objectContaining({ state: "attached", handle: OWNER }));
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("detached internal replies remain durable and panel-readable across daemon restart", async () => {
    const first = await boot({ configObject: {}, session: new FakeMainSession({ plan: { finalText: "detached background reply" } }) });
    let notificationId = "";
    let firstConnection: Connection | undefined;
    try {
      firstConnection = await connectControl(first.paths.controlSocket);
      const response = await request(firstConnection, "detached-notify", "session.notify", { text: "background status" });
      expect(response).toMatchObject({
        type: "response",
        payload: { reply: "detached background reply", admitted: true, delivered: false },
      });
      // Admission is durable even with no live route.
      notificationId = String(payloadOf(response).notificationId);
      expect(notificationId.length).toBeGreaterThan(0);
      const listed = payloadOf(await request(firstConnection, "detached-list", "assistant.notifications.list", {}));
      expect(listed.notifications).toContainEqual({
        id: notificationId,
        text: "detached background reply",
        acknowledged: false,
      });
      expect(first.runtime.store.assistantWork.listNotificationRoutes(notificationId)).toEqual([]);
      expect(first.port.sent).toEqual([]);
      const history = payloadOf(await request(firstConnection, "detached-history", "chat.history", { limit: 50 }));
      expect((history.messages as Array<Record<string, unknown>>).filter((message) => message.text === "detached background reply")).toHaveLength(1);
    } finally {
      await stopHarness(first.runtime, firstConnection?.socket);
    }

    const second = await boot({
      root: first.root,
      configObject: {},
      session: new FakeMainSession({ plan: { finalText: "unused after restart" } }),
    });
    let secondConnection: Connection | undefined;
    try {
      secondConnection = await connectControl(second.paths.controlSocket);
      const listed = payloadOf(await request(secondConnection, "restarted-list", "assistant.notifications.list", {}));
      expect(listed.notifications).toContainEqual({
        id: notificationId,
        text: "detached background reply",
        acknowledged: false,
      });
      const history = payloadOf(await request(secondConnection, "restarted-history", "chat.history", { limit: 50 }));
      expect((history.messages as Array<Record<string, unknown>>).filter((message) => message.text === "detached background reply")).toHaveLength(1);
      expect(second.port.sent).toEqual([]);
    } finally {
      await stopHarness(second.runtime, secondConnection?.socket);
    }
  });

  test("unsafe background replies are never persisted to Chat history", async () => {
    const harness = await boot({ configObject: {}, session: new FakeMainSession({ plan: { finalText: "timeout" } }) });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      const response = await request(connection, "unsafe-notify", "session.notify", { text: "background status" });
      expect(response).toMatchObject({ type: "response", payload: { delivered: false, reply: "timeout" } });
      expect(harness.runtime.store.getMeta("sdk.main_session.owner_replies")).toBeUndefined();
      const history = payloadOf(await request(connection, "unsafe-history", "chat.history", { limit: 50 }));
      expect((history.messages as Array<Record<string, unknown>>).some((message) => message.text === "timeout")).toBe(false);
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });
});

describe("WI-19 chat event ordering", () => {
  test("the owner echo is represented exactly once across live events and history", async () => {
    const session = new FakeMainSession({ plan: { finalText: "echo reply" } });
    const promptGate = new Deferred<void>();
    session.promptGate = promptGate;
    const harness = await boot({ configObject: {}, session });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe", "chat.subscribe", {});
      await request(connection, "send", "chat.send", { text: "echo once" });
      const history = payloadOf(await request(connection, "history", "chat.history", { limit: 50 }));
      const liveOwner = owners(connection).find((message) => message.text === "echo once");
      const tailOwner = (history.tail as Array<{ readonly payload: Record<string, unknown> }>).find((event) => event.payload.role === "owner" && event.payload.text === "echo once");
      expect(liveOwner).toBeDefined();
      expect(tailOwner).toBeDefined();
      expect((history.messages as Array<Record<string, unknown>>).some((message) => message.role === "owner" && message.text === "echo once")).toBe(false);
      expect(new Set([liveOwner?.seq, (tailOwner?.payload as Record<string, unknown> | undefined)?.seq]).size).toBe(1);
      promptGate.resolve();
      await waitForEvent(connection, (frame) => frame.topic === "chat.message" && payloadOf(frame).final === true);
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });

  test("continuation output is attributed to the first steer while the second steer resolves after its first delta", async () => {
    const session = new FakeMainSession({
      plan: { segments: ["initial segment"], finalText: "" },
      continuationPlan: { segments: ["continuation segment"], finalText: "complete continuation" },
    });
    session.waitSecondSteerForFirstDelta = true;
    const promptEndGate = new Deferred<void>();
    session.promptEndGate = promptEndGate;
    const continuationOpenGate = new Deferred<void>();
    session.continuationOpenGate = continuationOpenGate;
    const harness = await boot({ handle: OWNER, session });
    let connection: Connection | undefined;
    try {
      connection = await connectControl(harness.paths.controlSocket);
      await request(connection, "subscribe", "chat.subscribe", {});
      const first = await request(connection, "first", "chat.send", { text: "first steer" });
      expect(first).toMatchObject({ payload: { outcome: "started" } });
      await waitFor(() => session.promptCalls.length === 1);

      const firstSteer = request(connection, "steer-one", "chat.send", { text: "one" });
      const secondSteer = request(connection, "steer-two", "chat.send", { text: "two" });
      await waitFor(() => session.steerCalls.length === 2);
      promptEndGate.resolve();
      await session.promptEnded.promise;
      await session.continuationStarted.promise;
      continuationOpenGate.resolve();
      const responses = await Promise.all([firstSteer, secondSteer]);
      expect(responses).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ outcome: "steered" }) }),
        expect.objectContaining({ payload: expect.objectContaining({ outcome: "steered" }) }),
      ]);
      expect(session.timeline.indexOf("delta:continuation segment")).toBeGreaterThanOrEqual(0);
      expect(session.timeline.indexOf("delta:continuation segment")).toBeLessThan(session.timeline.findIndex((entry) => entry.startsWith("steer:two")));
      await waitForEvent(connection, (frame) => payloadOf(frame).final === true && payloadOf(frame).turnId !== undefined);
      const steerOwnerTexts = owners(connection).filter((message) => message.text === "one" || message.text === "two");
      expect(steerOwnerTexts).toHaveLength(2);
      const firstTurnId = eventTurnId(steerOwnerTexts[0]!);
      expect(firstTurnId).toBeDefined();
      const continuationMessages = assistants(connection).filter((message) => eventTurnId(message) === firstTurnId);
      expect(continuationMessages.filter((message) => message.final === true)).toHaveLength(1);
      expect(continuationMessages.find((message) => message.text === "continuation segment")).toBeDefined();
      expect(continuationMessages.find((message) => message.text === "complete continuation")).toMatchObject({ final: true });
      expect(harness.runtime.store.listDeliveries().filter((row) => row.idempotencyKey === `inbound-turn:${firstTurnId}`)).toHaveLength(1);
      const history = payloadOf(await request(connection, "ordering-history", "chat.history", { limit: 50 }));
      const historyOwnerTexts = (history.messages as Array<Record<string, unknown>>).filter((message) => message.role === "owner").map((message) => message.text);
      const historySteerOwners = (history.messages as Array<Record<string, unknown>>).filter((message) => message.role === "owner" && (message.text === "one" || message.text === "two"));
      expect(historySteerOwners).toHaveLength(2);
      expect(historyOwnerTexts).toEqual(expect.arrayContaining(["first steer", "one", "two"]));
      expect((history.messages as Array<Record<string, unknown>>).filter((message) => message.role === "assistant" && message.text === "complete continuation")).toHaveLength(1);
    } finally {
      await stopHarness(harness.runtime, connection?.socket);
    }
  });
});
