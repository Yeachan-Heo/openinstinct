import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildLifecycle } from "../../src/children/lifecycle.ts";
import { ChildRegistry } from "../../src/children/registry.ts";
import { SdkConversationRunner } from "../../src/children/runners/sdk-conversation.ts";
import { SdkInProcessRunner } from "../../src/children/runners/sdk-inprocess.ts";
import { TerminalJournal } from "../../src/children/terminal-journal.ts";
import {
  openMainSession,
  SdkMainSessionFactory,
} from "../../src/sdk-session/main-session.ts";
import { openStateStore, type ReceiptRecord } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 240_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for real delegated child completion");
    }
    await Bun.sleep(250);
  }
}

const runRealSession = process.env.OI_REAL_SESSION === "1" ? test : test.skip;

runRealSession("opens one real SDK session, completes a delegated turn, and releases its child", async () => {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-real-session-"));
  directories.push(root);
  const store = openStateStore(join(root, "state.db"));
  const registry = new ChildRegistry(store);
  const journal = new TerminalJournal(join(root, "children", "journal"));
  const model = process.env.OI_REAL_MODEL ?? "layofflabs-anthropic/claude-sonnet-5";
  const runner = new SdkInProcessRunner({ root: join(root, "children"), modelPattern: model });
  const conversation = new SdkConversationRunner({ root: join(root, "children"), modelPattern: model });
  const receipts: ReceiptRecord[] = [];
  const lifecycle = new ChildLifecycle({
    registry,
    journal,
    runner,
    conversation,
    onReceipt: (receipt) => {
      receipts.push(receipt);
    },
  });
  const factory = new SdkMainSessionFactory({
    persona: () => ({ ownerHandle: "+821012345678", imessage: "attached" }),
    chromeProfile: join(root, "chrome-profile"),
    modelPattern: model,
    delegateBackground: (request) => lifecycle.delegate(request),
    sendImage: () => ({ kind: "queued", deliveryId: "unused-in-this-integration" }),
  });
  const main = await openMainSession({
    store,
    workingDirectory: join(root, "session"),
    factory,
    watchdogMs: 300_000,
  });

  try {
    const turn = await main.turn(
      "Call delegate_background exactly once now with title 'real integration' and prompt 'Reply with exactly CHILD_OK and no other text.' After the tool accepts it, reply exactly DELEGATED.",
    );
    expect(turn).toMatchObject({ kind: "reply" });
    // Pin the SDK transcript shape used by the history reader: both standard
    // messages carry numeric timestamps, and tool calls are content blocks.
    expect(main.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", timestamp: expect.any(Number) }),
      expect.objectContaining({
        role: "assistant",
        timestamp: expect.any(Number),
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "toolCall",
            name: "delegate_background",
            arguments: expect.any(Object),
          }),
        ]),
      }),
    ]));
    expect(registry.list()).toHaveLength(1);
    const childId = registry.list()[0]!.id;
    // A successful conversational turn is durable and idle, not terminal.
    // Progress callbacks must not be mistaken for the completed turn receipt.
    const receipt = await waitFor(() => receipts.find((entry) => entry.idempotencyKey === `child-turn:${childId}:1`));
    const child = store.getChild(childId)!;
    expect(child).toMatchObject({ kind: "task_tool", state: "idle", turnSeq: 1, lastAssistantText: "CHILD_OK" });
    expect(child.sessionFile).toEqual(expect.any(String));
    expect(store.getReceipt(receipt.id)).toMatchObject({
      state: "persisted",
      childId,
      idempotencyKey: `child-turn:${childId}:1`,
      artifactPath: child.sessionFile,
    });
    expect(receipt.projection).toContain("CHILD_OK");
    expect(journal.recoverTerminal(childId)).toBeUndefined();

    expect(lifecycle.release(childId)).toEqual({ status: "released" });
    const terminated = await waitFor(() => {
      const current = store.getChild(childId);
      return current?.state === "terminated" ? current : undefined;
    });
    expect(terminated).toMatchObject({ terminalSummary: "released", turnSeq: 1, lastAssistantText: "CHILD_OK" });
    // Stop flushes/disposes the SDK session before inspecting its on-disk envelope.
    await lifecycle.stop();
    const transcript: unknown[] = readFileSync(child.sessionFile!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "CHILD_OK" })]),
        }),
      }),
    ]));
    expect(store.listReceipts().filter((entry) => entry.childId === childId)).toEqual([store.getReceipt(receipt.id)!]);
    // Idle release is a durable registry termination, not a fabricated terminal report.
    expect(journal.recoverTerminal(childId)).toBeUndefined();
  } finally {
    await lifecycle.stop();
    await main.stop();
    store.close();
  }
}, 300_000);
