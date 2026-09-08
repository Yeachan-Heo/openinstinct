import { Buffer } from "node:buffer";

import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import type {
  EvidenceProvenance,
  FollowupPolicyRecord,
  OwnerRuleMatcher,
  OwnerRuleRecord,
  SetFollowupPolicyInput,
} from "./model.ts";

export const OWNER_SEND_RULE_JSON_MAX_BYTES = 4_096;
export const OWNER_SEND_RULE_VALUE_MAX_LENGTH = 512;
export const OWNER_FOLLOWUP_JSON_MAX_BYTES = 4_096;

export type OwnerFollowupCommand = {
  readonly operation: "followup";
  readonly policy: Omit<SetFollowupPolicyInput, "provenance">;
};

export type OwnerFollowupCommandParseResult =
  | { readonly kind: "valid"; readonly command: OwnerFollowupCommand }
  | { readonly kind: "invalid"; readonly operation: "followup"; readonly message: string };

export type OwnerSendRuleCommand =
  | { readonly operation: "allow_send"; readonly matcher: OwnerRuleMatcher }
  | { readonly operation: "revoke_send"; readonly ruleId: string; readonly revision: number };

export type OwnerSendRuleCommandParseResult =
  | { readonly kind: "valid"; readonly command: OwnerSendRuleCommand }
  | { readonly kind: "invalid"; readonly operation: "allow_send" | "revoke_send"; readonly message: string };

/** Extending OwnerRuleMatcher (for example with account) must update this parser; fields are never silently dropped. */
const OWNER_SEND_RULE_FIELDS = {
  recipient: true,
  topic: true,
  action: true,
} satisfies Record<Exclude<keyof OwnerRuleMatcher, "effectClass">, true>;
const OWNER_SEND_RULE_KEYS = Object.keys(OWNER_SEND_RULE_FIELDS);

/** SetFollowupPolicyInput additions must be explicitly accepted here; authority fields are never dropped. */
const OWNER_FOLLOWUP_FIELDS = {
  workId: true,
  actionId: true,
  enabled: true,
  intervalMs: true,
  maxAttempts: true,
} satisfies Record<Exclude<keyof SetFollowupPolicyInput, "provenance">, true>;
const OWNER_FOLLOWUP_INPUT_FIELDS = {
  ...OWNER_FOLLOWUP_FIELDS,
  provenance: true,
} satisfies Record<keyof SetFollowupPolicyInput, true>;
void OWNER_FOLLOWUP_INPUT_FIELDS;
const OWNER_FOLLOWUP_KEYS = Object.keys(OWNER_FOLLOWUP_FIELDS);

const ALLOW_USAGE = 'Use exactly /allow-send {"recipient":"…","topic":"…","action":"…"} with no extra fields.';
const REVOKE_USAGE = "Use exactly /revoke-send RULE_ID REVISION.";
const FOLLOWUP_USAGE = 'Use exactly /followup {"workId":"…","actionId":"…","enabled":true,"intervalMs":60000,"maxAttempts":1} with no extra fields.';
const WILDCARD = /[*?\[\]{}]/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Standalone command parser. Mixed or quoted command tokens are recognized only to reject them. */
export function parseOwnerSendRuleCommand(text: string): OwnerSendRuleCommandParseResult | undefined {
  const trimmed = text.trim();
  if (CONTROL_CHARACTER.test(trimmed)) {
    if (/\/allow-send/i.test(trimmed)) return invalidCommand("allow_send", "Send-rule commands must be standalone text without control characters.");
    if (/\/revoke-send/i.test(trimmed)) return invalidCommand("revoke_send", "Send-rule commands must be standalone text without control characters.");
    return undefined;
  }
  const allowAt = commandTokenIndex(trimmed, "/allow-send");
  const revokeAt = commandTokenIndex(trimmed, "/revoke-send");
  if (allowAt < 0 && revokeAt < 0) {
    if (/^\/allow-send/i.test(trimmed)) return invalidCommand("allow_send", "Use an exact /allow-send command.");
    if (/^\/revoke-send/i.test(trimmed)) return invalidCommand("revoke_send", "Use an exact /revoke-send command.");
    return undefined;
  }
  if (allowAt !== 0 && revokeAt !== 0) {
    return { kind: "invalid", operation: allowAt >= 0 ? "allow_send" : "revoke_send", message: "Send-rule commands must be standalone text. Use /allow-send JSON or /revoke-send RULE_ID REVISION." };
  }

  if (allowAt === 0) {
    if (!/^\/allow-send(?:\s|$)/.test(trimmed)) return invalidCommand("allow_send", ALLOW_USAGE);
    const encoded = trimmed.slice("/allow-send".length).trim();
    if (Buffer.byteLength(encoded, "utf8") > OWNER_SEND_RULE_JSON_MAX_BYTES) {
      return invalidCommand("allow_send", `${ALLOW_USAGE} JSON exceeds ${OWNER_SEND_RULE_JSON_MAX_BYTES} bytes.`);
    }
    if (encoded.length === 0) return invalidCommand("allow_send", ALLOW_USAGE);
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch {
      return invalidCommand("allow_send", ALLOW_USAGE);
    }
    if (!isRecord(value) || hasDuplicateTopLevelKeys(encoded) || !hasExactKeys(value, OWNER_SEND_RULE_KEYS)) {
      return invalidCommand("allow_send", ALLOW_USAGE);
    }
    try {
      return {
        kind: "valid",
        command: {
          operation: "allow_send",
          matcher: {
            effectClass: "external_message",
            recipient: exactRuleValue(value.recipient, "recipient"),
            topic: exactRuleValue(value.topic, "topic"),
            action: exactRuleValue(value.action, "action"),
          },
        },
      };
    } catch (error) {
      return invalidCommand("allow_send", `${ALLOW_USAGE} ${messageOf(error)}`);
    }
  }

  if (!/^\/revoke-send(?:\s|$)/.test(trimmed)) return invalidCommand("revoke_send", REVOKE_USAGE);
  const match = /^\/revoke-send\s+(\S+)\s+([1-9]\d*)$/.exec(trimmed);
  if (!match || match[1]!.length > 512 || match[1]!.includes("\0") || WILDCARD.test(match[1]!)) {
    return invalidCommand("revoke_send", REVOKE_USAGE);
  }
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision)) return invalidCommand("revoke_send", REVOKE_USAGE);
  return {
    kind: "valid",
    command: { operation: "revoke_send", ruleId: match[1]!, revision },
  };
}

