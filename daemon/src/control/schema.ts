export const CONTROL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_CONNECTION_BUFFER_BYTES = 1024 * 1024;

export const CONTROL_CAPABILITIES = [
  "status.get",
  "monitors.list",
  "monitors.toggle",
  "monitors.run",
  "monitors.delete",
  "daemon.pause",
  "daemon.resume",
  "session.compact",
  "session.compact.status",
  "session.reload",
  "session.reset",
  "session.notify",
  "chat.send",
  "chat.history",
  "chat.subscribe",
  "chat.activity",
  "assistant.notifications.list",
  "assistant.notifications.ack",
  "assistant.notifications.rendered",
  "settings.get",
  "settings.set",
  "models.list",
  "accounts.list",
  "accounts.login",
  "accounts.logout",
  "accounts.login.finish",
  "accounts.providers",
  "accounts.discover",
  "accounts.adopt",
  "providers.custom",
  "daemon.restart",
  "browser.open",
  "maintenance.run",
  "memory.backfillCaptures",
] as const;

export const CHAT_EVENT_TOPICS = ["chat.message", "chat.presence"] as const;
export type ChatEventTopic = (typeof CHAT_EVENT_TOPICS)[number];

export interface ChatSendPayload {
  readonly text: string;
}

export interface ChatHistoryPayload {
  readonly limit: number;
}

export interface ChatSubscribePayload {
  readonly [key: string]: never;
}

export interface ChatActivityPayload {
  readonly frontmost: boolean;
  readonly lastInputAgeSeconds: number | null;
}

export interface AssistantNotificationsListPayload {
  readonly [key: string]: never;
}

export interface AssistantNotificationAckPayload {
  readonly notificationId: string;
}

export interface AssistantNotificationRenderedPayload {
  readonly notificationId: string;
}

export interface ChatEventPayload extends JsonObject {
  readonly seq: number;
}

export interface ChatEvent {
  readonly topic: ChatEventTopic;
  readonly payload: ChatEventPayload;
}

export interface ChatHistoryResponse {
  readonly messages: readonly JsonObject[];
  readonly seq: number;
  readonly tail: readonly (ChatEvent & { readonly topic: "chat.message" })[];
  readonly inFlight?: {
    readonly turnId: string;
    readonly typing: boolean;
  };
  readonly truncated?: true;
  readonly tailTruncated?: true;
}


export type ControlCapability = (typeof CONTROL_CAPABILITIES)[number];
export type KnownVerb = ControlCapability;
export type CompactAcceptanceState = "accepted" | "already_running";
export type CompactOperationState = "running" | "succeeded" | "failed" | "canceled";
export type ErrorCode =
  | "buffer_too_large"
  | "duplicate_request_id"
  | "frame_too_large"
  | "hello_required"
  | "incompatible_version"
  | "internal_error"
  | "invalid_frame"
  | "malformed_json"
  | "monitor_busy"
  | "monitor_not_found"
  | "monitor_protected"
  | "revision_conflict"
  | "verb_unknown";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface HelloFrame {
  readonly type: "hello";
  readonly v: typeof CONTROL_VERSION;
  readonly client: string;
}

export interface NegotiatedFrame {
  readonly type: "negotiated";
  readonly v: typeof CONTROL_VERSION;
  readonly capabilities: readonly ControlCapability[];
}

export interface StatusGetPayload {
  readonly [key: string]: never;
}

export interface MonitorTogglePayload {
  readonly id: string;
  readonly enabled: boolean;
  readonly expectedRevision: number;
}

export interface DaemonPausePayload {
  readonly [key: string]: never;
}


export interface SessionCompactPayload {
  readonly requestKey: string;
}

export interface SessionCompactStatusPayload {
  readonly operationId: string;
}

export type RequestPayload =
  | StatusGetPayload
  | MonitorTogglePayload
  | DaemonPausePayload
  | SessionCompactPayload
  | SessionCompactStatusPayload
  | ChatSendPayload
  | ChatHistoryPayload
  | ChatSubscribePayload
  | ChatActivityPayload
  | AssistantNotificationsListPayload
  | AssistantNotificationAckPayload
  | AssistantNotificationRenderedPayload
  | JsonObject;


export interface RequestFrame {
  readonly type: "request";
  readonly id: string;
  readonly verb: string;
  readonly payload: RequestPayload;
}

export interface ResponseFrame {
  readonly type: "response";
  readonly id: string;
  readonly ok: true;
  readonly payload: JsonObject;
}

