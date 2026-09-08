import type {
  ManagedHttpEndpointPolicy,
  ManagedHttpMessageAuthorization,
  ManagedHttpMessageAuthorizer,
  ManagedHttpMutationMethod,
  ManagedHttpPlan,
  ManagedHttpSecretResolver,
} from "./http-effects.ts";
import type { JsonValue } from "./model.ts";

interface SecretBinding {
  readonly origin: string;
  readonly header: string;
  readonly environment: string;
}

interface MessageTemplateBinding {
  readonly id: string;
  readonly version: number;
  readonly origin: string;
  readonly method: ManagedHttpMutationMethod;
  readonly path: string;
  readonly action: string;
  readonly allowedBodyKeys: readonly string[];
  readonly recipientPath: readonly (string | number)[];
  readonly topicPath?: readonly (string | number)[];
  readonly messagePath: readonly (string | number)[];
  readonly fixedTopic?: string;
}

/** Host configuration only. Tool arguments and fetched content cannot add bindings. */
export function configuredHttpAccess(env: Readonly<Record<string, string | undefined>> = process.env): {
  readonly endpointPolicy: ManagedHttpEndpointPolicy;
  readonly resolveSecret: ManagedHttpSecretResolver;
  readonly authorizeMessage: ManagedHttpMessageAuthorizer;
} {
  const originsValue: unknown = JSON.parse(env.OI_HTTP_LOCAL_ORIGINS ?? "[]");
  if (!Array.isArray(originsValue) || originsValue.some((value) => typeof value !== "string")) {
    throw new Error("OI_HTTP_LOCAL_ORIGINS must be a JSON array of exact origins");
  }
  const localOrigins = new Set(originsValue.map(exactOrigin));
  const messageBindings = parseMessageBindings(env.OI_HTTP_MESSAGE_BINDINGS);
  const bindingsValue: unknown = JSON.parse(env.OI_HTTP_SECRET_BINDINGS ?? "{}");
  if (!bindingsValue || typeof bindingsValue !== "object" || Array.isArray(bindingsValue)) {
    throw new Error("OI_HTTP_SECRET_BINDINGS must be a JSON object");
  }
  const bindings = new Map<string, SecretBinding>();
  for (const [reference, value] of Object.entries(bindingsValue)) {
    if (!reference.trim() || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid HTTP secret binding");
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== "environment,header,origin"
      || typeof entry.origin !== "string" || typeof entry.header !== "string"
      || typeof entry.environment !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(entry.environment)
      || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry.header)) throw new Error("invalid HTTP secret binding fields");
    bindings.set(reference, { origin: exactOrigin(entry.origin), header: entry.header.toLowerCase(), environment: entry.environment });
  }
  // Snapshot host credentials rather than reading mutable model-controlled request fields.
  const values = new Map([...bindings].map(([reference, binding]) => [reference, env[binding.environment]]));
  return {
    endpointPolicy: (endpoint) => ({ allowed: true, allowPrivateNetwork: localOrigins.has(endpoint.origin) }),
    authorizeMessage: (plan) => authorizeMessagePlan(plan, messageBindings),
    resolveSecret: (reference, context) => {
      const binding = bindings.get(reference);
      if (!binding || new URL(context.url).origin !== binding.origin || context.headerName.toLowerCase() !== binding.header) {
        throw new Error("HTTP credential binding does not authorize this origin and header");
      }
      const value = values.get(reference);
      if (!value) throw new Error("HTTP credential binding is not configured");
      return value;
    },
  };
}

