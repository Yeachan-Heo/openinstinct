import { describe, expect, test } from "bun:test";
import { browserProfileEnforcer, checkBrowserInput, checkMainBashInput, forbiddenBashReason, forbiddenPathReason } from "../src/browser/enforce.ts";

const P = "/Users/x/.openinstinct/chrome-profile";

describe("browser profile enforcement", () => {
  test("only calls pinned to the agent profile pass", () => {
    expect(checkBrowserInput({ action: "open" }, P)).toMatch(/app is missing/);
    expect(checkBrowserInput({ app: { browser: "chrome" } }, P)).toMatch(/user_data_dir must be/);
    expect(checkBrowserInput({ app: { browser: "chrome", user_data_dir: "/Users/x/Library/Application Support/Google/Chrome" } }, P)).toMatch(/user_data_dir must be/);
    expect(checkBrowserInput({ app: { browser: "chrome", user_data_dir: P, cdp_url: "http://127.0.0.1:9999", cdp_port: 9222 } }, P)).toMatch(/cdp_url/);
    expect(checkBrowserInput({ app: { browser: "chrome", user_data_dir: `${P}/`, cdp_port: 9222 } }, P)).toBeUndefined();
    expect(checkBrowserInput({ app: { browser: "chrome", user_data_dir: P, cdp_url: "http://127.0.0.1:9222", cdp_port: 9222 } }, P)).toBeUndefined();
  });

  test("extension blocks a bare browser call and lets other tools through", () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    browserProfileEnforcer(P)({ on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler) } as never);
    const onToolCall = handlers.get("tool_call")!;
    expect(onToolCall({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "ls" } })).toBeUndefined();
    expect((onToolCall({ type: "tool_call", toolCallId: "t", toolName: "task", input: {} }) as { block: boolean }).block).toBe(true);
    const blocked = onToolCall({ type: "tool_call", toolCallId: "2", toolName: "browser", input: { action: "open", url: "https://x" } }) as { block: boolean; reason: string };
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain(`"user_data_dir":"${P}"`);
    expect(onToolCall({ type: "tool_call", toolCallId: "3", toolName: "browser", input: { action: "open", app: { browser: "chrome", user_data_dir: P, background: true, no_focus: true, cdp_port: 9222 } } })).toBeUndefined();
  });
});

describe("main-session bash guard", () => {
  test("quick or async bash passes; long/blocking bash is redirected to delegate_background", () => {
    expect(checkMainBashInput({ command: "ls", timeout: 5 })).toBeUndefined();
    expect(checkMainBashInput({ command: "sleep 100", async: true })).toBeUndefined();
    expect(checkMainBashInput({ command: "ls" })).toMatch(/delegate_background/);
    expect(checkMainBashInput({ command: "make", timeout: 120 })).toMatch(/async: true/);
    const handlers = new Map<string, (event: unknown) => unknown>();
    browserProfileEnforcer("/x", { guardBash: true })({ on: (n: string, h: (e: unknown) => unknown) => handlers.set(n, h) } as never);
    expect((handlers.get("tool_call")!({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "ls" } }) as { block: boolean }).block).toBe(true);
    const child = new Map<string, (event: unknown) => unknown>();
    browserProfileEnforcer("/x")({ on: (n: string, h: (e: unknown) => unknown) => child.set(n, h) } as never);
    expect(child.get("tool_call")!({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "ls" } })).toBeUndefined();
  });
});

describe("per-turn tool budget", () => {
  test("blocks the 7th call in a turn and resets on turn_start", () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    browserProfileEnforcer("/x", { maxToolCallsPerTurn: 6 })({ on: (n: string, h: (e: unknown) => unknown) => handlers.set(n, h) } as never);
    const call = () => handlers.get("tool_call")!({ type: "tool_call", toolCallId: "c", toolName: "read", input: { path: "/a.txt" } }) as { block?: boolean } | undefined;
    for (let i = 0; i < 6; i += 1) expect(call()).toBeUndefined();
    expect(call()?.block).toBe(true);
    handlers.get("turn_start")!({ type: "turn_start" });
    expect(call()).toBeUndefined();
    expect((handlers.get("tool_call")!({ type: "tool_call", toolCallId: "j", toolName: "job", input: {} }) as { block: boolean }).block).toBe(true);
  });
});

