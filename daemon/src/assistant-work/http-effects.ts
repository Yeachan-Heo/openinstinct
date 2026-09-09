import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

import type { CustomTool } from "@gajae-code/coding-agent";
import { Type } from "@gajae-code/coding-agent/extensibility/typebox";

import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import {
  canonicalJson,
  stableAttemptId,
  type ActionRecord,
  type AttemptRecord,
  type ClaimRejectionReason,
  type EffectClass,
  type JsonValue,
  type ProposeActionInput,
} from "./model.ts";

export const MANAGED_HTTP_ACTION = "managed_http_request";

const DEFAULT_WORKER_ID = "main-session:managed-http";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_EVIDENCE_BODY_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE_BYTES = 16 * 1024;
const MAX_DURABLE_EVIDENCE_BYTES = 24 * 1024;
const MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const SENSITIVE_HEADER_NAME = /(^authorization$|^cookie$|^set-cookie$|api[-_]?key|token|secret|credential|signature|^x-auth)/i;
const SENSITIVE_QUERY_NAME = /(^|[-_.])(token|secret|access[-_.]?token|auth[-_.]?token|api[-_.]?key|client[-_.]?secret|password|passwd|credential|authorization|signature)([-_.]|$)/i;
const SENSITIVE_BODY_KEY = /(^|[-_.])(token|secret|access[-_.]?token|auth[-_.]?token|api[-_.]?key|client[-_.]?secret|password|passwd|credential|authorization|signature)([-_.]|$)/i;

export type ManagedHttpMutationMethod = typeof MUTATION_METHODS[number];
export type ManagedHttpEffectClass = Extract<EffectClass, "external_message" | "external_mutation">;
export type ManagedHttpEndpointPurpose = "read" | "mutation" | "verification";

export type ManagedHttpHeaderReference =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly secretRef: string };

export type ManagedHttpVerificationExpectation =
  | {
      readonly kind: "json_field";
      readonly path: readonly (string | number)[];
      readonly value: JsonValue;
    }
  | {
      readonly kind: "text_contains";
      readonly text: string;
    }
  | {
      readonly kind: "text_equals";
      readonly text: string;
    };

export interface ManagedHttpVerification {
  readonly url: string;
  readonly headers?: readonly ManagedHttpHeaderReference[];
  readonly expected: ManagedHttpVerificationExpectation;
}

export interface ManagedHttpMessageOperation {
  /** Exact canonical recipient key used by AssistantWorkRepository owner-rule matching. */
  readonly recipient: string;
  /** Exact canonical topic key used by AssistantWorkRepository owner-rule matching. */
  readonly topic: string;
  /** Exact canonical action key used by AssistantWorkRepository owner-rule matching. */
  readonly action: string;
}

export interface ManagedHttpMessageAuthorization {
  /** Host-owned stable template identity. Models cannot mint or choose this value. */
  readonly capabilityId: string;
  readonly capabilityVersion: number;
}

export interface ManagedHttpMessageAuthorizer {
  (plan: ManagedHttpPlan): ManagedHttpMessageAuthorization | undefined;
}

export interface ManagedHttpPlan {
  readonly version: 1;
  readonly method: ManagedHttpMutationMethod;
  readonly url: string;
  readonly headers: readonly ManagedHttpHeaderReference[];
  readonly body: string | null;
  readonly verification: {
    readonly url: string;
    readonly headers: readonly ManagedHttpHeaderReference[];
    readonly expected: ManagedHttpVerificationExpectation;
  };
  readonly messageOperation: ManagedHttpMessageOperation | null;
  readonly messageAuthorization: ManagedHttpMessageAuthorization | null;
}

export interface ManagedHttpEndpointPolicyInput {
  readonly url: string;
  readonly origin: string;
  readonly scheme: "http" | "https";
  readonly hostname: string;
  readonly port: number;
  readonly method: "GET" | ManagedHttpMutationMethod;
  readonly purpose: ManagedHttpEndpointPurpose;
  /** All DNS answers validated by host policy; the selected address is pinned for the connection. */
  readonly resolvedAddresses: readonly string[];
}

export type ManagedHttpEndpointPolicyDecision =
  | boolean
  | {
      readonly allowed: boolean;
      /**
       * Applies only to this exact scheme/host/port decision. Cloud metadata
       * addresses remain blocked even when trusted host policy allows local IPs.
       */
      readonly allowPrivateNetwork?: boolean;
    };

export interface ManagedHttpEndpointPolicy {
  (endpoint: ManagedHttpEndpointPolicyInput): ManagedHttpEndpointPolicyDecision | Promise<ManagedHttpEndpointPolicyDecision>;
}

export interface ManagedHttpSecretResolverContext {
  readonly headerName: string;
  readonly url: string;
  readonly purpose: ManagedHttpEndpointPurpose;
}

export interface ManagedHttpSecretResolver {
  (reference: string, context: ManagedHttpSecretResolverContext): string | Promise<string>;
}

export interface ManagedHttpRuntimeOptions {
  readonly endpointPolicy: ManagedHttpEndpointPolicy;
  readonly authorizeMessage?: ManagedHttpMessageAuthorizer;
  readonly resolveSecret?: ManagedHttpSecretResolver;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxEvidenceBodyBytes?: number;
}

export interface ManagedHttpToolOptions extends ManagedHttpRuntimeOptions {
  readonly repository: AssistantWorkRepository;
  readonly workerId?: string;
  readonly now?: () => Date;
}

export interface ObserveManagedHttpInput extends ManagedHttpRuntimeOptions {
  readonly url: string;
  readonly headers?: readonly ManagedHttpHeaderReference[];
  readonly signal?: AbortSignal;
}

export interface PreflightManagedHttpActionInput {
  readonly workId: string;
  readonly semanticKey: string;
  readonly method: ManagedHttpMutationMethod;
  readonly url: string;
  readonly headers?: readonly ManagedHttpHeaderReference[];
  readonly body?: string;
  readonly verification: ManagedHttpVerification;
  readonly messageOperation?: ManagedHttpMessageOperation;
}

export interface PreflightManagedHttpActionOptions {
  readonly endpointPolicy: ManagedHttpEndpointPolicy;
  readonly authorizeMessage?: ManagedHttpMessageAuthorizer;
}

export interface PreflightManagedHttpActionResult {
  readonly effectClass: ManagedHttpEffectClass;
  readonly plan: ManagedHttpPlan;
  readonly proposal: ProposeActionInput;
}

export interface ProposeManagedHttpActionOptions extends PreflightManagedHttpActionOptions {
  readonly repository: AssistantWorkRepository;
  readonly now?: () => string;
}

export interface ProposeManagedHttpActionResult extends PreflightManagedHttpActionResult {
  readonly action: ActionRecord;
}

export interface ExecuteManagedHttpActionInput extends ManagedHttpRuntimeOptions {
  readonly repository: AssistantWorkRepository;
  readonly actionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
}

export type ManagedHttpPreflightRejectionReason =
  | "invalid_plan"
  | "effect_class_mismatch"
  | "material_mismatch"
  | "endpoint_denied"
  | "endpoint_resolution_failed";

export type ManagedHttpExecutionResult =
  | {
      readonly kind: "rejected";
      readonly reason: ClaimRejectionReason;
      readonly action?: ActionRecord;
      readonly attempt?: AttemptRecord;
    }
  | {
      readonly kind: "preflight_rejected";
      readonly reason: ManagedHttpPreflightRejectionReason;
      readonly action: ActionRecord;
      readonly message: string;
      readonly requiredEffectClass?: ManagedHttpEffectClass;
    }
  | {
      readonly kind: "confirmed";
      readonly action: ActionRecord;
      readonly attempt: AttemptRecord;
      readonly evidence: JsonValue;
    }
  | {
      readonly kind: "definitive_failed";
      readonly action: ActionRecord;
      readonly attempt: AttemptRecord;
      readonly evidence: JsonValue;
    }
  | {
      readonly kind: "ambiguous";
      readonly action: ActionRecord;
      readonly attempt: AttemptRecord;
      readonly evidence: JsonValue;
    };

export type ManagedHttpExecutionStage = "claim" | "effect_start" | "settlement";

export class ManagedHttpPreflightError extends Error {
  public constructor(
    public readonly code:
      | "invalid_method"
      | "invalid_url"
      | "invalid_header"
      | "invalid_body"
      | "invalid_verification"
      | "invalid_message_operation"
      | "endpoint_denied"
      | "endpoint_resolution_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedHttpPreflightError";
  }
}

export class ManagedHttpExecutionError extends Error {
  public constructor(
    public readonly stage: ManagedHttpExecutionStage,
    public readonly effectMayHaveOccurred: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedHttpExecutionError";
  }
}

export interface ManagedHttpResponseObservation {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly contentType?: string;
  readonly body: string;
  readonly bodyBytes: number;
  readonly truncated: boolean;
  readonly sha256: string;
}

export type ObserveManagedHttpResult =
  | { readonly kind: "response"; readonly response: ManagedHttpResponseObservation }
  | {
      readonly kind: "failed";
      readonly code: "timeout" | "aborted" | "network_error" | "unsafe_redirect" | "credential_error";
      readonly message: string;
      readonly response?: Omit<ManagedHttpResponseObservation, "body">;
    };