function parseMessageBindings(value: string | undefined): readonly MessageTemplateBinding[] {
  const parsed: unknown = JSON.parse(value ?? "[]");
  if (!Array.isArray(parsed)) throw new Error("OI_HTTP_MESSAGE_BINDINGS must be a JSON array");
  const seen = new Set<string>();
  return parsed.map((value, index) => {
    if (!isRecord(value)) throw new Error(`invalid HTTP message binding ${index}`);
    const keys = Object.keys(value).sort();
    const allowedKeys = [
      "action", "allowedBodyKeys", "fixedTopic", "id", "messagePath", "method", "origin", "path",
      "recipientPath", "topicPath", "version",
    ];
    if (keys.some((key) => !allowedKeys.includes(key)) || ["action", "allowedBodyKeys", "id", "messagePath", "method", "origin", "path", "recipientPath", "version"].some((key) => !keys.includes(key))) {
      throw new Error(`invalid HTTP message binding ${index} fields`);
    }
    if (
      typeof value.id !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.id)
      || !Number.isSafeInteger(value.version)
      || (value.version as number) < 1
      || typeof value.origin !== "string"
      || !isMutationMethod(value.method)
      || typeof value.path !== "string"
      || !isExactPath(value.path)
      || typeof value.action !== "string"
      || value.action.length === 0
      || value.action.length > 512
      || value.action !== value.action.trim()
      || !Array.isArray(value.allowedBodyKeys)
      || (value.fixedTopic !== undefined && (typeof value.fixedTopic !== "string" || value.fixedTopic.length === 0 || value.fixedTopic.length > 512 || value.fixedTopic !== value.fixedTopic.trim()))
      || (value.fixedTopic === undefined) === (value.topicPath === undefined)
    ) {
      throw new Error(`invalid HTTP message binding ${index}`);
    }
    const allowedBodyKeys = value.allowedBodyKeys.map((key) => {
      if (typeof key !== "string" || key.length === 0 || key.length > 256 || key !== key.trim()) {
        throw new Error(`invalid HTTP message binding ${index} allowedBodyKeys`);
      }
      return key;
    }).sort();
    if (allowedBodyKeys.length === 0 || new Set(allowedBodyKeys).size !== allowedBodyKeys.length) {
      throw new Error(`invalid HTTP message binding ${index} allowedBodyKeys`);
    }
    const recipientPath = parseJsonPath(value.recipientPath, `HTTP message binding ${index} recipientPath`);
    const messagePath = parseJsonPath(value.messagePath, `HTTP message binding ${index} messagePath`);
    const topicPath = value.topicPath === undefined
      ? undefined
      : parseJsonPath(value.topicPath, `HTTP message binding ${index} topicPath`);
    const origin = exactOrigin(value.origin);
    const identity = `${value.id}@${value.version as number}`;
    if (seen.has(identity)) throw new Error(`duplicate HTTP message binding ${identity}`);
    seen.add(identity);
    return {
      id: value.id,
      version: value.version as number,
      origin,
      method: value.method,
      path: value.path,
      action: value.action,
      allowedBodyKeys,
      recipientPath,
      ...(topicPath === undefined ? {} : { topicPath }),
      ...(value.fixedTopic === undefined ? {} : { fixedTopic: value.fixedTopic }),
      messagePath,
    };
  });
}

function authorizeMessagePlan(
  plan: ManagedHttpPlan,
  bindings: readonly MessageTemplateBinding[],
): ManagedHttpMessageAuthorization | undefined {
  if (plan.messageOperation === null || plan.body === null) return undefined;
  const url = new URL(plan.url);
  let body: JsonValue;
  try {
    const parsed: unknown = JSON.parse(plan.body);
    if (!isJsonValue(parsed)) return undefined;
    body = parsed;
  } catch {
    return undefined;
  }
  if (!isRecord(body)) return undefined;
  const bodyKeys = Object.keys(body).sort();
  for (const binding of bindings) {
    if (
      url.origin !== binding.origin
      || plan.method !== binding.method
      || url.pathname !== binding.path
      || url.search !== ""
      || plan.messageOperation.action !== binding.action
      || bodyKeys.some((key) => !binding.allowedBodyKeys.includes(key))
    ) continue;
    const recipient = readBoundText(body, binding.recipientPath);
    const topic = binding.topicPath === undefined
      ? binding.fixedTopic
      : readBoundText(body, binding.topicPath);
    const message = readBoundText(body, binding.messagePath);
    if (
      recipient === undefined
      || topic === undefined
      || message === undefined
      || message.length === 0
      || recipient !== plan.messageOperation.recipient
      || topic !== plan.messageOperation.topic
    ) continue;
    return { capabilityId: binding.id, capabilityVersion: binding.version };
  }
  return undefined;
}

function readBoundText(value: JsonValue, path: readonly (string | number)[]): string | undefined {
  let current: JsonValue = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return undefined;
      current = current[segment]!;
    } else {
      if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
      current = current[segment]!;
    }
  }
  return typeof current === "string" && current.length <= 100_000 ? current : undefined;
}

function parseJsonPath(value: unknown, label: string): readonly (string | number)[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error(`${label} is invalid`);
  return value.map((segment) => {
    if (typeof segment === "string" && segment.length > 0 && segment.length <= 256 && !/[\0\r\n]/.test(segment)) return segment;
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) return segment;
    throw new Error(`${label} is invalid`);
  });
}

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || url.pathname !== "/" || value !== url.origin) {
    throw new Error("HTTP bindings require an exact scheme/host/port origin");
  }
  return url.origin;
}

function isExactPath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#") || value.includes("\0")) return false;
  const normalized = new URL(value, "https://binding.invalid");
  return normalized.pathname === value && normalized.search === "" && normalized.hash === "";
}

function isMutationMethod(value: unknown): value is ManagedHttpMutationMethod {
  return value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE";
}

function isRecord(value: JsonValue | unknown): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
