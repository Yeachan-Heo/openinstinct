import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CustomTool } from "@gajae-code/coding-agent";

import {
  createManagedHttpTool,
  executeManagedHttpAction,
  isManagedHttpActionRecord,
  managedHttpPlanToJson,
  MANAGED_HTTP_ACTION,
  observeManagedHttp,
  parseManagedHttpPlan,
  preflightManagedHttpAction,
  proposeManagedHttpAction,
  type ManagedHttpEndpointPolicy,
  type ManagedHttpToolOptions,
  type PreflightManagedHttpActionInput,
} from "../../src/assistant-work/http-effects.ts";
import { configuredHttpAccess } from "../../src/assistant-work/http-policy.ts";
import { stableAttemptId, type ActionRecord } from "../../src/assistant-work/model.ts";
import { openStateStore } from "../../src/store/db.ts";
import {
  HttpServiceFixture,
  startHttpServiceFixture,
} from "../fixtures/assistant-work/http-service.ts";

const T0 = "2026-09-05T12:00:00.000Z";
const T1 = "2026-09-05T12:01:00.000Z";
const T2 = "2026-09-05T12:02:00.000Z";
const roots: string[] = [];
const fixtures: HttpServiceFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore() {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-managed-http-"));
  roots.push(root);
  return openStateStore(join(root, "state.db"));
}

async function fixture(): Promise<HttpServiceFixture> {
  const service = await startHttpServiceFixture();
  fixtures.push(service);
  return service;
}

function policyFor(service: HttpServiceFixture): ManagedHttpEndpointPolicy {
  return (endpoint) => ({
    allowed: endpoint.origin === service.origin,
    allowPrivateNetwork: endpoint.origin === service.origin,
  });
}

function messageAccess(
  service: HttpServiceFixture,
  overrides: Record<string, unknown> = {},
) {
  return configuredHttpAccess({
    OI_HTTP_LOCAL_ORIGINS: JSON.stringify([service.origin]),
    OI_HTTP_MESSAGE_BINDINGS: JSON.stringify([{
      id: "fixture-status-message",
      version: 1,
      origin: service.origin,
      method: "POST",
      path: "/messages/status-thread-7",
      action: "send_status_message",
      allowedBodyKeys: ["recipient", "text"],
      recipientPath: ["recipient"],
      fixedTopic: "status-thread-7",
      messagePath: ["text"],
      ...overrides,
    }]),
  });
}

function admitWork(store: ReturnType<typeof openStateStore>, suffix: string) {
  return store.assistantWork.admitObservation({
    source: "test:managed-http",
    occurrenceKey: `observation-${suffix}`,
    workKey: `work-${suffix}`,
    workTitle: `Managed HTTP ${suffix}`,
    provenance: {
      principal: "system",
      channel: "test",
      subject: "managed-http-fixture",
      evidenceId: `fixture-${suffix}`,
    },
    observedAt: T0,
    evidence: { fixture: suffix },
  }, T0).work;
}

function approve(
  store: ReturnType<typeof openStateStore>,
  action: ActionRecord,
  suffix: string,
): void {
  store.assistantWork.grantExplicitApproval({
    actionId: action.id,
    revision: action.revision,
    digest: action.digest,
    provenance: {
      principal: "owner",
      channel: "test-owner",
      subject: "authenticated-owner",
      evidenceId: `approval-${suffix}`,
    },
  }, T1);
}

function mutationInput(
  workId: string,
  service: HttpServiceFixture,
  suffix: string,
  overrides: Partial<PreflightManagedHttpActionInput> = {},
): PreflightManagedHttpActionInput {
  const path = `/services/${suffix}`;
  return {
    workId,
    semanticKey: `http-${suffix}`,
    method: "PATCH",
    url: service.url(path),
    headers: [{ name: "content-type", value: "application/json" }],
    body: JSON.stringify({ status: suffix }),
    verification: {
      url: service.url(path),
      expected: { kind: "json_field", path: ["resource", "value", "status"], value: suffix },
    },
    ...overrides,
  };
}

