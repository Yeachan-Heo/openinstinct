import { join } from "node:path";
import type { CustomTool } from "@gajae-code/coding-agent";

import type { ChildConversation, ChildTurnResult, ConversationalChildRunner } from "../conversation.ts";
import { SdkChildSessionFactory, type ChildAgentSession, type ChildSessionFactory } from "./sdk-inprocess.ts";
import { createReportProgressTool } from "../report-progress-tool.ts";

export interface SdkConversationRunnerOptions {
  readonly root: string;
  readonly factory?: ChildSessionFactory;
  /** Required when no factory is injected: the production SDK child model. */
  readonly modelPattern?: string;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
  readonly interimMaxBytes?: number;
  readonly interimRatePerMinute?: number;
  /** Managed tools available to ordinary conversational children. */
  readonly customTools?: readonly CustomTool[];
}

/** Long-lived SDK adapter used only by delegate_background children. */
export class SdkConversationRunner implements ConversationalChildRunner {
  public readonly name = "sdk-conversation";
  private readonly factory: ChildSessionFactory;

  public constructor(private readonly options: SdkConversationRunnerOptions) {
    if (!options.factory && !options.modelPattern) {
      throw new Error("SdkConversationRunner needs modelPattern when using the production SDK factory");
    }
    this.factory = options.factory ?? new SdkChildSessionFactory(options.modelPattern!);
  }