interface ManagedHttpToolParams {
  readonly operation: "get" | "propose" | "execute";
  readonly url?: string;
  readonly headers?: readonly ManagedHttpHeaderReference[];
  readonly workId?: string;
  readonly semanticKey?: string;
  readonly method?: ManagedHttpMutationMethod;
  readonly body?: string;
  readonly verification?: ManagedHttpVerification;
  readonly messageOperation?: ManagedHttpMessageOperation;
  readonly actionId?: string;
  readonly revision?: number;
  readonly digest?: string;
}

interface PreparedEndpoint {
  readonly url: URL;
  readonly address: string;
  readonly purpose: ManagedHttpEndpointPurpose;
  readonly privateNetwork: boolean;
}

interface ResolvedHeaders {
  readonly headers: Headers;
  readonly secretValues: readonly string[];
}

interface ResponseCapture {
  readonly status: number;
  readonly ok: boolean;
  readonly contentType?: string;
  readonly location: string | null;
  readonly bytes: Buffer;
  readonly text: string;
  readonly truncated: boolean;
}

interface FetchFailure {
  readonly kind: "failed";
  readonly code: "timeout" | "aborted" | "network_error";
}

interface FetchResponse {
  readonly kind: "response";
  readonly response: ResponseCapture;
}

type FetchResult = FetchFailure | FetchResponse;

export interface ManagedHttpClassification {
  readonly effectClass: ManagedHttpEffectClass;
  readonly action: string;
  readonly recipient?: string;
  readonly topic?: string;
}

const headerReferenceSchema = Type.Union([
  Type.Object({
    name: Type.String({ minLength: 1, maxLength: 256 }),
    value: Type.String({ maxLength: MAX_HEADER_VALUE_BYTES }),
  }, { additionalProperties: false }),
  Type.Object({
    name: Type.String({ minLength: 1, maxLength: 256 }),
    secretRef: Type.String({ minLength: 1, maxLength: 512 }),
  }, { additionalProperties: false }),
]);

const verificationExpectationSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("json_field"),
    path: Type.Array(Type.Union([
      Type.String({ maxLength: 256 }),
      Type.Integer({ minimum: 0 }),
    ]), { minItems: 1, maxItems: 32 }),
    value: Type.Unknown(),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Enum(["text_contains", "text_equals"]),
    text: Type.String({ maxLength: DEFAULT_MAX_RESPONSE_BYTES }),
  }, { additionalProperties: false }),
]);

const verificationSchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 8_192 }),
  headers: Type.Optional(Type.Array(headerReferenceSchema, { maxItems: MAX_HEADERS })),
  expected: verificationExpectationSchema,
}, { additionalProperties: false });

const messageOperationSchema = Type.Object({
  recipient: Type.String({ minLength: 1, maxLength: 512 }),
  topic: Type.String({ minLength: 1, maxLength: 512 }),
  action: Type.String({ minLength: 1, maxLength: 512 }),
}, { additionalProperties: false });

