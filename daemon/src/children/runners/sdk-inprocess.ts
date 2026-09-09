import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createAgentSession, SessionManager, Settings, type CustomTool } from "@gajae-code/coding-agent";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { browserProfileEnforcer } from "../../browser/enforce.ts";
import { createChildTabRegistry, type ChildTabRegistry } from "../../browser/child-tab.ts";
import { loadSoul } from "../../persona/soul.ts";
import type { ChildRunRequest, ChildRunResult, ChildRunner } from "../runner.ts";
import { CHILD_REPORTING_INSTRUCTION } from "../report-progress-tool.ts";
export interface ChildAgentSession {
  readonly sessionFile?: string;
  readonly messages?: unknown;
  readonly activePromptHandle?: unknown;
  readonly promptHash?: string;
  prompt(text: string): Promise<void>;
  steer?(text: string): Promise<void> | void;
  subscribe?(listener: (event: unknown) => void): () => void;
  abort?(options?: { readonly timeoutMs?: number }): Promise<void> | void;
  dispose?(): Promise<void>;
  getLastAssistantText?(): string;
  getContextUsage?(): { readonly tokens: number | null } | undefined;
  waitForIdle?(): Promise<void>;
  setInterruptMode?(mode: "immediate" | "wait"): void;
}

export interface ChildSessionFactory {
  create(input: {
    readonly childId: string;
    readonly title: string;
    readonly workingDirectory: string;
    readonly sessionDirectory: string;
    readonly sessionFile?: string;
    readonly conversational: boolean;
    readonly customTools?: readonly CustomTool[];
  }): Promise<ChildAgentSession>;
}

export interface SdkInProcessRunnerOptions {
  readonly root: string;
  readonly factory?: ChildSessionFactory;
  /** Required when no factory is injected: the production SDK child model. */
  readonly modelPattern?: string;
  /** Main provides the exact managed or observation-only tools for this child lane. */
  readonly customTools?: readonly CustomTool[];
  /** Shared per-task tab registry for the single browser window. */
  readonly tabs?: ChildTabRegistry;
}

/**
 * The conversational task-tool runner owns a separate file-backed SDK session
 * below ~/.openinstinct/children; it never shares the main session object.
 */
export class SdkInProcessRunner implements ChildRunner {
  public readonly name = "sdk-inprocess";
  private readonly factory: ChildSessionFactory;

  public constructor(private readonly options: SdkInProcessRunnerOptions) {
    if (!options.factory && !options.modelPattern) {
      throw new Error("SdkInProcessRunner needs modelPattern when using the production SDK factory");
    }
    this.factory = options.factory ?? new SdkChildSessionFactory(options.modelPattern!, options.tabs);
  }

  public async run(request: ChildRunRequest, signal: AbortSignal): Promise<ChildRunResult> {
    const workingDirectory = join(this.options.root, "work", request.childId);
    const sessionDirectory = join(this.options.root, "sessions", request.childId);
    let session: ChildAgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let abortListener: (() => void) | undefined;

    try {
      session = await this.factory.create({
        childId: request.childId,
        title: request.title,
        workingDirectory,
        sessionDirectory,
        conversational: false,
        ...(this.options.customTools === undefined || this.options.customTools.length === 0
          ? {}
          : { customTools: [...this.options.customTools] }),
      });
      abortListener = () => {
        if (session?.abort) {
          void Promise.resolve(session.abort({ timeoutMs: 5_000 })).catch(() => undefined);
        }
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) {
        abortListener();
        return {
          state: "cancelled",
          summary: "Background task was cancelled before it started.",
          ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
          errorCode: "cancelled",
          errorMessage: "child lifecycle cancelled the task",
        };
      }

      const capture = capturePrompt(session, request.prompt, request.onProgress);
      unsubscribe = capture.unsubscribe;
      const summary = await capture.result;
      if (signal.aborted) {
        return {
          state: "cancelled",
          summary: "Background task was cancelled.",
          ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
          errorCode: "cancelled",
          errorMessage: "child lifecycle cancelled the task",
        };
      }
      return {
        state: "completed",
        summary: summary || "Child completed without a textual response.",
        ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
      };
    } catch (error) {
      return {
        state: signal.aborted ? "cancelled" : "failed",
        summary: signal.aborted ? "Background task was cancelled." : `Background task failed: ${messageOf(error)}`,
        ...(session?.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
        errorCode: signal.aborted ? "cancelled" : errorCodeOf(error),
        errorMessage: messageOf(error),
      };
    } finally {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      unsubscribe?.();
      if (session?.dispose) {
        await session.dispose().catch(() => undefined);
      }
    }
  }
}

/** Keep each child on its own tab without restricting its runtime tools. */
export function composeChildSessionExtensions(chromeProfile: string, tabPrefix: string, tabs: ChildTabRegistry) {
  return [browserProfileEnforcer(chromeProfile, { tabPrefix, tabs })];
}

export class SdkChildSessionFactory implements ChildSessionFactory {
  public readonly agentRegistry = new AgentRegistry();
  private sessionSequence = 0;

  public constructor(
    private readonly modelPattern: string,
    private readonly tabs: ChildTabRegistry = createChildTabRegistry(),
  ) {}

