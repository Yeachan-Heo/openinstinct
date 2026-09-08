import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BootstrapProbes, ProbeResult } from "../src/bootstrap/states.ts";
import type { ConfigProbeResult } from "../src/bootstrap/probes.ts";
import type { ChildRunner } from "../src/children/runner.ts";
import type { DeliveryPort, DeliveryReceipt } from "../src/delivery/port.ts";
import { recordSuppressedWhilePaused, setDaemonPaused } from "../src/control/pause.ts";
import { bindChatCursor } from "../src/imessage/reader.ts";
import { startDaemon, type DaemonRuntime } from "../src/main.ts";
import { dataPaths, type DataPaths } from "../src/paths.ts";
import type { MainAgentSession, MainSessionFactory, MainSessionFactoryInput } from "../src/sdk-session/main-session.ts";
import { openStateStore } from "../src/store/index.ts";
import { requestControl } from "../../scripts/lib/control-client.ts";

const roots: string[] = [];

class FakeSession implements MainAgentSession {
  public readonly prompts: string[] = [];
  public messages: unknown[] = [];
  public readonly listeners = new Set<(event: unknown) => void>();
  public promptStarted: (() => void) | undefined;
  public promptRelease: (() => void) | undefined;
  public disposeStarted: (() => void) | undefined;
  public disposeGate: Promise<void> | undefined;
  public disposeError: Error | undefined;
  public disposed = false;

  public constructor(public readonly sessionFile: string, public readonly sessionId = "lanes-session") {}

  public async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.promptStarted?.();
    if (this.promptRelease) {
      await new Promise<void>((resolve) => {
        const release = this.promptRelease;
        this.promptRelease = () => {
          release?.();
          resolve();
        };
      });
    }
    for (const listener of this.listeners) {
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lane reply" } });
    }
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async dispose(): Promise<void> {
    this.disposeStarted?.();
    this.disposed = true;
    await this.disposeGate;
    if (this.disposeError !== undefined) {
      throw this.disposeError;
    }
  }
}

class FakeFactory implements MainSessionFactory {
  public readonly sessions: FakeSession[] = [];

  public constructor(private readonly root: string) {}

  public async create(input: MainSessionFactoryInput): Promise<MainAgentSession> {
    const session = new FakeSession(input.sessionFile ?? join(this.root, "main.jsonl"));
    this.sessions.push(session);
    return session;
  }
}

class FakePort implements DeliveryPort {
  public readonly sent: { readonly handle: string; readonly text: string }[] = [];
  public readonly reads: string[] = [];
  public readonly typing: { readonly handle: string; readonly on: boolean }[] = [];
  public sendTextStarted: (() => void) | undefined;
  public sendTextGate: Promise<void> | undefined;

  public async sendText(handle: string, text: string): Promise<DeliveryReceipt> {
    this.sent.push({ handle, text });
    this.sendTextStarted?.();
    if (this.sendTextGate !== undefined) {
      await this.sendTextGate;
    }
    return { messageId: `text-${this.sent.length}` };
  }

  public async sendReply(handle: string, text: string): Promise<DeliveryReceipt> {
    this.sent.push({ handle, text });
    return { messageId: `reply-${this.sent.length}`, threadId: "thread" };
  }

  public async sendFile(handle: string): Promise<DeliveryReceipt> {
    this.sent.push({ handle, text: "<file>" });
    return { messageId: `file-${this.sent.length}` };
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
}

function controlledProbes(handle?: string): ProbeControl {
  const control: ProbeControl = {
    config: { status: "passed", ...(handle === undefined ? {} : { allowlistHandle: handle }) },
    credentials: { status: "passed" },
    fda: { status: "passed" },
    accessibility: { status: "passed" },
    probes: undefined as never,
  };
  control.probes = {
    config: async () => control.config,
    credentials: async () => control.credentials,
    fda: async () => control.fda,
    accessibility: async () => control.accessibility,
  };
  return control;
}

function createChatDb(path: string, handle = "+821012345678"): void {
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

function insertMessage(path: string, guid: string, text: string, handleId = 1): void {
  const db = new Database(path);
  try {
    db.query("INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES (?, ?, ?, 0, ?)")
      .run(guid, handleId, text, Date.now());
    const row = db.query("SELECT max(ROWID) AS rowid FROM message").get() as { readonly rowid: number };
    db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)").run(row.rowid);
  } finally {
    db.close();
  }
}

function insertHandle(path: string, handle: string): void {
  const db = new Database(path);
  try {
    db.query("INSERT INTO handle (id) VALUES (?)").run(handle);
  } finally {
    db.close();
  }
}

function pathsFor(root: string): DataPaths {
  const paths = dataPaths(join(root, "home"));
  mkdirSync(paths.root, { recursive: true });
  return paths;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for lane state");
    }
    await Bun.sleep(10);
  }
}

