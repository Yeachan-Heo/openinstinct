import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setDaemonPaused } from "../src/control/pause.ts";
import type { ChatEventSink } from "../src/chat/hub.ts";
import { ChatHub, PANEL_SOURCE_MARKER } from "../src/chat/hub.ts";
import type { DeliveryPort, DeliveryReceipt } from "../src/delivery/port.ts";
import { DeliveryService } from "../src/delivery/service.ts";
import { OwnerOutbox } from "../src/delivery/outbox.ts";
import { NdjsonLogger } from "../src/log.ts";
import type { MemoryClosureQueue } from "../src/memory/adapters/intents.ts";
import {
  OwnerTurnIngress,
  type OwnerTurnRequest,
} from "../src/owner-turn.ts";
import type {
  ActiveTurn,
  MainSession,
  MainTurnInput,
  MainTurnResult,
  SegmentCapture,
  SteerOutcome,
} from "../src/sdk-session/main-session.ts";
import { openStateStore, type StateStore } from "../src/store/index.ts";

const OWNER_HANDLE = "+821012345678";
const roots: string[] = [];

type LogCall = readonly [string, string, string, Record<string, unknown> | undefined];

class FakeLogger {
  public readonly calls: LogCall[] = [];

  public write(...args: LogCall): void {
    this.calls.push(args);
  }

  public events(name: string): Record<string, unknown>[] {
    return this.calls.filter((call) => call[2] === name).map((call) => call[3] ?? {});
  }
}

class FakePort implements DeliveryPort {
  public readonly sent: Array<{ readonly handle: string; readonly text: string }> = [];
  public readonly replies: Array<{ readonly guid: string; readonly text: string }> = [];
  public readonly files: Array<{ readonly handle: string; readonly path: string; readonly caption?: string }> = [];
  public readonly reads: string[] = [];
  public readonly typings: Array<{ readonly handle: string; readonly typing: boolean }> = [];

  public async sendText(handle: string, text: string): Promise<DeliveryReceipt> {
    this.sent.push({ handle, text });
    return { messageId: `text-${this.sent.length}` };
  }

  public async sendReply(guid: string, text: string): Promise<DeliveryReceipt> {
    this.replies.push({ guid, text });
    return { messageId: `reply-${this.replies.length}` };
  }

  public async sendFile(handle: string, path: string, caption?: string): Promise<DeliveryReceipt> {
    this.files.push({ handle, path, ...(caption === undefined ? {} : { caption }) });
    return { messageId: `file-${this.files.length}` };
  }

  public async markRead(handle: string): Promise<void> {
    this.reads.push(handle);
  }

  public async setTyping(handle: string, typing: boolean): Promise<void> {
    this.typings.push({ handle, typing });
  }
}

class FakeMemory {
  public readonly captures: Array<Record<string, unknown>> = [];

  public enqueueCapture(input: Record<string, unknown>): string {
    this.captures.push(input);
    return `capture-${this.captures.length}`;
  }
}

class ControlledSession {
  public running = false;
  public messages: unknown[] = [];
  public readonly turns: MainTurnInput[] = [];
  public readonly steers: MainTurnInput[] = [];
  public nextSteer: SteerOutcome = { kind: "admitted" };
  public turnResult: MainTurnResult = { kind: "reply", text: "reply" };
  private resolveTurn?: (result: MainTurnResult) => void;

  public get transcript(): unknown {
    return this.messages;
  }

  public async steer(input: MainTurnInput): Promise<SteerOutcome> {
    this.steers.push(input);
    return this.nextSteer;
  }

  public turn(input: string | MainTurnInput): Promise<MainTurnResult> {
    const normalized = typeof input === "string" ? { text: input } : input;
    this.turns.push(normalized);
    this.running = true;
    return new Promise((resolve) => {
      this.resolveTurn = resolve;
    });
  }

  public complete(result: MainTurnResult = this.turnResult): void {
    this.running = false;
    this.resolveTurn?.(result);
    this.resolveTurn = undefined;
  }
}

interface ActiveHandle {
  readonly active: ActiveTurn;
  readonly resolve: (result: MainTurnResult) => void;
}