/** Parses the complete bounded policy; merely recognizing /followup never dispatches work. */
export function parseOwnerFollowupCommand(text: string): OwnerFollowupCommandParseResult | undefined {
  const trimmed = text.trim();
  if (CONTROL_CHARACTER.test(trimmed)) {
    return /\/followup/i.test(trimmed)
      ? invalidFollowup("Follow-up commands must be standalone text without control characters.")
      : undefined;
  }
  const lower = trimmed.toLowerCase();
  const tokenAt = lower.indexOf("/followup");
  if (tokenAt < 0) return undefined;
  if (tokenAt !== 0) return invalidFollowup("Follow-up commands must be standalone text. " + FOLLOWUP_USAGE);
  if (!trimmed.startsWith("/followup")) return invalidFollowup("Use an exact /followup command.");
  if (!/^\/followup(?:\s|$)/.test(trimmed)) return invalidFollowup(FOLLOWUP_USAGE);

  const encoded = trimmed.slice("/followup".length).trim();
  if (Buffer.byteLength(encoded, "utf8") > OWNER_FOLLOWUP_JSON_MAX_BYTES) {
    return invalidFollowup(`${FOLLOWUP_USAGE} JSON exceeds ${OWNER_FOLLOWUP_JSON_MAX_BYTES} bytes.`);
  }
  if (encoded.length === 0) return invalidFollowup(FOLLOWUP_USAGE);
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return invalidFollowup(FOLLOWUP_USAGE);
  }
  if (!isRecord(value) || hasDuplicateTopLevelKeys(encoded) || !hasExactKeys(value, OWNER_FOLLOWUP_KEYS)) {
    return invalidFollowup(FOLLOWUP_USAGE);
  }
  try {
    return {
      kind: "valid",
      command: {
        operation: "followup",
        policy: {
          workId: exactRuleValue(value.workId, "workId"),
          actionId: exactRuleValue(value.actionId, "actionId"),
          enabled: exactBoolean(value.enabled, "enabled"),
          intervalMs: positiveSafeInteger(value.intervalMs, "intervalMs"),
          maxAttempts: nonNegativeSafeInteger(value.maxAttempts, "maxAttempts"),
        },
      },
    };
  } catch (error) {
    return invalidFollowup(`${FOLLOWUP_USAGE} ${messageOf(error)}`);
  }
}

export function applyOwnerFollowupCommand(input: {
  readonly repository: AssistantWorkRepository;
  readonly command: OwnerFollowupCommand;
  readonly provenance: EvidenceProvenance;
  readonly now: string;
}): FollowupPolicyRecord {
  if (input.provenance.principal !== "owner") {
    throw new Error("follow-up commands require authenticated owner provenance");
  }
  return input.repository.setFollowupPolicy({
    ...input.command.policy,
    provenance: input.provenance,
  }, input.now);
}

