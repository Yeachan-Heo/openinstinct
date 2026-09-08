import type { ChildTabRegistry } from "./child-tab.ts";
import type { ExtensionFactory } from "@gajae-code/coding-agent";

/**
 * Hard rule, not a prompt: every `browser` tool call must run on Gajae's own
 * persistent Chrome profile. The extension hook cannot rewrite inputs, so a
 * bare or mis-targeted call is blocked with the exact `app` block to pass;
 * the model retries correctly on the next step. Nothing ever reaches the
 * owner's personal Chrome profile or a throwaway temp profile.
 */
/** Main session only: bash must not block the owner's chat. */
const MAIN_BASH_MAX_TIMEOUT_S = 20;

export function checkMainBashInput(input: Record<string, unknown>): string | undefined {
  if (input.async === true) {
    return undefined;
  }
  const timeout = typeof input.timeout === "number" ? input.timeout : undefined;
  if (timeout !== undefined && timeout <= MAIN_BASH_MAX_TIMEOUT_S) {
    return undefined;
  }
  return `In the owner chat, bash must either be quick (timeout ≤ ${MAIN_BASH_MAX_TIMEOUT_S}s, set explicitly) or run with async: true. For anything longer or multi-step, use delegate_background and tell the owner it is underway`;
}

/**
 * Paths no session may read with `read`/`bash`: our own transcripts, journals
 * and logs. They are huge, self-referential, and reading them once blew a
 * monitor child past the 1 MiB output cap. Memory lives elsewhere and is fine.
 */
export function forbiddenPathReason(target: string, root: string): string | undefined {
  const norm = target.replace(/\/+$/, "");
  const banned = [
    [`${root}/children`, "child work/session/journal directories"],
    [`${root}/logs`, "daemon logs"],
    [`${root}/gjc`, "the SDK state directory (sessions, auth)"],
    [`${root}/state.db`, "the daemon state database"],
    [`${root}/env`, "the credentials file"],
    [`${root}/secrets`, "stored credentials (use them via the service, never read them back)"],
  ] as const;
  for (const [prefix, what] of banned) {
    if (norm === prefix || norm.startsWith(`${prefix}/`)) {
      return `Reading ${what} is off-limits: it is enormous and not information for the owner. Use memory_search / the memory directory instead.`;
    }
  }
  // Other agents' homes on this Mac: their bot tokens, gateways and memory
  // are not ours. A child once read the gajae-way Discord bot token from
  // here and started calling the Discord API as that bot.
  const home = process.env.HOME ?? "";
  for (const other of [`${home}/gajaeway-play`, `${home}/.gjc`, `${home}/.gajae-way`]) {
    if (norm === other || norm.startsWith(`${other}/`)) {
      return "That directory belongs to another agent running on this Mac (its credentials, gateway and memory). Never read or use it; Discord is only reachable through the browser as the owner.";
    }
  }
  if (/\.jsonl$/.test(norm) && norm.includes("/sessions/")) {
    return "Session transcripts are off-limits (they are your own history, and huge). Use memory_search instead.";
  }
  return undefined;
}

/** Bot-token API calls are never ours: Discord is a browser-only surface for this agent. */
export function forbiddenBashReason(command: string): string | undefined {
  if (/discord(app)?\.com\/api\b/i.test(command) || /Authorization:\s*Bot\b/i.test(command) || /discord[-_]token/i.test(command)) {
    return "Calling the Discord API with a bot token is off-limits: that bot belongs to another agent. Read Discord through the browser as the owner, and never post there.";
  }
  return undefined;
}

function pathsInBash(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s"'=])(\/[^\s"'|;&<>]+|~\/[^\s"'|;&<>]+)/g)].map((m) => m[1]!.replace(/^~/, process.env.HOME ?? "~"));
}