  public async open(
    input: {
      readonly childId: string;
      readonly title: string;
      readonly sessionFile?: string;
      readonly onReport?: (report: {
        readonly text: string;
        readonly toolCallId: string;
        readonly truncated?: boolean;
      }) => {
        readonly accepted: boolean;
        readonly truncated?: boolean;
        readonly bytes?: number;
        readonly reason?: "rate_limited";
        readonly retryAfterSec?: number;
      };
    },
    signal: AbortSignal,
  ): Promise<ChildConversation> {
    const customTools = [
      ...(this.options.customTools ?? []),
      ...(input.onReport === undefined
        ? []
        : [createReportProgressTool({
          childId: input.childId,
          title: input.title,
          admit: input.onReport,
          ...(this.options.interimMaxBytes === undefined ? {} : { maxBytes: this.options.interimMaxBytes }),
          ...(this.options.interimRatePerMinute === undefined ? {} : { ratePerMinute: this.options.interimRatePerMinute }),
        })]),
    ];
    const session = await this.factory.create({
      childId: input.childId,
      title: input.title,
      workingDirectory: join(this.options.root, "work", input.childId),
      sessionDirectory: join(this.options.root, "sessions", input.childId),
      ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
      conversational: true,
      ...(customTools.length === 0 ? {} : { customTools }),
    });
    if (signal.aborted) {
      await Promise.race([
        session.dispose?.().catch(() => undefined) ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      throw abortError();
    }
    return new SdkChildConversation(session, (event, fields) => this.options.onEvent?.(event, { childId: input.childId, ...fields }));
  }
}

interface PendingTurn {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly resolve: (result: ChildTurnResult) => void;
  token: string | undefined;
  started: boolean;
  promptSubmitted: boolean;
  buffer: string;
  toolCalls: number;
  settled: boolean;
  abortTimer: ReturnType<typeof setTimeout> | undefined;
  abortListener: () => void;
  onProgress: (progress: { readonly tokens?: number; readonly toolCalls?: number }) => void;
}

class SdkChildConversation implements ChildConversation {
  private readonly unsubscribe: () => void;
  private generation = 0;
  private readonly seenRunTokens = new Set<string>();
  private readonly settledRunTokens = new Set<string>();
  private pending: PendingTurn | undefined;

  public constructor(
    private readonly session: ChildAgentSession,
    private readonly onEvent?: (event: string, fields: Record<string, unknown>) => void,
  ) {
    this.unsubscribe = session.subscribe?.((event) => this.handleEvent(event)) ?? (() => undefined);
  }

  public get sessionFile(): string | undefined {
    return this.session.sessionFile;
  }

  public get promptHash(): string | undefined {
    return this.session.promptHash;
  }

  public turn(
    prompt: string,
    signal: AbortSignal,
    onProgress: (progress: { readonly tokens?: number; readonly toolCalls?: number }) => void,
  ): Promise<ChildTurnResult> {
    if (this.pending) {
      throw new Error("child conversation already has a running turn");
    }
    const deferred = Promise.withResolvers<ChildTurnResult>();
    const generation = ++this.generation;
    const pending: PendingTurn = {
      generation,
      signal,
      resolve: deferred.resolve,
      token: undefined,
      started: false,
      promptSubmitted: false,
      buffer: "",
      toolCalls: 0,
      settled: false,
      abortTimer: undefined,
      abortListener: () => this.abortTurn(pending),
      onProgress,
    };
    this.pending = pending;
    signal.addEventListener("abort", pending.abortListener, { once: true });
    if (signal.aborted) {
      this.abortTurn(pending);
    }

    void Promise.resolve()
      .then(() => {
        pending.promptSubmitted = true;
        return this.session.prompt(prompt);
      })
      .then(async () => {
        if (!this.isCurrent(pending)) {
          return;
        }
        await this.session.waitForIdle?.();
        if (!this.isCurrent(pending)) {
          return;
        }
        if (this.session.activePromptHandle === undefined) {
          this.event("child_turn_settled_without_agent_end", { generation: pending.generation });
          this.settle(pending, this.completedResult(pending));
        }
      })
      .catch((error) => {
        if (!this.isCurrent(pending)) {
          return;
        }
        const cancelled = pending.signal.aborted;
        this.settle(pending, {
          state: cancelled ? "cancelled" : "failed",
          text: cancelled ? this.textFor(pending) : pending.buffer.trim(),
          errorCode: cancelled ? "cancelled" : errorCodeOf(error),
          errorMessage: cancelled ? "child lifecycle cancelled the task" : messageOf(error),
        });
      });

    return deferred.promise;
  }

  public steer(text: string): void {
    if (!this.session.steer) {
      return;
    }
    void Promise.resolve()
      .then(() => this.session.steer!(text))
      .catch((error) => {
        this.event("child_steer_failed", { message: messageOf(error) });
      });
  }

  public lastAssistantText(): string {
    return this.session.getLastAssistantText?.() ?? latestAssistantText(this.session.messages);
  }

  public async dispose(): Promise<void> {
    this.unsubscribe();
    await this.session.dispose?.();
  }

  private handleEvent(event: unknown): void {
    const pending = this.pending;
    if (!pending || !this.isCurrent(pending) || event === null || typeof event !== "object") {
      return;
    }
    const data = event as Record<string, unknown>;
    const type = data.type;
    if (type === "agent_start") {
      // A session may emit maintenance/continuation starts while the same
      // prompt is still unwinding. Only a current, unseen SDK token can bind
      // this generation; tokenless starts are intentionally non-authoritative.
      if (!pending.promptSubmitted) {
        return;
      }
      const token = typeof data.sdkRunToken === "string" && data.sdkRunToken.length > 0
        ? data.sdkRunToken
        : undefined;
      if (!pending.started && token !== undefined) {
        if (this.seenRunTokens.has(token) || this.settledRunTokens.has(token)) {
          this.event("child_run_token_rejected", { generation: pending.generation, token, reason: "already_seen" });
          return;
        }
        this.seenRunTokens.add(token);
        pending.started = true;
        pending.token = token;
      }
      return;
    }
    if (type === "tool_execution_start") {
      pending.toolCalls += 1;
      const usage = this.session.getContextUsage?.();
      pending.onProgress({
        toolCalls: pending.toolCalls,
        ...(usage?.tokens == null ? {} : { tokens: usage.tokens }),
      });
      return;
    }
    if (type === "message_end" && isAssistantMessage(data)) {
      if (!pending.started || pending.token === undefined) {
        return;
      }
      const usage = this.session.getContextUsage?.();
      if (usage?.tokens != null) {
        pending.onProgress({ tokens: usage.tokens });
      }
      return;
    }
    // Message updates do not carry sdkRunToken in the SDK event contract. They
    // are authoritative only after this generation has claimed an unseen token;
    // tokenless SDK builds remain on the prompt()/waitForIdle fallback.
    if (isTextDelta(event)) {
      if (!pending.started || pending.token === undefined) {
        return;
      }
      pending.buffer += event.assistantMessageEvent.delta;
      return;
    }
    if (type === "agent_end") {
      if (data.stopReason === "maintenance" && data.maintenanceOutcome !== "aborted") {
        return;
      }
      if (!this.matchesToken(pending, data) || pending.generation !== this.generation) {
        return;
      }
      this.settle(pending, pending.signal.aborted
        ? { state: "cancelled", text: this.textFor(pending), errorCode: "cancelled", errorMessage: "child lifecycle cancelled the task" }
        : this.completedResult(pending));
      return;
    }
    if (type === "agent_failed") {
      if (!this.matchesToken(pending, data) || pending.generation !== this.generation) {
        return;
      }
      const error = data.error;
      const diagnostic = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
      this.settle(pending, pending.signal.aborted
        ? { state: "cancelled", text: this.textFor(pending), errorCode: "cancelled", errorMessage: "child lifecycle cancelled the task" }
        : {
          state: "failed",
          text: "",
          errorCode: typeof diagnostic.code === "string" ? diagnostic.code : "child_run_failed",
          errorMessage: typeof diagnostic.message === "string" ? diagnostic.message : "child agent failed",
        });
    }
  }

  private abortTurn(pending: PendingTurn): void {
    if (!this.isCurrent(pending)) {
      return;
    }
    if (this.session.abort) {
      void Promise.resolve()
        .then(() => this.session.abort!({ timeoutMs: 5_000 }))
        .catch((error) => {
          this.event("child_abort_failed", { message: messageOf(error) });
        });
    }
    pending.abortTimer = setTimeout(() => {
      this.settle(pending, {
        state: "cancelled",
        text: this.textFor(pending),
        errorCode: "cancelled",
        errorMessage: "child lifecycle cancelled the task",
      });
    }, 5_000);
  }

  private matchesToken(pending: PendingTurn, event: Record<string, unknown>): boolean {
    if (!pending.started || pending.token === undefined) {
      // Tokenless SDK builds use the prompt()/waitForIdle fallback; an
      // uncorrelated tokenless terminal event is never authoritative.
      return false;
    }
    return event.sdkRunToken === pending.token;
  }

  private completedResult(pending: PendingTurn): ChildTurnResult {
    return { state: "completed", text: this.textFor(pending) };
  }

  private textFor(pending: PendingTurn): string {
    return pending.buffer.trim() || this.lastAssistantText();
  }

  private settle(pending: PendingTurn, result: ChildTurnResult): void {
    if (pending.token !== undefined) {
      this.settledRunTokens.add(pending.token);
    }
    if (!this.isCurrent(pending)) {
      return;
    }
    pending.settled = true;
    if (pending.abortTimer) {
      clearTimeout(pending.abortTimer);
    }
    pending.signal.removeEventListener("abort", pending.abortListener);
    this.pending = undefined;
    pending.resolve(result);
  }

  private isCurrent(pending: PendingTurn): boolean {
    return this.pending === pending && !pending.settled && pending.generation === this.generation;
  }

  private event(event: string, fields: Record<string, unknown>): void {
    this.onEvent?.(event, fields);
  }
}

function isAssistantMessage(event: Record<string, unknown>): boolean {
  const message = event.message;
  return message !== null && typeof message === "object" && (message as { readonly role?: unknown }).role === "assistant";
}

function isTextDelta(event: unknown): event is {
  readonly type: "message_update";
  readonly assistantMessageEvent: { readonly type: "text_delta"; readonly delta: string };
} {
  return event !== null
    && typeof event === "object"
    && (event as { readonly type?: unknown }).type === "message_update"
    && (event as { readonly assistantMessageEvent?: { readonly type?: unknown; readonly delta?: unknown } })
      .assistantMessageEvent?.type === "text_delta"
    && typeof (event as { readonly assistantMessageEvent?: { readonly delta?: unknown } }).assistantMessageEvent?.delta === "string";
}

function latestAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== "object" || (message as { readonly role?: unknown }).role !== "assistant") {
      continue;
    }
    const content = (message as { readonly content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    const text = content
      .filter((block): block is { readonly type: "text"; readonly text: string } => (
        block !== null
        && typeof block === "object"
        && (block as { readonly type?: unknown }).type === "text"
        && typeof (block as { readonly text?: unknown }).text === "string"
      ))
      .map((block) => block.text)
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function errorCodeOf(error: unknown): string {
  if (error !== null && typeof error === "object" && typeof (error as { readonly code?: unknown }).code === "string") {
    return (error as { readonly code: string }).code;
  }
  return "child_run_failed";
}

function messageOf(error: unknown): string {
  return Array.from(error instanceof Error ? error.message : String(error)).slice(0, 500).join("");
}

function abortError(): Error {
  return Object.assign(new Error("child conversation open was cancelled"), { code: "cancelled" });
}
