import { describe, expect, test } from "bun:test";

import { createChildTabRegistry, type ChildTabCdp } from "../../src/browser/child-tab.ts";
import { checkBrowserInput } from "../../src/browser/enforce.ts";

function fakeCdp(initial: Array<{ id: string; title: string; url: string }> = [], opts: { down?: boolean } = {}) {
  const pages = [...initial];
  const log: string[] = [];
  let next = 1;
  const cdp: ChildTabCdp = {
    async pages() {
      if (opts.down) throw new Error("ECONNREFUSED");
      log.push("pages");
      return pages.map((p) => ({ ...p }));
    },
    async createTab() {
      const id = `t${next++}`;
      pages.push({ id, title: "", url: "about:blank" });
      log.push(`create:${id}`);
      return id;
    },
    async title(id, title) {
      const page = pages.find((p) => p.id === id);
      if (page) page.title = title;
      log.push(`title:${id}=${title}`);
    },
    async closeTarget(id) {
      const i = pages.findIndex((p) => p.id === id);
      if (i >= 0) pages.splice(i, 1);
      log.push(`close:${id}`);
    },
  };
  return { cdp, pages, log };
}

describe("child tab registry", () => {
  test("creates one titled tab per child in the existing window, reuses it, and closes it on release", async () => {
    const f = fakeCdp([{ id: "owner", title: "Gmail", url: "https://mail.google.com" }]);
    const tabs = createChildTabRegistry(f.cdp);

    expect(await tabs.ensure("abcd1234-")).toEqual({ targetId: "t1", created: true });
    expect(await tabs.ensure("abcd1234-")).toEqual({ targetId: "t1", created: false });
    expect(await tabs.ensure("ffff0000-")).toEqual({ targetId: "t2", created: true });
    expect(f.pages.map((p) => p.title)).toEqual(["Gmail", "abcd1234-", "ffff0000-"]);

    expect(await tabs.release("abcd1234-")).toBe(true);
    expect(await tabs.release("abcd1234-")).toBe(false);
    expect(f.pages.map((p) => p.title)).toEqual(["Gmail", "ffff0000-"]);
    expect(f.log.filter((l) => l.startsWith("create"))).toEqual(["create:t1", "create:t2"]);
  });

  test("concurrent first calls from the same child create a single tab", async () => {
    const f = fakeCdp();
    const tabs = createChildTabRegistry(f.cdp);
    const [a, b, c] = await Promise.all([tabs.ensure("p-"), tabs.ensure("p-"), tabs.ensure("p-")]);
    expect([a, b, c].map((r) => r?.targetId)).toEqual(["t1", "t1", "t1"]);
    expect(f.log.filter((l) => l.startsWith("create"))).toHaveLength(1);
  });

  test("adopts a tab that already carries the child's title (daemon restart) without creating another", async () => {
    const f = fakeCdp([{ id: "old", title: "p-", url: "https://x" }]);
    const tabs = createChildTabRegistry(f.cdp);
    expect(await tabs.ensure("p-")).toEqual({ targetId: "old", created: false });
    expect(await tabs.release("p-")).toBe(true);
    expect(f.pages).toHaveLength(0);
  });

  test("Chrome not running: ensure is a no-op so the SDK's own launch path runs", async () => {
    const f = fakeCdp([], { down: true });
    const tabs = createChildTabRegistry(f.cdp);
    expect(await tabs.ensure("p-")).toBeUndefined();
    expect(await tabs.release("p-")).toBe(false);
  });
});

describe("enforcer requires app.target for namespaced children", () => {
  const profile = "/Users/x/.openinstinct/chrome-profile";
  const base = { browser: "chrome", user_data_dir: profile, cdp_port: 9222, background: true, no_focus: true };

  test("accepts the child's own tab, rejects a missing or foreign target", () => {
    expect(checkBrowserInput({ app: { ...base, target: "p-" }, name: "p-main" }, profile, "p-")).toBeUndefined();
    expect(checkBrowserInput({ app: base, name: "p-main" }, profile, "p-")).toMatch(/app\.target must be "p-"/);
    expect(checkBrowserInput({ app: { ...base, target: "q-" }, name: "p-main" }, profile, "p-")).toMatch(/got "q-"/);
  });

  test("main session (no prefix) is unaffected", () => {
    expect(checkBrowserInput({ app: base, name: "main" }, profile)).toBeUndefined();
  });
});