/** Registration API; endpoint policy and secret resolution are host-owned. */
export function createManagedHttpTool(options: ManagedHttpToolOptions): CustomTool {
  const now = options.now ?? (() => new Date());
  const workerId = requiredTrimmed(options.workerId ?? DEFAULT_WORKER_ID, "workerId");
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxResponseBytes = boundedResponseBytes(options.maxResponseBytes);
  const maxEvidenceBodyBytes = boundedEvidenceBodyBytes(options.maxEvidenceBodyBytes, maxResponseBytes);

  return {
    name: "assistant_managed_http",
    label: "Managed HTTP",
    strict: true,
    concurrency: "exclusive",
    description: "Read one policy-validated HTTP(S) endpoint with GET, or propose/execute one exact POST, PUT, PATCH, or DELETE action. Execute planned mutations immediately; a separate GET verifies the result. Redirects and blind retries are disabled. Credentials use host-resolved secret header references, never plaintext header values.",
    parameters: Type.Object({
      operation: Type.Enum(["get", "propose", "execute"]),
      url: Type.Optional(Type.String({ minLength: 1, maxLength: 8_192 })),
      headers: Type.Optional(Type.Array(headerReferenceSchema, { maxItems: MAX_HEADERS })),
      workId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      semanticKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      method: Type.Optional(Type.Enum(MUTATION_METHODS)),
      body: Type.Optional(Type.String({ maxLength: MAX_BODY_BYTES })),
      verification: Type.Optional(verificationSchema),
      messageOperation: Type.Optional(messageOperationSchema),
      actionId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
      digest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _onUpdate, _context, signal) {
      const input = params as ManagedHttpToolParams;
      if (input.operation === "get") {
        rejectNonReadFields(input);
        const result = await observeManagedHttp({
          url: requiredString(input.url, "url"),
          headers: input.headers,
          endpointPolicy: options.endpointPolicy,
          resolveSecret: options.resolveSecret,
          timeoutMs,
          maxResponseBytes,
          signal,
        });
        return {
          content: [{ type: "text" as const, text: readResultText(result) }],
          details: { operation: "get" as const, ...result },
        };
      }

      if (input.operation === "propose") {
        rejectExecutionFieldsOnProposal(input);
        const proposed = await proposeManagedHttpAction({
          workId: requiredTrimmed(input.workId, "workId"),
          semanticKey: requiredTrimmed(input.semanticKey, "semanticKey"),
          method: requiredMutationMethod(input.method),
          url: requiredString(input.url, "url"),
          headers: input.headers,
          body: input.body,
          verification: requiredVerification(input.verification),
          messageOperation: input.messageOperation,
        }, {
          repository: options.repository,
          endpointPolicy: options.endpointPolicy,
          authorizeMessage: options.authorizeMessage,
          now: () => now().toISOString(),
        });
        return {
          content: [{ type: "text" as const, text: proposalText(proposed.action) }],
          details: {
            operation: "propose" as const,
            action: actionSummary(proposed.action),
            request: planSummary(proposed.plan),
            effectExecuted: false,
          },
        };
      }

      rejectProposalFieldsOnExecution(input);
      const actionId = requiredTrimmed(input.actionId, "actionId");
      const revision = requiredRevision(input.revision);
      const digest = requiredDigest(input.digest);
      const attemptId = stableAttemptId(actionId, revision, requiredTrimmed(toolCallId, "toolCallId"));
      const result = await executeManagedHttpAction({
        repository: options.repository,
        actionId,
        revision,
        digest,
        attemptId,
        workerId,
        endpointPolicy: options.endpointPolicy,
        resolveSecret: options.resolveSecret,
        authorizeMessage: options.authorizeMessage,
        timeoutMs,
        maxResponseBytes,
        maxEvidenceBodyBytes,
        signal,
        now: () => now().toISOString(),
      });
      return {
        content: [{ type: "text" as const, text: executionText(result, actionId, revision) }],
        details: executionDetails(result, attemptId),
      };
    },
  };
}

/** Performs one bounded, redirect-free GET. It does not create an action row. */
export async function observeManagedHttp(input: ObserveManagedHttpInput): Promise<ObserveManagedHttpResult> {
  const timeoutMs = positiveInteger(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxResponseBytes = boundedResponseBytes(input.maxResponseBytes);
  const maxReadBodyBytes = boundedReadBodyBytes(maxResponseBytes);
  const url = normalizeUrl(input.url, "read URL");
  const headers = normalizeHeaderReferences(input.headers ?? [], "read headers");
  const endpoint = await prepareEndpoint(url, "GET", "read", input.endpointPolicy);
  assertSecretTransport(headers, endpoint, "read headers");
  let resolved: ResolvedHeaders;
  try {
    resolved = await resolveHeaders(headers, input.resolveSecret, endpoint);
  } catch {
    return {
      kind: "failed",
      code: "credential_error",
      message: "A host-managed secret reference could not be resolved; the GET was not invoked.",
    };
  }
  const fetched = await fetchOnce(endpoint, "GET", resolved.headers, undefined, input.signal, timeoutMs, maxResponseBytes);
  if (fetched.kind === "failed") {
    return { kind: "failed", code: fetched.code, message: readFailureMessage(fetched.code) };
  }

  const observation = responseObservation(url.href, fetched.response, resolved.secretValues, maxReadBodyBytes);
  if (isRedirect(fetched.response.status)) {
    return {
      kind: "failed",
      code: "unsafe_redirect",
      message: "The GET returned a redirect, which was not followed.",
      response: omitBody(observation),
    };
  }
  return { kind: "response", response: observation };
}

/** Builds exact persisted mutation material after trusted endpoint-policy preflight. */
export async function preflightManagedHttpAction(
  input: PreflightManagedHttpActionInput,
  options: PreflightManagedHttpActionOptions,
): Promise<PreflightManagedHttpActionResult> {
  const workId = requiredTrimmed(input.workId, "workId");
  const semanticKey = requiredTrimmed(input.semanticKey, "semanticKey");
  const method = normalizeMutationMethod(input.method);
  const url = normalizeUrl(input.url, "mutation URL");
  const headers = normalizeHeaderReferences(input.headers ?? [], "mutation headers");
  const body = normalizeBody(input.body);
  const verification = normalizeVerification(input.verification);
  const messageOperation = input.messageOperation === undefined
    ? null
    : normalizeMessageOperation(input.messageOperation);

  const mutationEndpoint = await prepareEndpoint(url, method, "mutation", options.endpointPolicy);
  const verificationEndpoint = await prepareEndpoint(
    new URL(verification.url),
    "GET",
    "verification",
    options.endpointPolicy,
  );
  assertSecretTransport(headers, mutationEndpoint, "mutation headers");
  assertSecretTransport(verification.headers, verificationEndpoint, "verification headers");

  let plan: ManagedHttpPlan = {
    version: 1,
    method,
    url: url.href,
    headers,
    body,
    verification,
    messageOperation,
    messageAuthorization: null,
  };
  const messageAuthorization = plan.messageOperation === null
    ? undefined
    : normalizeMessageAuthorization(options.authorizeMessage?.(plan));
  if (messageAuthorization !== undefined) {
    plan = { ...plan, messageAuthorization };
  }
  const classification = classifyManagedHttpPlan(plan);
  const proposal: ProposeActionInput = {
    workId,
    semanticKey,
    effectClass: classification.effectClass,
    ...(classification.recipient === undefined ? {} : { recipient: classification.recipient }),
    ...(classification.topic === undefined ? {} : { topic: classification.topic }),
    action: classification.action,
    payload: managedHttpPlanToJson(plan),
    scope: managedHttpScope(plan),
  };
  return { effectClass: classification.effectClass, plan, proposal };
}

/** Preflights and persists one exact action revision through AssistantWorkRepository. */
export async function proposeManagedHttpAction(
  input: PreflightManagedHttpActionInput,
  options: ProposeManagedHttpActionOptions,
): Promise<ProposeManagedHttpActionResult> {
  const preflight = await preflightManagedHttpAction(input, options);
  const now = options.now ?? (() => new Date().toISOString());
  const action = options.repository.proposeAction(preflight.proposal, now());
  return { ...preflight, action };
}

/** Claims one exact revision, persists effect_started, fetches once, then verifies once. */
export async function executeManagedHttpAction(
  input: ExecuteManagedHttpActionInput,
): Promise<ManagedHttpExecutionResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const timeoutMs = positiveInteger(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxResponseBytes = boundedResponseBytes(input.maxResponseBytes);
  const maxEvidenceBodyBytes = boundedEvidenceBodyBytes(input.maxEvidenceBodyBytes, maxResponseBytes);
  const action = input.repository.getAction(input.actionId);
  if (!action) return { kind: "rejected", reason: "unknown_action" };
  if (action.revision !== input.revision) return { kind: "rejected", reason: "stale_revision", action };
  if (action.digest !== input.digest) return { kind: "rejected", reason: "stale_digest", action };

  let plan: ManagedHttpPlan;
  try {
    plan = parseManagedHttpPlan(action.payload);
  } catch (error) {
    return preflightRejected(action, "invalid_plan", safePreflightMessage(error));
  }
  if (plan.messageAuthorization !== null) {
    const currentMessageAuthorization = normalizeMessageAuthorization(input.authorizeMessage?.({
      ...plan,
      messageAuthorization: null,
    }));
    if (
      currentMessageAuthorization === undefined
      || !messageAuthorizationMatches(plan.messageAuthorization, currentMessageAuthorization)
    ) {
      return preflightRejected(action, "material_mismatch", "HTTP message semantics lack the persisted trusted host request binding");
    }
  }

  const classification = classifyManagedHttpPlan(plan);
  if (classification.effectClass !== action.effectClass) {
    return {
      kind: "preflight_rejected",
      reason: "effect_class_mismatch",
      action,
      message: `host preflight requires ${classification.effectClass}, not ${action.effectClass}`,
      requiredEffectClass: classification.effectClass,
    };
  }
  if (!managedHttpActionMatchesPlan(action, plan)) {
    return preflightRejected(action, "material_mismatch", "persisted action routing does not match the managed HTTP plan");
  }

  let mutationEndpoint: PreparedEndpoint;
  let verificationEndpoint: PreparedEndpoint;
  try {
    mutationEndpoint = await prepareEndpoint(new URL(plan.url), plan.method, "mutation", input.endpointPolicy);
    verificationEndpoint = await prepareEndpoint(
      new URL(plan.verification.url),
      "GET",
      "verification",
      input.endpointPolicy,
    );
    assertSecretTransport(plan.headers, mutationEndpoint, "mutation headers");
    assertSecretTransport(plan.verification.headers, verificationEndpoint, "verification headers");
  } catch (error) {
    const code = error instanceof ManagedHttpPreflightError && error.code === "endpoint_denied"
      ? "endpoint_denied"
      : "endpoint_resolution_failed";
    return preflightRejected(action, code, safePreflightMessage(error));
  }

  let claim: ReturnType<AssistantWorkRepository["claimForDispatch"]>;
  try {
    claim = input.repository.claimForDispatch({
      actionId: input.actionId,
      revision: input.revision,
      digest: input.digest,
      attemptId: input.attemptId,
      workerId: input.workerId,
    }, now());
  } catch (error) {
    throw new ManagedHttpExecutionError("claim", false, "managed HTTP claim failed", { cause: error });
  }
  if (claim.kind === "rejected") return claim;

  try {
    const started = input.repository.markEffectStarted({
      attemptId: input.attemptId,
      workerId: input.workerId,
    }, now());
    if (started.attempt.state !== "effect_started") {
      throw new Error(`unexpected attempt state after effect start: ${started.attempt.state}`);
    }
  } catch (error) {
    throw new ManagedHttpExecutionError(
      "effect_start",
      false,
      "effect_started could not be persisted; fetch was not invoked",
      { cause: error },
    );
  }

  if (input.signal?.aborted) {
    return settleDefinitive(input, {
      code: "http_cancelled_before_fetch",
      message: "the caller cancelled after effect_started was persisted but before fetch was invoked",
      retryable: false,
      effectInvoked: false,
    }, now);
  }

  let requestHeaders: ResolvedHeaders;
  let verificationHeaders: ResolvedHeaders;
  try {
    requestHeaders = await resolveHeaders(plan.headers, input.resolveSecret, mutationEndpoint);
    verificationHeaders = await resolveHeaders(
      plan.verification.headers,
      input.resolveSecret,
      verificationEndpoint,
    );
  } catch {
    return settleDefinitive(input, {
      code: "http_credential_resolution_failed",
      message: "a host-managed secret reference could not be resolved; fetch was not invoked",
      retryable: false,
      effectInvoked: false,
    }, now);
  }

  const allSecrets = dedupeSecrets([...requestHeaders.secretValues, ...verificationHeaders.secretValues]);
  let currentMutationEndpoint: PreparedEndpoint;
  try {
    currentMutationEndpoint = await prepareEndpoint(
      new URL(plan.url),
      plan.method,
      "mutation",
      input.endpointPolicy,
    );
    assertSecretTransport(plan.headers, currentMutationEndpoint, "mutation headers");
  } catch {
    return settleDefinitive(input, {
      code: "http_endpoint_changed_before_fetch",
      message: "the endpoint no longer passed trusted policy and address validation; fetch was not invoked",
      retryable: false,
      effectInvoked: false,
    }, now);
  }
  const mutation = await fetchOnce(
    currentMutationEndpoint,
    plan.method,
    requestHeaders.headers,
    plan.body ?? undefined,
    input.signal,
    timeoutMs,
    maxResponseBytes,
  );
  let verification: FetchResult;

  if (input.signal?.aborted) {
    verification = { kind: "failed", code: "aborted" };
  } else {
    try {
      const currentVerificationEndpoint = await prepareEndpoint(
        new URL(plan.verification.url),
        "GET",
        "verification",
        input.endpointPolicy,
      );
      assertSecretTransport(plan.verification.headers, currentVerificationEndpoint, "verification headers");
      verification = await fetchOnce(
        currentVerificationEndpoint,
        "GET",
        verificationHeaders.headers,
        undefined,
        undefined,
        timeoutMs,
        maxResponseBytes,
      );
    } catch {
      verification = { kind: "failed", code: "network_error" };
    }
  }

  const checked = mutation.kind === "response"
    && !isRedirect(mutation.response.status)
    && verification.kind === "response"
    && verificationMatches(plan.verification.expected, verification.response);
  const verifiedAt = now();
  let evidence = mutationEvidence(
    plan,
    mutation,
    verification,
    checked,
    allSecrets,
    maxEvidenceBodyBytes,
    verifiedAt,
  );
  if (Buffer.byteLength(canonicalJson(evidence), "utf8") > MAX_DURABLE_EVIDENCE_BYTES) {
    evidence = mutationEvidence(plan, mutation, verification, checked, allSecrets, 0, verifiedAt);
  }
  if (Buffer.byteLength(canonicalJson(evidence), "utf8") > MAX_DURABLE_EVIDENCE_BYTES) {
    evidence = compactMutationEvidence(plan, mutation, verification, checked, verifiedAt);
  }
  return checked
    ? settleConfirmed(input, evidence, now)
    : settleAmbiguous(input, evidence, now);
}

export function classifyManagedHttpPlan(plan: ManagedHttpPlan): ManagedHttpClassification {
  if (plan.messageOperation !== null && plan.messageAuthorization !== null) {
    return {
      effectClass: "external_message",
      recipient: plan.messageOperation.recipient,
      topic: plan.messageOperation.topic,
      action: plan.messageOperation.action,
    };
  }
  return { effectClass: "external_mutation", action: MANAGED_HTTP_ACTION };
}

/** Shared approval/dispatch recognition must validate payload-derived routing, not only an action-name constant. */
export function managedHttpActionMatchesPlan(action: ActionRecord, plan: ManagedHttpPlan): boolean {
  const expected = classifyManagedHttpPlan(plan);
  return action.effectClass === expected.effectClass
    && action.action === expected.action
    && action.recipient === expected.recipient
    && action.topic === expected.topic;
}

export function isManagedHttpActionRecord(action: ActionRecord): boolean {
  try {
    return managedHttpActionMatchesPlan(action, parseManagedHttpPlan(action.payload));
  } catch {
    return false;
  }
}

export function parseManagedHttpPlan(payload: JsonValue): ManagedHttpPlan {
  const object = jsonObject(payload, "managed HTTP payload");
  assertExactKeys(
    object,
    ["body", "headers", "messageAuthorization", "messageOperation", "method", "url", "verification", "version"],
    "managed HTTP payload",
  );
  if (object.version !== 1 || typeof object.method !== "string" || typeof object.url !== "string") {
    throw new ManagedHttpPreflightError("invalid_body", "managed HTTP payload must be a version 1 plan");
  }
  if (object.body !== null && typeof object.body !== "string") {
    throw new ManagedHttpPreflightError("invalid_body", "managed HTTP plan body must be a string or null");
  }
  if (!Array.isArray(object.headers)) {
    throw new ManagedHttpPreflightError("invalid_header", "managed HTTP plan headers must be an array");
  }
  const verificationObject = jsonObject(object.verification, "managed HTTP verification");
  assertExactKeys(verificationObject, ["expected", "headers", "url"], "managed HTTP verification");
  if (typeof verificationObject.url !== "string" || !Array.isArray(verificationObject.headers)) {
    throw new ManagedHttpPreflightError("invalid_verification", "managed HTTP verification fields are invalid");
  }

  const plan: ManagedHttpPlan = {
    version: 1,
    method: normalizeMutationMethod(object.method),
    url: normalizeUrl(object.url, "mutation URL").href,
    headers: normalizeHeaderReferences(
      object.headers.map((entry, index) => parseHeaderReference(entry, `mutation header ${index}`)),
      "mutation headers",
    ),
    body: normalizeBody(object.body ?? undefined),
    verification: {
      url: normalizeUrl(verificationObject.url, "verification URL").href,
      headers: normalizeHeaderReferences(
        verificationObject.headers.map((entry, index) => parseHeaderReference(entry, `verification header ${index}`)),
        "verification headers",
      ),
      expected: parseVerificationExpectation(verificationObject.expected),
    },
    messageAuthorization: object.messageAuthorization === null
      ? null
      : parseMessageAuthorization(object.messageAuthorization),
    messageOperation: object.messageOperation === null
      ? null
      : parseMessageOperation(object.messageOperation),
  };
  if (plan.messageAuthorization !== null && plan.messageOperation === null) {
    throw new ManagedHttpPreflightError(
      "invalid_message_operation",
      "managed HTTP host message authorization requires a message operation",
    );
  }
  if (canonicalJson(managedHttpPlanToJson(plan)) !== canonicalJson(payload)) {
    throw new ManagedHttpPreflightError("invalid_body", "managed HTTP plan is not in canonical form");
  }
  return plan;
}

export function managedHttpPlanToJson(plan: ManagedHttpPlan): JsonValue {
  return {
    version: 1,
    method: plan.method,
    url: plan.url,
    headers: plan.headers.map(headerReferenceToJson),
    body: plan.body,
    verification: {
      url: plan.verification.url,
      headers: plan.verification.headers.map(headerReferenceToJson),
      expected: verificationExpectationToJson(plan.verification.expected),
    },
    messageOperation: plan.messageOperation === null
      ? null
      : {
          recipient: plan.messageOperation.recipient,
          topic: plan.messageOperation.topic,
          action: plan.messageOperation.action,
        },
    messageAuthorization: plan.messageAuthorization === null
      ? null
      : {
          capabilityId: plan.messageAuthorization.capabilityId,
          capabilityVersion: plan.messageAuthorization.capabilityVersion,
        },
  };
}

function managedHttpScope(plan: ManagedHttpPlan): JsonValue {
  return {
    kind: "managed_http",
    method: plan.method,
    url: plan.url,
    headerReferences: plan.headers.map(headerScope),
    bodyBytes: plan.body === null ? 0 : Buffer.byteLength(plan.body, "utf8"),
    bodySha256: sha256(Buffer.from(plan.body ?? "", "utf8")),
    messageAuthorization: plan.messageAuthorization === null
      ? null
      : {
          capabilityId: plan.messageAuthorization.capabilityId,
          capabilityVersion: plan.messageAuthorization.capabilityVersion,
        },
    verification: {
      method: "GET",
      url: plan.verification.url,
      headerReferences: plan.verification.headers.map(headerScope),
      expectation: expectationScope(plan.verification.expected),
    },
  };
}

async function prepareEndpoint(
  url: URL,
  method: "GET" | ManagedHttpMutationMethod,
  purpose: ManagedHttpEndpointPurpose,
  policy: ManagedHttpEndpointPolicy,
): Promise<PreparedEndpoint> {
  const normalized = normalizeUrl(url.href, `${purpose} URL`);
  const hostname = unbracketHostname(normalized.hostname);
  const port = effectivePort(normalized);
  const addresses = await resolveEndpointAddresses(hostname);
  for (const address of addresses) {
    if (isCloudMetadataAddress(address)) {
      throw new ManagedHttpPreflightError(
        "endpoint_denied",
        `cloud metadata endpoints are not available through managed HTTP: ${normalized.origin}`,
      );
    }
  }

  let rawDecision: ManagedHttpEndpointPolicyDecision;
  try {
    rawDecision = await policy({
      url: normalized.href,
      origin: normalized.origin,
      scheme: normalized.protocol === "https:" ? "https" : "http",
      hostname,
      port,
      method,
      purpose,
      resolvedAddresses: addresses,
    });
  } catch (error) {
    throw new ManagedHttpPreflightError(
      "endpoint_denied",
      "trusted endpoint policy failed closed",
      { cause: error },
    );
  }
  const decision = typeof rawDecision === "boolean" ? { allowed: rawDecision } : rawDecision;
  if (!decision || typeof decision.allowed !== "boolean" || !decision.allowed) {
    throw new ManagedHttpPreflightError(
      "endpoint_denied",
      `trusted endpoint policy denied ${method} ${normalized.href}`,
    );
  }
  if (decision.allowPrivateNetwork !== undefined && typeof decision.allowPrivateNetwork !== "boolean") {
    throw new ManagedHttpPreflightError("endpoint_denied", "trusted endpoint policy returned an invalid decision");
  }
  if (addresses.some(isNonPublicAddress) && decision.allowPrivateNetwork !== true) {
    throw new ManagedHttpPreflightError(
      "endpoint_denied",
      `trusted endpoint policy did not allow the local address for ${normalized.origin}`,
    );
  }

  const address = addresses[0]!;
  if (proxyCouldIntercept(normalized, address)) {
    throw new ManagedHttpPreflightError(
      "endpoint_resolution_failed",
      "a configured HTTP proxy prevents validation of the actual endpoint address",
    );
  }
  return {
    url: normalized,
    address,
    purpose,
    privateNetwork: addresses.some(isNonPublicAddress),
  };
}

async function resolveEndpointAddresses(hostname: string): Promise<readonly string[]> {
  const family = isIP(hostname);
  if (family !== 0) return [hostname];
  let records: readonly { readonly address: string }[];
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new ManagedHttpPreflightError(
      "endpoint_resolution_failed",
      `endpoint hostname could not be resolved: ${hostname}`,
      { cause: error },
    );
  }
  const addresses = [...new Set(records.map((record) => record.address))];
  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0)) {
    throw new ManagedHttpPreflightError(
      "endpoint_resolution_failed",
      `endpoint hostname did not resolve to a usable IP address: ${hostname}`,
    );
  }
  return addresses;
}