export interface ErrorFrame {
  readonly type: "error";
  readonly id?: string;
  readonly ok: false;
  readonly code: ErrorCode;
  readonly message: string;
}

export interface EventFrame {
  readonly type: "event";
  readonly topic: string;
  readonly payload: JsonObject;
}

export type ControlFrame = HelloFrame | NegotiatedFrame | RequestFrame | ResponseFrame | ErrorFrame | EventFrame;
export type ClientFrame = HelloFrame | RequestFrame;
export type ServerFrame = NegotiatedFrame | ResponseFrame | ErrorFrame | EventFrame;

/**
 * The codecs below are derived from this closed field schema rather than from
 * hand-written wire casts. Add a field here before teaching a handler about it.
 */
export const FRAME_SCHEMA = {
  hello: ["type", "v", "client"],
  negotiated: ["type", "v", "capabilities"],
  request: ["type", "id", "verb", "payload"],
  response: ["type", "id", "ok", "payload"],
  error: ["type", "ok", "code", "message"],
  event: ["type", "topic", "payload"],
  optional: {
    error: ["id"],
    payload: {
      "models.list": ["refresh"],
    },
  },
  payload: {
    "status.get": [],
    "monitors.list": [],
    "monitors.toggle": ["id", "enabled", "expectedRevision"],
    "monitors.run": ["id"],
    "monitors.delete": ["id", "expectedRevision"],
    "daemon.pause": [],
    "daemon.resume": [],
    "session.compact": ["requestKey"],
    "maintenance.run": [],
    "memory.backfillCaptures": [],
    "session.compact.status": ["operationId"],
    "session.reload": [],
    "session.reset": [],
    "session.notify": ["text"],
    "chat.send": ["text"],
    "chat.history": ["limit"],
    "chat.subscribe": [],
    "chat.activity": ["frontmost", "lastInputAgeSeconds"],
    "assistant.notifications.list": [],
    "assistant.notifications.ack": ["notificationId"],
    "assistant.notifications.rendered": ["notificationId"],
    "settings.get": [],
    "settings.set": ["patch"],
    "models.list": [],
    "accounts.list": [],
    "accounts.login": ["provider"],
    "accounts.logout": ["provider", "account"],
    "accounts.login.finish": ["code"],
    "accounts.providers": [],
    "accounts.discover": [],
    "accounts.adopt": ["id"],
    "providers.custom": ["id", "baseUrl", "api", "apiKey", "model"],
    "daemon.restart": [],
    "browser.open": [],
  },

} as const;

export class FrameValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FrameValidationError";
  }
}

export function decodeFrame(value: unknown): ControlFrame {
  const frame = expectObject(value, "frame");
  const type = expectString(frame.type, "frame.type");

  switch (type) {
    case "hello":
      return decodeHello(frame);
    case "negotiated":
      return decodeNegotiated(frame);
    case "request":
      return decodeRequest(frame);
    case "response":
      return decodeResponse(frame);
    case "error":
      return decodeError(frame);
    case "event":
      return decodeEvent(frame);
    default:
      throw new FrameValidationError(`unknown frame type: ${type}`);
  }
}

export function decodeClientFrame(value: unknown): ClientFrame {
  const frame = decodeFrame(value);
  if (frame.type !== "hello" && frame.type !== "request") {
    throw new FrameValidationError("client frame must be hello or request");
  }
  return frame;
}

export function decodeServerFrame(value: unknown): ServerFrame {
  const frame = decodeFrame(value);
  if (frame.type === "hello" || frame.type === "request") {
    throw new FrameValidationError("server frame must not be a client frame");
  }
  return frame;
}

export function parseFrameJson(text: string): ControlFrame {
  try {
    return decodeFrame(JSON.parse(text));
  } catch (error) {
    if (error instanceof FrameValidationError) {
      throw error;
    }
    throw new FrameValidationError("malformed JSON");
  }
}

export function encodeFrame(frame: ControlFrame): string {
  return JSON.stringify(decodeFrame(frame));
}

export function errorFrame(code: ErrorCode, message: string, id?: string): ErrorFrame {
  return id === undefined
    ? { type: "error", ok: false, code, message }
    : { type: "error", id, ok: false, code, message };
}

export function isKnownVerb(verb: string): verb is KnownVerb {
  return (CONTROL_CAPABILITIES as readonly string[]).includes(verb);
}

function decodeHello(frame: Record<string, unknown>): HelloFrame {
  expectFields(frame, FRAME_SCHEMA.hello, "hello");
  const v = expectVersion(frame.v, "hello.v");
  return { type: "hello", v, client: expectNonEmptyString(frame.client, "hello.client") };
}