async function statusPayload(runtime: DaemonRuntime): Promise<Record<string, unknown>> {
  return (await requestControl(runtime.paths.controlSocket, "status.get")).payload;
}

async function waitForStatus(
  runtime: DaemonRuntime,
  predicate: (status: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let status = await statusPayload(runtime);
  while (!predicate(status)) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for status");
    }
    await Bun.sleep(10);
    status = await statusPayload(runtime);
  }
  return status;
}

function logEntries(paths: DataPaths): Record<string, unknown>[] {
  if (!existsSync(paths.daemonLog)) {
    return [];
  }
  return readFileSync(paths.daemonLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function startHarness(input: {
  readonly paths: DataPaths;
  readonly probes: ProbeControl;
  readonly factory?: FakeFactory;
  readonly port?: FakePort;
  readonly chatDbPath?: string;
  readonly exit?: (code: number) => void;
  readonly childRunner?: ChildRunner;
}): Promise<DaemonRuntime> {
  return startDaemon({
    paths: input.paths,
    probes: input.probes.probes,
    ...(input.factory === undefined ? {} : { mainSessionFactory: input.factory }),
    ...(input.port === undefined ? {} : { sender: input.port }),
    ...(input.childRunner === undefined ? {} : { childRunner: input.childRunner }),
    ...(input.chatDbPath === undefined ? {} : { chatDbPath: input.chatDbPath }),
    reprobeIntervalMs: 25,
    maintenanceIntervalMs: 60_000,
    exit: input.exit ?? (() => undefined),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("main lane lifecycle", () => {
  test("boots the core lane without config or iMessage", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-no-handle-"));
    roots.push(root);
    const paths = pathsFor(root);
    const probes = controlledProbes();
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes, factory });
    try {
      expect(runtime.status().state).toBe("running");
      expect(factory.sessions).toHaveLength(1);
      const status = await statusPayload(runtime);
      expect(status.imessage).toMatchObject({ state: "detached", reason: "no_owner_handle" });
      expect((status.session as Record<string, unknown>).state).toBe("active");
      const entries = logEntries(paths);
      expect(entries.filter((entry) => entry.event === "core_lane_started")).toHaveLength(1);
      expect(entries.filter((entry) => entry.event === "config_missing_defaults_applied")).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });

  test("orphans an unprovable running child and keeps the readable transcript clean", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-orphan-"));
    roots.push(root);
    const paths = pathsFor(root);
    const now = new Date().toISOString();
    const seeded = openStateStore(paths.stateDb);
    const child = seeded.createChild({
      id: "running-before-boot",
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "Recovered work",
      prompt: "recover me",
      timeoutMs: 1_000,
    }, now);
    seeded.markChildAdmitted(child.id, now);
    seeded.markChildRunning(child.id, now);
    seeded.close();

    const factory = new FakeFactory(paths.session);
    const recoveryRunner: ChildRunner = {
      name: "unused-recovery",
      run: async () => ({ state: "completed", summary: "unused" }),
    };
    const runtime = await startHarness({
      paths,
      probes: controlledProbes(),
      factory,
      childRunner: recoveryRunner,
    });
    try {
      expect(runtime.status().state).toBe("running");
      expect(factory.sessions[0]?.disposed).toBe(false);
      await waitFor(() => runtime.store.getChild(child.id)?.state === "orphaned");
      await waitFor(() => runtime.store.listReceipts().some((candidate) => (
        candidate.childId === child.id
        && candidate.idempotencyKey === `child-orphan:${child.id}`
        && candidate.state === "delivered"
      )));
      const receipt = runtime.store.listReceipts().find((candidate) => (
        candidate.childId === child.id && candidate.idempotencyKey === `child-orphan:${child.id}`
      ));
      expect(receipt).toMatchObject({
        childId: child.id,
        idempotencyKey: `child-orphan:${child.id}`,
        state: "delivered",
      });
      const history = await requestControl(paths.controlSocket, "chat.history", { limit: 50 });
      expect(history.payload).toMatchObject({
        messages: [expect.objectContaining({ role: "assistant", text: "lane reply", turnId: expect.stringContaining("internal:receipt-follow-up:") })],
        tail: [],
      });
    } finally {
      await runtime.stop();
    }
  });

  test("attaches after FDA is granted without replacing the session identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-attach-"));
    roots.push(root);
    const paths = pathsFor(root);
    const handle = "+821012345678";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: handle }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, handle);
    insertMessage(chatDbPath, "seed-message", "seed");
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, 1);
    seeded.close();
    const probes = controlledProbes(handle);
    probes.fda = { status: "denied", reason: "FDA denied" };
    const factory = new FakeFactory(paths.session);
    const port = new FakePort();
    const runtime = await startHarness({ paths, probes, factory, port, chatDbPath });
    try {
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).reason === "fda_denied");
      expect(factory.sessions).toHaveLength(1);
      const sessionId = factory.sessions[0]!.sessionId;
      probes.fda = { status: "passed" };
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).state === "attached");
      expect(factory.sessions.every((session) => session.sessionId === sessionId)).toBe(true);
      insertMessage(chatDbPath, "attach-message", "hello after FDA");
      await waitFor(() => port.sent.length === 1, 5_000);
      expect(port.sent[0]).toMatchObject({ handle, text: "lane reply" });
      expect(logEntries(paths).filter((entry) => entry.event === "imessage_lane_attached")).toHaveLength(1);
    } finally {

      await runtime.stop();
    }
  });

  test("detaches on FDA revoke and keeps subsequent replies out of the ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-revoke-"));
    roots.push(root);
    const paths = pathsFor(root);
    const handle = "+821012345678";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: handle }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, handle);
    insertMessage(chatDbPath, "seed-message", "seed");
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, 1);
    seeded.close();
    const probes = controlledProbes(handle);
    const factory = new FakeFactory(paths.session);
    const port = new FakePort();
    const runtime = await startHarness({ paths, probes, factory, port, chatDbPath });
    try {
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).state === "attached");
      insertMessage(chatDbPath, "before-revoke", "before revoke");
      await waitFor(() => port.sent.length === 1);
      const before = runtime.store.listDeliveries().length;
      probes.fda = { status: "denied", reason: "FDA revoked" };
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).reason === "fda_denied");
      insertMessage(chatDbPath, "after-revoke", "after revoke");
      await Bun.sleep(300);
      expect(port.sent).toHaveLength(1);
      expect(runtime.store.listDeliveries()).toHaveLength(before);
      expect(logEntries(paths).some((entry) => entry.event === "imessage_lane_detached" && entry.reason === "fda_denied")).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  test("retires a persisted handle backlog before attaching its replacement at boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-boot-retire-"));
    roots.push(root);
    const paths = pathsFor(root);
    const oldHandle = "+821012345678";
    const nextHandle = "+821055512345";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: nextHandle }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, nextHandle);
    const seeded = openStateStore(paths.stateDb);
    const now = new Date().toISOString();
    seeded.setMeta("daemon.allowlist_handle", oldHandle);
    seeded.admitDelivery({
      id: "boot-old-pending",
      idempotencyKey: "boot-old-pending",
      handle: oldHandle,
      kind: "text",
      body: "retired pending",
    }, now);
    const inflight = seeded.admitDelivery({
      id: "boot-old-inflight",
      idempotencyKey: "boot-old-inflight",
      handle: oldHandle,
      kind: "text",
      body: "retired inflight",
    }, now);
    seeded.claimDelivery(inflight.id, now);
    bindChatCursor(seeded, chatDbPath, 0);
    seeded.close();
    const probes = controlledProbes(nextHandle);
    const factory = new FakeFactory(paths.session);
    const port = new FakePort();
    const runtime = await startHarness({ paths, probes, factory, port, chatDbPath });
    try {
      await waitForStatus(runtime, (status) => {
        const imessage = status.imessage as Record<string, unknown>;
        return imessage.state === "attached" && imessage.handle === nextHandle;
      });
      await waitFor(() => (
        runtime.store.getDelivery("boot-old-pending")?.state === "expired"
        && runtime.store.getDelivery("boot-old-inflight")?.state === "expired"
      ));
      expect(runtime.store.getDelivery("boot-old-pending")).toMatchObject({ state: "expired", handle: oldHandle });
      expect(runtime.store.getDelivery("boot-old-inflight")).toMatchObject({ state: "expired", handle: oldHandle });
      expect(port.sent.filter((entry) => entry.handle === oldHandle)).toHaveLength(0);
      const entries = logEntries(paths);
      const expiredIndex = entries.findIndex((entry) => entry.event === "deliveries_expired_for_handle" && entry.handle === oldHandle);
      const expired = expiredIndex < 0 ? undefined : entries[expiredIndex];
      const attachedIndex = entries.findIndex((entry) => entry.event === "imessage_lane_attached" && entry.handle === nextHandle);
      expect(expired).toMatchObject({ event: "deliveries_expired_for_handle", handle: oldHandle, count: 2 });
      expect(attachedIndex).toBeGreaterThan(expiredIndex);
    } finally {
      await runtime.stop();
    }
  });

  test("keeps a live handle backlog across restart without expiring it", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-restart-backlog-"));
    roots.push(root);
    const paths = pathsFor(root);
    const handle = "+821012345678";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: handle }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, handle);
    const initial = openStateStore(paths.stateDb);
    initial.setMeta("daemon.allowlist_handle", handle);
    bindChatCursor(initial, chatDbPath, 0);
    initial.close();

    const first = await startHarness({
      paths,
      probes: controlledProbes(handle),
      factory: new FakeFactory(paths.session),
      chatDbPath,
    });
    try {
      await waitForStatus(first, (status) => (status.imessage as Record<string, unknown>).state === "attached");
    } finally {
      await first.stop();
    }

    const backlog = openStateStore(paths.stateDb);
    backlog.setMeta("daemon.allowlist_handle", handle);
    backlog.admitDelivery({
      id: "restart-backlog",
      idempotencyKey: "restart-backlog",
      handle,
      kind: "text",
      body: "live backlog",
    }, new Date().toISOString());
    backlog.close();

    const port = new FakePort();
    const second = await startHarness({
      paths,
      probes: controlledProbes(handle),
      factory: new FakeFactory(paths.session),
      port,
      chatDbPath,
    });
    try {
      await waitForStatus(second, (status) => (status.imessage as Record<string, unknown>).state === "attached");
      await waitFor(() => port.sent.some((entry) => entry.handle === handle && entry.text === "live backlog"));
      expect(second.store.getDelivery("restart-backlog")).toMatchObject({ state: "confirmed", handle });
      expect(logEntries(paths).some((entry) => entry.event === "deliveries_expired_for_handle")).toBe(false);
    } finally {
      await second.stop();
    }
  });
  test("expires retired-handle rows before attaching the replacement lane", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-retire-"));
    roots.push(root);
    const paths = pathsFor(root);
    const oldHandle = "+821012345678";
    const nextHandle = "+821055512345";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: oldHandle }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, oldHandle);
    insertMessage(chatDbPath, "seed-message", "seed");
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, 1);
    seeded.close();
    const probes = controlledProbes(oldHandle);
    probes.fda = { status: "denied", reason: "FDA denied" };
    const factory = new FakeFactory(paths.session);
    const port = new FakePort();
    const runtime = await startHarness({ paths, probes, factory, port, chatDbPath });
    try {
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).reason === "fda_denied");
      const now = new Date().toISOString();
      runtime.store.admitDelivery({ id: "old-1", idempotencyKey: "old-1", handle: oldHandle, kind: "text", body: "old one" }, now);
      runtime.store.admitDelivery({ id: "old-2", idempotencyKey: "old-2", handle: oldHandle, kind: "text", body: "old two" }, now);
      writeFileSync(paths.config, JSON.stringify({ allowlistHandle: nextHandle }));
      probes.config = { status: "passed", allowlistHandle: nextHandle };
      probes.fda = { status: "passed" };
      const response = await requestControl(paths.controlSocket, "settings.set", { patch: { ownerHandle: nextHandle } });
      expect(response.payload).toMatchObject({ ok: true, reloaded: true });
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).state === "attached");
      expect(runtime.store.getDelivery("old-1")?.state).toBe("expired");
      expect(runtime.store.getDelivery("old-2")?.state).toBe("expired");
      expect(port.sent.filter((entry) => entry.text.startsWith("old"))).toHaveLength(0);
      const entries = logEntries(paths);
      const expired = entries.findIndex((entry) => entry.event === "deliveries_expired_for_handle");
      const attached = entries.findIndex((entry) => entry.event === "imessage_lane_attached" && entry.handle === nextHandle);
      expect(expired).toBeGreaterThanOrEqual(0);
      expect(attached).toBeGreaterThan(expired);
    } finally {
      await runtime.stop();
    }
  });

  test("stops and restarts the core lane when credentials disappear", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-credentials-"));
    roots.push(root);
    const paths = pathsFor(root);
    const probes = controlledProbes();
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes, factory });
    try {
      await waitForStatus(runtime, (status) => (status.session as Record<string, unknown>).state === "active");
      const sessionFile = factory.sessions[0]!.sessionFile;
      probes.credentials = { status: "missing", reason: "credentials missing" };
      await waitForStatus(runtime, (status) => (status.bootstrap as Record<string, unknown>).state === "credentials_blocked");
      expect((await statusPayload(runtime)).session).toMatchObject({ state: "inactive" });
      probes.credentials = { status: "passed" };
      await waitFor(() => factory.sessions.length >= 2);
      await waitForStatus(runtime, (status) => (status.session as Record<string, unknown>).state === "active");
      expect(factory.sessions[1]!.sessionFile).toBe(sessionFile);
      expect(logEntries(paths).some((entry) => entry.event === "core_lane_stopped")).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  test("routes inactive notices to iMessage once and retains detached notices for the panel", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-notify-"));
    roots.push(root);
    const paths = pathsFor(root);
    const handle = "+821012345678";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: handle }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, handle);
    insertMessage(chatDbPath, "seed-message", "seed");
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, 1);
    seeded.close();
    const probes = controlledProbes(handle);
    const factory = new FakeFactory(paths.session);
    const port = new FakePort();
    const runtime = await startHarness({ paths, probes, factory, port, chatDbPath });
    try {
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).state === "attached");
      await requestControl(paths.controlSocket, "chat.activity", { frontmost: false, lastInputAgeSeconds: 0 });
      const attached = await requestControl(paths.controlSocket, "session.notify", { text: "attached note" });
      expect(attached.payload).toMatchObject({ reply: "lane reply", admitted: true, delivered: false });
      // The returned id proves durable notification admission, not remote delivery.
      const attachedId = String(attached.payload.notificationId);
      expect(attachedId.length).toBeGreaterThan(0);
      await waitFor(() => port.sent.length === 1);
      await waitFor(() => runtime.store.assistantWork.getNotificationRoute(attachedId, "imessage")?.state === "delivered", 5_000);
      expect(runtime.store.assistantWork.getNotificationRoute(attachedId, "chat")).toBeUndefined();
      await Bun.sleep(1_100);
      expect(port.sent).toEqual([{ handle, text: "lane reply" }]);
      const attachedList = (await requestControl(paths.controlSocket, "assistant.notifications.list")).payload;
      expect(attachedList.notifications).toContainEqual({ id: attachedId, text: "lane reply", acknowledged: false });

      probes.fda = { status: "denied", reason: "FDA revoked" };
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).reason === "fda_denied");
      const detached = await requestControl(paths.controlSocket, "session.notify", { text: "detached note" });
      expect(detached.payload).toMatchObject({ reply: "lane reply", admitted: true, delivered: false });
      // Detached admission still returns a durable id even though no route exists.
      const detachedId = String(detached.payload.notificationId);
      expect(detachedId.length).toBeGreaterThan(0);
      await waitFor(() => runtime.store.assistantWork.getNotification(detachedId) !== undefined);
      const detachedList = (await requestControl(paths.controlSocket, "assistant.notifications.list")).payload;
      expect(detachedList.notifications).toContainEqual({ id: detachedId, text: "lane reply", acknowledged: false });
      expect(runtime.store.assistantWork.listNotificationRoutes(detachedId)).toEqual([]);
      await Bun.sleep(1_100);
      expect(port.sent).toEqual([{ handle, text: "lane reply" }]);
      const history = (await requestControl(paths.controlSocket, "chat.history", { limit: 50 })).payload;
      expect((history.messages as Array<Record<string, unknown>>).filter((message) => message.text === "lane reply")).toHaveLength(2);
    } finally {
      await runtime.stop();
    }
  });

  test("keeps the core up with independent defaults for malformed config scopes", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-invalid-config-"));
    roots.push(root);
    const paths = pathsFor(root);
    writeFileSync(paths.config, "{");
    const probes = controlledProbes();
    probes.config = { status: "invalid", reason: "config.json is not valid JSON" };
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes, factory });
    try {
      expect(runtime.status().state).toBe("running");
      expect(factory.sessions).toHaveLength(1);
      const invalid = logEntries(paths).filter((entry) => entry.event === "config_invalid_defaults_applied");
      expect(invalid).toHaveLength(2);
      expect(invalid.map((entry) => entry.scope).sort()).toEqual(["monitors", "runtime"]);
      expect(logEntries(paths).some((entry) => entry.event === "config_missing_defaults_applied")).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  test("keeps the core lane running when the FDA probe errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-fda-error-"));
    roots.push(root);
    const paths = pathsFor(root);
    const handle = "+821012345678";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: handle }));
    const probes = controlledProbes(handle);
    probes.fda = { status: "error", reason: "TCC probe unavailable" };
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes, factory });
    try {
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).reason === "fda_probe_error");
      expect(runtime.status().state).toBe("running");
      expect(factory.sessions).toHaveLength(1);
      expect(logEntries(paths).some((entry) => entry.event === "imessage_lane_attached")).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  test("rolls back a failed chat.db preflight and retries on a later tick", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-preflight-"));
    roots.push(root);
    const paths = pathsFor(root);
    const handle = "+821012345678";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: handle }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    mkdirSync(chatDbPath, { recursive: true });
    const probes = controlledProbes(handle);
    const factory = new FakeFactory(paths.session);
    const port = new FakePort();
    const runtime = await startHarness({ paths, probes, factory, port, chatDbPath });
    try {
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).reason === "attach_failed");
      expect((await statusPayload(runtime)).imessage).toMatchObject({ state: "detached", reason: "attach_failed" });
      rmSync(chatDbPath, { recursive: true, force: true });
      createChatDb(chatDbPath, handle);
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).state === "attached");
      expect(logEntries(paths).filter((entry) => entry.event === "imessage_lane_attach_failed").length).toBeGreaterThan(0);
      expect(logEntries(paths).filter((entry) => entry.event === "imessage_lane_attached")).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });

  test("keeps one paused-backlog notice durable while the iMessage lane is detached", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-paused-"));
    roots.push(root);
    const paths = pathsFor(root);
    const handle = "+821012345678";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: handle }));
    const probes = controlledProbes(handle);
    probes.fda = { status: "denied", reason: "FDA denied" };
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes, factory });
    try {
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).reason === "fda_denied");
      setDaemonPaused(runtime.store, true);
      recordSuppressedWhilePaused(runtime.store, 2);
      await requestControl(paths.controlSocket, "daemon.resume");
      await waitFor(() => runtime.store.assistantWork.listNotifications().some((notice) => notice.body === "lane reply"));

      const notices = runtime.store.assistantWork.listNotifications().filter((notice) => notice.body === "lane reply");
      expect(notices).toHaveLength(1);
      const notice = notices[0]!;
      const listed = (await requestControl(paths.controlSocket, "assistant.notifications.list")).payload;
      expect(listed.notifications).toContainEqual({ id: notice.id, text: "lane reply", acknowledged: false });
      expect(runtime.store.assistantWork.listNotificationRoutes(notice.id)).toEqual([]);
      expect(runtime.store.listDeliveries()).toHaveLength(0);
      const history = (await requestControl(paths.controlSocket, "chat.history", { limit: 50 })).payload;
      expect((history.messages as Array<Record<string, unknown>>).filter((message) => message.text === "lane reply")).toHaveLength(1);
      expect(logEntries(paths).some((entry) => entry.event === "delivery_skipped_no_imessage_lane" && String(entry.idempotencyKey).startsWith("paused-backlog:"))).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  test("fences an in-flight A turn before retiring A and attaching B", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-handle-turn-"));
    roots.push(root);
    const paths = pathsFor(root);
    const oldHandle = "+821012345678";
    const nextHandle = "+821055512345";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: oldHandle }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, oldHandle);
    insertHandle(chatDbPath, nextHandle);
    insertMessage(chatDbPath, "seed-message", "seed");
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, 1);
    seeded.close();
    const probes = controlledProbes(oldHandle);
    const factory = new FakeFactory(paths.session);
    const port = new FakePort();
    const runtime = await startHarness({ paths, probes, factory, port, chatDbPath });
    try {
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).state === "attached");
      const active = factory.sessions.at(-1)!;
      active.promptRelease = () => undefined;
      insertMessage(chatDbPath, "in-flight-A", "old turn", 1);
      await waitFor(() => active.prompts.length === 1);
      writeFileSync(paths.config, JSON.stringify({ allowlistHandle: nextHandle }));
      probes.config = { status: "passed", allowlistHandle: nextHandle };
      const settingsPromise = requestControl(paths.controlSocket, "settings.set", { patch: { ownerHandle: nextHandle } });
      await Bun.sleep(100);
      active.promptRelease?.();
      await settingsPromise;
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).state === "attached" && (status.imessage as Record<string, unknown>).handle === nextHandle);
      expect(port.sent.filter((entry) => entry.handle === oldHandle)).toHaveLength(0);
      const entries = logEntries(paths);
      expect(entries.some((entry) => entry.event === "delivery_skipped_no_imessage_lane" && entry.reason === "lane_changed")).toBe(true);
      expect(entries.some((entry) => entry.event === "deliveries_expired_for_handle" && entry.handle === oldHandle)).toBe(true);
      insertMessage(chatDbPath, "after-B", "new turn", 2);
      await waitFor(() => port.sent.some((entry) => entry.handle === nextHandle));
    } finally {
      await runtime.stop();
    }
  });

  test("expires pending rows when the configured owner handle is cleared while detached", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-clear-handle-"));
    roots.push(root);
    const paths = pathsFor(root);
    const oldHandle = "+821012345678";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: oldHandle }));
    const probes = controlledProbes(oldHandle);
    probes.fda = { status: "denied", reason: "FDA denied" };
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes, factory });
    try {
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).reason === "fda_denied");
      const now = new Date().toISOString();
      runtime.store.admitDelivery({ id: "clear-1", idempotencyKey: "clear-1", handle: oldHandle, kind: "text", body: "clear one" }, now);
      runtime.store.admitDelivery({ id: "clear-2", idempotencyKey: "clear-2", handle: oldHandle, kind: "text", body: "clear two" }, now);
      probes.config = { status: "passed" };
      const response = await requestControl(paths.controlSocket, "settings.set", { patch: { ownerHandle: "" } });
      expect(response.payload).toMatchObject({ ok: true, reloaded: true });
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).reason === "no_owner_handle");
      expect(runtime.store.getDelivery("clear-1")?.state).toBe("expired");
      expect(runtime.store.getDelivery("clear-2")?.state).toBe("expired");
      expect((await statusPayload(runtime)).settings).toEqual({});
    } finally {
      await runtime.stop();
    }
  });

  test("refuses chat.send once shutdown starts while delivery teardown is blocked", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-shutdown-chat-"));
    roots.push(root);
    const paths = pathsFor(root);
    const handle = "+821012345678";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: handle }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, handle);
    insertMessage(chatDbPath, "seed-message", "seed");
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, 1);
    seeded.close();
    const probes = controlledProbes(handle);
    const factory = new FakeFactory(paths.session);
    const port = new FakePort();
    const releaseSend = Promise.withResolvers<void>();
    let sendStarted = false;
    port.sendTextGate = releaseSend.promise;
    port.sendTextStarted = () => {
      sendStarted = true;
    };
    const runtime = await startHarness({ paths, probes, factory, port, chatDbPath });
    try {
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).state === "attached");
      insertMessage(chatDbPath, "shutdown-in-flight", "before shutdown");
      await waitFor(() => sendStarted);
      const stopping = runtime.stop();
      let error: unknown;
      try {
        await requestControl(paths.controlSocket, "chat.send", { text: "during shutdown" });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain("control internal_error");
      expect(String(error)).toContain("main session is not running");
      releaseSend.resolve();
      await stopping;
      expect(logEntries(paths).filter((entry) => entry.event === "stopped")).toHaveLength(1);
    } finally {
      releaseSend.resolve();
      await runtime.stop();
    }
  });

  test("keeps chat.history readable after core is unpublished until session teardown completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-shutdown-history-"));
    roots.push(root);
    const paths = pathsFor(root);
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes: controlledProbes(), factory });
    const releaseDispose = Promise.withResolvers<void>();
    try {
      const session = factory.sessions[0]!;
      session.messages = [
        { role: "user", content: "before shutdown", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "still here" }], timestamp: 2 },
      ];
      let disposeStarted = false;
      session.disposeStarted = () => { disposeStarted = true; };
      session.disposeGate = releaseDispose.promise;

      const stopping = runtime.stop();
      await waitFor(() => disposeStarted);
      const response = await requestControl(paths.controlSocket, "chat.history", { limit: 50 });
      expect(response.payload).toMatchObject({
        messages: [
          { role: "owner", text: "before shutdown" },
          { role: "assistant", text: "still here" },
        ],
      });

      releaseDispose.resolve();
      await stopping;
    } finally {
      releaseDispose.resolve();
      await runtime.stop();
    }
  });

  test("serializes shutdown behind a blocked probe and never restarts afterward", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-shutdown-probe-"));
    roots.push(root);
    const paths = pathsFor(root);
    const probes = controlledProbes();
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes, factory });
    const base = probes.probes;
    const release = Promise.withResolvers<ProbeResult>();
    let blocked = false;
    (probes as { probes: BootstrapProbes }).probes = {
      ...base,
      credentials: async () => {
        if (!blocked) {
          return probes.credentials;
        }
        return release.promise;
      },
    };
    try {
      await waitForStatus(runtime, (status) => (status.session as Record<string, unknown>).state === "active");
      blocked = true;
      await Bun.sleep(75);
      const stopping = runtime.stop();
      await Bun.sleep(75);
      expect(factory.sessions).toHaveLength(1);
      release.resolve({ status: "passed" });
      await stopping;
      expect(factory.sessions).toHaveLength(1);
      expect(logEntries(paths).filter((entry) => entry.event === "stopped")).toHaveLength(1);
    } finally {
      release.resolve({ status: "passed" });
    }
  });

  test("finishes core cleanup and closes control when session teardown fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-stop-failure-"));
    roots.push(root);
    const paths = pathsFor(root);
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes: controlledProbes(), factory });
    factory.sessions[0]!.disposeError = new Error("dispose failed");

    await expect(runtime.stop()).rejects.toThrow("dispose failed");
    const entries = logEntries(paths);
    expect(entries).toContainEqual(expect.objectContaining({
      event: "core_lane_stop_failed",
      message: "dispose failed",
    }));
    await expect(requestControl(paths.controlSocket, "status.get")).rejects.toThrow();
  });

  test("routes daemon.restart through shutdown and exits with the restart code", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-restart-"));
    roots.push(root);
    const paths = pathsFor(root);
    const probes = controlledProbes();
    const factory = new FakeFactory(paths.session);
    const exitCodes: number[] = [];
    const runtime = await startHarness({ paths, probes, factory, exit: (code) => exitCodes.push(code) });
    try {
      const response = await requestControl(paths.controlSocket, "daemon.restart");
      expect(response.payload).toMatchObject({ restarting: true });
      await waitFor(() => exitCodes.includes(75), 2_000);
      expect(logEntries(paths).filter((entry) => entry.event === "core_lane_started")).toHaveLength(1);
      expect(logEntries(paths).filter((entry) => entry.event === "stopped")).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });

  test("reloads the shared session once per FDA lane transition", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-reloads-"));
    roots.push(root);
    const paths = pathsFor(root);
    const handle = "+821012345678";
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: handle }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, handle);
    insertMessage(chatDbPath, "seed-message", "seed");
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, 1);
    seeded.close();
    const probes = controlledProbes(handle);
    probes.fda = { status: "denied", reason: "FDA denied" };
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes, factory, chatDbPath });
    try {
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).reason === "fda_denied");
      probes.fda = { status: "passed" };
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).state === "attached");
      probes.fda = { status: "denied", reason: "FDA revoked" };
      await waitForStatus(runtime, (status) => (status.imessage as Record<string, unknown>).reason === "fda_denied");
      await waitFor(() => logEntries(paths).filter((entry) => entry.event === "session_reloaded" && entry.trigger === "imessage_lane").length === 2);
      expect(logEntries(paths).filter((entry) => entry.event === "session_reloaded" && entry.trigger === "imessage_lane")).toHaveLength(2);
    } finally {
      await runtime.stop();
    }
  });

  test("rejects session.notify while credentials block the core lane", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-notify-blocked-"));
    roots.push(root);
    const paths = pathsFor(root);
    const probes = controlledProbes();
    probes.credentials = { status: "missing", reason: "credentials missing" };
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes, factory });
    try {
      await waitForStatus(runtime, (status) => (status.bootstrap as Record<string, unknown>).state === "credentials_blocked");
      let error: unknown;
      try {
        await requestControl(paths.controlSocket, "session.notify", { text: "blocked note" });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain("main session is not running");
      probes.credentials = { status: "passed" };
      await waitFor(() => factory.sessions.length === 1);
    } finally {
      await runtime.stop();
    }
  });

  test("memoizes runtime.stop and closes the store exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-lanes-stop-idempotent-"));
    roots.push(root);
    const paths = pathsFor(root);
    const probes = controlledProbes();
    const factory = new FakeFactory(paths.session);
    const runtime = await startHarness({ paths, probes, factory });
    const first = runtime.stop();
    const second = runtime.stop();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(logEntries(paths).filter((entry) => entry.event === "stopped")).toHaveLength(1);
  });
});
