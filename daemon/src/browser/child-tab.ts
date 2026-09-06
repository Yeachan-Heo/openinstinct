/**
 * One Chrome window, one tab per background task.
 *
 * In profile mode the SDK's browser tool never creates pages: a named tab
 * attaches to an existing page picked by `app.target` (a url/title substring)
 * or, absent that, the first non-helper page. Two tasks would therefore share
 * a page, and a cold start with `background: true` launches Chrome with
 * --no-startup-window and has no page at all.
 *
 * So the daemon provisions the page: before a child's first browser call it
 * creates a tab in the existing window whose document title is the child's
 * tab prefix, and the enforcer requires `app.target` to be that prefix. When
 * the child ends, the tab is closed. Nothing here spawns Chrome; if no
 * instance answers on the pinned CDP port the SDK's own launch path runs.
 */
import { CDP_PORT } from "./open-visible.ts";

export interface ChildTabCdp {
  /** Page targets currently open, oldest first. */
  pages(): Promise<ReadonlyArray<{ readonly id: string; readonly title: string; readonly url: string }>>;
  /** Creates a tab in the existing window and returns its target id. */
  createTab(): Promise<string>;
  /** Sets document.title on a target so `app.target` can find it. */
  title(targetId: string, title: string): Promise<void>;
  closeTarget(targetId: string): Promise<void>;
}

export interface ChildTabRegistry {
  /** Ensures this child's tab exists; no-op when Chrome is not running. */
  ensure(tabPrefix: string): Promise<{ readonly targetId: string; readonly created: boolean } | undefined>;
  /** Closes the child's tab if it still exists. */
  release(tabPrefix: string): Promise<boolean>;
}

export function createChildTabRegistry(cdp: ChildTabCdp = liveCdp): ChildTabRegistry {
  const owned = new Map<string, string>();
  const inflight = new Map<string, Promise<{ readonly targetId: string; readonly created: boolean } | undefined>>();
  return {
    async ensure(tabPrefix) {
      const pending = inflight.get(tabPrefix);
      if (pending) return pending;
      const task = (async () => {
        let pages: Awaited<ReturnType<ChildTabCdp["pages"]>>;
        try {
          pages = await cdp.pages();
        } catch {
          return undefined;
        }
        const existing = pages.find((page) => page.title === tabPrefix);
        if (existing) {
          owned.set(tabPrefix, existing.id);
          return { targetId: existing.id, created: false };
        }
        const targetId = await cdp.createTab();
        await cdp.title(targetId, tabPrefix);
        owned.set(tabPrefix, targetId);
        return { targetId, created: true };
      })();
      inflight.set(tabPrefix, task);
      try {
        return await task;
      } finally {
        inflight.delete(tabPrefix);
      }
    },
    async release(tabPrefix) {
      const targetId = owned.get(tabPrefix);
      owned.delete(tabPrefix);
      if (targetId === undefined) return false;
      try {
        await cdp.closeTarget(targetId);
        return true;
      } catch {
        return false;
      }
    },
  };
}

const liveCdp: ChildTabCdp = {
  async pages() {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
    const list = (await response.json()) as ReadonlyArray<{ id: string; type: string; title: string; url: string }>;
    return list.filter((t) => t.type === "page").map((t) => ({ id: t.id, title: t.title, url: t.url }));
  },
  async createTab() {
    // /json/new opens in the last-focused window of the profile, never a new window.
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(3000) });
    const created = (await response.json()) as { id: string };
    return created.id;
  },
  async title(targetId, title) {
    const ws = new WebSocket(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${targetId}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error("cdp timeout")); }, 3000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `document.title = ${JSON.stringify(title)}` } }));
      ws.onmessage = () => { clearTimeout(timer); ws.close(); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("cdp error")); };
    });
  },
  async closeTarget(targetId) {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${targetId}`, { signal: AbortSignal.timeout(1500) });
  },
};
