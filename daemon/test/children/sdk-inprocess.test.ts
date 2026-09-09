import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SdkInProcessRunner,
  childSystemPrompt,
  composeChildSessionExtensions,
  type ChildAgentSession,
  type ChildSessionFactory,
} from "../../src/children/runners/sdk-inprocess.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("child application extensions allow raw tools and preserve tab ownership", async () => {
  const handlers: Array<(event: unknown) => unknown> = [];
  const ensured: string[] = [];
  const tabs = {
    ensure: async (prefix: string) => { ensured.push(prefix); return undefined; },
    release: async () => true,
    sweep: async () => [],
  };
  for (const extension of composeChildSessionExtensions("/tmp/child-profile", "child-", tabs)) {
    await extension({
      on: (name: string, handler: (event: unknown) => unknown) => {
        if (name === "tool_call") handlers.push(handler);
      },
    } as never);
  }
  expect(handlers).toHaveLength(1);
  for (const toolName of ["write", "edit", "bash", "browser", "unknown_plugin_tool"]) {
    const input = toolName === "browser"
      ? { action: "click", name: "child-main", app: { browser: "chrome", user_data_dir: "/tmp/child-profile", cdp_port: 9222, target: "child-" } }
      : { path: "/tmp/child-file", command: "touch /tmp/child-file" };
    for (const handler of handlers) {
      expect(await handler({ type: "tool_call", toolCallId: toolName, toolName, input })).toBeUndefined();
    }
  }
  expect(ensured).toEqual(["child-"]);
  expect(await handlers[0]!({ type: "tool_call", toolName: "browser", input: {
    name: "other-main", app: { browser: "chrome", user_data_dir: "/tmp/child-profile", cdp_port: 9222, target: "child-" },
  } })).toMatchObject({ block: true });
  expect(ensured).toEqual(["child-"]);
});

test("observers retain task intent without mandatory managed tools or approval instructions", () => {
  for (const conversational of [false, true]) {
    for (const observations of [false, true]) {
      const prompt = childSystemPrompt(["SDK defaults"], conversational, "child-", observations).join("\n");
      expect(prompt).toContain("SDK runtime tools are available directly; custom managed tools are optional");
      expect(prompt).toContain("verify effects before claiming success");
      expect(prompt).not.toContain("/approve");
      expect(prompt).not.toContain("instead of raw write/edit");
      expect(prompt).not.toContain("remain ambiguous after execution");
      if (observations) expect(prompt).toContain("assigned observation task");
    }
  }
});

class FakeChildSession implements ChildAgentSession {
  public readonly sessionFile = "/tmp/child-session.jsonl";
  public readonly calls: string[] = [];
  public disposed = false;
  private readonly listeners = new Set<(event: unknown) => void>();

  public constructor(private readonly events: readonly unknown[] = [{
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "CHILD_OK" },
  }]) {}

  public async prompt(text: string): Promise<void> {
    this.calls.push(text);
    for (const event of this.events) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
  }
}

describe("SdkInProcessRunner", () => {
  test("uses an injected child session factory and returns its terminal text", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-sdk-child-"));
    directories.push(root);
    const session = new FakeChildSession();
    const factoryCalls: Array<{ readonly childId: string; readonly title: string; readonly workingDirectory: string; readonly sessionDirectory: string; readonly conversational: boolean }> = [];
    const factory: ChildSessionFactory = {
      create: async (input) => {
        factoryCalls.push(input);
        return session;
      },
    };
    const runner = new SdkInProcessRunner({ root, factory });
    let progressEvents = 0;

    const result = await runner.run({
      childId: "child-1",
      title: "Find the answer",
      prompt: "Reply with CHILD_OK",
      onProgress: () => {
        progressEvents += 1;
      },
    }, new AbortController().signal);

    expect(result).toEqual({
      state: "completed",
      summary: "CHILD_OK",
      sessionFile: "/tmp/child-session.jsonl",
    });
    expect(session.calls).toEqual(["Reply with CHILD_OK"]);
    expect(progressEvents).toBe(1);
    expect(session.disposed).toBe(true);
    expect(factoryCalls).toEqual([{
      childId: "child-1",
      title: "Find the answer",
      workingDirectory: join(root, "work", "child-1"),
      sessionDirectory: join(root, "sessions", "child-1"),
      conversational: false,
    }]);
  });

  test("reports SDK tool lifecycle events as progress heartbeats", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-sdk-child-"));
    directories.push(root);
    const session = new FakeChildSession([
      { type: "tool_execution_start" },
      { type: "tool_execution_update" },
      { type: "tool_execution_end" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "DONE" } },
    ]);
    const runner = new SdkInProcessRunner({
      root,
      factory: { create: async () => session },
    });
    const progress: Array<{ readonly tokens?: number; readonly toolCalls?: number }> = [];

    const result = await runner.run({
      childId: "child-tool-progress",
      title: "Use tools",
      prompt: "finish",
      onProgress: (event) => progress.push(event),
    }, new AbortController().signal);

    expect(result).toMatchObject({ state: "completed", summary: "DONE" });
    expect(progress).toHaveLength(4);
    expect(progress[0]).toMatchObject({ toolCalls: 1 });
  });
});
