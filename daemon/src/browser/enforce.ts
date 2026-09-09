import type { ChildTabRegistry } from "./child-tab.ts";
import type { ExtensionFactory } from "@gajae-code/coding-agent";

/**
 * Hard rule, not a prompt: every `browser` tool call must run on Gajae's own
 * persistent Chrome profile. The extension hook cannot rewrite inputs, so a
 * bare or mis-targeted call is blocked with the exact `app` block to pass;
 * the model retries correctly on the next step. Nothing ever reaches the
 * owner's personal Chrome profile or a throwaway temp profile.
 */
export function browserProfileEnforcer(chromeProfile: string, options: { readonly tabPrefix?: string; readonly tabs?: ChildTabRegistry } = {}): ExtensionFactory {
  const targetHint = options.tabPrefix ? `,"target":"${options.tabPrefix}"` : "";
  const required = `app: {"browser":"chrome","user_data_dir":"${chromeProfile}","background":true,"no_focus":true,"cdp_port":9222${targetHint}}`;
  const tabHint = options.tabPrefix ? `name "${options.tabPrefix}main"` : `tab "main"`;
  return (pi) => {
    pi.on("tool_call", (event) => {
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
