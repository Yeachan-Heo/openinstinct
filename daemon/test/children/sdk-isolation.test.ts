import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { SdkChildSessionFactory } from "../../src/children/runners/sdk-inprocess.ts";
import { openStateStore } from "../../src/store/index.ts";
import { SdkMainSessionFactory, openMainSession } from "../../src/sdk-session/main-session.ts";

const directories: string[] = [];

type DiscoverySession = {
  getActiveToolNames(): string[];
  getDiscoverableTools(filter: { source: "builtin" }): Array<{ name: string }>;
  activateDiscoveredTools(names: string[]): Promise<string[]>;
};

async function expectNativeWorkerDiscovery(session: DiscoverySession): Promise<void> {
  const names = ["task", "subagent", "job"];
  const discoverable = session.getDiscoverableTools({ source: "builtin" }).map((tool) => tool.name);
  for (const name of names) {
    expect(session.getActiveToolNames()).not.toContain(name);
    expect(discoverable).toContain(name);
  }
  const activated = await session.activateDiscoveredTools(names);
  for (const name of names) {
    expect(activated).toContain(name);
    expect(session.getActiveToolNames()).toContain(name);
  }
  expect(session.getActiveToolNames()).toContain("browser");
  expect(session.getActiveToolNames()).not.toContain("irc");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SDK session registry isolation", () => {
  test("child uses a scope-local registry, unique identity, and no active IRC tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-sdk-isolation-child-"));
    directories.push(root);
    const globalBefore = AgentRegistry.global().list();
    const factory = new SdkChildSessionFactory("anthropic/claude-sonnet-4-5");
    const session = await factory.create({
      childId: "isolation-child",
      title: "Isolation child",
      workingDirectory: join(root, "work"),
      sessionDirectory: join(root, "sessions"),
      conversational: true,
      customTools: [],
    });
    try {
      const active = (session as unknown as { getActiveToolNames(): string[] }).getActiveToolNames();
      expect(active).not.toContain("irc");
      expect(active).toContain("browser");
      expect((session as unknown as { readonly sdkPermissionMode: string }).sdkPermissionMode).toBe("allow");
      await expectNativeWorkerDiscovery(session as unknown as DiscoverySession);
      expect(AgentRegistry.global().list()).toEqual(globalBefore);
      expect(factory.agentRegistry.list()).toHaveLength(1);
      expect(factory.agentRegistry.list()[0]).toMatchObject({
        id: expect.stringContaining("openinstinct-child-isolation-child-"),
        displayName: expect.stringContaining("OpenInstinct child"),
      });
    } finally {
      await session.dispose?.();
    }
    expect(factory.agentRegistry.list()).toHaveLength(0);
    expect(AgentRegistry.global().list()).toEqual(globalBefore);
  }, 15_000);

  test("main uses a separate scope-local registry and disposes its identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-sdk-isolation-main-"));
    directories.push(root);
    const store = openStateStore(join(root, "state.db"));
    const globalBefore = AgentRegistry.global().list();
    const factory = new SdkMainSessionFactory({
      persona: () => ({ ownerHandle: "+821012345678", imessage: "attached" }),
      chromeProfile: join(root, "chrome"),
      modelPattern: "anthropic/claude-sonnet-4-5",
      delegateBackground: () => ({ id: "unused" }),
      sendImage: () => ({ kind: "queued", deliveryId: "unused" }),
    });
    const main = await openMainSession({ store, workingDirectory: join(root, "session"), factory });
    try {
      const active = (main as unknown as { readonly session: { getActiveToolNames(): string[] } }).session.getActiveToolNames();
      expect(active).not.toContain("irc");
      expect(active).toContain("browser");
      expect(active).toContain("delegate_background");
      expect(active).toContain("send_image");
      expect((main as unknown as { readonly session: { readonly sdkPermissionMode: string } }).session.sdkPermissionMode).toBe("allow");
      await expectNativeWorkerDiscovery((main as unknown as { readonly session: DiscoverySession }).session);
      expect(AgentRegistry.global().list()).toEqual(globalBefore);
      expect(factory.agentRegistry.list()).toHaveLength(1);
      expect(factory.agentRegistry.list()[0]).toMatchObject({
        id: expect.stringContaining("openinstinct-main-"),
        displayName: expect.stringContaining("OpenInstinct main"),
      });
    } finally {
      await main.stop();
      store.close();
    }
    expect(factory.agentRegistry.list()).toHaveLength(0);
    expect(AgentRegistry.global().list()).toEqual(globalBefore);
  }, 15_000);
});