async function execute(
  store: ReturnType<typeof openStateStore>,
  service: HttpServiceFixture,
  action: ActionRecord,
  dispatchKey: string,
  options: Partial<Pick<ManagedHttpToolOptions, "timeoutMs" | "maxResponseBytes" | "maxEvidenceBodyBytes" | "resolveSecret" | "authorizeMessage">> = {},
) {
  return await executeManagedHttpAction({
    repository: store.assistantWork,
    actionId: action.id,
    revision: action.revision,
    digest: action.digest,
    attemptId: stableAttemptId(action.id, action.revision, dispatchKey),
    workerId: "managed-http-test",
    endpointPolicy: policyFor(service),
    now: () => T2,
    ...options,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for HTTP fixture request");
    await Bun.sleep(5);
  }
}

async function invoke(tool: CustomTool, id: string, params: Record<string, unknown>) {
  return await tool.execute(id, params as never, undefined, {} as never);
}

describe("managed service-neutral HTTP effects", () => {
  test("a secret reference is authorized separately for every header", async () => {
    const service = await fixture();
    const checked: string[] = [];
    const result = await observeManagedHttp({
      url: service.url("/read/echo-auth"), endpointPolicy: policyFor(service),
      headers: [
        { name: "authorization", secretRef: "secret://fixture/credential" },
        { name: "x-api-key", secretRef: "secret://fixture/credential" },
      ],
      resolveSecret: (_reference, context) => {
        checked.push(context.headerName);
        if (context.headerName !== "authorization") throw new Error("header not authorized");
        return "fixture-secret";
      },
    });
    expect(checked).toEqual(["authorization", "x-api-key"]);
    expect(result.kind).not.toBe("response");
    expect(service.requestCount("GET", "/read/echo-auth")).toBe(0);
  });
  test("observes one real GET with a byte bound and requires trusted policy for a loopback origin", async () => {
    const service = await fixture();
    const deniedPolicy: ManagedHttpEndpointPolicy = () => ({ allowed: true });

    await expect(observeManagedHttp({
      url: service.url("/read/plain"),
      endpointPolicy: deniedPolicy,
    })).rejects.toThrow("did not allow the local address");

    const plain = await observeManagedHttp({
      url: service.url("/read/plain"),
      endpointPolicy: policyFor(service),
    });
    expect(plain).toMatchObject({
      kind: "response",
      response: {
        status: 200,
        body: "fixture plain response",
        truncated: false,
      },
    });

    const bounded = await observeManagedHttp({
      url: service.url("/read/large"),
      endpointPolicy: policyFor(service),
      maxResponseBytes: 128,
    });
    expect(bounded).toMatchObject({ kind: "response", response: { bodyBytes: 128, truncated: true } });
    if (bounded.kind !== "response") throw new Error("expected bounded GET response");
    expect(Buffer.byteLength(bounded.response.body, "utf8")).toBeLessThanOrEqual(128);
    expect(service.requestCount("GET", "/read/large")).toBe(1);

    const redirected = await observeManagedHttp({
      url: service.url("/read/redirect"),
      endpointPolicy: policyFor(service),
    });
    expect(redirected).toMatchObject({ kind: "failed", code: "unsafe_redirect", response: { status: 302 } });
    expect(service.requestCount("GET", "/read/redirect")).toBe(1);
    expect(service.requestCount("GET", "/read/plain")).toBe(1);
  });

  test("rejects URL credentials, non-HTTP schemes, credential query parameters, and cloud metadata even under local policy", async () => {
    const allowAllLocal: ManagedHttpEndpointPolicy = () => ({ allowed: true, allowPrivateNetwork: true });
    await expect(observeManagedHttp({
      url: "file:///tmp/fixture",
      endpointPolicy: allowAllLocal,
    })).rejects.toThrow("must use http or https");
    await expect(observeManagedHttp({
      url: "http://owner:secret@127.0.0.1/",
      endpointPolicy: allowAllLocal,
    })).rejects.toThrow("must not contain URL credentials");
    await expect(observeManagedHttp({
      url: "https://example.test/resource?access_token=secret",
      endpointPolicy: allowAllLocal,
    })).rejects.toThrow("secret header reference");
    await expect(observeManagedHttp({
      url: "http://169.254.169.254/latest/meta-data/",
      endpointPolicy: allowAllLocal,
    })).rejects.toThrow("cloud metadata endpoints are not available");
  });

  test("uses the same adapter for known and novel service routes and confirms only after GET verification", async () => {
    const service = await fixture();
    const store = createStore();
    const work = admitWork(store, "arbitrary-routes");
    try {
      const known = await proposeManagedHttpAction(mutationInput(work.id, service, "known/items/42", {
        method: "PUT",
        semanticKey: "known-service-route",
        body: JSON.stringify({ status: "ready", service: "known" }),
        verification: {
          url: service.url("/services/known/items/42"),
          expected: { kind: "json_field", path: ["resource", "value", "service"], value: "known" },
        },
      }), {
        repository: store.assistantWork,
        endpointPolicy: policyFor(service),
        now: () => T0,
      });
      expect(known).toMatchObject({
        effectClass: "external_mutation",
        action: { state: "approval_pending", action: MANAGED_HTTP_ACTION },
        plan: {
          method: "PUT",
          url: service.url("/services/known/items/42"),
          body: JSON.stringify({ status: "ready", service: "known" }),
        },
      });
      expect(isManagedHttpActionRecord(known.action)).toBe(true);
      approve(store, known.action, "known");
      await expect(execute(store, service, known.action, "known-dispatch")).resolves.toMatchObject({
        kind: "confirmed",
        action: { state: "confirmed" },
        attempt: { state: "confirmed", authorizationSource: "owner_explicit", effectStartedAt: T2 },
        evidence: { code: "http_effect_verified", effectInvoked: true },
      });

      const novel = await proposeManagedHttpAction(mutationInput(work.id, service, "odd-protocol/v7/widgets/fuchsia", {
        method: "POST",
        semanticKey: "novel-service-route",
        body: JSON.stringify({ status: "synchronized", dialect: "novel" }),
        verification: {
          url: service.url("/services/odd-protocol/v7/widgets/fuchsia"),
          expected: { kind: "json_field", path: ["resource", "value", "dialect"], value: "novel" },
        },
      }), {
        repository: store.assistantWork,
        endpointPolicy: policyFor(service),
        now: () => T0,
      });
      approve(store, novel.action, "novel");
      await expect(execute(store, service, novel.action, "novel-dispatch")).resolves.toMatchObject({
        kind: "confirmed",
        evidence: { verification: { matched: true } },
      });

      expect(service.requestCount("PUT", "/services/known/items/42")).toBe(1);
      expect(service.requestCount("POST", "/services/odd-protocol/v7/widgets/fuchsia")).toBe(1);
      expect(service.requestCount("GET", "/services/known/items/42")).toBe(1);
      expect(service.requestCount("GET", "/services/odd-protocol/v7/widgets/fuchsia")).toBe(1);
    } finally {
      store.close();
    }
  });

  test("classifies every mutation host-side and binds an explicit message operation to an exact owner rule", async () => {
    const service = await fixture();
    const store = createStore();
    const work = admitWork(store, "message-rule");
    const messageOperation = {
      recipient: "person@example.test",
      topic: "status-thread-7",
      action: "send_status_message",
    } as const;
    try {
      store.assistantWork.setOwnerRule({
        matcher: { effectClass: "external_message", ...messageOperation },
        provenance: {
          principal: "owner",
          channel: "test-owner",
          subject: "authenticated-owner",
          evidenceId: "message-rule-fixture",
        },
      }, T0);

      const path = "/messages/status-thread-7";
      const proposed = await proposeManagedHttpAction(mutationInput(work.id, service, "message", {
        semanticKey: "send-message",
        method: "POST",
        url: service.url(path),
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "x-recipient", value: messageOperation.recipient },
          { name: "x-topic", value: messageOperation.topic },
        ],
        body: JSON.stringify({ recipient: messageOperation.recipient, text: "The build is ready." }),
        verification: {
          url: service.url(path),
          expected: { kind: "json_field", path: ["resource", "value", "text"], value: "The build is ready." },
        },
        messageOperation,
      }), {
        repository: store.assistantWork,
        endpointPolicy: policyFor(service),
        authorizeMessage: messageAccess(service).authorizeMessage,
        now: () => T0,
      });
      expect(proposed).toMatchObject({
        effectClass: "external_message",
        action: {
          state: "approval_pending",
          effectClass: "external_message",
          recipient: messageOperation.recipient,
          topic: messageOperation.topic,
          action: messageOperation.action,
        },
      });
      expect(isManagedHttpActionRecord(proposed.action)).toBe(true);
      await expect(execute(store, service, proposed.action, "owner-rule-message", { authorizeMessage: messageAccess(service).authorizeMessage })).resolves.toMatchObject({
        kind: "confirmed",
        attempt: { authorizationSource: "owner_rule" },
      });
      expect(proposed.plan.messageAuthorization).toEqual({ capabilityId: "fixture-status-message", capabilityVersion: 1 });

      const staleCapability = messageAccess(service).authorizeMessage(proposed.plan);
      expect(staleCapability).toEqual({ capabilityId: "fixture-status-message", capabilityVersion: 1 });
      await expect(execute(store, service, proposed.action, "revoked-message-binding", {
        authorizeMessage: messageAccess(service, { version: 2 }).authorizeMessage,
      })).resolves.toMatchObject({
        kind: "preflight_rejected",
        reason: "material_mismatch",
      });
      expect(store.assistantWork.listAttempts(proposed.action.id)).toHaveLength(1);

      const unmatched = await preflightManagedHttpAction(mutationInput(work.id, service, "message-unmatched", {
        semanticKey: "message-label-without-host-binding",
        method: "POST",
        url: service.url("/unrelated/admin/delete"),
        body: JSON.stringify({ recipient: messageOperation.recipient, text: "The build is ready." }),
        verification: {
          url: service.url("/unrelated/admin/delete"),
          expected: { kind: "text_contains", text: "ready" },
        },
        messageOperation,
      }), {
        endpointPolicy: policyFor(service),
        authorizeMessage: messageAccess(service).authorizeMessage,
      });
      expect(unmatched).toMatchObject({
        effectClass: "external_mutation",
        plan: { messageAuthorization: null },
        proposal: { effectClass: "external_mutation", action: MANAGED_HTTP_ACTION },
      });

      const mismatchedRecipient = await preflightManagedHttpAction(mutationInput(work.id, service, "message-recipient-mismatch", {
        semanticKey: "message-recipient-mismatch",
        method: "POST",
        url: service.url("/messages/status-thread-7"),
        body: JSON.stringify({ recipient: "other@example.test", text: "The build is ready." }),
        verification: {
          url: service.url("/messages/status-thread-7"),
          expected: { kind: "text_contains", text: "ready" },
        },
        messageOperation,
      }), {
        endpointPolicy: policyFor(service),
        authorizeMessage: messageAccess(service).authorizeMessage,
      });
      expect(mismatchedRecipient.effectClass).toBe("external_mutation");

      const callerLabeled = await preflightManagedHttpAction({
        ...mutationInput(work.id, service, "caller-label", { semanticKey: "caller-label" }),
        effectClass: "ordinary_local_edit",
      } as never, { endpointPolicy: policyFor(service) });
      expect(callerLabeled.effectClass).toBe("external_mutation");
      expect(callerLabeled.proposal).toMatchObject({
        effectClass: "external_mutation",
        action: MANAGED_HTTP_ACTION,
      });
    } finally {
      store.close();
    }
  });

  test("rejects a forged persisted effect class before claim or fetch", async () => {
    const service = await fixture();
    const store = createStore();
    const work = admitWork(store, "forged-class");
    const path = "/services/forged-class";
    try {
      const preflight = await preflightManagedHttpAction(mutationInput(work.id, service, "forged-class"), {
        endpointPolicy: policyFor(service),
      });
      const forged = store.assistantWork.proposeAction({
        ...preflight.proposal,
        effectClass: "ordinary_local_edit",
      }, T0);
      expect(isManagedHttpActionRecord(forged)).toBe(false);
      const result = await execute(store, service, forged, "forged-class-dispatch");
      expect(result).toMatchObject({
        kind: "preflight_rejected",
        reason: "effect_class_mismatch",
        requiredEffectClass: "external_mutation",
      });
      expect(store.assistantWork.listAttempts(forged.id)).toHaveLength(0);
      expect(service.requestCount("PATCH", path)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("persists the durable claim and effect_started transition before invoking fetch", async () => {
    const service = await fixture();
    const store = createStore();
    const work = admitWork(store, "durable-start");
    const path = "/gated/durable-start";
    service.hold(path);
    try {
      const proposed = await proposeManagedHttpAction(mutationInput(work.id, service, "gated/durable-start", {
        semanticKey: "durable-start",
        url: service.url(path),
        verification: {
          url: service.url(path),
          expected: { kind: "json_field", path: ["resource", "value", "status"], value: "gated/durable-start" },
        },
      }), {
        repository: store.assistantWork,
        endpointPolicy: policyFor(service),
        now: () => T0,
      });
      approve(store, proposed.action, "durable-start");
      const attemptId = stableAttemptId(proposed.action.id, proposed.action.revision, "durable-start-dispatch");
      const pending = executeManagedHttpAction({
        repository: store.assistantWork,
        actionId: proposed.action.id,
        revision: proposed.action.revision,
        digest: proposed.action.digest,
        attemptId,
        workerId: "managed-http-test",
        endpointPolicy: policyFor(service),
        now: () => T2,
      });
      await waitFor(() => service.requestCount("PATCH", path) === 1);
      expect(store.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "effect_started",
        effectStartedAt: T2,
      });
      service.release(path);
      await expect(pending).resolves.toMatchObject({ kind: "confirmed", attempt: { state: "confirmed" } });
      expect(service.requestCount("PATCH", path)).toBe(1);
    } finally {
      store.close();
    }
  });

  test("marks a timed-out mutation ambiguous, never retries it, and leaves later remote effects for reconciliation", async () => {
    const service = await fixture();
    const store = createStore();
    const work = admitWork(store, "timeout");
    const path = "/slow/timeout";
    try {
      const proposed = await proposeManagedHttpAction(mutationInput(work.id, service, "slow/timeout", {
        semanticKey: "slow-timeout",
        url: service.url(path),
        body: JSON.stringify({ status: "eventually-applied" }),
        verification: {
          url: service.url(path),
          expected: { kind: "json_field", path: ["resource", "value", "status"], value: "eventually-applied" },
        },
      }), {
        repository: store.assistantWork,
        endpointPolicy: policyFor(service),
        now: () => T0,
      });
      approve(store, proposed.action, "timeout");
      const attemptId = stableAttemptId(proposed.action.id, proposed.action.revision, "timeout-dispatch");
      const result = await executeManagedHttpAction({
        repository: store.assistantWork,
        actionId: proposed.action.id,
        revision: proposed.action.revision,
        digest: proposed.action.digest,
        attemptId,
        workerId: "managed-http-test",
        endpointPolicy: policyFor(service),
        timeoutMs: 20,
        now: () => T2,
      });
      expect(result).toMatchObject({
        kind: "ambiguous",
        action: { state: "ambiguous" },
        attempt: { state: "ambiguous" },
        evidence: {
          code: "http_effect_unconfirmed",
          request: { outcome: "timeout" },
          verification: { matched: false },
        },
      });
      expect(service.requestCount("PATCH", path)).toBe(1);
      await Bun.sleep(120);
      expect(service.resource(path)).toMatchObject({ value: { status: "eventually-applied" } });

      const replay = await executeManagedHttpAction({
        repository: store.assistantWork,
        actionId: proposed.action.id,
        revision: proposed.action.revision,
        digest: proposed.action.digest,
        attemptId,
        workerId: "managed-http-test",
        endpointPolicy: policyFor(service),
        timeoutMs: 20,
        now: () => T2,
      });
      expect(replay).toMatchObject({ kind: "rejected", reason: "ambiguous" });
      expect(service.requestCount("PATCH", path)).toBe(1);
    } finally {
      store.close();
    }
  });

  test("does not turn a successful HTTP response into confirmation when verification is wrong", async () => {
    const service = await fixture();
    const store = createStore();
    const work = admitWork(store, "wrong-verification");
    const path = "/services/wrong-verification";
    try {
      const proposed = await proposeManagedHttpAction(mutationInput(work.id, service, "wrong-verification", {
        verification: {
          url: service.url(path),
          expected: { kind: "json_field", path: ["resource", "value", "status"], value: "not-the-written-value" },
        },
      }), {
        repository: store.assistantWork,
        endpointPolicy: policyFor(service),
        now: () => T0,
      });
      approve(store, proposed.action, "wrong-verification");
      const result = await execute(store, service, proposed.action, "wrong-verification-dispatch");
      expect(result).toMatchObject({
        kind: "ambiguous",
        evidence: {
          request: { status: 200, outcome: "response" },
          verification: { status: 200, matched: false },
        },
      });
      expect(store.assistantWork.getAction(proposed.action.id)).toMatchObject({ state: "ambiguous" });
      expect(service.requestCount("PATCH", path)).toBe(1);
    } finally {
      store.close();
    }
  });

  test("invalidates stale digest approval material before dispatch", async () => {
    const service = await fixture();
    const store = createStore();
    const work = admitWork(store, "stale-digest");
    const path = "/services/stale-digest";
    try {
      const first = await proposeManagedHttpAction(mutationInput(work.id, service, "stale-digest", {
        body: JSON.stringify({ status: "first" }),
        verification: {
          url: service.url(path),
          expected: { kind: "json_field", path: ["resource", "value", "status"], value: "first" },
        },
      }), {
        repository: store.assistantWork,
        endpointPolicy: policyFor(service),
        now: () => T0,
      });
      approve(store, first.action, "stale-first");
      const revised = await proposeManagedHttpAction(mutationInput(work.id, service, "stale-digest", {
        body: JSON.stringify({ status: "revised" }),
        verification: {
          url: service.url(path),
          expected: { kind: "json_field", path: ["resource", "value", "status"], value: "revised" },
        },
      }), {
        repository: store.assistantWork,
        endpointPolicy: policyFor(service),
        now: () => T1,
      });
      expect(revised.action).toMatchObject({
        id: first.action.id,
        revision: first.action.revision + 1,
        state: "approval_pending",
      });
      expect(store.assistantWork.listExplicitApprovals(first.action.id)).toMatchObject([{ state: "invalidated" }]);

      const staleRevision = await executeManagedHttpAction({
        repository: store.assistantWork,
        actionId: first.action.id,
        revision: first.action.revision,
        digest: first.action.digest,
        attemptId: stableAttemptId(first.action.id, first.action.revision, "stale-revision"),
        workerId: "managed-http-test",
        endpointPolicy: policyFor(service),
        now: () => T2,
      });
      expect(staleRevision).toMatchObject({ kind: "rejected", reason: "stale_revision" });

      const staleDigest = await executeManagedHttpAction({
        repository: store.assistantWork,
        actionId: revised.action.id,
        revision: revised.action.revision,
        digest: first.action.digest,
        attemptId: stableAttemptId(revised.action.id, revised.action.revision, "stale-digest"),
        workerId: "managed-http-test",
        endpointPolicy: policyFor(service),
        now: () => T2,
      });
      expect(staleDigest).toMatchObject({ kind: "rejected", reason: "stale_digest" });
      await expect(execute(store, service, revised.action, "revised-without-approval")).resolves.toMatchObject({
        kind: "rejected",
        reason: "approval_required",
      });
      expect(service.requestCount("PATCH", path)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("never follows a mutation redirect to an unintended destination", async () => {
    const service = await fixture();
    const store = createStore();
    const work = admitWork(store, "redirect");
    const source = "/redirect/no-replay";
    const target = "/redirect-target/no-replay";
    try {
      const proposed = await proposeManagedHttpAction(mutationInput(work.id, service, "redirect/no-replay", {
        semanticKey: "redirect-no-replay",
        method: "POST",
        url: service.url(source),
        verification: {
          url: service.url(target),
          expected: { kind: "json_field", path: ["resource", "value", "status"], value: "redirect/no-replay" },
        },
      }), {
        repository: store.assistantWork,
        endpointPolicy: policyFor(service),
        now: () => T0,
      });
      approve(store, proposed.action, "redirect");
      const result = await execute(store, service, proposed.action, "redirect-dispatch");
      expect(result).toMatchObject({
        kind: "ambiguous",
        evidence: {
          request: { status: 307, outcome: "redirect_rejected" },
          verification: { matched: false },
        },
      });
      expect(service.requestCount("POST", source)).toBe(1);
      expect(service.requestCount("POST", target)).toBe(0);
      expect(service.requestCount("GET", target)).toBe(1);
      expect(service.resource(target)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("resolves credential headers at runtime and never persists or returns the token", async () => {
    const service = await fixture();
    const store = createStore();
    const work = admitWork(store, "secret-header");
    const path = "/secret-echo/credential";
    const token = "Bearer fixture-super-secret-token";
    try {
      const proposed = await proposeManagedHttpAction(mutationInput(work.id, service, "secret-echo/credential", {
        semanticKey: "secret-header",
        url: service.url(path),
        headers: [
          { name: "authorization", secretRef: "secret://fixture/service-token" },
          { name: "content-type", value: "application/json" },
        ],
        verification: {
          url: service.url(path),
          headers: [{ name: "authorization", secretRef: "secret://fixture/service-token" }],
          expected: { kind: "json_field", path: ["resource", "value", "status"], value: "secret-echo/credential" },
        },
      }), {
        repository: store.assistantWork,
        endpointPolicy: policyFor(service),
        now: () => T0,
      });
      expect(JSON.stringify(proposed.action)).not.toContain(token);
      expect(JSON.stringify(proposed.plan)).toContain("secret://fixture/service-token");
      expect(JSON.stringify(proposed.plan)).not.toContain(token);
      approve(store, proposed.action, "secret-header");
      const result = await execute(store, service, proposed.action, "secret-header-dispatch", {
        resolveSecret: async (reference) => {
          expect(reference).toBe("secret://fixture/service-token");
          return token;
        },
      });
      expect(result).toMatchObject({ kind: "confirmed" });
      expect(JSON.stringify(result)).not.toContain("fixture-super-secret-token");
      expect(JSON.stringify(store.assistantWork.getAttempt(
        stableAttemptId(proposed.action.id, proposed.action.revision, "secret-header-dispatch"),
      ))).not.toContain("fixture-super-secret-token");
      const request = service.requests().find((entry) => entry.method === "PATCH" && entry.path === path);
      expect(request?.headers.authorization).toBe(token);
      const observed = await observeManagedHttp({
        url: service.url("/read/echo-auth"),
        headers: [{ name: "authorization", secretRef: "secret://fixture/service-token" }],
        endpointPolicy: policyFor(service),
        resolveSecret: () => token,
      });
      expect(observed).toMatchObject({ kind: "response", response: { body: expect.stringContaining("[REDACTED]") } });
      expect(JSON.stringify(observed)).not.toContain("fixture-super-secret-token");

      await expect(preflightManagedHttpAction(mutationInput(work.id, service, "plaintext-secret", {
        semanticKey: "plaintext-secret",
        headers: [{ name: "authorization", value: token }],
      }), { endpointPolicy: policyFor(service) })).rejects.toThrow("must use a host-resolved secretRef");
      await expect(preflightManagedHttpAction(mutationInput(work.id, service, "plaintext-body-secret", {
        semanticKey: "plaintext-body-secret",
        body: JSON.stringify({ api_key: "fixture-super-secret-token" }),
      }), { endpointPolicy: policyFor(service) })).rejects.toThrow("plaintext credential material");
    } finally {
      store.close();
    }
  });

  test("round-trips only canonical exact method, URL, body, header references, and verification material", async () => {
    const service = await fixture();
    const store = createStore();
    const work = admitWork(store, "canonical-plan");
    try {
      const preflight = await preflightManagedHttpAction(mutationInput(work.id, service, "canonical-plan", {
        headers: [
          { name: "X-Zeta", value: "z" },
          { name: "authorization", secretRef: "secret://canonical/token" },
          { name: "Content-Type", value: "application/json" },
        ],
        verification: {
          url: service.url("/services/canonical-plan"),
          headers: [{ name: "X-Verify", value: "one" }],
          expected: { kind: "text_contains", text: "canonical-plan" },
        },
      }), { endpointPolicy: policyFor(service) });
      expect(preflight.plan.headers.map((header) => header.name)).toEqual([
        "authorization",
        "content-type",
        "x-zeta",
      ]);
      const json = managedHttpPlanToJson(preflight.plan);
      expect(parseManagedHttpPlan(json)).toEqual(preflight.plan);
      expect(() => parseManagedHttpPlan({
        ...(json as unknown as Record<string, unknown>),
        retries: 3,
      } as never)).toThrow("unsupported or missing fields");
    } finally {
      store.close();
    }
  });

  test("exposes one registration API for GET, proposal, and exact approved execution", async () => {
    const service = await fixture();
    const store = createStore();
    const work = admitWork(store, "tool-api");
    let currentTime = T0;
    try {
      const tool = createManagedHttpTool({
        repository: store.assistantWork,
        endpointPolicy: policyFor(service),
        workerId: "managed-http-tool-test",
        now: () => new Date(currentTime),
      });
      expect(tool.name).toBe("assistant_managed_http");
      const read = await invoke(tool, "tool-read", {
        operation: "get",
        url: service.url("/read/plain"),
      });
      expect(read).toMatchObject({ details: { operation: "get", kind: "response" } });

      const proposal = await invoke(tool, "tool-propose", {
        operation: "propose",
        workId: work.id,
        semanticKey: "tool-mutation",
        method: "DELETE",
        url: service.url("/services/tool-mutation"),
        verification: {
          url: service.url("/services/tool-mutation"),
          expected: { kind: "json_field", path: ["resource", "method"], value: "DELETE" },
        },
      });
      const action = proposal.details.action as ActionRecord;
      expect(action).toMatchObject({ state: "approval_pending", effectClass: "external_mutation" });
      approve(store, store.assistantWork.getAction(action.id)!, "tool-api");
      currentTime = T2;
      const executed = await invoke(tool, "tool-execute", {
        operation: "execute",
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
      });
      expect(executed).toMatchObject({
        details: { operation: "execute", kind: "confirmed", attempt: { authorizationSource: "owner_explicit" } },
      });
      expect(service.requestCount("DELETE", "/services/tool-mutation")).toBe(1);
    } finally {
      store.close();
    }
  });
});