async function resolveHeaders(
  references: readonly ManagedHttpHeaderReference[],
  resolver: ManagedHttpSecretResolver | undefined,
  endpoint: PreparedEndpoint,
): Promise<ResolvedHeaders> {
  const headers = new Headers();
  const secretValues: string[] = [];
  for (const reference of references) {
    if ("value" in reference) {
      headers.set(reference.name, reference.value);
      continue;
    }
    if (!resolver) throw new Error("managed HTTP secret resolver is unavailable");
    const resolved = await resolver(reference.secretRef, {
      headerName: reference.name,
      url: endpoint.url.href,
      purpose: endpoint.purpose,
    });
    if (typeof resolved !== "string" || resolved.length === 0 || /[\0\r\n]/.test(resolved)) {
      throw new Error("managed HTTP secret resolver returned an invalid value");
    }
    const value = normalizeHeaderValue(resolved, "resolved secret header");
    if (value.length === 0) throw new Error("managed HTTP secret resolver returned an empty value");
    secretValues.push(value);
    headers.set(reference.name, value);
  }
  return { headers, secretValues };
}

async function fetchOnce(
  endpoint: PreparedEndpoint,
  method: "GET" | ManagedHttpMutationMethod,
  headers: Headers,
  body: string | undefined,
  outerSignal: AbortSignal | undefined,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<FetchResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  outerSignal?.addEventListener("abort", abort, { once: true });
  if (outerSignal?.aborted) controller.abort();

  const requestHeaders = new Headers(headers);
  requestHeaders.set("host", endpoint.url.host);
  const networkUrl = directNetworkUrl(endpoint.url, endpoint.address);
  const init: BunFetchRequestInit = {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body }),
    signal: controller.signal,
    redirect: "manual",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    maxRedirects: 0,
    ...(endpoint.url.protocol === "https:"
      ? {
          tls: {
            serverName: unbracketHostname(endpoint.url.hostname),
            checkServerIdentity: (
              _hostname: string,
              certificate: Parameters<typeof checkServerIdentity>[1],
            ) => checkServerIdentity(unbracketHostname(endpoint.url.hostname), certificate),
          },
        }
      : {}),
  };

  try {
    const response = await fetch(networkUrl, init);
    return { kind: "response", response: await captureResponse(response, maxResponseBytes) };
  } catch {
    return {
      kind: "failed",
      code: timedOut ? "timeout" : outerSignal?.aborted ? "aborted" : "network_error",
    };
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", abort);
  }
}