function decodeNegotiated(frame: Record<string, unknown>): NegotiatedFrame {
  expectFields(frame, FRAME_SCHEMA.negotiated, "negotiated");
  const v = expectVersion(frame.v, "negotiated.v");
  if (!Array.isArray(frame.capabilities)) {
    throw new FrameValidationError("negotiated.capabilities must be an array");
  }
  const capabilities = frame.capabilities.map((value, index) => {
    const capability = expectString(value, `negotiated.capabilities[${index}]`);
    if (!isKnownVerb(capability)) {
      throw new FrameValidationError(`unknown capability: ${capability}`);
    }
    return capability;
  });
  return { type: "negotiated", v, capabilities };
}

function decodeRequest(frame: Record<string, unknown>): RequestFrame {
  expectFields(frame, FRAME_SCHEMA.request, "request");
  const verb = expectNonEmptyString(frame.verb, "request.verb");
  const payload = expectObject(frame.payload, "request.payload");

  if (isKnownVerb(verb)) {
    expectFields(payload, FRAME_SCHEMA.payload[verb], `request payload for ${verb}`, optionalPayloadFields(verb));
    validateKnownPayload(verb, payload);
  }

  return {
    type: "request",
    id: expectNonEmptyString(frame.id, "request.id"),
    verb,
    payload: payload as RequestPayload,
  };
}

function decodeResponse(frame: Record<string, unknown>): ResponseFrame {
  expectFields(frame, FRAME_SCHEMA.response, "response");
  if (frame.ok !== true) {
    throw new FrameValidationError("response.ok must be true");
  }
  return {
    type: "response",
    id: expectNonEmptyString(frame.id, "response.id"),
    ok: true,
    payload: expectObject(frame.payload, "response.payload") as JsonObject,
  };
}

function decodeError(frame: Record<string, unknown>): ErrorFrame {
  expectFields(frame, FRAME_SCHEMA.error, "error", FRAME_SCHEMA.optional.error);
  if (frame.ok !== false) {
    throw new FrameValidationError("error.ok must be false");
  }
  const code = expectString(frame.code, "error.code");
  if (!ERROR_CODES.includes(code as ErrorCode)) {
    throw new FrameValidationError(`unknown error code: ${code}`);
  }
  const id = frame.id === undefined ? undefined : expectNonEmptyString(frame.id, "error.id");
  return id === undefined
    ? { type: "error", ok: false, code: code as ErrorCode, message: expectNonEmptyString(frame.message, "error.message") }
    : { type: "error", id, ok: false, code: code as ErrorCode, message: expectNonEmptyString(frame.message, "error.message") };
}

function decodeEvent(frame: Record<string, unknown>): EventFrame {
  expectFields(frame, FRAME_SCHEMA.event, "event");
  const topic = expectNonEmptyString(frame.topic, "event.topic");
  const payload = expectObject(frame.payload, "event.payload");
  if ((CHAT_EVENT_TOPICS as readonly string[]).includes(topic)) {
    expectPositiveInteger(payload.seq, "event.payload.seq");
    if (topic === "chat.message" && payload.final !== undefined) {
      if (typeof payload.final !== "boolean") {
        throw new FrameValidationError("event.payload.final must be boolean");
      }
      if (payload.final === true && payload.role !== "assistant") {
        throw new FrameValidationError("event.payload.final requires assistant role");
      }
    }
  }
  return {
    type: "event",
    topic,
    payload: payload as JsonObject,
  };
}

function optionalPayloadFields(verb: KnownVerb): readonly string[] {
  const optional: Partial<Record<KnownVerb, readonly string[]>> = FRAME_SCHEMA.optional.payload;
  return optional[verb] ?? [];
}