export function browserProfileEnforcer(chromeProfile: string, options: { readonly guardBash?: boolean; readonly maxToolCallsPerTurn?: number; readonly forbiddenRoot?: string; readonly tabPrefix?: string; readonly tabs?: ChildTabRegistry } = {}): ExtensionFactory {
  let turnCalls = 0;
  const targetHint = options.tabPrefix ? `,"target":"${options.tabPrefix}"` : "";
  const required = `app: {"browser":"chrome","user_data_dir":"${chromeProfile}","background":true,"no_focus":true,"cdp_port":9222${targetHint}}`;
  const tabHint = options.tabPrefix ? `name "${options.tabPrefix}main"` : `tab "main"`;
  return (pi) => {
    pi.on("turn_start", () => { turnCalls = 0; });
    pi.on("tool_call", (event) => {
      // gjc's own subagent spawner bypasses OpenInstinct's child lifecycle
      // (concurrency cap, receipts, journal, panel visibility, model pin,
      // this very enforcer). Background work goes through delegate_background.
      if (event.toolName === "task" || event.toolName === "subagent" || event.toolName === "job") {
        return { block: true, reason: "That tool is not available here. Background work goes through delegate_background; answer the owner with what you have." };
      }
      if (options.maxToolCallsPerTurn !== undefined) {
        turnCalls += 1;
        if (turnCalls > options.maxToolCallsPerTurn) {
          return { block: true, reason: `Tool budget for this reply is spent (${options.maxToolCallsPerTurn} calls). Reply to the owner now with what you have; if more work is needed, hand it to delegate_background.` };
        }
      }
      if (options.forbiddenRoot) {
        const input = (event as { readonly input?: Record<string, unknown> }).input ?? {};
        const targets: string[] = event.toolName === "read" && typeof input.path === "string"
          ? [input.path.split(":")[0]!]
          : event.toolName === "bash" && typeof input.command === "string"
            ? pathsInBash(input.command)
            : [];
        for (const t of targets) {
          const why = forbiddenPathReason(t, options.forbiddenRoot);
          if (why) return { block: true, reason: why };
        }
      }
      if (event.toolName === "bash") {
        const command = (event as { readonly input?: Record<string, unknown> }).input?.command;
        const why = typeof command === "string" ? forbiddenBashReason(command) : undefined;
        if (why) return { block: true, reason: why };
      }
      if (options.guardBash && event.toolName === "bash") {
        const problem = checkMainBashInput((event as { readonly input?: Record<string, unknown> }).input ?? {});
        return problem === undefined ? undefined : { block: true, reason: problem };
      }
      if (event.toolName !== "browser") {
        return undefined;
      }
      const input = (event as { readonly input?: Record<string, unknown> }).input ?? {};
      const problem = checkBrowserInput(input, chromeProfile, options.tabPrefix);
      if (problem !== undefined) {
        return { block: true, reason: `${problem}. Retry the same browser call with exactly ${required} and ${tabHint}.` };
      }
      // Give this task its own tab in the shared window before the tool
      // attaches; app.target (checked above) then resolves to exactly that tab.
      if (options.tabs !== undefined && options.tabPrefix !== undefined) {
        return options.tabs.ensure(options.tabPrefix).then(() => undefined);
      }
      return undefined;
    });
  };
}

/**
 * Returns a human reason when the call is not pinned to the agent profile, or
 * (when `tabPrefix` is set) when the tab name is outside this session's
 * namespace. The SDK's tab registry is process-wide and keyed by name only, so
 * two concurrent children both calling their tab "threads" would drive the
 * same page; prefixing makes collisions impossible.
 */
export function checkBrowserInput(input: Record<string, unknown>, chromeProfile: string, tabPrefix?: string): string | undefined {
  const app = input.app;
  if (app === null || typeof app !== "object") {
    return "browser calls must target Gajae's own Chrome profile (app is missing)";
  }
  const a = app as Record<string, unknown>;
  if (a.browser !== "chrome") {
    return `app.browser must be "chrome" (got ${JSON.stringify(a.browser)})`;
  }
  if (typeof a.user_data_dir !== "string" || normalize(a.user_data_dir) !== normalize(chromeProfile)) {
    return `app.user_data_dir must be ${JSON.stringify(chromeProfile)} (got ${JSON.stringify(a.user_data_dir)})`;
  }
  if (typeof a.cdp_url === "string" && a.cdp_url !== "http://127.0.0.1:9222") {
    return `app.cdp_url must be "http://127.0.0.1:9222" when provided (got ${JSON.stringify(a.cdp_url)})`;
  }
  if (a.cdp_port !== 9222) {
    return `app.cdp_port must be 9222 (got ${JSON.stringify(a.cdp_port)})`;
  }
  if (tabPrefix !== undefined) {
    const name = typeof input.name === "string" ? input.name : "main";
    if (!name.startsWith(tabPrefix)) {
      return `tab names in this task must start with "${tabPrefix}" (got ${JSON.stringify(name)}); other tasks share the same browser`;
    }
    if (a.target !== tabPrefix) {
      return `app.target must be ${JSON.stringify(tabPrefix)} so this task drives its own tab in the shared window (got ${JSON.stringify(a.target)})`;
    }
  }
  return undefined;
}

function normalize(p: string): string {
  return p.replace(/\/+$/, "");
}