async function captureResponse(response: Response, maxBytes: number): Promise<ResponseCapture> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      const remaining = maxBytes - bytes;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        bytes += Math.max(remaining, 0);
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
  }
  const content = Buffer.concat(chunks, bytes);
  return {
    status: response.status,
    ok: response.ok,
    contentType: boundedHeaderValue(response.headers.get("content-type")),
    location: response.headers.get("location"),
    bytes: content,
    text: content.toString("utf8"),
    truncated,
  };
}

/** Independently verifies persisted expectations against raw bounded bytes, never display-redacted text. */
export async function verifyManagedHttpPlan(plan: ManagedHttpPlan, options: ManagedHttpRuntimeOptions): Promise<JsonValue | undefined> {
  const endpoint = await prepareEndpoint(new URL(plan.verification.url), "GET", "verification", options.endpointPolicy);
  assertSecretTransport(plan.verification.headers, endpoint, "verification headers");
  const resolved = await resolveHeaders(plan.verification.headers, options.resolveSecret, endpoint);
  const result = await fetchOnce(endpoint, "GET", resolved.headers, undefined, undefined,
    positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"), boundedResponseBytes(options.maxResponseBytes));
  if (result.kind !== "response" || !verificationMatches(plan.verification.expected, result.response)) return undefined;
  return { verificationUrl: plan.verification.url, responseHash: sha256(result.response.bytes), status: result.response.status };
}

function verificationMatches(
  expectation: ManagedHttpVerificationExpectation,
  response: ResponseCapture,
): boolean {
  if (!response.ok || isRedirect(response.status)) return false;
  if (expectation.kind === "text_contains") return response.text.includes(expectation.text);
  if (expectation.kind === "text_equals") return !response.truncated && response.text === expectation.text;
  if (expectation.kind !== "json_field") return false;
  if (response.truncated) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    return false;
  }
  let current = parsed;
  for (const segment of expectation.path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return false;
      current = current[segment];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return isJsonValue(current) && canonicalJson(current) === canonicalJson(expectation.value);
}

function mutationEvidence(
  plan: ManagedHttpPlan,
  mutation: FetchResult,
  verification: FetchResult,
  matched: boolean,
  secrets: readonly string[],
  maxEvidenceBodyBytes: number,
  verifiedAt: string,
): JsonValue {
  return {
    kind: "managed_http_verification",
    version: 1,
    code: matched ? "http_effect_verified" : "http_effect_unconfirmed",
    message: matched
      ? "the verification GET proved the expected remote state"
      : "the mutation may have occurred, but the verification GET did not prove the expected remote state",
    retryable: false,
    verifiedAt,
    effectInvoked: true,
    request: fetchEvidence(plan.url, plan.method, mutation, secrets, 0),
    verification: {
      ...fetchEvidence(plan.verification.url, "GET", verification, secrets, maxEvidenceBodyBytes),
      matched,
      expectation: expectationScope(plan.verification.expected),
    },
  };
}

function compactMutationEvidence(
  plan: ManagedHttpPlan,
  mutation: FetchResult,
  verification: FetchResult,
  matched: boolean,
  verifiedAt: string,
): JsonValue {
  return {
    kind: "managed_http_verification",
    version: 1,
    code: matched ? "http_effect_verified" : "http_effect_unconfirmed",
    message: matched
      ? "the verification GET proved the expected remote state"
      : "the mutation may have occurred, but the verification GET did not prove the expected remote state",
    retryable: false,
    verifiedAt,
    effectInvoked: true,
    evidenceCompacted: true,
    request: compactFetchEvidence(plan.url, plan.method, mutation),
    verification: {
      ...compactFetchEvidence(plan.verification.url, "GET", verification),
      matched,
      expectation: expectationScope(plan.verification.expected),
    },
  };
}

function compactFetchEvidence(
  url: string,
  method: "GET" | ManagedHttpMutationMethod,
  result: FetchResult,
): { readonly [key: string]: JsonValue } {
  return result.kind === "failed"
    ? { method, url, outcome: result.code }
    : {
        method,
        url,
        outcome: isRedirect(result.response.status) ? "redirect_rejected" : "response",
        status: result.response.status,
        ok: result.response.ok,
        bodyBytes: result.response.bytes.byteLength,
        bodySha256: sha256(result.response.bytes),
        truncated: result.response.truncated,
      };
}

function fetchEvidence(
  url: string,
  method: "GET" | ManagedHttpMutationMethod,
  result: FetchResult,
  secrets: readonly string[],
  textLimit: number,
): { readonly [key: string]: JsonValue } {
  if (result.kind === "failed") {
    return { url, method, outcome: result.code };
  }
  const response = result.response;
  return {
    url,
    method,
    outcome: isRedirect(response.status) ? "redirect_rejected" : "response",
    status: response.status,
    ok: response.ok,
    ...(response.contentType === undefined ? {} : { contentType: redactText(response.contentType, secrets) }),
    bodyBytes: response.bytes.byteLength,
    bodySha256: sha256(response.bytes),
    truncated: response.truncated,
    ...(textLimit <= 0
      ? {}
      : {
          bodySampleBytes: Math.min(response.bytes.byteLength, textLimit),
          bodySampleSha256: sha256(response.bytes.subarray(0, textLimit)),
        }),
  };
}

function responseObservation(
  url: string,
  response: ResponseCapture,
  secrets: readonly string[],
  maxReadBodyBytes: number,
): ManagedHttpResponseObservation {
  const body = redactText(response.text, secrets);
  const bodyBytes = Buffer.byteLength(body, "utf8");
  return {
    url,
    status: response.status,
    ok: response.ok,
    ...(response.contentType === undefined ? {} : { contentType: redactText(response.contentType, secrets) }),
    body: truncateUtf8(body, maxReadBodyBytes),
    bodyBytes: response.bytes.byteLength,
    truncated: response.truncated || bodyBytes > maxReadBodyBytes,
    sha256: sha256(response.bytes),
  };
}

function settleConfirmed(
  input: ExecuteManagedHttpActionInput,
  evidence: JsonValue,
  now: () => string,
): Extract<ManagedHttpExecutionResult, { readonly kind: "confirmed" }> {
  try {
    const settled = input.repository.confirmAttempt({
      attemptId: input.attemptId,
      workerId: input.workerId,
      outcome: evidence,
    }, now());
    return { kind: "confirmed", ...settled, evidence };
  } catch (error) {
    throw new ManagedHttpExecutionError("settlement", true, "managed HTTP confirmation could not be persisted", { cause: error });
  }
}

function settleDefinitive(
  input: ExecuteManagedHttpActionInput,
  evidence: JsonValue,
  now: () => string,
): Extract<ManagedHttpExecutionResult, { readonly kind: "definitive_failed" }> {
  try {
    const settled = input.repository.failAttemptDefinitively({
      attemptId: input.attemptId,
      workerId: input.workerId,
      outcome: evidence,
    }, now());
    return { kind: "definitive_failed", ...settled, evidence };
  } catch (error) {
    throw new ManagedHttpExecutionError("settlement", false, "managed HTTP definitive failure could not be persisted", { cause: error });
  }
}

function settleAmbiguous(
  input: ExecuteManagedHttpActionInput,
  evidence: JsonValue,
  now: () => string,
): Extract<ManagedHttpExecutionResult, { readonly kind: "ambiguous" }> {
  try {
    const settled = input.repository.markAttemptAmbiguous({
      attemptId: input.attemptId,
      workerId: input.workerId,
      outcome: evidence,
    }, now());
    return { kind: "ambiguous", ...settled, evidence };
  } catch (error) {
    throw new ManagedHttpExecutionError("settlement", true, "managed HTTP ambiguity could not be persisted", { cause: error });
  }
}

function normalizeUrl(input: string, label: string): URL {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || input.length > 8_192) {
    throw new ManagedHttpPreflightError("invalid_url", `${label} must be a non-empty URL without surrounding whitespace`);
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new ManagedHttpPreflightError("invalid_url", `${label} is invalid`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ManagedHttpPreflightError("invalid_url", `${label} must use http or https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ManagedHttpPreflightError("invalid_url", `${label} must not contain URL credentials`);
  }
  if (url.hash !== "") {
    throw new ManagedHttpPreflightError("invalid_url", `${label} must not contain a fragment`);
  }
  const hostname = unbracketHostname(url.hostname);
  if (hostname.length === 0 || hostname.includes("%")) {
    throw new ManagedHttpPreflightError("invalid_url", `${label} has an invalid hostname`);
  }
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_NAME.test(key)) {
      throw new ManagedHttpPreflightError(
        "invalid_url",
        `${label} must pass credentials through a secret header reference, not a query parameter`,
      );
    }
  }
  return url;
}

function normalizeHeaderReferences(
  input: readonly ManagedHttpHeaderReference[],
  label: string,
): readonly ManagedHttpHeaderReference[] {
  if (!Array.isArray(input) || input.length > MAX_HEADERS) {
    throw new ManagedHttpPreflightError("invalid_header", `${label} must contain at most ${MAX_HEADERS} entries`);
  }
  const result = input.map((entry, index): ManagedHttpHeaderReference => {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      throw new ManagedHttpPreflightError("invalid_header", `${label} entry ${index} is invalid`);
    }
    const keys = Object.keys(entry).sort();
    const isLiteral = keys.length === 2 && keys[0] === "name" && keys[1] === "value" && typeof entry.value === "string";
    const isSecret = keys.length === 2 && keys[0] === "name" && keys[1] === "secretRef" && typeof entry.secretRef === "string";
    if (!isLiteral && !isSecret) {
      throw new ManagedHttpPreflightError(
        "invalid_header",
        `${label} entry ${index} must contain exactly name+value or name+secretRef`,
      );
    }
    const name = normalizeHeaderName(entry.name, `${label} entry ${index}`);
    if (isLiteral) {
      if (SENSITIVE_HEADER_NAME.test(name)) {
        throw new ManagedHttpPreflightError(
          "invalid_header",
          `${name} must use a host-resolved secretRef instead of a plaintext value`,
        );
      }
      return { name, value: normalizeHeaderValue(entry.value as string, `${label} entry ${index}`) };
    }
    const secretRef = normalizeSecretReference(entry.secretRef as string, `${label} entry ${index} secretRef`);
    return { name, secretRef };
  });
  result.sort((left, right) => left.name.localeCompare(right.name));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]!.name === result[index]!.name) {
      throw new ManagedHttpPreflightError("invalid_header", `${label} contains duplicate header ${result[index]!.name}`);
    }
  }
  return result;
}

function normalizeHeaderName(input: string, label: string): string {
  const name = input.toLowerCase();
  if (input.length === 0 || input !== input.trim() || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(input)) {
    throw new ManagedHttpPreflightError("invalid_header", `${label} has an invalid header name`);
  }
  if (FORBIDDEN_REQUEST_HEADERS.has(name) || name.startsWith("sec-") || name.startsWith("proxy-")) {
    throw new ManagedHttpPreflightError("invalid_header", `${name} is controlled by the managed HTTP transport`);
  }
  return name;
}

function normalizeHeaderValue(input: string, label: string): string {
  if (/[\0\r\n]/.test(input) || Buffer.byteLength(input, "utf8") > MAX_HEADER_VALUE_BYTES) {
    throw new ManagedHttpPreflightError("invalid_header", `${label} has an invalid or oversized header value`);
  }
  const headers = new Headers();
  try {
    headers.set("x-openinstinct-normalize", input);
  } catch (error) {
    throw new ManagedHttpPreflightError("invalid_header", `${label} has an invalid header value`, { cause: error });
  }
  return headers.get("x-openinstinct-normalize")!;
}

function normalizeBody(input: string | undefined): string | null {
  if (input === undefined) return null;
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > MAX_BODY_BYTES) {
    throw new ManagedHttpPreflightError("invalid_body", "managed HTTP body must be a string no larger than 1 MiB");
  }
  if (bodyContainsPlainCredential(input)) {
    throw new ManagedHttpPreflightError(
      "invalid_body",
      "managed HTTP body appears to contain plaintext credential material; credentials must use secret header references",
    );
  }
  return input;
}

function bodyContainsPlainCredential(body: string): boolean {
  if (/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/i.test(body)) return true;
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(body)) return true;
  try {
    if (jsonContainsCredential(JSON.parse(body))) return true;
  } catch {
    // Non-JSON bodies are checked as form data below.
  }
  if (!body.includes("=")) return false;
  try {
    for (const key of new URLSearchParams(body).keys()) {
      if (SENSITIVE_BODY_KEY.test(key)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function jsonContainsCredential(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(jsonContainsCredential);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => SENSITIVE_BODY_KEY.test(key) || jsonContainsCredential(nested));
}

function normalizeVerification(input: ManagedHttpVerification): ManagedHttpPlan["verification"] {
  if (!isRecord(input)) {
    throw new ManagedHttpPreflightError("invalid_verification", "verification is required");
  }
  const keys = Object.keys(input).sort();
  if (keys.some((key) => key !== "expected" && key !== "headers" && key !== "url") || !keys.includes("expected") || !keys.includes("url")) {
    throw new ManagedHttpPreflightError("invalid_verification", "verification contains unsupported or missing fields");
  }
  if (typeof input.url !== "string") {
    throw new ManagedHttpPreflightError("invalid_verification", "verification URL is required");
  }
  return {
    url: normalizeUrl(input.url, "verification URL").href,
    headers: normalizeHeaderReferences(input.headers ?? [], "verification headers"),
    expected: normalizeVerificationExpectation(input.expected),
  };
}

function normalizeVerificationExpectation(input: ManagedHttpVerificationExpectation): ManagedHttpVerificationExpectation {
  if (!isRecord(input) || typeof input.kind !== "string") {
    throw new ManagedHttpPreflightError("invalid_verification", "verification expectation is invalid");
  }
  if (input.kind === "json_field") {
    const keys = Object.keys(input).sort();
    if (keys.length !== 3 || keys[0] !== "kind" || keys[1] !== "path" || keys[2] !== "value" || !Array.isArray(input.path)) {
      throw new ManagedHttpPreflightError("invalid_verification", "json_field verification requires exactly path and value");
    }
    if (input.path.length === 0 || input.path.length > 32) {
      throw new ManagedHttpPreflightError("invalid_verification", "json_field verification path must contain 1 to 32 segments");
    }
    const path = input.path.map((segment, index) => {
      if (typeof segment === "string" && segment.length <= 256 && !/[\0\r\n]/.test(segment)) return segment;
      if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) return segment;
      throw new ManagedHttpPreflightError("invalid_verification", `json_field verification path segment ${index} is invalid`);
    });
    if (Buffer.byteLength(canonicalJson(path), "utf8") > 2_048) {
      throw new ManagedHttpPreflightError("invalid_verification", "json_field verification path is too large");
    }
    if (!isJsonValue(input.value)) {
      throw new ManagedHttpPreflightError("invalid_verification", "json_field expected value must be JSON-compatible");
    }
    return { kind: "json_field", path, value: cloneJsonValue(input.value) };
  }
  if (input.kind === "text_contains" || input.kind === "text_equals") {
    const keys = Object.keys(input).sort();
    if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "text" || typeof input.text !== "string") {
      throw new ManagedHttpPreflightError("invalid_verification", `${input.kind} verification requires exactly text`);
    }
    if (input.text.length > DEFAULT_MAX_RESPONSE_BYTES || (input.kind === "text_contains" && input.text.length === 0)) {
      throw new ManagedHttpPreflightError("invalid_verification", `${input.kind} verification text is invalid`);
    }
    return { kind: input.kind, text: input.text };
  }
  throw new ManagedHttpPreflightError("invalid_verification", "unsupported verification expectation");
}

function normalizeMessageOperation(input: ManagedHttpMessageOperation): ManagedHttpMessageOperation {
  if (!isRecord(input)) {
    throw new ManagedHttpPreflightError("invalid_message_operation", "messageOperation must be an object");
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== 3 || keys[0] !== "action" || keys[1] !== "recipient" || keys[2] !== "topic") {
    throw new ManagedHttpPreflightError(
      "invalid_message_operation",
      "messageOperation requires exactly recipient, topic, and action",
    );
  }
  return {
    recipient: requiredExactString(input.recipient, "messageOperation recipient", 512),
    topic: requiredExactString(input.topic, "messageOperation topic", 512),
    action: requiredExactString(input.action, "messageOperation action", 512),
  };
}

function parseHeaderReference(value: JsonValue, label: string): ManagedHttpHeaderReference {
  const object = jsonObject(value, label);
  const keys = Object.keys(object).sort();
  if (keys.length !== 2 || keys[0] !== "name") {
    throw new ManagedHttpPreflightError("invalid_header", `${label} must contain exactly two fields`);
  }
  if (keys[1] === "value" && typeof object.name === "string" && typeof object.value === "string") {
    return { name: object.name, value: object.value };
  }
  if (keys[1] === "secretRef" && typeof object.name === "string" && typeof object.secretRef === "string") {
    return { name: object.name, secretRef: object.secretRef };
  }
  throw new ManagedHttpPreflightError("invalid_header", `${label} is invalid`);
}

function parseVerificationExpectation(value: JsonValue | undefined): ManagedHttpVerificationExpectation {
  const object = jsonObject(value, "managed HTTP verification expectation");
  if (object.kind === "json_field") {
    if (!Array.isArray(object.path) || object.value === undefined) {
      throw new ManagedHttpPreflightError("invalid_verification", "json_field verification is invalid");
    }
    return normalizeVerificationExpectation({
      kind: "json_field",
      path: object.path.map((segment) => {
        if (typeof segment !== "string" && typeof segment !== "number") {
          throw new ManagedHttpPreflightError("invalid_verification", "json_field path segment is invalid");
        }
        return segment;
      }),
      value: object.value,
    });
  }
  if ((object.kind === "text_contains" || object.kind === "text_equals") && typeof object.text === "string") {
    return normalizeVerificationExpectation({ kind: object.kind, text: object.text });
  }
  throw new ManagedHttpPreflightError("invalid_verification", "managed HTTP verification expectation is invalid");
}

function parseMessageAuthorization(value: JsonValue): ManagedHttpMessageAuthorization {
  const object = jsonObject(value, "managed HTTP message authorization");
  assertExactKeys(object, ["capabilityId", "capabilityVersion"], "managed HTTP message authorization");
  return normalizeMessageAuthorization(object) ?? (() => {
    throw new ManagedHttpPreflightError("invalid_message_operation", "managed HTTP message authorization is invalid");
  })();
}

function normalizeMessageAuthorization(value: unknown): ManagedHttpMessageAuthorization | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ManagedHttpPreflightError("invalid_message_operation", "host message authorization is invalid");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2
    || keys[0] !== "capabilityId"
    || keys[1] !== "capabilityVersion"
    || typeof value.capabilityId !== "string"
    || value.capabilityId.length === 0
    || value.capabilityId.length > 256
    || value.capabilityId !== value.capabilityId.trim()
    || /[\0\r\n]/.test(value.capabilityId)
    || !Number.isSafeInteger(value.capabilityVersion)
    || (value.capabilityVersion as number) < 1
  ) {
    throw new ManagedHttpPreflightError("invalid_message_operation", "host message authorization is invalid");
  }
  return { capabilityId: value.capabilityId, capabilityVersion: value.capabilityVersion as number };
}

function messageAuthorizationMatches(
  persisted: ManagedHttpMessageAuthorization | null,
  current: ManagedHttpMessageAuthorization,
): boolean {
  return persisted?.capabilityId === current.capabilityId
    && persisted.capabilityVersion === current.capabilityVersion;
}
function parseMessageOperation(value: JsonValue): ManagedHttpMessageOperation {
  const object = jsonObject(value, "managed HTTP message operation");
  if (typeof object.recipient !== "string" || typeof object.topic !== "string" || typeof object.action !== "string") {
    throw new ManagedHttpPreflightError("invalid_message_operation", "managed HTTP message operation is invalid");
  }
  return normalizeMessageOperation({
    recipient: object.recipient,
    topic: object.topic,
    action: object.action,
  });
}


function directNetworkUrl(url: URL, address: string): URL {
  const direct = new URL(url.href);
  direct.hostname = address.includes(":") ? `[${address}]` : address;
  return direct;
}

function assertSecretTransport(
  headers: readonly ManagedHttpHeaderReference[],
  endpoint: PreparedEndpoint,
  label: string,
): void {
  if (
    endpoint.url.protocol === "http:"
    && !endpoint.privateNetwork
    && headers.some((header) => "secretRef" in header)
  ) {
    throw new ManagedHttpPreflightError(
      "endpoint_denied",
      `${label} cannot send secret references over public plaintext HTTP`,
    );
  }
}

function isCloudMetadataAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return address === "169.254.169.254"
      || address === "169.254.170.2"
      || address === "169.254.170.23"
      || address === "100.100.100.200";
  }
  const groups = ipv6Groups(address);
  if (groups === undefined) return false;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isCloudMetadataAddress(
      `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`,
    );
  }
  if (
    groups[0] === 0x0064
    && groups[1] === 0xff9b
    && groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isCloudMetadataAddress(
      `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`,
    );
  }
  return groups[0] === 0xfd00
    && groups[1] === 0x0ec2
    && groups.slice(2, 7).every((group) => group === 0)
    && groups[7] === 0x0254;
}

function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    if (a === undefined || b === undefined || c === undefined) return true;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (family !== 6) return true;
  const groups = ipv6Groups(address);
  if (!groups) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] === 0 || groups[7] === 1)) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isNonPublicAddress(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  }
  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true;
  if (
    first === 0x0064
    && groups[1] === 0xff9b
    && groups.slice(2, 6).every((group) => group === 0)
  ) return false;
  if ((first & 0xe000) !== 0x2000) return true;
  return first === 0x2001 && groups[1] === 0x0db8;
}

function ipv6Groups(address: string): readonly number[] | undefined {
  let input = address.toLowerCase();
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);
  if (input.includes(".")) {
    const separator = input.lastIndexOf(":");
    const dotted = input.slice(separator + 1);
    if (isIP(dotted) !== 4) return undefined;
    const octets = dotted.split(".").map(Number);
    input = `${input.slice(0, separator)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => Number.parseInt(group, 16));
}

function proxyCouldIntercept(url: URL, address: string): boolean {
  const proxy = url.protocol === "https:"
    ? process.env.HTTPS_PROXY ?? process.env.https_proxy
    : process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy) return false;
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
  if (!noProxy) return true;
  const entries = noProxy.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.includes("*")) return false;
  return !entries.some((entry) => noProxyEntryMatches(entry, address, effectivePort(url)));
}

function noProxyEntryMatches(entry: string, hostname: string, port: number): boolean {
  let host = entry;
  let expectedPort: number | undefined;
  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    if (close < 0) return false;
    host = entry.slice(1, close);
    if (entry[close + 1] === ":") expectedPort = Number(entry.slice(close + 2));
  } else {
    const colon = entry.lastIndexOf(":");
    if (colon > 0 && entry.indexOf(":") === colon) {
      const parsed = Number(entry.slice(colon + 1));
      if (Number.isInteger(parsed)) {
        host = entry.slice(0, colon);
        expectedPort = parsed;
      }
    }
  }
  if (expectedPort !== undefined && expectedPort !== port) return false;
  const normalizedHost = hostname.toLowerCase();
  const normalizedEntry = host.toLowerCase().replace(/^\./, "");
  return normalizedHost === normalizedEntry || normalizedHost.endsWith(`.${normalizedEntry}`);
}