function validateKnownPayload(verb: KnownVerb, payload: Record<string, unknown>): void {
  switch (verb) {
    case "status.get":
    case "monitors.list":
    case "daemon.pause":
    case "daemon.resume":
    case "maintenance.run":
    case "session.reload":
    case "session.reset":
    case "settings.get":
      return;
    case "models.list":
      if (payload.refresh !== undefined && typeof payload.refresh !== "boolean") {
        throw new FrameValidationError("models.list.refresh must be boolean");
      }
      return;
    case "accounts.list":
    case "daemon.restart":
    case "browser.open":
    case "accounts.providers":
    case "accounts.discover":
      return;
    case "accounts.adopt":
      expectNonEmptyString(payload.id, "accounts.adopt.id");
      return;
    case "chat.subscribe":
      return;
    case "chat.activity":
      if (typeof payload.frontmost !== "boolean") {
        throw new FrameValidationError("chat.activity.frontmost must be boolean");
      }
      if (
        payload.lastInputAgeSeconds !== null
        && (typeof payload.lastInputAgeSeconds !== "number"
          || !Number.isFinite(payload.lastInputAgeSeconds)
          || payload.lastInputAgeSeconds < 0)
      ) {
        throw new FrameValidationError("chat.activity.lastInputAgeSeconds must be a nonnegative finite number or null");
      }
      return;
    case "assistant.notifications.list":
      return;
    case "assistant.notifications.ack": {
      const notificationId = expectNonEmptyString(payload.notificationId, "assistant.notifications.ack.notificationId");
      if (notificationId.trim().length === 0) {
        throw new FrameValidationError("assistant.notifications.ack.notificationId must not be blank");
      }
      return;
    }
    case "assistant.notifications.rendered": {
      const notificationId = expectNonEmptyString(payload.notificationId, "assistant.notifications.rendered.notificationId");
      if (notificationId.trim().length === 0) {
        throw new FrameValidationError("assistant.notifications.rendered.notificationId must not be blank");
      }
      return;
    }
    case "chat.send": {
      const text = expectNonEmptyString(payload.text, "chat.send.text");
      if (text.length > 4_000) {
        throw new FrameValidationError("chat.send.text must be no longer than 4000 characters");
      }
      return;
    }
    case "chat.history": {
      const limit = expectPositiveInteger(payload.limit, "chat.history.limit");
      if (limit > 50) {
        throw new FrameValidationError("chat.history.limit must be no greater than 50");
      }
      return;
    }
    case "providers.custom":
      for (const k of ["id", "baseUrl", "api", "apiKey", "model"]) expectNonEmptyString(payload[k], `providers.custom.${k}`);
      return;
    case "monitors.run":
      expectNonEmptyString(payload.id, "monitors.run.id");
      return;
    case "monitors.toggle":
      expectNonEmptyString(payload.id, "monitors.toggle.id");
      if (typeof payload.enabled !== "boolean") {
        throw new FrameValidationError("monitors.toggle.enabled must be boolean");
      }
      expectPositiveInteger(payload.expectedRevision, "monitors.toggle.expectedRevision");
      return;
    case "settings.set":
      expectObject(payload.patch, "settings.set.patch");
      return;
    case "session.notify":
      expectNonEmptyString(payload.text, "session.notify.text");
      return;
    case "accounts.login":
      expectNonEmptyString(payload.provider, "accounts.login.provider");
      return;
    case "accounts.login.finish":
      expectNonEmptyString(payload.code, "accounts.login.finish.code");
      return;
    case "accounts.logout":
      expectNonEmptyString(payload.provider, "accounts.logout.provider");
      expectNonEmptyString(payload.account, "accounts.logout.account");
      return;
    case "monitors.delete":
      expectNonEmptyString(payload.id, "monitors.delete.id");
      expectPositiveInteger(payload.expectedRevision, "monitors.delete.expectedRevision");
      return;
    case "session.compact":
      expectNonEmptyString(payload.requestKey, "session.compact.requestKey");
      return;
    case "session.compact.status":
      expectNonEmptyString(payload.operationId, "session.compact.status.operationId");
      return;
  }
}

function expectObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new FrameValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  name: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...fields, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new FrameValidationError(`${name} contains unknown field: ${key}`);
    }
  }
  for (const field of fields) {
    if (!(field in value)) {
      throw new FrameValidationError(`${name} is missing field: ${field}`);
    }
  }
}

function expectVersion(value: unknown, name: string): typeof CONTROL_VERSION {
  if (value !== CONTROL_VERSION) {
    throw new FrameValidationError(`${name} must equal ${CONTROL_VERSION}`);
  }
  return CONTROL_VERSION;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new FrameValidationError(`${name} must be a string`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, name: string): string {
  const string = expectString(value, name);
  if (string.length === 0) {
    throw new FrameValidationError(`${name} must not be empty`);
  }
  return string;
}

function expectPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new FrameValidationError(`${name} must be a positive integer`);
  }
  return value;
}

const ERROR_CODES: readonly ErrorCode[] = [
  "buffer_too_large",
  "duplicate_request_id",
  "frame_too_large",
  "hello_required",
  "incompatible_version",
  "internal_error",
  "invalid_frame",
  "malformed_json",
  "monitor_busy",
  "monitor_not_found",
  "monitor_protected",
  "revision_conflict",
  "verb_unknown",
];
