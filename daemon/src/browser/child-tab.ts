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
 * creates a tab in the existing window, titles it with the child's tab
 * prefix so `app.target` can find it, and closes it when the child ends.
 *
 * Identity is the CDP target id, recorded on disk — not the title, which the
 * first navigation overwrites. That record is what lets a restarted daemon
 * (or a sweep) close tabs whose task is gone instead of leaving them behind.
 * Nothing here spawns Chrome; if no instance answers on the pinned CDP port
 * the SDK's own launch path runs.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
  /**
   * Closes every recorded tab whose task is not in `live`, and forgets records
   * whose target no longer exists. Returns the prefixes it closed.
   */
  sweep(live: ReadonlySet<string>): Promise<string[]>;
}

export interface ChildTabRegistryOptions {
  readonly cdp?: ChildTabCdp;
  /** JSON file holding `{ [tabPrefix]: targetId }`; omitted = memory only (tests). */
  readonly statePath?: string;
}

export function createChildTabRegistry(options: ChildTabRegistryOptions = {}): ChildTabRegistry {
  const cdp = options.cdp ?? liveCdp;
  const owned = new Map<string, string>(loadState(options.statePath));
  const inflight = new Map<string, Promise<{ readonly targetId: string; readonly created: boolean } | undefined>>();
  const persist = (): void => saveState(options.statePath, owned);

  async function closeQuietly(targetId: string): Promise<boolean> {
    try {
      await cdp.closeTarget(targetId);
      return true;
    } catch {
      return false;
    }
  }

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
        const recorded = owned.get(tabPrefix);
        if (recorded !== undefined && pages.some((page) => page.id === recorded)) {
          return { targetId: recorded, created: false };
        }
        // Record lost (or never made) but the tab still carries our title.
        const titled = pages.find((page) => page.title === tabPrefix);
        if (titled) {
          owned.set(tabPrefix, titled.id);
          persist();
          return { targetId: titled.id, created: false };
        }
        const targetId = await cdp.createTab();
        owned.set(tabPrefix, targetId);
        persist();
        await cdp.title(targetId, tabPrefix);
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
      persist();
      if (targetId === undefined) return false;
      return closeQuietly(targetId);
    },
    async sweep(live) {
      let pages: Awaited<ReturnType<ChildTabCdp["pages"]>>;
      try {
        pages = await cdp.pages();
      } catch {
        return [];
      }
      const open = new Set(pages.map((page) => page.id));
      const closed: string[] = [];
      for (const [tabPrefix, targetId] of [...owned]) {
        if (!open.has(targetId)) {
          owned.delete(tabPrefix);
          continue;
        }
        if (live.has(tabPrefix)) continue;
        owned.delete(tabPrefix);
        if (await closeQuietly(targetId)) closed.push(tabPrefix);
      }
      // Tabs still titled with a prefix we have no record of (daemon crashed
      // between createTab and persist) are ours too.
      for (const page of pages) {
        if (/^[0-9a-f]{8}-$/.test(page.title) && !live.has(page.title) && !owned.has(page.title)) {
          if (await closeQuietly(page.id)) closed.push(page.title);
        }
      }
      persist();
      return closed;
    },
  };
}

function loadState(path: string | undefined): Array<[string, string]> {
  if (path === undefined) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  } catch {
    return [];
  }
}

function saveState(path: string | undefined, owned: ReadonlyMap<string, string>): void {
  if (path === undefined) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(owned)));
    renameSync(tmp, path);
  } catch {
    // Best effort: losing the record only means a sweep falls back to titles.
  }
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