describe("forbidden path guard", () => {
  test("blocks read/bash on children, logs, gjc state, secrets, transcripts; allows memory", () => {
    const root = "/Users/x/.openinstinct";
    expect(forbiddenPathReason(`${root}/children/sessions/abc/2026.jsonl`, root)).toMatch(/off-limits/);
    expect(forbiddenPathReason(`${root}/logs/daemon.ndjson`, root)).toMatch(/daemon logs/);
    expect(forbiddenPathReason(`${root}/gjc/sessions/x.jsonl`, root)).toMatch(/off-limits/);
    expect(forbiddenPathReason(`${root}/secrets/kakao`, root)).toMatch(/credentials/);
    expect(forbiddenPathReason(`${root}/memory/daily/2026-09-02.md`, root)).toBeUndefined();
    expect(forbiddenPathReason("/tmp/shot.png", root)).toBeUndefined();
    const handlers = new Map<string, (event: unknown) => unknown>();
    browserProfileEnforcer("/x", { forbiddenRoot: root })({ on: (n: string, h: (e: unknown) => unknown) => handlers.set(n, h) } as never);
    const tc = handlers.get("tool_call")!;
    expect((tc({ type: "tool_call", toolCallId: "1", toolName: "read", input: { path: `${root}/children/journal/a.json:1-50` } }) as { block: boolean }).block).toBe(true);
    expect((tc({ type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: `tail -c 5000 ${root}/logs/daemon.ndjson`, timeout: 5 } }) as { block: boolean }).block).toBe(true);
    expect(tc({ type: "tool_call", toolCallId: "3", toolName: "bash", input: { command: `cat ${root}/memory/MEMORY.md`, timeout: 5 } })).toBeUndefined();
  });
});

describe("other agents' homes and bot tokens", () => {
  const home = process.env.HOME ?? "";
  test("gajae-way / host gjc directories are off-limits", () => {
    expect(forbiddenPathReason(`${home}/gajaeway-play/discord/discord-token`, `${home}/.openinstinct`)).toContain("another agent");
    expect(forbiddenPathReason(`${home}/.gjc/agent/config.yml`, `${home}/.openinstinct`)).toContain("another agent");
    expect(forbiddenPathReason(`${home}/.openinstinct/memory/MEMORY.md`, `${home}/.openinstinct`)).toBeUndefined();
  });
  test("bash calling the Discord API with a bot token is blocked", () => {
    expect(forbiddenBashReason('curl -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/@me')).toContain("Discord API");
    expect(forbiddenBashReason("TOKEN=$(cat ~/gajaeway-play/discord/discord-token)")).toContain("Discord API");
    expect(forbiddenBashReason("curl https://discord.com/channels/@me")).toBeUndefined();
  });
});

describe("per-child tab namespace", () => {
  const app = { browser: "chrome", user_data_dir: "/p", background: true, no_focus: true, cdp_port: 9222 };
  const own = { ...app, target: "abcd1234-" };
  test("tab names outside the child's prefix are refused, including the implicit default", () => {
    expect(checkBrowserInput({ app: own, name: "threads" }, "/p", "abcd1234-")).toContain('start with "abcd1234-"');
    expect(checkBrowserInput({ app: own }, "/p", "abcd1234-")).toContain("got \"main\"");
    expect(checkBrowserInput({ app: own, name: "abcd1234-threads" }, "/p", "abcd1234-")).toBeUndefined();
  });
  test("a child must target its own tab in the shared window", () => {
    expect(checkBrowserInput({ app, name: "abcd1234-main" }, "/p", "abcd1234-")).toContain('app.target must be "abcd1234-"');
  });
  test("main session has no prefix requirement", () => {
    expect(checkBrowserInput({ app, name: "main" }, "/p")).toBeUndefined();
  });
});
