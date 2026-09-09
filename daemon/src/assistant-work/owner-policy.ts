import { Buffer } from "node:buffer";

import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import type {
  EvidenceProvenance,
  FollowupPolicyRecord,
  SetFollowupPolicyInput,
} from "./model.ts";

const OWNER_FOLLOWUP_VALUE_MAX_LENGTH = 512;
export const OWNER_FOLLOWUP_JSON_MAX_BYTES = 4_096;

export type OwnerFollowupCommand = {
  readonly operation: "followup";
  readonly policy: Omit<SetFollowupPolicyInput, "provenance">;
};

export type OwnerFollowupCommandParseResult =
  | { readonly kind: "valid"; readonly command: OwnerFollowupCommand }
  | { readonly kind: "invalid"; readonly operation: "followup"; readonly message: string };

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

const FOLLOWUP_USAGE = 'Use exactly /followup {"workId":"…","actionId":"…","enabled":true,"intervalMs":60000,"maxAttempts":1} with no extra fields.';
const WILDCARD = /[*?\[\]{}]/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

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

function invalidFollowup(message: string): Extract<OwnerFollowupCommandParseResult, { readonly kind: "invalid" }> {
  return { kind: "invalid", operation: "followup", message };
}

function exactRuleValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  if (value.length === 0 || value.trim().length === 0) throw new Error(`${label} must not be empty.`);
  if (value !== value.trim()) throw new Error(`${label} must not have surrounding whitespace.`);
  if (CONTROL_CHARACTER.test(value)) throw new Error(`${label} contains a control character.`);
  if (value.length > OWNER_FOLLOWUP_VALUE_MAX_LENGTH) {
    throw new Error(`${label} exceeds ${OWNER_FOLLOWUP_VALUE_MAX_LENGTH} characters.`);
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
