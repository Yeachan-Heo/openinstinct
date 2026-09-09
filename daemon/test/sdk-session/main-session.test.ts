import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAIN_SESSION_FILE_META,
  MAIN_SESSION_ID_META,
  MainSession,
  createSendImageTool,
  composeMainSessionExtensions,
  openMainSession,
  type MainAgentSession,
  type ActiveTurn,
  type MainSessionFactory,
  visibleTurnFailure,
} from "../../src/sdk-session/main-session.ts";
import { ORIENTATION_SEPARATOR } from "../../src/persona/orientation.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("main application extensions allow raw tools and retain browser profile routing", async () => {
  const handlers: Array<(event: unknown) => unknown> = [];
  for (const extension of composeMainSessionExtensions("/tmp/autonomous-profile")) {
    await extension({
      on: (name: string, handler: (event: unknown) => unknown) => {
        if (name === "tool_call") handlers.push(handler);
      },
    } as never);
  }
  expect(handlers).toHaveLength(1);
  for (const toolName of ["write", "edit", "bash", "browser", "unknown_plugin_tool"]) {
    const input = toolName === "browser"
      ? { action: "click", app: { browser: "chrome", user_data_dir: "/tmp/autonomous-profile", cdp_port: 9222 } }
      : { path: "/tmp/autonomous-file", command: "touch /tmp/autonomous-file" };
    for (const handler of handlers) {
      expect(await handler({ type: "tool_call", toolCallId: toolName, toolName, input })).toBeUndefined();
    }
  }
  expect(await handlers[0]!({ type: "tool_call", toolName: "browser", input: {} })).toMatchObject({ block: true });
});

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

class FakeSession implements MainAgentSession {
  public readonly sessionFile = "/tmp/main-session.jsonl";
  public readonly sessionId = "main-session-id";
  public readonly calls: string[] = [];
  public readonly messages: unknown = [];
  public abortCalls = 0;
  private readonly listeners = new Set<(event: unknown) => void>();

  public constructor(
    private readonly respond: (prompt: string) => Promise<string>,
    public readonly model?: MainAgentSession["model"],
    private readonly fastActive = false,
  ) {}

  public async prompt(text: string): Promise<void> {
    this.calls.push(text);
    const reply = await this.respond(text);
    for (const listener of this.listeners) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: reply },
      });
    }
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  public isFastModeActive(): boolean {
    return this.fastActive;
  }

  public emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

type FakeStep = string | { readonly text: string; readonly toolExecutionStart?: boolean };

type PinnedFakeOptions = {
  readonly promptBoundaries?: readonly FakeStep[];
  readonly continuationBoundaries?: readonly FakeStep[];
  readonly promptPollAtBoundary?: boolean;
  readonly continuationPollAtBoundary?: boolean;
  readonly autoContinue?: boolean;
};

class FakeAgentSession implements MainAgentSession {
  public readonly sessionFile = "/tmp/pinned-main-session.jsonl";
  public readonly sessionId = "pinned-main-session";
  public readonly messages: unknown[] = [];
  public readonly promptCalls: string[] = [];
  public readonly steerCalls: string[] = [];
  public readonly promptStarted = new Deferred<void>();
  public readonly promptBoundariesDone = new Deferred<void>();
  public readonly continuationBoundariesDone = new Deferred<void>();
  public readonly promptEnded = new Deferred<void>();
  public readonly promptOwnStarted = new Deferred<void>();
  public readonly continuationEnded = new Deferred<void>();
  public promptStartGate: Deferred<void> | undefined;
  public promptAfterOwnGate: Deferred<void> | undefined;
  public promptEndGate: Deferred<void> | undefined;
  public promptResolveGate: Deferred<void> | undefined;
  public continuationOpenGate: Deferred<void> | undefined;
  public continuationEndGate: Deferred<void> | undefined;
  public rejectNextSteer = false;
  public continuationOpens = 0;
  public abortCalls = 0;
  public readonly listeners = new Set<(event: unknown) => void>();
  public readonly emittedEvents: unknown[] = [];
  public live = false;
  private readonly queue: string[] = [];
  private continuationScheduled = false;
  private readonly promptBoundaries: readonly FakeStep[];
  private readonly continuationBoundaries: readonly FakeStep[];
  private readonly promptPollAtBoundary: boolean;
  private readonly continuationPollAtBoundary: boolean;
  private readonly autoContinue: boolean;

  public constructor(options: PinnedFakeOptions = {}) {
    this.promptBoundaries = options.promptBoundaries ?? ["prompt reply"];
    this.continuationBoundaries = options.continuationBoundaries ?? ["continuation reply"];
    this.promptPollAtBoundary = options.promptPollAtBoundary ?? true;
    this.continuationPollAtBoundary = options.continuationPollAtBoundary ?? true;
    this.autoContinue = options.autoContinue ?? true;
  }