export function ownerFollowupCommandResultText(policy: FollowupPolicyRecord): string {
  const nextDue = policy.nextDueAt === undefined ? "none" : policy.nextDueAt;
  return `Follow-up policy for work ${policy.workId} and action ${policy.actionId} is ${policy.enabled ? "enabled" : "disabled"} at revision ${policy.revision}. It is bound to action revision ${policy.actionRevision} digest ${policy.actionDigest}, intervalMs=${policy.intervalMs}, maxAttempts=${policy.maxAttempts}, nextDueAt=${nextDue}. No follow-up was dispatched by this command.`;
}

export function applyOwnerSendRuleCommand(input: {
  readonly repository: AssistantWorkRepository;
  readonly command: OwnerSendRuleCommand;
  readonly provenance: EvidenceProvenance;
  readonly now: string;
}): OwnerRuleRecord {
  if (input.provenance.principal !== "owner") {
    throw new Error("owner send-rule commands require authenticated owner provenance");
  }
  if (input.command.operation === "allow_send") {
    return input.repository.setOwnerRule({
      matcher: input.command.matcher,
      provenance: input.provenance,
    }, input.now);
  }
  return input.repository.revokeOwnerRule(
    input.command.ruleId,
    input.command.revision,
    input.provenance,
    input.now,
  );
}

function invalidCommand(
  operation: "allow_send" | "revoke_send",
  message: string,
): Extract<OwnerSendRuleCommandParseResult, { readonly kind: "invalid" }> {
  return { kind: "invalid", operation, message };
}

function invalidFollowup(message: string): Extract<OwnerFollowupCommandParseResult, { readonly kind: "invalid" }> {
  return { kind: "invalid", operation: "followup", message };
}

export function ownerSendRuleCommandResultText(
  command: OwnerSendRuleCommand,
  rule: OwnerRuleRecord,
  options: { readonly changed?: boolean } = {},
): string {
  if (command.operation === "allow_send") {
    const stateText = options.changed === false ? "was already enabled" : "is enabled";
    return `Allowed external messages matching exactly recipient=${JSON.stringify(rule.matcher.recipient)}, topic=${JSON.stringify(rule.matcher.topic)}, action=${JSON.stringify(rule.matcher.action)}. Rule ${rule.id} ${stateText} at revision ${rule.revision}. This rule does not authorize any other recipient, topic, action, account, or effect. To revoke it, send exactly: /revoke-send ${rule.id} ${rule.revision}`;
  }
  const stateText = options.changed === false ? "was already revoked" : "is revoked";
  return `Send rule ${rule.id} ${stateText} at revision ${rule.revision}; future claims cannot use it.`;
}

function exactRuleValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  if (value.length === 0 || value.trim().length === 0) throw new Error(`${label} must not be empty.`);
  if (value !== value.trim()) throw new Error(`${label} must not have surrounding whitespace.`);
  if (CONTROL_CHARACTER.test(value)) throw new Error(`${label} contains a control character.`);
  if (value.length > OWNER_SEND_RULE_VALUE_MAX_LENGTH) {
    throw new Error(`${label} exceeds ${OWNER_SEND_RULE_VALUE_MAX_LENGTH} characters.`);
  }
  if (WILDCARD.test(value)) throw new Error(`${label} wildcards are not allowed.`);
  return value;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be an integer from 1 through ${Number.MAX_SAFE_INTEGER}.`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be an integer from 0 through ${Number.MAX_SAFE_INTEGER}.`);
  }
  return value;
}

function commandTokenIndex(text: string, command: string): number {
  const lower = text.toLowerCase();
  let index = lower.indexOf(command);
  while (index >= 0) {
    const before = index === 0 ? undefined : text[index - 1];
    const after = text[index + command.length];
    if ((before === undefined || /[\s"'(`]/.test(before)) && (after === undefined || /\s/.test(after))) return index;
    index = lower.indexOf(command, index + command.length);
  }
  return -1;
}

function hasDuplicateTopLevelKeys(encoded: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  let stringStart = -1;
  let escaped = false;
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index]!;
    if (stringStart >= 0) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        const end = index + 1;
        let cursor = end;
        while (cursor < encoded.length && /\s/.test(encoded[cursor]!)) cursor += 1;
        if (depth === 1 && encoded[cursor] === ":") {
          const key = JSON.parse(encoded.slice(stringStart, end)) as string;
          if (seen.has(key)) return true;
          seen.add(key);
        }
        stringStart = -1;
      }
      continue;
    }
    if (character === '"') stringStart = index;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
  }
  return false;
}


function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
