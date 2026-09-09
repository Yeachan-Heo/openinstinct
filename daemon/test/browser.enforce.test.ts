import { describe, expect, test } from "bun:test";
import { browserProfileEnforcer, checkBrowserInput } from "../src/browser/enforce.ts";

const P = "/Users/x/.openinstinct/chrome-profile";

function toolHandler() {
  const handlers = new Map<string, (event: unknown) => unknown>();
  browserProfileEnforcer(P)({ on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler) } as never);
  return handlers.get("tool_call")!;
}

describe("browser profile enforcement", () => {
  test("only calls pinned to the agent profile pass", () => {
    expect(checkBrowserInput({ action: "open" }, P)).toMatch(/app is missing/);
    expect(checkBrowserInput({ app: { browser: "firefox", user_data_dir: P, cdp_port: 9222 } }, P)).toMatch(/app.browser/);
    expect(checkBrowserInput({ app: { browser: "chrome" } }, P)).toMatch(/user_data_dir must be/);
    expect(checkBrowserInput({ app: { browser: "chrome", user_data_dir: "/Users/x/Library/Application Support/Google/Chrome" } }, P)).toMatch(/user_data_dir must be/);
    expect(checkBrowserInput({ app: { browser: "chrome", user_data_dir: P, cdp_port: 9999 } }, P)).toMatch(/cdp_port/);
    expect(checkBrowserInput({ app: { browser: "chrome", user_data_dir: P, cdp_url: "http://127.0.0.1:9999", cdp_port: 9222 } }, P)).toMatch(/cdp_url/);
    expect(checkBrowserInput({ app: { browser: "chrome", user_data_dir: `${P}/`, cdp_port: 9222 } }, P)).toBeUndefined();
    expect(checkBrowserInput({ app: { browser: "chrome", user_data_dir: P, cdp_url: "http://127.0.0.1:9222", cdp_port: 9222 } }, P)).toBeUndefined();
  });

  test("extension blocks a bare browser call and explains the correct routing", () => {
    const call = toolHandler();
    const blocked = call({ type: "tool_call", toolCallId: "2", toolName: "browser", input: { action: "open", url: "https://x" } }) as { block: boolean; reason: string };
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain(`"user_data_dir":"${P}"`);
    expect(call({ type: "tool_call", toolCallId: "3", toolName: "browser", input: { action: "click", app: { browser: "chrome", user_data_dir: P, cdp_port: 9222 } } })).toBeUndefined();
  });
});

describe("unrestricted non-browser runtime tools", () => {
  test("write, edit, unknown tools and SDK worker tools are not intercepted", () => {
    const call = toolHandler();
    for (const toolName of ["write", "edit", "task", "subagent", "job", "unknown_plugin_tool"]) {
      expect(call({ type: "tool_call", toolCallId: toolName, toolName, input: {} })).toBeUndefined();
    }
  });

  test("diagnostic paths and other agent directories remain accessible", () => {
    const call = toolHandler();
    const root = "/Users/x/.openinstinct";
    const paths = [
      `${root}/children/sessions/abc/2026.jsonl`,
      `${root}/children/journal/a.json:1-50`,
      `${root}/logs/daemon.ndjson`,
      `${root}/gjc/sessions/x.jsonl`,
      `${root}/state.db`,
      `${root}/env`,
      `${root}/secrets/kakao`,
      `${root}/memory/MEMORY.md`,
      `${process.env.HOME}/gajaeway-play/discord/discord-token`,
      `${process.env.HOME}/.gjc/agent/config.yml`,
      `${process.env.HOME}/.gajae-way/config.yml`,
    ];
    for (const path of paths) {
      expect(call({ type: "tool_call", toolCallId: path, toolName: "read", input: { path } })).toBeUndefined();
      expect(call({ type: "tool_call", toolCallId: path, toolName: "bash", input: { command: `cat "${path}"` } })).toBeUndefined();
    }
  });

  test("shell commands have no application timeout or Discord API restriction", () => {
    const call = toolHandler();
    for (const input of [
      { command: "ls" },
      { command: "make", timeout: 120 },
      { command: "sleep 100", async: true },
      { command: 'curl -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/@me' },
      { command: "TOKEN=$(cat ~/gajaeway-play/discord/discord-token)" },
    ]) {
      expect(call({ type: "tool_call", toolCallId: input.command, toolName: "bash", input })).toBeUndefined();
    }
  });

  test("neither non-browser nor correctly routed browser calls exhaust a turn budget", () => {
    const call = toolHandler();
    for (let index = 0; index < 100; index += 1) {
      expect(call({ type: "tool_call", toolCallId: `read-${index}`, toolName: "read", input: { path: "/a.txt" } })).toBeUndefined();
      expect(call({ type: "tool_call", toolCallId: `browser-${index}`, toolName: "browser", input: {
        action: "click", app: { browser: "chrome", user_data_dir: P, cdp_port: 9222 },
      } })).toBeUndefined();
    }
  });
});

describe("per-child tab namespace", () => {
  const app = { browser: "chrome", user_data_dir: "/p", background: true, no_focus: true, cdp_port: 9222 };
  const own = { ...app, target: "abcd1234-" };
  test("tab names outside the child's prefix are refused, including the implicit default", () => {
    expect(checkBrowserInput({ app: own, name: "threads" }, "/p", "abcd1234-")).toContain('start with "abcd1234-"');
    expect(checkBrowserInput({ app: own }, "/p", "abcd1234-")).toContain('got "main"');
    expect(checkBrowserInput({ app: own, name: "abcd1234-threads" }, "/p", "abcd1234-")).toBeUndefined();
  });
  test("a child must target its own tab in the shared window", () => {
    expect(checkBrowserInput({ app, name: "abcd1234-main" }, "/p", "abcd1234-")).toContain('app.target must be "abcd1234-"');
  });
  test("main session has no prefix requirement", () => {
    expect(checkBrowserInput({ app, name: "main" }, "/p")).toBeUndefined();
  });
});