  public async prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
    this.live = true;
    this.promptStarted.resolve();
    if (this.promptStartGate) {
      await this.promptStartGate.promise;
    }
    this.emit({ type: "agent_start" });
    this.pushUserMessage(text);
    this.promptOwnStarted.resolve();
    if (this.promptAfterOwnGate) {
      await this.promptAfterOwnGate.promise;
    }
    for (const boundary of this.promptBoundaries) {
      if (this.promptPollAtBoundary) {
        this.consumeQueuedSteers();
      }
      this.pushAssistantMessage(boundary);
    }
    this.promptBoundariesDone.resolve();
    if (this.promptEndGate) {
      await this.promptEndGate.promise;
    }
    this.live = false;
    this.emit({ type: "agent_end" });
    this.promptEnded.resolve();
    if (this.autoContinue && this.queue.length > 0) {
      this.scheduleContinuation();
    }
    if (this.promptResolveGate) {
      await this.promptResolveGate.promise;
    }
  }

  public async steer(text: string): Promise<void> {
    this.steerCalls.push(text);
    if (this.rejectNextSteer) {
      this.rejectNextSteer = false;
      throw new Error("steer rejected");
    }
    this.queue.push(text);
    if (!this.live && this.autoContinue) {
      this.scheduleContinuation();
    }
    await Promise.resolve();
  }

  public async abort(): Promise<void> {
    this.abortCalls += 1;
    this.live = false;
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public emit(event: unknown): void {
    this.emittedEvents.push(event);
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
    this.continuationOpens += 1;
    this.emit({ type: "agent_start" });
    this.consumeQueuedSteers();
    if (this.continuationOpenGate) {
      await this.continuationOpenGate.promise;
    }
    for (const boundary of this.continuationBoundaries) {
      if (this.continuationPollAtBoundary) {
        this.consumeQueuedSteers();
      }
      this.pushAssistantMessage(boundary);
    }
    this.continuationBoundariesDone.resolve();
    if (this.continuationEndGate) {
      await this.continuationEndGate.promise;
    }
    this.live = false;
    this.emit({ type: "agent_end" });
    this.continuationEnded.resolve();
    if (this.autoContinue && this.queue.length > 0) {
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

  private pushAssistantMessage(step: FakeStep): void {
    const text = typeof step === "string" ? step : step.text;
    this.messages.push({ role: "assistant", content: [{ type: "text", text }] });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    if (typeof step !== "string" && step.toolExecutionStart) {
      this.emit({ type: "tool_execution_start", toolName: "bash", args: { command: "true" } });
    }
    this.emit({ type: "message_end", message: { role: "assistant" } });
  }
}

function createStore(): { readonly store: StateStore; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-main-session-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

function factory(session: MainAgentSession): MainSessionFactory {
  return { create: async () => session };
}

type ContinuationState = {
  readonly state: "armed" | "running";
  readonly pendingIds: string[];
  readonly active: ActiveTurn;
};

function continuationState(main: MainSession): ContinuationState | undefined {
  return (main as unknown as { readonly continuation?: ContinuationState }).continuation;
}

describe("MainSession", () => {
  test("serializes owner turns in arrival order", async () => {
    const { store, root } = createStore();
    const firstGate = new Deferred<void>();
    const session = new FakeSession(async (prompt) => {
      if (prompt === "first") {
        await firstGate.promise;
      }
      return `${prompt}-reply`;
    });
    const main = new MainSession({
      session,
      store,
      workingDirectory: root,
      factory: factory(session),
      watchdogMs: 1_000,
    });

    try {
      const first = main.turn("first");
      const second = main.turn("second");
      await Bun.sleep(5);
      expect(session.calls).toEqual(["first"]);

      firstGate.resolve();
      await expect(first).resolves.toEqual({ kind: "reply", text: "first-reply" });
      await expect(second).resolves.toEqual({ kind: "reply", text: "second-reply" });
      expect(session.calls).toEqual(["first", "second"]);
    } finally {
      await main.stop();
      store.close();
    }
  });
  test("uses the orientation separator and exposes the transcript", async () => {
    const { store, root } = createStore();
    const session = new FakeSession(async () => "reply");
    const main = new MainSession({
      session,
      store,
      workingDirectory: root,
      factory: factory(session),
      watchdogMs: 1_000,
      orientation: () => "orientation",
    });

    try {
      await expect(main.turn("hello")).resolves.toEqual({ kind: "reply", text: "reply" });
      expect(session.calls[0]?.startsWith(`orientation${ORIENTATION_SEPARATOR}`)).toBe(true);
      expect(main.transcript).toBe(session.messages);
    } finally {
      await main.stop();
      store.close();
    }
  });

  test("aborts a stalled turn at the watchdog deadline and leaves the queue live", async () => {
    const { store, root } = createStore();
    const session = new FakeSession(async () => await new Promise<string>(() => undefined));
    const main = new MainSession({
      session,
      store,
      workingDirectory: root,
      factory: factory(session),
      watchdogMs: 10,
      abortGraceMs: 10,
    });

    try {
      await expect(main.turn("never finishes")).resolves.toEqual({
        kind: "failed",
        code: "watchdog_timeout",
        message: "turn exceeded 0.01s",
      });
      expect(session.abortCalls).toBe(1);
      expect(visibleTurnFailure({
        kind: "failed",
        code: "watchdog_timeout",
        message: "turn exceeded 300s",
      })).toBe("[turn failed] watchdog_timeout: turn exceeded 300s. The conversation stays live; retry or rephrase.");
    } finally {
      await main.stop();
      store.close();
    }
  });

  test("recreates the same file-backed session when abort is unavailable", async () => {
    const { store, root } = createStore();
    let disposed = false;
    const stalled: MainAgentSession = {
      sessionFile: "/tmp/stalled-main.jsonl",
      sessionId: "stalled-main",
      prompt: async () => await new Promise<void>(() => undefined),
      dispose: async () => {
        disposed = true;
      },
    };
    const replacement = new FakeSession(async () => "replacement reply");
    const inputs: Array<{ readonly workingDirectory: string; readonly sessionFile?: string }> = [];
    const sessionFactory: MainSessionFactory = {
      create: async (input) => {
        inputs.push(input);
        return replacement;
      },
    };
    const main = new MainSession({
      session: stalled,
      store,
      workingDirectory: root,
      factory: sessionFactory,
      watchdogMs: 10,
    });

    try {
      await expect(main.turn("stalled")).resolves.toMatchObject({ code: "watchdog_timeout" });
      await expect(main.turn("after timeout")).resolves.toEqual({ kind: "reply", text: "replacement reply" });
      expect(disposed).toBe(true);
      expect(inputs).toEqual([{ workingDirectory: root, sessionFile: "/tmp/stalled-main.jsonl" }]);
    } finally {
      await main.stop();
      store.close();
    }
  });

  test("reopens the exact persistent session file recorded in StateStore", async () => {
    const { store, root } = createStore();
    const first = new FakeSession(async () => "first");
    const resumed = new FakeSession(async () => "resumed");
    const inputs: Array<{ readonly workingDirectory: string; readonly sessionFile?: string }> = [];
    const sessions = [first, resumed];
    const sessionFactory: MainSessionFactory = {
      create: async (input) => {
        inputs.push(input);
        return sessions.shift()!;
      },
    };

    try {
      const initial = await openMainSession({ store, workingDirectory: root, factory: sessionFactory });
      await initial.stop();
      const reopened = await openMainSession({ store, workingDirectory: root, factory: sessionFactory });
      await reopened.stop();

      expect(inputs).toEqual([
        { workingDirectory: root },
        { workingDirectory: root, sessionFile: "/tmp/main-session.jsonl" },
      ]);
      expect(store.getMeta(MAIN_SESSION_FILE_META)).toBe("/tmp/main-session.jsonl");
      expect(store.getMeta(MAIN_SESSION_ID_META)).toBe("main-session-id");
    } finally {
      store.close();
    }
  });
  test("exposes fast capability and reports provider auto-disable once", async () => {
    const first = createStore();
    const session = new FakeSession(
      async () => "ok",
      { id: "gpt-fast", provider: "custom", compat: { supportsServiceTier: true } },
      true,
    );
    let rejections = 0;
    const main = new MainSession({
      session,
      store: first.store,
      workingDirectory: first.root,
      factory: factory(session),
      onFastModeRejected: () => { rejections += 1; },
    });

    try {
      expect(main.fastModeAvailable).toBe(true);
      expect(main.fastModeEnabled).toBe(true);
      session.emit({ type: "message_end", message: { role: "assistant", disabledFeatures: ["priority"] } });
      session.emit({ type: "message_end", message: { role: "assistant", disabledFeatures: ["priority"] } });
      await Bun.sleep(0);
      expect(rejections).toBe(1);
    } finally {
      await main.stop();
      first.store.close();
    }

    const second = createStore();
    const unsupported = new FakeSession(async () => "ok", { id: "local", provider: "llama.cpp" }, true);
    const unsupportedMain = new MainSession({
      session: unsupported,
      store: second.store,
      workingDirectory: second.root,
      factory: factory(unsupported),
    });
    try {
      expect(unsupportedMain.fastModeAvailable).toBe(false);
      expect(unsupportedMain.fastModeEnabled).toBe(false);
    } finally {
      await unsupportedMain.stop();
      second.store.close();
    }
  });
  test("never repeats an old assistant message when a turn produces no new output", async () => {
    const { store, root } = createStore();
    const stale: MainAgentSession = {
      sessionFile: "/tmp/stale.jsonl",
      sessionId: "stale",
      messages: [{ role: "assistant", content: [{ type: "text", text: "old repeated reply" }] }],
      async prompt() {},
    };
    const main = new MainSession({
      session: stale,
      store,
      workingDirectory: root,
      factory: factory(stale),
    });

    try {
      await expect(main.turn("new question")).resolves.toEqual({
        kind: "failed",
        code: "empty_reply",
        message: "session completed without visible reply text",
      });
    } finally {
      await main.stop();
      store.close();
    }
  });
  test("uses the current message_end payload when no text delta arrives", async () => {
    const { store, root } = createStore();
    const listeners = new Set<(event: unknown) => void>();
    const session: MainAgentSession = {
      sessionFile: "/tmp/message-end.jsonl",
      sessionId: "message-end",
      async prompt() {
        for (const listener of listeners) {
          listener({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "fresh reply" }] },
          });
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const main = new MainSession({ session, store, workingDirectory: root, factory: factory(session) });

    try {
      await expect(main.turn("question")).resolves.toEqual({ kind: "reply", text: "fresh reply" });
    } finally {
      await main.stop();
      store.close();
    }
  });
test("C1 early output attributes the continuation before its first delta", async () => {
  const { store, root } = createStore();
  const session = new FakeAgentSession({
    promptBoundaries: ["prompt output"],
    continuationBoundaries: ["full continuation output"],
  });
  const promptResolveGate = new Deferred<void>();
  session.promptResolveGate = promptResolveGate;
  const timeline: string[] = [];
  const started: ActiveTurn[] = [];
  const segments: string[] = [];
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 1_000,
    onTurnStarted: (active) => {
      started.push(active);
      timeline.push(`started:${active.kind}`);
    },
    onSegment: (text) => {
      segments.push(text);
      timeline.push(`segment:${text}`);
    },
  });

  try {
    const prompt = main.turn({ text: "prompt", owner: true, turnId: "prompt" });
    await session.promptEnded.promise;

    const outcome = await main.steer({ text: "late", owner: true, turnId: "t1" });
    expect(outcome).toEqual({ kind: "admitted" });

    expect(session.continuationOpens).toBe(1);
    const continuation = started.find((active) => active.kind === "continuation");
    expect(continuation).toBeDefined();
    expect(continuation?.openingTurnIds).toEqual(["t1"]);
    expect(timeline.indexOf("started:continuation")).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf("started:continuation")).toBeLessThan(timeline.indexOf("segment:full continuation output"));
    expect(segments).toContain("full continuation output");
    expect(segments).not.toContain("continuation output");
    expect(session.promptCalls).toHaveLength(1);

    await continuation?.settled;
    promptResolveGate.resolve();
    await prompt;
  } finally {
    await main.stop();
    store.close();
  }
});
test("C2 batches concurrent late steers and consumes each id once", async () => {
  const { store, root } = createStore();
  const session = new FakeAgentSession({
    promptBoundaries: ["prompt output"],
    continuationBoundaries: ["batched continuation output"],
  });
  const promptResolveGate = new Deferred<void>();
  const continuationOpenGate = new Deferred<void>();
  session.promptResolveGate = promptResolveGate;
  session.continuationOpenGate = continuationOpenGate;
  const started: ActiveTurn[] = [];
  const merged: Array<{ readonly active: ActiveTurn; readonly turnId: string }> = [];
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 1_000,
    onTurnStarted: (active) => started.push(active),
    onSteerMerged: (active, turnId) => merged.push({ active, turnId }),
  });

  try {
    const prompt = main.turn({ text: "prompt", owner: true, turnId: "prompt" });
    await session.promptEnded.promise;

    const firstSteer = main.steer({ text: "one", owner: true, turnId: "t1" });
    const secondSteer = main.steer({ text: "two", owner: true, turnId: "t2" });
    await expect(Promise.all([firstSteer, secondSteer])).resolves.toEqual([
      { kind: "admitted" },
      { kind: "admitted" },
    ]);

    const continuations = started.filter((active) => active.kind === "continuation");
    expect(continuations).toHaveLength(1);
    const continuation = continuations[0]!;
    expect(continuation.openingTurnIds).toEqual(["t1", "t2"]);
    expect(Object.isFrozen(continuation.openingTurnIds)).toBe(true);
    expect(() => (continuation.openingTurnIds as string[]).push("unexpected")).toThrow();
    expect(continuationState(main)?.pendingIds).toEqual([]);
    expect(continuation.openingTurnIds).toEqual(["t1", "t2"]);
    expect(merged).toEqual([]);

    let settlements = 0;
    continuation.settled.then(() => {
      settlements += 1;
    });
    continuationOpenGate.resolve();
    await continuation.settled;
    expect(settlements).toBe(1);
    expect(session.continuationOpens).toBe(1);
    const userTexts = session.messages
      .filter((message) => (
        message !== null && typeof message === "object" && (message as { readonly role?: unknown }).role === "user"
      ))
      .map((message) => (message as { readonly content: Array<{ readonly text: string }> }).content[0]!.text);
    expect(userTexts).toEqual(["prompt", "one", "two"]);

    promptResolveGate.resolve();
    await prompt;
  } finally {
    await main.stop();
    store.close();
  }
});
test("C3 merges a steer that joins a running continuation at its next boundary", async () => {
  const { store, root } = createStore();
  const session = new FakeAgentSession({
    promptBoundaries: ["prompt output"],
    continuationBoundaries: ["joined continuation output"],
  });
  const promptResolveGate = new Deferred<void>();
  const continuationOpenGate = new Deferred<void>();
  const continuationEndGate = new Deferred<void>();
  session.promptResolveGate = promptResolveGate;
  session.continuationOpenGate = continuationOpenGate;
  session.continuationEndGate = continuationEndGate;
  const started: ActiveTurn[] = [];
  const continuationStarted = new Deferred<ActiveTurn>();
  const merged: Array<{ readonly active: ActiveTurn; readonly turnId: string }> = [];
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 1_000,
    onTurnStarted: (active) => {
      started.push(active);
      if (active.kind === "continuation") {
        continuationStarted.resolve(active);
      }
    },
    onSteerMerged: (active, turnId) => merged.push({ active, turnId }),
  });

  try {
    const prompt = main.turn({ text: "prompt", owner: true, turnId: "prompt" });
    await session.promptEnded.promise;
    await expect(main.steer({ text: "first", owner: true, turnId: "t1" })).resolves.toEqual({ kind: "admitted" });

    const continuation = await continuationStarted.promise;
    expect(continuation.openingTurnIds).toEqual(["t1"]);
    expect(continuationState(main)?.state).toBe("running");
    expect(continuationState(main)?.pendingIds).toEqual([]);

    await expect(main.steer({ text: "joined", owner: true, turnId: "t3" })).resolves.toEqual({ kind: "admitted" });
    expect(continuationState(main)?.pendingIds).toEqual(["t3"]);
    continuationOpenGate.resolve();
    await session.continuationBoundariesDone.promise;

    expect(merged).toHaveLength(1);
    expect(merged[0]?.active).toBe(continuation);
    expect(merged[0]?.turnId).toBe("t3");
    expect(continuation.openingTurnIds).toEqual(["t1"]);
    continuationEndGate.resolve();
    await continuation.settled;
    expect(session.continuationOpens).toBe(1);
    expect(started.filter((active) => active.kind === "continuation")).toHaveLength(1);

    promptResolveGate.resolve();
    await prompt;
  } finally {
    await main.stop();
    store.close();
  }
});
test("C4 skips the prompt user event before merging an in-run steer", async () => {
  const { store, root } = createStore();
  const session = new FakeAgentSession({
    promptBoundaries: ["after steer output"],
  });
  const promptAfterOwnGate = new Deferred<void>();
  session.promptAfterOwnGate = promptAfterOwnGate;
  const started: ActiveTurn[] = [];
  const merged: Array<{ readonly active: ActiveTurn; readonly turnId: string; readonly pending: string[] }> = [];
  const events: string[] = [];
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 1_000,
    onTurnStarted: (active) => started.push(active),
    onSteerMerged: (active, turnId) => merged.push({
      active,
      turnId,
      pending: [...(continuationState(main)?.pendingIds ?? [])],
    }),
    onEvent: (event) => events.push(event),
  });

  try {
    const prompt = main.turn({ text: "prompt", owner: true, turnId: "prompt" });
    const active = await new Promise<ActiveTurn>((resolve) => {
      const check = (): void => {
        const current = started.find((turn) => turn.kind === "prompt");
        if (current) {
          resolve(current);
        } else {
          queueMicrotask(check);
        }
      };
      check();
    });
    await session.promptOwnStarted.promise;
    expect(active.initialUserPending).toBe(0);
    expect(continuationState(main)).toBeUndefined();

    await expect(main.steer({ text: "steered", owner: true, turnId: "t1" })).resolves.toEqual({ kind: "admitted" });
    expect(active.initialUserPending).toBe(0);
    expect(continuationState(main)?.pendingIds).toEqual(["t1"]);
    expect(events).toContain("router_initial_user_skipped");

    promptAfterOwnGate.resolve();
    await prompt;
    expect(merged).toHaveLength(1);
    expect(merged[0]?.active).toBe(active);
    expect(merged[0]?.turnId).toBe("t1");
    expect(merged[0]?.pending).toEqual([]);
    expect(session.continuationOpens).toBe(0);
    expect(continuationState(main)).toBeUndefined();
  } finally {
    await main.stop();
    store.close();
  }
});
test("C5 keeps a steer admitted after the last poll for the next continuation", async () => {
  const { store, root } = createStore();
  const session = new FakeAgentSession({
    promptBoundaries: ["prompt output"],
    continuationBoundaries: ["continuation output"],
  });
  const promptEndGate = new Deferred<void>();
  const continuationOpenGate = new Deferred<void>();
  session.promptEndGate = promptEndGate;
  session.continuationOpenGate = continuationOpenGate;
  const started: ActiveTurn[] = [];
  const continuationStarted = new Deferred<ActiveTurn>();
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 1_000,
    onTurnStarted: (active) => {
      started.push(active);
      if (active.kind === "continuation") {
        continuationStarted.resolve(active);
      }
    },
  });

  try {
    const prompt = main.turn({ text: "prompt", owner: true, turnId: "prompt" });
    await session.promptBoundariesDone.promise;
    await expect(main.steer({ text: "late", owner: true, turnId: "t1" })).resolves.toEqual({ kind: "admitted" });
    expect(continuationState(main)?.pendingIds).toEqual(["t1"]);

    promptEndGate.resolve();
    await session.promptEnded.promise;
    expect(continuationState(main)?.state).toBe("armed");
    expect(continuationState(main)?.pendingIds).toEqual(["t1"]);

    const continuation = await continuationStarted.promise;
    expect(continuation.openingTurnIds).toEqual(["t1"]);
    expect(continuationState(main)?.pendingIds).toEqual([]);
    continuationOpenGate.resolve();
    await continuation.settled;
    expect(session.continuationOpens).toBe(1);
    expect(started.filter((active) => active.kind === "continuation")).toHaveLength(1);
    await prompt;
  } finally {
    await main.stop();
    store.close();
  }
});
test("C6 re-arms only leftover steers after a continuation closes", async () => {
  const { store, root } = createStore();
  const session = new FakeAgentSession({
    promptBoundaries: ["prompt output"],
    continuationBoundaries: ["continuation output"],
  });
  const promptResolveGate = new Deferred<void>();
  const continuationOpenGate = new Deferred<void>();
  const continuationEndGate = new Deferred<void>();
  session.promptResolveGate = promptResolveGate;
  session.continuationOpenGate = continuationOpenGate;
  session.continuationEndGate = continuationEndGate;
  const continuations: ActiveTurn[] = [];
  const firstStarted = new Deferred<ActiveTurn>();
  const secondStarted = new Deferred<ActiveTurn>();
  const merged: string[] = [];
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 1_000,
    onTurnStarted: (active) => {
      if (active.kind !== "continuation") {
        return;
      }
      continuations.push(active);
      if (continuations.length === 1) {
        firstStarted.resolve(active);
      } else if (continuations.length === 2) {
        secondStarted.resolve(active);
      }
    },
    onSteerMerged: (_active, turnId) => merged.push(turnId),
  });

  try {
    const prompt = main.turn({ text: "prompt", owner: true, turnId: "prompt" });
    await session.promptEnded.promise;
    const firstSteer = main.steer({ text: "one", owner: true, turnId: "t1" });
    const secondSteer = main.steer({ text: "two", owner: true, turnId: "t2" });
    await expect(Promise.all([firstSteer, secondSteer])).resolves.toEqual([
      { kind: "admitted" },
      { kind: "admitted" },
    ]);

    const first = await firstStarted.promise;
    expect(first.openingTurnIds).toEqual(["t1", "t2"]);
    expect(continuationState(main)?.pendingIds).toEqual([]);
    continuationOpenGate.resolve();
    await session.continuationBoundariesDone.promise;

    await expect(main.steer({ text: "leftover", owner: true, turnId: "t3" })).resolves.toEqual({ kind: "admitted" });
    expect(continuationState(main)?.pendingIds).toEqual(["t3"]);
    continuationEndGate.resolve();

    const second = await secondStarted.promise;
    expect(second.openingTurnIds).toEqual(["t3"]);
    expect(continuations).toHaveLength(2);
    expect(merged).toEqual([]);
    expect(session.continuationOpens).toBe(2);
    expect([...first.openingTurnIds!, ...second.openingTurnIds!]).toEqual(["t1", "t2", "t3"]);
    const userTexts = session.messages
      .filter((message) => (
        message !== null && typeof message === "object" && (message as { readonly role?: unknown }).role === "user"
      ))
      .map((message) => (message as { readonly content: Array<{ readonly text: string }> }).content[0]!.text);
    expect(userTexts).toEqual(["prompt", "one", "two", "leftover"]);
    await Promise.all(continuations.map((active) => active.settled));

    promptResolveGate.resolve();
    await prompt;
  } finally {
    await main.stop();
    store.close();
  }
});
test("C7 promotes an internal run only when its owner steer is consumed, and rejects cleanly", async () => {
  const { store, root } = createStore();
  const session = new FakeAgentSession({
    promptBoundaries: [{ text: "promoted segment", toolExecutionStart: true }],
  });
  const promptAfterOwnGate = new Deferred<void>();
  session.promptAfterOwnGate = promptAfterOwnGate;
  const started: ActiveTurn[] = [];
  const promoted: Array<{ readonly active: ActiveTurn; readonly turnId: string }> = [];
  const merged: string[] = [];
  const segments: string[] = [];
  const events: string[] = [];
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 1_000,
    onTurnStarted: (active) => started.push(active),
    onTurnPromoted: (active, turnId) => promoted.push({ active, turnId }),
    onSteerMerged: (_active, turnId) => merged.push(turnId),
    onSegment: (text) => segments.push(text),
    onEvent: (event) => events.push(event),
  });

  try {
    const turn = main.turn({ text: "notify", owner: false });
    const active = await new Promise<ActiveTurn>((resolve) => {
      const check = (): void => {
        const current = started[0];
        if (current) {
          resolve(current);
        } else {
          queueMicrotask(check);
        }
      };
      check();
    });
    await session.promptOwnStarted.promise;
    expect(active.owner).toBe(false);
    expect(active.initialUserPending).toBe(0);
    expect(main.busy).toBe(false);

    await expect(main.steer({ text: "owner steer", owner: true, turnId: "t1" })).resolves.toEqual({ kind: "admitted" });
    expect(promoted).toEqual([]);
    expect(segments).toEqual([]);
    expect(continuationState(main)?.pendingIds).toEqual(["t1"]);

    promptAfterOwnGate.resolve();
    await turn;
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.active).toBe(active);
    expect(promoted[0]?.turnId).toBe("t1");
    expect(active.owner).toBe(true);
    expect(main.busy).toBe(false);
    expect(merged).toEqual([]);
    expect(segments).toEqual(["promoted segment"]);
    expect(events.filter((event) => event === "router_initial_user_skipped")).toHaveLength(1);
    expect(session.continuationOpens).toBe(0);
    expect(continuationState(main)).toBeUndefined();
  } finally {
    await main.stop();
    store.close();
  }

  const rejectedStore = createStore();
  const rejectedSession = new FakeAgentSession({ promptBoundaries: [] });
  const promptStartGate = new Deferred<void>();
  rejectedSession.promptStartGate = promptStartGate;
  rejectedSession.rejectNextSteer = true;
  const rejectedStarted = new Deferred<ActiveTurn>();
  const rejectedPromotions: string[] = [];
  const rejectedMain = new MainSession({
    session: rejectedSession,
    store: rejectedStore.store,
    workingDirectory: rejectedStore.root,
    factory: factory(rejectedSession),
    watchdogMs: 1_000,
    onTurnStarted: (active) => {
      if (!active.owner) {
        rejectedStarted.resolve(active);
      }
    },
    onTurnPromoted: (_active, turnId) => rejectedPromotions.push(turnId),
  });
  try {
    const rejectedTurn = rejectedMain.turn({ text: "notify", owner: false });
    await rejectedStarted.promise;
    await rejectedSession.promptStarted.promise;
    await expect(rejectedMain.steer({ text: "rejected", owner: true, turnId: "t2" })).resolves.toMatchObject({
      kind: "not_admitted",
      reason: "rejected",
    });
    expect(continuationState(rejectedMain)).toBeUndefined();
    expect(rejectedPromotions).toEqual([]);
    promptStartGate.resolve();
    await rejectedTurn;
  } finally {
    await rejectedMain.stop();
    rejectedStore.store.close();
  }
});
test("C8 times out an armed continuation that never runs and releases the queue", async () => {
  const { store, root } = createStore();
  const session = new FakeAgentSession({ autoContinue: false, promptBoundaries: ["prompt output"] });
  const promptEndGate = new Deferred<void>();
  session.promptEndGate = promptEndGate;
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 20,
    abortGraceMs: 10,
  });

  try {
    const prompt = main.turn({ text: "prompt", owner: true, turnId: "prompt" });
    await session.promptBoundariesDone.promise;
    await expect(main.steer({ text: "never runs", owner: true, turnId: "t1" })).resolves.toEqual({ kind: "admitted" });
    const armed = continuationState(main)?.active;
    expect(armed).toBeDefined();
    expect(continuationState(main)?.pendingIds).toEqual(["t1"]);

    promptEndGate.resolve();
    await prompt;
    await expect(armed!.settled).resolves.toMatchObject({
      kind: "failed",
      code: "watchdog_timeout",
    });
    expect(session.continuationOpens).toBe(0);
    expect(session.abortCalls).toBe(1);
    expect(continuationState(main)).toBeUndefined();

    session.promptEndGate = undefined;
    await expect(main.turn({ text: "after timeout", owner: true, turnId: "after" })).resolves.toMatchObject({ kind: "reply" });
    expect(session.promptCalls).toEqual(["prompt", "after timeout"]);
  } finally {
    await main.stop();
    store.close();
  }
});
test("C9 never lets an owner prompt's own user event consume an armed steer", async () => {
  // Variant (a): the live prompt run consumes the steer at its next boundary.
  const inRun = createStore();
  const inRunSession = new FakeAgentSession({ promptBoundaries: ["prompt output"] });
  const inRunStartGate = new Deferred<void>();
  inRunSession.promptStartGate = inRunStartGate;
  const inRunAfterOwnGate = new Deferred<void>();
  inRunSession.promptAfterOwnGate = inRunAfterOwnGate;
  const inRunStarted: ActiveTurn[] = [];
  const inRunMerged: string[] = [];
  const inRunPromoted: string[] = [];
  const inRunEvents: string[] = [];
  const inRunMain = new MainSession({
    session: inRunSession,
    store: inRun.store,
    workingDirectory: inRun.root,
    factory: factory(inRunSession),
    watchdogMs: 1_000,
    onTurnStarted: (active) => inRunStarted.push(active),
    onSteerMerged: (_active, turnId) => inRunMerged.push(turnId),
    onTurnPromoted: (_active, turnId) => inRunPromoted.push(turnId),
    onEvent: (event) => inRunEvents.push(event),
  });

  try {
    const turn = inRunMain.turn({ text: "prompt", owner: true, turnId: "prompt" });
    // The wrapper publishes its prompt turn while session.prompt() is still deferred.
    await inRunSession.promptStarted.promise;
    expect(inRunStarted).toHaveLength(1);
    expect(inRunStarted[0]?.kind).toBe("prompt");
    expect(inRunStarted[0]?.initialUserPending).toBe(1);

    // A steer admitted in that window arms the continuation before the SDK emits anything.
    await expect(inRunMain.steer({ text: "steer", owner: true, turnId: "t1" })).resolves.toEqual({ kind: "admitted" });
    expect(continuationState(inRunMain)?.pendingIds).toEqual(["t1"]);

    // The prompt's OWN user message_start must decrement the counter and leave the FIFO intact.
    inRunStartGate.resolve();
    await inRunSession.promptOwnStarted.promise;
    expect(inRunStarted[0]?.initialUserPending).toBe(0);
    expect(continuationState(inRunMain)?.pendingIds).toEqual(["t1"]);
    expect(inRunMerged).toEqual([]);
    expect(inRunPromoted).toEqual([]);
    expect(inRunEvents.filter((event) => event === "router_initial_user_skipped")).toHaveLength(1);

    inRunAfterOwnGate.resolve();
    await turn;
    // Consumed in-run: exactly one merge, and no continuation run was needed.
    expect(inRunMerged).toEqual(["t1"]);
    expect(inRunPromoted).toEqual([]);
    expect(inRunSession.continuationOpens).toBe(0);
    expect(continuationState(inRunMain)).toBeUndefined();
  } finally {
    await inRunMain.stop();
    inRun.store.close();
  }

  // Variant (b): agent_end arrives before the steer is consumed, so the arm survives.
  const survives = createStore();
  const survivesSession = new FakeAgentSession({
    promptBoundaries: ["prompt output"],
    promptPollAtBoundary: false,
    continuationBoundaries: ["continuation output"],
  });
  const survivesStartGate = new Deferred<void>();
  survivesSession.promptStartGate = survivesStartGate;
  const survivesStarted: ActiveTurn[] = [];
  const survivesMerged: string[] = [];
  const survivesEvents: string[] = [];
  const survivesMain = new MainSession({
    session: survivesSession,
    store: survives.store,
    workingDirectory: survives.root,
    factory: factory(survivesSession),
    watchdogMs: 1_000,
    onTurnStarted: (active) => survivesStarted.push(active),
    onSteerMerged: (_active, turnId) => survivesMerged.push(turnId),
    onEvent: (event) => survivesEvents.push(event),
  });

  try {
    const turn = survivesMain.turn({ text: "prompt", owner: true, turnId: "prompt" });
    await survivesSession.promptStarted.promise;
    await expect(survivesMain.steer({ text: "steer", owner: true, turnId: "t1" })).resolves.toEqual({ kind: "admitted" });
    survivesStartGate.resolve();
    await survivesSession.promptOwnStarted.promise;
    expect(continuationState(survivesMain)?.pendingIds).toEqual(["t1"]);

    await turn;
    await survivesSession.continuationEnded.promise;
    // The arm was never discarded at agent_end, so a continuation run owns t1.
    expect(survivesSession.continuationOpens).toBe(1);
    const continuation = survivesStarted.find((active) => active.kind === "continuation");
    expect(continuation?.openingTurnIds).toEqual(["t1"]);
    expect(survivesMerged).toEqual([]);
    expect(survivesEvents.filter((event) => event === "router_initial_user_skipped")).toHaveLength(1);
    await expect(continuation!.settled).resolves.toMatchObject({ kind: "reply" });
  } finally {
    await survivesMain.stop();
    survives.store.close();
  }
});
test("C10 never lets an internal prompt's own user event promote an armed steer", async () => {
  const { store, root } = createStore();
  const session = new FakeAgentSession({
    promptBoundaries: ["internal output"],
    promptPollAtBoundary: false,
    continuationBoundaries: ["continuation output"],
  });
  const promptStartGate = new Deferred<void>();
  session.promptStartGate = promptStartGate;
  const started: ActiveTurn[] = [];
  const promoted: string[] = [];
  const merged: string[] = [];
  const segments: string[] = [];
  const events: string[] = [];
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 1_000,
    onTurnStarted: (active) => started.push(active),
    onTurnPromoted: (_active, turnId) => promoted.push(turnId),
    onSteerMerged: (_active, turnId) => merged.push(turnId),
    onSegment: (text) => segments.push(text),
    onEvent: (event) => events.push(event),
  });

  try {
    const turn = main.turn({ text: "notify", owner: false });
    await session.promptStarted.promise;
    expect(started[0]?.owner).toBe(false);

    await expect(main.steer({ text: "owner steer", owner: true, turnId: "t1" })).resolves.toEqual({ kind: "admitted" });
    expect(continuationState(main)?.pendingIds).toEqual(["t1"]);

    // The internal prompt's own user event is skipped: no promotion, no segment sink.
    promptStartGate.resolve();
    await session.promptOwnStarted.promise;
    expect(promoted).toEqual([]);
    expect(continuationState(main)?.pendingIds).toEqual(["t1"]);
    expect(events.filter((event) => event === "router_initial_user_skipped")).toHaveLength(1);

    await turn;
    // The internal run's own output never reached the owner segment sink.
    expect(segments).not.toContain("internal output");
    expect(promoted).toEqual([]);

    await session.continuationEnded.promise;
    const continuation = started.find((active) => active.kind === "continuation");
    expect(continuation?.owner).toBe(true);
    expect(continuation?.openingTurnIds).toEqual(["t1"]);
    expect(merged).toEqual([]);
    // The text streamed as a flushed segment, so the settled reply carries no residual text.
    await expect(continuation!.settled).resolves.toMatchObject({ kind: "reply", text: "" });
    expect(segments).toContain("continuation output");
  } finally {
    await main.stop();
    store.close();
  }
});
test("steer outcomes: a queued owner box absorbs steers without an SDK call", async () => {
  const { store, root } = createStore();
  const session = new FakeAgentSession({ promptBoundaries: ["first output"] });
  const promptEndGate = new Deferred<void>();
  session.promptEndGate = promptEndGate;
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 1_000,
  });

  try {
    const first = main.turn({ text: "first", owner: true, turnId: "first" });
    await session.promptStarted.promise;
    // A second owner turn is boxed in `pending` behind the live one.
    const second = main.turn({ text: "second", owner: true, turnId: "second" });
    await expect(main.steer({ text: "s1", owner: true, turnId: "t1" })).resolves.toEqual({ kind: "admitted" });
    await expect(main.steer({ text: "s2", owner: true, turnId: "t2" })).resolves.toEqual({ kind: "admitted" });
    // Absorbed by the queued box: no SDK steer yet, and no continuation armed.
    expect(session.steerCalls).toEqual([]);
    expect(continuationState(main)).toBeUndefined();

    promptEndGate.resolve();
    await first;
    await second;
    // Injected as two distinct ordered SDK steers, never concatenated.
    expect(session.steerCalls).toEqual(["s1", "s2"]);
  } finally {
    await main.stop();
    store.close();
  }
});
test("steer outcomes: idle and missing-steer-api sessions are not admitted", async () => {
  const idle = createStore();
  const idleSession = new FakeAgentSession();
  const idleMain = new MainSession({
    session: idleSession,
    store: idle.store,
    workingDirectory: idle.root,
    factory: factory(idleSession),
    watchdogMs: 1_000,
  });
  try {
    await expect(idleMain.steer({ text: "nothing live", owner: true, turnId: "t1" })).resolves.toMatchObject({
      kind: "not_admitted",
      reason: "idle",
    });
    expect(idleSession.steerCalls).toEqual([]);
  } finally {
    await idleMain.stop();
    idle.store.close();
  }

  const noApi = createStore();
  const noApiSession = new FakeSession(async () => "reply");
  const noApiMain = new MainSession({
    session: noApiSession,
    store: noApi.store,
    workingDirectory: noApi.root,
    factory: factory(noApiSession),
    watchdogMs: 1_000,
  });
  try {
    await expect(noApiMain.steer({ text: "no api", owner: true, turnId: "t1" })).resolves.toMatchObject({
      kind: "not_admitted",
      reason: "no_steer_api",
    });
  } finally {
    await noApiMain.stop();
    noApi.store.close();
  }
});
test("activeTurn.transcriptIndex equals the message count at prompt time", async () => {
  const { store, root } = createStore();
  const session = new FakeAgentSession({ promptBoundaries: ["first output"] });
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 1_000,
  });

  try {
    await main.turn({ text: "first", owner: true, turnId: "first" });
    const countAfterFirst = session.messages.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    const started: ActiveTurn[] = [];
    const secondMain = new MainSession({
      session,
      store,
      workingDirectory: root,
      factory: factory(session),
      watchdogMs: 1_000,
      onTurnStarted: (active) => started.push(active),
    });
    try {
      await secondMain.turn({ text: "second", owner: true, turnId: "second" });
      expect(started[0]?.transcriptIndex).toBe(countAfterFirst);
    } finally {
      await secondMain.stop();
    }
  } finally {
    await main.stop();
    store.close();
  }
});
test("the send_image tool reports queued and chat-only outcomes distinctly", async () => {
  const queuedTool = createSendImageTool(() => ({ kind: "queued", deliveryId: "delivery-1" }));
  const queued = await queuedTool.execute("call-1", { filePath: "/tmp/a.png", caption: "a picture" }, undefined, {} as never);
  expect(JSON.stringify(queued.content)).toContain("Image queued for delivery as delivery-1");
  expect(queued.details).toEqual({ kind: "queued", deliveryId: "delivery-1" });

  const chatOnlyTool = createSendImageTool(() => ({ kind: "chat_only" }));
  const chatOnly = await chatOnlyTool.execute("call-2", { filePath: "/tmp/b.png", caption: "b picture" }, undefined, {} as never);
  expect(JSON.stringify(chatOnly.content)).toContain("iMessage is not connected");
  expect(chatOnly.details).toEqual({ kind: "chat_only" });
});
test("publishes safe internal replies once even when iMessage is detached", async () => {
  const { store, root } = createStore();
  const session = new FakeSession(async () => "unused");
  const published: string[] = [];
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    ownerDelivery: () => undefined,
    onOwnerReply: (reply) => published.push(reply.text),
  });
  try {
    expect(main.admitOwnerReply({ idempotencyKey: "recovery:1", text: "The task completed successfully; no action is needed." })).toEqual({ id: "" });
    main.admitOwnerReply({ idempotencyKey: "recovery:1", text: "The task completed successfully; no action is needed." });
    expect(published).toEqual(["The task completed successfully; no action is needed."]);
    expect(() => main.admitOwnerReply({ idempotencyKey: "recovery:2", text: "timeout" })).toThrow("owner reply failed safety policy");
  } finally {
    await main.stop();
    store.close();
  }
});
test("stop bounds a hanging abort and settles queued callers", async () => {
  const { store, root } = createStore();
  const never = new Promise<string>(() => undefined);
  const session = new FakeSession(async () => await never);
  (session as unknown as { abort: () => Promise<void> }).abort = async () => await new Promise<void>(() => undefined);
  const authoritative: ActiveTurn[] = [];
  const main = new MainSession({
    session,
    store,
    workingDirectory: root,
    factory: factory(session),
    watchdogMs: 10_000,
    abortGraceMs: 10,
    onTurnStarted: (turn) => authoritative.push(turn),
  });
  const active = main.turn({ text: "held", owner: true, turnId: "held" });
  const queued = main.turn({ text: "queued", owner: true, turnId: "queued" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const startedAt = Date.now();
    await main.stop();
    expect(Date.now() - startedAt).toBeLessThan(100);
    await expect(active).resolves.toMatchObject({ kind: "failed", code: "session_stopping" });
    await expect(queued).resolves.toMatchObject({ kind: "failed", code: "session_stopping" });
    await expect(authoritative[0]?.settled).resolves.toMatchObject({ kind: "failed", code: "session_stopping" });
  } finally {
    store.close();
  }
});
test("an internal turn returns its streamed reply text instead of an empty segment result", async () => {
  const { store, root } = createStore();
  const session = new FakeSession(async () => "[[no-owner-message]]");
  const segments: string[] = [];
  const main = new MainSession({ session, store, workingDirectory: root, factory: factory(session), onSegment: (text) => segments.push(text) });
  try {
    await expect(main.turn({ text: "internal receipt triage", owner: false })).resolves.toEqual({ kind: "reply", text: "[[no-owner-message]]" });
    expect(segments).toEqual([]);
  } finally {
    await main.stop();
    store.close();
  }
});
});
