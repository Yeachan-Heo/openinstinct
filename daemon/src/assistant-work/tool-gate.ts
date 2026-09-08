import type {
  ExtensionFactory,
  ToolCallEventResult,
  ToolResultEventResult,
} from "@gajae-code/coding-agent";

import {
  ManagedOpaqueToolGateContext,
  type ManagedOpaqueToolGateContextOptions,
  type OpaqueToolAdmission,
} from "./tool-gate-context.ts";

export {
  isManagedOpaqueToolAction,
  MANAGED_OPAQUE_TOOL_ACTION,
  opaqueToolInputDigest,
  opaqueToolSemanticKey,
  type ManagedOpaqueToolGateContextOptions,
  type OpaqueToolAdmission,
} from "./tool-gate-context.ts";

export interface ManagedToolGateOptions extends ManagedOpaqueToolGateContextOptions {
  /** Whether assistant_local_file is registered in this session. Defaults true. */
  readonly managedLocalFileAvailable?: boolean;
}

export type ManagedToolGateDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "redirect_local_file"; readonly reason: string }
  | { readonly kind: "forbidden"; readonly reason: string }
  | { readonly kind: "opaque_external_mutation" };

const MUTATING_BROWSER_VERBS = new Set(["click", "type", "fill", "select", "press"]);
const COOPERATIVE_BROWSER_VERBS = new Set([
  "observe",
  "extract",
  "screenshot",
  "wait",
  "scroll",
  "back",
  "navigate",
]);

/**
 * Intercepts model tool calls through the SDK's real tool_call/tool_result
 * lifecycle. Register this after the browser profile enforcer: profile failures
 * must block before an approved call is durably marked effect_started.
 *
 * This gate is service-neutral and cooperative. It does not parse shell syntax,
 * promise browser containment, remove generic tools, or treat model output as
 * authority.
 */
export function createManagedToolGate(options: ManagedToolGateOptions): ExtensionFactory {
  return (pi) => {
    const context = new ManagedOpaqueToolGateContext(options);
    const managedLocalFileAvailable = options.managedLocalFileAvailable ?? true;

    pi.on("tool_call", async (event): Promise<ToolCallEventResult | void> => {
      const input = event.input as unknown as Record<string, unknown>;
      const decision = classifyManagedToolCall(event.toolName, input, { managedLocalFileAvailable });
      if (decision.kind === "allow") return;
      if (decision.kind === "redirect_local_file" || decision.kind === "forbidden") {
        return { block: true, reason: decision.reason };
      }
      if (!managedLocalFileAvailable) {
        return {
          block: true,
          reason: "This child is observation-only and cannot dispatch raw effects. Return the exact requested change to the main session for managed review and execution.",
        };
      }

      try {
        const admission = await context.admit(event.toolCallId, event.toolName, input);
        if (admission.kind === "allowed") return;
        return { block: true, reason: opaqueRejectionReason(admission, event.toolName) };
      } catch (error) {
        return {
          block: true,
          reason: `Managed tool admission failed closed before execution: ${errorMessage(error)}`,
        };
      }
    });

    pi.on("tool_result", async (event): Promise<ToolResultEventResult | void> => {
      const transition = await context.recordResult({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        content: event.content,
        details: event.details,
        isError: event.isError,
      });
      if (!transition) return;
      return {
        content: [
          ...event.content,
          {
            type: "text",
            text: `Managed opaque action ${transition.action.id} is ambiguous: this raw tool result is execution evidence, not independent verification. Do not retry the effect.`,
          },
        ],
        details: event.details,
        isError: event.isError,
      };
    });
  };
}