function activeTurn(options: {
  readonly turnId?: string;
  readonly kind?: "prompt" | "continuation";
  readonly openingTurnIds?: readonly string[];
  readonly owner?: boolean;
  readonly transcriptIndex?: number;
} = {}): ActiveHandle {
  let resolve!: (result: MainTurnResult) => void;
  const settled = new Promise<MainTurnResult>((complete) => {
    resolve = complete;
  });
  const kind = options.kind ?? "prompt";
  const active: ActiveTurn = {
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    ...(options.openingTurnIds === undefined ? {} : { openingTurnIds: options.openingTurnIds }),
    initialUserPending: kind === "continuation" ? 0 : 1,
    owner: options.owner ?? true,
    kind,
    transcriptIndex: options.transcriptIndex ?? 0,
    done: false,
    settled,
    capture: {} as SegmentCapture,
  };
  return { active, resolve };
}

interface Harness {
  readonly root: string;
  readonly store: StateStore;
  readonly logger: FakeLogger;
  readonly port: FakePort;
  readonly service: DeliveryService;
  readonly outbox: OwnerOutbox;
  readonly hub: ChatHub;
  readonly events: Array<{ readonly topic: string; readonly payload: Record<string, unknown> }>;
  readonly session: ControlledSession;
  readonly memory: FakeMemory;
  readonly ingress: OwnerTurnIngress;
}

function createHarness(attached = true): Harness {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-owner-turn-"));
  roots.push(root);
  const store = openStateStore(join(root, "state.db"));
  const logger = new FakeLogger();
  const port = new FakePort();
  const service = new DeliveryService({ store, port });
  const outbox = new OwnerOutbox({ logger: logger as unknown as NdjsonLogger });
  if (attached) {
    outbox.attach(service, OWNER_HANDLE);
  }
  const hub = new ChatHub(logger as unknown as NdjsonLogger);
  const events: Array<{ readonly topic: string; readonly payload: Record<string, unknown> }> = [];
  hub.subscribe(((topic, payload) => events.push({ topic, payload })) satisfies ChatEventSink);
  const session = new ControlledSession();
  const memory = new FakeMemory();
  const ingress = new OwnerTurnIngress({
    store,
    logger: logger as unknown as NdjsonLogger,
    hub,
    outbox,
    lanes: () => ({ session: session as unknown as MainSession, memory: memory as unknown as MemoryClosureQueue }),
    transcript: () => session.messages,
  });
  return { root, store, logger, port, service, outbox, hub, events, session, memory, ingress };
}

function request(turnId: string, source: "imessage" | "panel", text = turnId): OwnerTurnRequest {
  return {
    source,
    turnId,
    text,
    promptText: source === "panel" ? `${text}\n\n${PANEL_SOURCE_MARKER}` : text,
    ...(source === "imessage" ? { replyToGuid: turnId } : {}),
  };
}

async function settle(handle: ActiveHandle, result: MainTurnResult = { kind: "reply", text: "reply" }): Promise<void> {
  handle.resolve(result);
  await Promise.resolve();
  await Promise.resolve();
}

function messages(harness: Harness): Record<string, unknown>[] {
  return harness.events.filter((event) => event.topic === "chat.message").map((event) => event.payload);
}