function effectivePort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function headerReferenceToJson(reference: ManagedHttpHeaderReference): JsonValue {
  return "value" in reference
    ? { name: reference.name, value: reference.value }
    : { name: reference.name, secretRef: reference.secretRef };
}

function headerScope(reference: ManagedHttpHeaderReference): JsonValue {
  return "value" in reference
    ? {
        name: reference.name,
        source: "literal",
        valueBytes: Buffer.byteLength(reference.value, "utf8"),
        valueSha256: sha256(Buffer.from(reference.value, "utf8")),
      }
    : { name: reference.name, source: "secret_ref", reference: reference.secretRef };
}

function verificationExpectationToJson(expectation: ManagedHttpVerificationExpectation): JsonValue {
  return expectation.kind === "json_field"
    ? { kind: "json_field", path: expectation.path, value: expectation.value }
    : { kind: expectation.kind, text: expectation.text };
}

function expectationScope(expectation: ManagedHttpVerificationExpectation): JsonValue {
  if (expectation.kind === "json_field") {
    return {
      kind: "json_field",
      path: expectation.path,
      expectedSha256: sha256(Buffer.from(canonicalJson(expectation.value), "utf8")),
    };
  }
  return {
    kind: expectation.kind,
    expectedBytes: Buffer.byteLength(expectation.text, "utf8"),
    expectedSha256: sha256(Buffer.from(expectation.text, "utf8")),
  };
}