  public async create(input: {
    readonly childId: string;
    readonly title: string;
    readonly workingDirectory: string;
    readonly sessionDirectory: string;
    readonly sessionFile?: string;
    readonly conversational: boolean;
    readonly customTools?: readonly CustomTool[];
  }): Promise<ChildAgentSession> {
    const sessionSequence = ++this.sessionSequence;
    const agentId = `openinstinct-child-${input.childId}-${sessionSequence}`;
    const settings = Settings.isolated({ "irc.enabled": false, "irc.sidebar.enabled": false });
    let promptHash: string | undefined;
    mkdirSync(input.workingDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(input.sessionDirectory, { recursive: true, mode: 0o700 });
    const tabPrefix = `${input.childId.slice(0, 8)}-`;
    const manager = input.sessionFile === undefined
      ? SessionManager.create(input.workingDirectory, input.sessionDirectory)
      : await SessionManager.open(input.sessionFile);
    const customTools = input.customTools ?? [];
    const { session } = await createAgentSession({
      settings,
      agentRegistry: this.agentRegistry,
      agentId,
      agentDisplayName: `OpenInstinct child ${sessionSequence}`,
      agentRosterLabel: `child-${input.childId}`,
      // Discoverable-only meant the model had to find `browser` via search first;
      // in practice it concluded there was no browser and fell back to osascript.
      alwaysActiveToolNames: ["browser"],
      cwd: input.workingDirectory,
      sessionManager: manager,
      modelPattern: this.modelPattern,
      ...(customTools.length > 0 ? { customTools: [...customTools] } : {}),
      enableLsp: false,
      extensions: composeChildSessionExtensions(join(homedir(), ".openinstinct", "chrome-profile"), tabPrefix, this.tabs),
      systemPrompt: (defaults) => {
        const prompt = childSystemPrompt(
          defaults,
          input.conversational,
          tabPrefix,
          customTools.some((tool) => tool.name === "assistant_work_observe"),
        );
        promptHash = hashPrompt(prompt);
        return prompt;
      },
    });
    const steerable = session as unknown as { setInterruptMode?: (mode: "immediate" | "wait") => void };
    steerable.setInterruptMode?.("wait");
    const childSession = session as unknown as ChildAgentSession & { promptHash?: string };
    if (promptHash !== undefined) {
      childSession.promptHash = promptHash;
    }
    // The child's tab lives in the owner-visible shared window; close it with
    // the session so finished tasks do not pile up as blank tabs.
    const dispose = childSession.dispose?.bind(childSession);
    const tabs = this.tabs;
    childSession.dispose = async () => {
      await tabs.release(tabPrefix).catch(() => false);
      await dispose?.();
    };
    return childSession;
  }
}

export function childSystemPrompt(
  defaults: readonly string[],
  conversational: boolean,
  tabPrefix?: string,
  observationTools = false,
): string[] {
  const chromeProfile = join(homedir(), ".openinstinct", "chrome-profile");
  const browserInstruction = tabPrefix === undefined
    ? `Browser: always pass app: {browser: "chrome", user_data_dir: "${chromeProfile}", background: true, no_focus: true} and reuse the tab named "main"; never use the owner's personal Chrome profile.`
    : `Browser: always pass app: {browser: "chrome", user_data_dir: "${chromeProfile}", background: true, no_focus: true, cdp_port: 9222, target: "${tabPrefix}"}; never use the owner's personal Chrome profile. Other tasks share this browser window: your tab is the one titled "${tabPrefix}" (app.target selects it), and every tab name you use must start with "${tabPrefix}" (e.g. name: "${tabPrefix}main").`;
  return [
    ...defaults,
    loadSoul().text,
    browserInstruction,
    ...(observationTools
      ? ["Use the observation tools to persist evidence and monitor plans. Carry out the assigned observation task without expanding it into unrelated actions; SDK runtime tools remain available directly."]
      : []),
    "SDK runtime tools are available directly; custom managed tools are optional. Report actual tool results and verify effects before claiming success. Inspect uncertain outcomes before repeating an effect.",
    "Keep work focused and report progress during lengthy tasks. Prefer bounded commands or asynchronous execution when useful for responsiveness; these are recommendations, not execution limits.",
    ...(conversational ? [CHILD_REPORTING_INSTRUCTION] : []),
    "Runtime context: you are Gajae running as a background worker inside OpenInstinct; the soul above is unchanged. Complete the assigned task independently and return a concise, factual result for the owner-facing Gajae session to relay. That result is texted to the owner over iMessage, so write it as plain text: no Markdown headings, bold, code fences, tables, or list syntax.",
  ];
}

export function hashPrompt(prompt: readonly string[]): string {
  return createHash("sha256").update(prompt.join("\n")).digest("hex");
}

function capturePrompt(session: ChildAgentSession, prompt: string, onProgress?: (p: { readonly tokens?: number; readonly toolCalls?: number }) => void): {
  readonly result: Promise<string>;
  readonly unsubscribe: () => void;
} {
  let deltas = "";
  let toolCalls = 0;
  const reportProgress = (progress: { readonly tokens?: number; readonly toolCalls?: number } = {}): void => {
    const usage = (session as { getContextUsage?: () => { tokens: number | null } | undefined }).getContextUsage?.();
    onProgress?.({ ...progress, ...(usage?.tokens == null ? {} : { tokens: usage.tokens }) });
  };
  const unsubscribe = session.subscribe?.((event) => {
    const type = (event as { readonly type?: unknown }).type;
    if (type === "tool_execution_start") {
      toolCalls += 1;
      reportProgress({ toolCalls });
      return;
    }
    if (isTextDelta(event)) {
      deltas += event.assistantMessageEvent.delta;
      if (event.assistantMessageEvent.delta.length > 0) {
        reportProgress();
      }
      return;
    }
    if (type === "message_update" || type === "message_end" || type === "tool_execution_end" || type === "tool_execution_update") {
      reportProgress();
    }
  }) ?? (() => undefined);

  const result = Promise.resolve()
    .then(() => session.prompt(prompt))
    .then(() => deltas.trim() || latestAssistantText(session.messages));
  return { result, unsubscribe };
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
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message).slice(0, 500).join("");
}