function deliveries(harness: Harness): ReturnType<StateStore["listDeliveries"]> {
  return harness.store.listDeliveries();
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("OwnerTurnIngress", () => {
  test("(1) claims same-tick admissions synchronously and merges a queued owner box", async () => {
    const h = createHarness();
    try {
      const first = h.ingress.admit(request("t1", "panel", "first"));
      const second = h.ingress.admit(request("t2", "imessage", "second"));
      expect(await second).toBe("steered");
      expect(await first).toBe("started");
      expect(h.session.steers.map((input) => input.turnId)).toEqual(["t2"]);

      const run = activeTurn({ turnId: "t1", transcriptIndex: 0 });
      h.ingress.onTurnStarted(run.active);
      expect(h.ingress.current?.turnId).toBe("t1");
      expect(h.ingress.current?.steered).toEqual(["t2"]);
      expect(h.ingress.current?.sources).toEqual(new Set(["panel", "imessage"]));
      await settle(run);
      expect(deliveries(h).filter((row) => row.idempotencyKey.startsWith("inbound-turn:")).map((row) => row.idempotencyKey)).toEqual(["inbound-turn:t1"]);
    } finally {
      h.store.close();
    }
  });

  test("(2) tags both origins without leaking the panel marker", async () => {
    const h = createHarness(false);
    try {
      const panel = h.ingress.admit(request("panel:1", "panel", "panel words"));
      expect(await panel).toBe("started");
      const pRun = activeTurn({ turnId: "panel:1", transcriptIndex: 0 });
      h.ingress.onTurnStarted(pRun.active);
      h.session.messages.push({ role: "user", content: request("panel:1", "panel", "panel words").promptText });
      h.ingress.onSegment("panel reply");
      await settle(pRun);

      h.session.running = false;
      const imessage = h.ingress.admit(request("imessage:1", "imessage", "phone words"));
      expect(await imessage).toBe("started");
      const iRun = activeTurn({ turnId: "imessage:1", transcriptIndex: 1 });
      h.ingress.onTurnStarted(iRun.active);
      h.session.messages.push({ role: "user", content: "phone words" });
      await settle(iRun, { kind: "reply", text: "phone reply" });

      const owners = messages(h).filter((message) => message.role === "owner");
      expect(owners).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "panel", text: "panel words", turnId: "panel:1" }),
        expect.objectContaining({ source: "imessage", text: "phone words", turnId: "imessage:1" }),
      ]));
      expect(messages(h).every((message) => !String(message.text ?? "").includes(PANEL_SOURCE_MARKER))).toBe(true);
    } finally {
      h.store.close();
    }
  });

  test("(3) merges one in-run steer and records it once", async () => {
    const h = createHarness();
    try {
      const first = h.ingress.admit(request("t1", "imessage"));
      expect(await first).toBe("started");
      const run = activeTurn({ turnId: "t1" });
      h.ingress.onTurnStarted(run.active);
      const steer = h.ingress.admit(request("t2", "panel"));
      expect(await steer).toBe("steered");
      h.ingress.onSteerMerged(run.active, "t2");
      h.ingress.onSteerMerged(run.active, "t2");
      expect(h.ingress.current?.steered).toEqual(["t2"]);
      await settle(run);
      expect(h.logger.events("turn_merged_steers")).toEqual([{ turnId: "t1", steered: ["t2"] }]);
    } finally {
      h.store.close();
    }
  });

  test("(4a) gives one late steer a continuation context and one final", async () => {
    const h = createHarness();
    try {
      h.session.running = true;
      const steer = h.ingress.admit(request("t1", "panel", "late"));
      expect(await steer).toBe("steered");
      const run = activeTurn({ kind: "continuation", openingTurnIds: ["t1"], turnId: "t1" });
      h.ingress.onTurnStarted(run.active);
      h.ingress.onSegment("continuation output");
      await settle(run, { kind: "reply", text: "continuation final" });
      expect(messages(h).filter((m) => m.turnId === "t1" && m.role === "owner")).toHaveLength(1);
      expect(messages(h).filter((m) => m.turnId === "t1" && m.final === true)).toHaveLength(1);
      expect(deliveries(h).filter((row) => row.idempotencyKey === "inbound-turn:t1")).toHaveLength(1);
    } finally {
      h.store.close();
    }
  });

  test("(4b/4c) drains a two-source batch and joins a running continuation once", async () => {
    const h = createHarness();
    try {
      h.session.running = true;
      const one = h.ingress.admit(request("t1", "panel", "one"));
      const two = h.ingress.admit(request("t2", "imessage", "two"));
      expect(await one).toBe("steered");
      expect(await two).toBe("steered");
      const run = activeTurn({ kind: "continuation", openingTurnIds: ["t1", "t2"], turnId: "t1" });
      h.ingress.onTurnStarted(run.active);
      const three = h.ingress.admit(request("t3", "panel", "three"));
      expect(await three).toBe("steered");
      h.ingress.onSteerMerged(run.active, "t3");
      h.ingress.onSteerMerged(run.active, "t3");
      expect(h.ingress.current?.steered).toEqual(["t2", "t3"]);
      expect(h.ingress.current?.sources).toEqual(new Set(["panel", "imessage"]));
      await settle(run, { kind: "reply", text: "batch final" });
      expect(messages(h).filter((m) => m.final === true)).toHaveLength(1);
      expect(deliveries(h).filter((row) => row.idempotencyKey.startsWith("inbound-turn:")).map((row) => row.idempotencyKey)).toEqual(["inbound-turn:t1"]);
      expect(h.port.typings.filter((entry) => entry.typing === false)).toHaveLength(1);
      expect(h.events.filter((event) => event.topic === "chat.presence" && event.payload.typing === false)).toHaveLength(1);
    } finally {
      h.store.close();
    }
  });

  test("(4d/4e) keeps leftover and between-start steers out of the old context", async () => {
    const h = createHarness();
    try {
      h.session.running = true;
      const first = h.ingress.admit(request("t1", "imessage"));
      expect(await first).toBe("steered");
      const run1 = activeTurn({ kind: "continuation", openingTurnIds: ["t1"], turnId: "t1" });
      h.ingress.onTurnStarted(run1.active);
      const late = h.ingress.admit(request("t2", "panel"));
      expect(await late).toBe("steered");
      const run2 = activeTurn({ kind: "continuation", openingTurnIds: ["t2"], turnId: "t2" });
      h.ingress.onTurnStarted(run2.active);
      expect(h.ingress.current?.turnId).toBe("t2");
      expect(h.ingress.current?.steered).toEqual([]);
      await settle(run1, { kind: "reply", text: "first final" });
      await settle(run2, { kind: "reply", text: "second final" });
      expect(messages(h).filter((m) => m.final === true).map((m) => m.turnId)).toEqual(["t1", "t2"]);
      expect(deliveries(h).filter((row) => row.idempotencyKey.startsWith("inbound-turn:")).map((row) => row.idempotencyKey).sort()).toEqual(["inbound-turn:t1", "inbound-turn:t2"]);
    } finally {
      h.store.close();
    }
  });

  test("(5) keeps an old context for output after a steer falls back to a queued turn", async () => {
    const h = createHarness();
    try {
      const first = h.ingress.admit(request("old", "imessage"));
      expect(await first).toBe("started");
      const oldRun = activeTurn({ turnId: "old", transcriptIndex: 4 });
      h.ingress.onTurnStarted(oldRun.active);
      h.session.nextSteer = { kind: "not_admitted", reason: "rejected" };
      const fallback = h.ingress.admit(request("new", "panel"));
      expect(await fallback).toBe("started");
      h.ingress.onSegment("old segment");
      expect(messages(h).find((m) => m.text === "old segment")).toEqual(expect.objectContaining({ turnId: "old" }));
      const newRun = activeTurn({ turnId: "new", transcriptIndex: 7 });
      h.ingress.onTurnStarted(newRun.active);
      expect(h.ingress.current?.turnId).toBe("new");
      expect(h.ingress.current?.transcriptIndex).toBe(7);
      await settle(oldRun, { kind: "reply", text: "old final" });
      await settle(newRun, { kind: "reply", text: "new final" });
    } finally {
      h.store.close();
    }
  });

  test("(6/7) promotes a consumed internal steer, while rejected internal work stays ledger-only", async () => {
    const h = createHarness();
    try {
      h.session.running = true;
      const promoted = h.ingress.admit(request("promote", "panel", "owner"));
      expect(await promoted).toBe("steered");
      const internal = activeTurn({ owner: false, turnId: undefined });
      h.ingress.onTurnPromoted(internal.active, "promote");
      h.ingress.onSegment("visible after promotion");
      await settle(internal, { kind: "reply", text: "promoted final" });
      expect(messages(h).filter((m) => m.final === true)).toHaveLength(1);
      expect(deliveries(h).filter((row) => row.idempotencyKey.startsWith("inbound-turn:")).map((row) => row.idempotencyKey)).toEqual([]);
      expect(h.memory.captures).toHaveLength(0);

      h.session.nextSteer = { kind: "not_admitted", reason: "rejected" };
      h.session.running = true;
      const rejected = h.ingress.admit(request("rejected", "imessage"));
      expect(await rejected).toBe("started");
      h.ingress.onSegment("internal-only");
      expect(messages(h).some((m) => m.text === "internal-only")).toBe(false);
      expect(deliveries(h).some((row) => row.body === "internal-only")).toBe(true);
    } finally {
      h.store.close();
    }
  });

  test("adopts an owner message steered during an ingress-unowned notify turn", async () => {
    const h = createHarness();
    const notify = h.session.turn({ owner: true, text: "operator note" });
    const turnId = "owner-during-notify";
    try {
      expect(await h.ingress.admit(request(turnId, "panel", "owner message"))).toBe("steered");
      const active = activeTurn({ owner: true, turnId: undefined });
      h.ingress.onSteerMerged(active.active, turnId);
      await settle(active, { kind: "reply", text: "owner reply" });

      expect(messages(h).filter((message) => message.role === "assistant" && message.final === true)).toEqual([
        expect.objectContaining({ turnId, text: "owner reply", final: true }),
      ]);
      expect(h.ingress.history(50).tail.some((event) => event.payload.turnId === turnId)).toBe(false);
      expect(deliveries(h).filter((row) => row.idempotencyKey === `inbound-turn:${turnId}`)).toHaveLength(0);
      expect(h.logger.events("steer_merge_unowned").filter((entry) => entry.turnId === turnId)).toHaveLength(0);
    } finally {
      h.session.complete();
      await notify;
      h.store.close();
    }
  });

  test("logs steer_merge_unowned for a steer with no matching admission", () => {
    const h = createHarness();
    try {
      const active = activeTurn({ owner: true, turnId: undefined });
      h.ingress.onSteerMerged(active.active, "missing-steer");
      expect(h.ingress.current).toBeUndefined();
      expect(h.logger.events("steer_merge_unowned")).toEqual([{ turnId: "missing-steer" }]);
    } finally {
      h.store.close();
    }
  });

  test("(8/9) pins detached and old-handle bindings across lane changes", async () => {
    const h = createHarness(false);
    try {
      const first = h.ingress.admit(request("detached", "imessage"));
      expect(await first).toBe("started");
      const run = activeTurn({ turnId: "detached" });
      h.ingress.onTurnStarted(run.active);
      h.ingress.onSegment("detached segment");
      h.ingress.onImage("/tmp/image.png", "caption", { kind: "chat_only" });
      h.outbox.attach(h.service, OWNER_HANDLE);
      h.ingress.onSegment("still detached");
      await settle(run, { kind: "reply", text: "detached final" });
      expect(deliveries(h)).toHaveLength(0);
      expect(h.logger.events("delivery_skipped_no_imessage_lane").map((entry) => entry.reason)).toEqual([
        "detached_at_turn_start",
        "detached_at_turn_start",
        "detached_at_turn_start",
      ]);

      const attached = h.outbox.bind("old-handle");
      h.outbox.detach("handle_changed");
      h.outbox.attach(h.service, "+821012345679");
      expect(attached.admit({ idempotencyKey: "old-output", text: "drop" })).toBeUndefined();
      expect(h.port.sent).toEqual([]);
    } finally {
      h.store.close();
    }
  });

  test("(9b) a reply delivered only as streamed segments is still captured to memory", async () => {
    const h = createHarness();
    try {
      const admitted = h.ingress.admit(request("seg", "imessage", "what did we decide?"));
      expect(await admitted).toBe("started");
      const run = activeTurn({ turnId: "seg" });
      h.ingress.onTurnStarted(run.active);
      h.ingress.onSegment("We decided A.");
      h.ingress.onSegment("And B follows from it.");
      // Final-after-segments is deduplicated upstream: the settle carries no text.
      await settle(run, { kind: "reply", text: "" });

      expect(messages(h).filter((m) => m.final === true)).toHaveLength(0);
      expect(h.memory.captures).toHaveLength(1);
      expect(h.memory.captures[0]).toMatchObject({
        origin: { kind: "owner-chat", reference: "seg" },
        userText: "what did we decide?",
        replyText: "We decided A. And B follows from it.",
        idempotencyKey: "memory:owner-turn:seg",
      });
      expect(h.logger.events("turn_finished").at(-1)).toMatchObject({ segmentsOnly: true, captured: true });

      // A turn that produced neither segments nor text captures nothing.
      h.session.running = false;
      const empty = h.ingress.admit(request("empty", "imessage", "hello?"));
      expect(await empty).toBe("started");
      const emptyRun = activeTurn({ turnId: "empty" });
      h.ingress.onTurnStarted(emptyRun.active);
      await settle(emptyRun, { kind: "reply", text: "" });
      expect(h.memory.captures).toHaveLength(1);
      expect(h.logger.events("turn_finished").at(-1)).toMatchObject({ segmentsOnly: true, captured: false });
    } finally {
      h.store.close();
    }
  });

  test("(10) handles parity, breaker, capture intent, pause suppression, and no active lane", async () => {
    const h = createHarness();
    try {
      const panel = h.ingress.admit(request("panel", "panel", "same text"));
      expect(await panel).toBe("started");
      const panelRun = activeTurn({ turnId: "panel" });
      h.ingress.onTurnStarted(panelRun.active);
      await settle(panelRun, { kind: "reply", text: "same reply" });
      expect(h.memory.captures[0]).toMatchObject({
        origin: { kind: "owner-chat", reference: "panel" },
        userText: "same text",
        replyText: "same reply",
      });

      for (const id of ["failure-1", "failure-2", "failure-3"]) {
        h.session.running = false;
        const admission = h.ingress.admit(request(id, "panel"));
        expect(await admission).toBe("started");
        const run = activeTurn({ turnId: id });
        h.ingress.onTurnStarted(run.active);
        await settle(run, { kind: "failed", code: "provider", message: "provider down" });
      }
      expect(h.logger.events("turn_failure_notice_suppressed")).toHaveLength(1);

      setDaemonPaused(h.store, true);
      expect(await h.ingress.admit(request("paused", "panel"))).toBe("suppressed_paused");
      expect(h.store.getMeta("daemon.paused.suppressed_count")).toBe("1");
      setDaemonPaused(h.store, false);
    } finally {
      h.store.close();
    }

    const noLane = createHarness();
    try {
      const noLaneIngress = new OwnerTurnIngress({
        store: noLane.store,
        logger: noLane.logger as unknown as NdjsonLogger,
        hub: noLane.hub,
        outbox: noLane.outbox,
        lanes: () => undefined,
        transcript: () => [
          { role: "user", content: "history survives shutdown", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "still readable" }], timestamp: 2 },
        ],
      });
      expect(await noLaneIngress.admit(request("none", "panel"))).toBe("no_active_lane");
      expect(noLane.events).toHaveLength(0);
      // Admission and read access are intentionally separate: shutdown closes
      // admission immediately, but the control server remains live until lane
      // teardown finishes, so chat.history must keep serving the transcript.
      expect(noLaneIngress.history(50).messages).toEqual([
        expect.objectContaining({ role: "owner", text: "history survives shutdown" }),
        expect.objectContaining({ role: "assistant", text: "still readable" }),
      ]);
    } finally {
      noLane.store.close();
    }
  });

  test("(11) composes history with in-flight state, unmerged echoes, and the byte budget", async () => {
    const h = createHarness(false);
    try {
      h.session.messages = [
        { role: "user", content: "old question", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
        { role: "user", content: request("history", "panel", "current question").promptText, timestamp: 3 },
      ];
      const first = h.ingress.admit(request("history", "panel", "current question"));
      expect(await first).toBe("started");
      const run = activeTurn({ turnId: "history", transcriptIndex: -1 });
      h.ingress.onTurnStarted(run.active);
      h.ingress.onSegment("current segment");
      const pending = h.ingress.admit(request("unmerged", "imessage", "queued question"));
      expect(await pending).toBe("steered");
      const response = h.ingress.history(50);
      expect(response.inFlight).toEqual({ turnId: "history", typing: true });
      expect(response.tail.map((event) => event.payload.text)).toEqual(expect.arrayContaining(["current question", "current segment", "queued question"]));
      expect(response.messages).toEqual([
        expect.objectContaining({ role: "owner", text: "old question" }),
        expect.objectContaining({ role: "assistant", text: "old answer" }),
      ]);
      expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(256 * 1024 - 4_096);
      await settle(run);
    } finally {
      h.store.close();
    }
  });
});