function preflightRejected(
  action: ActionRecord,
  reason: ManagedHttpPreflightRejectionReason,
  message: string,
): Extract<ManagedHttpExecutionResult, { readonly kind: "preflight_rejected" }> {
  return { kind: "preflight_rejected", reason, action, message };
}

function safePreflightMessage(error: unknown): string {
  if (error instanceof ManagedHttpPreflightError) return error.message;
  return "managed HTTP preflight failed";
}

function readFailureMessage(code: "timeout" | "aborted" | "network_error" | "credential_error"): string {
  if (code === "timeout") return "The GET timed out; it was not retried.";
  if (code === "aborted") return "The GET was cancelled; it was not retried.";
  if (code === "credential_error") return "A host-managed secret reference could not be resolved; the GET was not invoked.";
  return "The GET failed at the network boundary; it was not retried.";
}

function readResultText(result: ObserveManagedHttpResult): string {
  if (result.kind === "failed") return result.message;
  const suffix = result.response.truncated ? " Response body was truncated at the configured byte limit." : "";
  return `GET ${result.response.url} returned HTTP ${result.response.status}.${suffix}\n\n${result.response.body}`;
}

function proposalText(action: ActionRecord): string {
  const identity = `action ${action.id} revision ${action.revision} digest ${action.digest}`;
  return `Recorded ${identity} in state ${action.state}. This proposal invoked no request. If planned, execute assistant_managed_http immediately with this exact actionId, revision, and digest.`;
}