/** Host classification only; no caller-supplied effect label is accepted. */
export function classifyManagedToolCall(
  toolName: string,
  input: Record<string, unknown>,
  options: { readonly managedLocalFileAvailable?: boolean } = {},
): ManagedToolGateDecision {
  if (isManagedOrReadOnlyTool(toolName)) return { kind: "allow" };
  if (toolName === "write" || toolName === "edit") {
    return {
      kind: "redirect_local_file",
      reason: options.managedLocalFileAvailable === false
        ? "This child is observation-only and cannot modify files. Return the exact requested change to the main session so it can use the managed local-file executor."
        : "Raw write/edit is not dispatched directly. Use assistant_local_file operation=propose with the exact file operation, then operation=execute with its actionId, revision, and digest. Ordinary local edits remain automatic through that managed executor.",
    };
  }
  if (toolName === "browser") return classifyBrowserCall(input);
  if (toolName === "bash") return { kind: "opaque_external_mutation" };

  // Unknown tools retain their generic capability, but execute only after the
  // host binds this exact name and input digest to explicit owner approval.
  return { kind: "opaque_external_mutation" };
}

function classifyBrowserCall(input: Record<string, unknown>): ManagedToolGateDecision {
  if (isForbiddenBrowserUrl(input.url)) {
    return {
      kind: "forbidden",
      reason: "Browser javascript: and data: URLs are not allowed. Use an ordinary http(s) page and structured browser actions instead.",
    };
  }

  switch (input.action) {
    case "open":
      return { kind: "allow" };
    case "close":
      return input.kill === true || input.all === true
        ? { kind: "opaque_external_mutation" }
        : { kind: "allow" };
    case "run":
      return { kind: "opaque_external_mutation" };
    case "act":
      return classifyBrowserActions(input.actions);
    default:
      return { kind: "opaque_external_mutation" };
  }
}

function classifyBrowserActions(value: unknown): ManagedToolGateDecision {
  if (!Array.isArray(value) || value.length === 0) return { kind: "opaque_external_mutation" };
  for (const step of value) {
    if (!isRecord(step) || typeof step.verb !== "string") return { kind: "opaque_external_mutation" };
    if (isForbiddenBrowserUrl(step.url)) {
      return {
        kind: "forbidden",
        reason: "Browser javascript: and data: URLs are not allowed. Use an ordinary http(s) page and structured browser actions instead.",
      };
    }
    if (MUTATING_BROWSER_VERBS.has(step.verb)) return { kind: "opaque_external_mutation" };
    if (!COOPERATIVE_BROWSER_VERBS.has(step.verb)) return { kind: "opaque_external_mutation" };
  }

  // Navigation/back can have site-level side effects. They remain available as
  // cooperative browser operations; this is not a claim of hard read-only mode.
  return { kind: "allow" };
}

const TRUSTED_HOST_TOOLS = new Set([
  "assistant_work_observe", "assistant_work_status", "assistant_local_file",
  "assistant_managed_install", "assistant_managed_http", "assistant_service_monitor",
  "assistant_response_received",
  "read", "search", "find", "ast_grep",
  "search_tool_bm25", "skill_discovery",
  "memory_search", "memory_capture", "memory_audit",
  "delegate_background", "child_nudge", "child_status", "report_progress",
  "monitor_author", "send_image",
]);

function isManagedOrReadOnlyTool(toolName: string): boolean {
  return TRUSTED_HOST_TOOLS.has(toolName);
}

function isForbiddenBrowserUrl(value: unknown): boolean {
  return typeof value === "string" && /^\s*(?:javascript|data):/i.test(value);
}

function opaqueRejectionReason(admission: Extract<OpaqueToolAdmission, { readonly kind: "rejected" }>, toolName: string): string {
  const identity = `action ${admission.action.id} revision ${admission.action.revision} digest ${admission.action.digest}`;
  if (admission.reason === "approval_required") {
    return `Explicit owner approval is required for raw ${toolName} ${identity}. No raw effect ran. Send exactly: /approve ${admission.action.id} ${admission.action.revision} ${admission.action.digest}. Then retry the same tool with the exact unchanged input.`;
  }
  if (admission.reason === "effect_started" || admission.reason === "ambiguous") {
    return `Raw ${toolName} ${identity} is ${admission.reason}. Do not retry it; reconcile the durable attempt with independent verification.`;
  }
  if (admission.reason === "confirmed") {
    return `Raw ${toolName} ${identity} is already confirmed. Duplicate execution is not allowed.`;
  }
  return `Raw ${toolName} ${identity} was not dispatched: ${admission.reason}. No new effect ran.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message).slice(0, 500).join("");
}