function executionText(
  result: ManagedHttpExecutionResult,
  actionId: string,
  revision: number,
): string {
  if (result.kind === "confirmed") {
    return `Confirmed action ${actionId} revision ${revision}. One mutation request ran and the separate GET verification proved the expected remote state.`;
  }
  if (result.kind === "ambiguous") {
    return `Action ${actionId} revision ${revision} is ambiguous after effect_started. The mutation may have occurred, verification did not prove the expected state, and no retry was attempted.`;
  }
  if (result.kind === "definitive_failed") {
    return `Action ${actionId} revision ${revision} failed before fetch was invoked. No retry was attempted.`;
  }
  if (result.kind === "preflight_rejected") {
    return `Did not dispatch action ${actionId} revision ${revision}: ${result.message}. Re-propose from current trusted endpoint policy.`;
  }
  if (result.kind === "rejected") {
    return `Did not dispatch action ${actionId} revision ${revision}: ${result.reason}. No new request was invoked.`;
  }
  return assertNever(result);
}

function executionDetails(result: ManagedHttpExecutionResult, attemptId: string): Record<string, unknown> {
  if (result.kind === "rejected") {
    return {
      operation: "execute",
      kind: result.kind,
      reason: result.reason,
      attemptId,
      ...(result.action === undefined ? {} : { action: actionSummary(result.action) }),
      ...(result.attempt === undefined ? {} : { attempt: attemptSummary(result.attempt) }),
    };
  }
  if (result.kind === "preflight_rejected") {
    return {
      operation: "execute",
      kind: result.kind,
      reason: result.reason,
      message: result.message,
      attemptId,
      action: actionSummary(result.action),
      ...(result.requiredEffectClass === undefined ? {} : { requiredEffectClass: result.requiredEffectClass }),
    };
  }
  return {
    operation: "execute",
    kind: result.kind,
    attemptId,
    action: actionSummary(result.action),
    attempt: attemptSummary(result.attempt),
    evidence: result.evidence,
  };
}

function actionSummary(action: ActionRecord): Record<string, unknown> {
  return {
    id: action.id,
    workId: action.workId,
    semanticKey: action.semanticKey,
    revision: action.revision,
    digest: action.digest,
    state: action.state,
    effectClass: action.effectClass,
    action: action.action,
    ...(action.recipient === undefined ? {} : { recipient: action.recipient }),
    ...(action.topic === undefined ? {} : { topic: action.topic }),
    ...(action.activeAttemptId === undefined ? {} : { activeAttemptId: action.activeAttemptId }),
  };
}

function attemptSummary(attempt: AttemptRecord): Record<string, unknown> {
  return {
    id: attempt.id,
    actionId: attempt.actionId,
    actionRevision: attempt.actionRevision,
    actionDigest: attempt.actionDigest,
    state: attempt.state,
    claimedAt: attempt.claimedAt,
    ...(attempt.effectStartedAt === undefined ? {} : { effectStartedAt: attempt.effectStartedAt }),
    ...(attempt.settledAt === undefined ? {} : { settledAt: attempt.settledAt }),
    ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome }),
  };
}

function planSummary(plan: ManagedHttpPlan): Record<string, unknown> {
  return {
    method: plan.method,
    url: plan.url,
    headers: plan.headers.map((header) => (
      "secretRef" in header
        ? { name: header.name, source: "secret_ref", reference: header.secretRef }
        : { name: header.name, source: "literal", valueBytes: Buffer.byteLength(header.value, "utf8") }
    )),
    bodyBytes: plan.body === null ? 0 : Buffer.byteLength(plan.body, "utf8"),
    verification: {
      method: "GET",
      url: plan.verification.url,
      expectation: expectationScope(plan.verification.expected),
    },
  };
}

function rejectNonReadFields(input: ManagedHttpToolParams): void {
  if (
    input.workId !== undefined
    || input.semanticKey !== undefined
    || input.method !== undefined
    || input.body !== undefined
    || input.verification !== undefined
    || input.messageOperation !== undefined
    || input.actionId !== undefined
    || input.revision !== undefined
    || input.digest !== undefined
  ) {
    throw new Error("managed HTTP get accepts only url and headers");
  }
}

function rejectExecutionFieldsOnProposal(input: ManagedHttpToolParams): void {
  if (input.actionId !== undefined || input.revision !== undefined || input.digest !== undefined) {
    throw new Error("managed HTTP proposal must not include actionId, revision, or digest");
  }
}

function rejectProposalFieldsOnExecution(input: ManagedHttpToolParams): void {
  if (
    input.url !== undefined
    || input.headers !== undefined
    || input.workId !== undefined
    || input.semanticKey !== undefined
    || input.method !== undefined
    || input.body !== undefined
    || input.verification !== undefined
    || input.messageOperation !== undefined
  ) {
    throw new Error("managed HTTP execution accepts only actionId, revision, and digest");
  }
}

function requiredVerification(value: ManagedHttpVerification | undefined): ManagedHttpVerification {
  if (value === undefined) throw new Error("verification is required when proposing a managed HTTP action");
  return value;
}

function requiredMutationMethod(value: ManagedHttpMutationMethod | undefined): ManagedHttpMutationMethod {
  if (value === undefined) throw new Error("method is required when proposing a managed HTTP action");
  return value;
}

function normalizeMutationMethod(input: string): ManagedHttpMutationMethod {
  if (typeof input !== "string") {
    throw new ManagedHttpPreflightError("invalid_method", "managed HTTP method is required");
  }
  const method = input.toUpperCase();
  if (!MUTATION_METHODS.includes(method as ManagedHttpMutationMethod)) {
    throw new ManagedHttpPreflightError(
      "invalid_method",
      "managed HTTP mutations support only POST, PUT, PATCH, and DELETE",
    );
  }
  return method as ManagedHttpMutationMethod;
}

function requiredTrimmed(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredString(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requiredExactString(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
    || /[\0\r\n]/.test(value)
  ) {
    throw new ManagedHttpPreflightError("invalid_message_operation", `${label} is invalid`);
  }
  return value;
}

function normalizeSecretReference(value: string, label: string): string {
  if (
    value.length > 512
    || !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(value)
    || value.includes("/../")
    || value.endsWith("/..")
  ) {
    throw new ManagedHttpPreflightError(
      "invalid_header",
      `${label} must be an opaque secret:// reference, not credential material`,
    );
  }
  return value;
}

function requiredRevision(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("revision must be a positive integer");
  return value as number;
}

function requiredDigest(value: string | undefined): string {
  const digest = requiredTrimmed(value, "digest");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("digest must be a lowercase sha256 digest");
  return digest;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function boundedResponseBytes(value: number | undefined): number {
  const normalized = positiveInteger(value ?? DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
  if (normalized > MAX_RESPONSE_BYTES) throw new Error("maxResponseBytes must not exceed 1 MiB");
  return normalized;
}

function boundedReadBodyBytes(maxResponseBytes: number): number {
  return maxResponseBytes;
}

function boundedEvidenceBodyBytes(value: number | undefined, maxResponseBytes: number): number {
  const normalized = positiveInteger(
    value ?? Math.min(DEFAULT_MAX_EVIDENCE_BODY_BYTES, maxResponseBytes),
    "maxEvidenceBodyBytes",
  );
  if (normalized > maxResponseBytes) throw new Error("maxEvidenceBodyBytes must not exceed maxResponseBytes");
  if (normalized > DEFAULT_MAX_EVIDENCE_BODY_BYTES) throw new Error("maxEvidenceBodyBytes must not exceed 8192 bytes");
  return normalized;
}

function jsonObject(value: JsonValue | undefined, label: string): { readonly [key: string]: JsonValue } {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedHttpPreflightError("invalid_body", `${label} must be an object`);
  }
  return value as { readonly [key: string]: JsonValue };
}

function assertExactKeys(
  object: { readonly [key: string]: JsonValue },
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ManagedHttpPreflightError("invalid_body", `${label} contains unsupported or missing fields`);
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function cloneJsonValue(value: JsonValue): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function isRedirect(status: number): boolean {
  return status >= 300 && status <= 399;
}

function boundedHeaderValue(value: string | null): string | undefined {
  if (value === null) return undefined;
  return value.replace(/[\0\r\n]/g, "").slice(0, 256);
}

function redactText(input: string, secrets: readonly string[]): string {
  let output = input;
  for (const secret of secrets) {
    if (secret.length > 0) output = output.split(secret).join("[REDACTED]");
  }
  return output
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [REDACTED]")
    .replace(/([\"']?(?:access_token|auth_token|api_key|client_secret|password|credential)[\"']?\s*[:=]\s*[\"']?)[^\s\"'&,}]+/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

function truncateUtf8(input: string, maxBytes: number): string {
  const bytes = Buffer.from(input, "utf8");
  if (bytes.byteLength <= maxBytes) return input;
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function assertNever(value: never): never {
  throw new Error(`unreachable managed HTTP result: ${String(value)}`);
}

function omitBody(
  observation: ManagedHttpResponseObservation,
): Omit<ManagedHttpResponseObservation, "body"> {
  const { body: _body, ...rest } = observation;
  return rest;
}

function dedupeSecrets(secrets: readonly string[]): readonly string[] {
  return [...new Set(secrets)].sort((left, right) => right.length - left.length);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
