import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CustomTool } from "@gajae-code/coding-agent";

import { createManagedHttpTool } from "../../src/assistant-work/http-effects.ts";
import { configuredHttpAccess } from "../../src/assistant-work/http-policy.ts";
import { createAssistantWorkTools } from "../../src/assistant-work/tools.ts";
import { ChatHub, PANEL_SOURCE_MARKER } from "../../src/chat/hub.ts";
import { OwnerOutbox } from "../../src/delivery/outbox.ts";
import { NdjsonLogger } from "../../src/log.ts";
import { OwnerTurnIngress, type OwnerTurnRequest } from "../../src/owner-turn.ts";
import type { ActionRecord, JsonValue } from "../../src/assistant-work/model.ts";
import type { MainSession, MainTurnInput } from "../../src/sdk-session/main-session.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";
import {
  HttpServiceFixture,
  startHttpServiceFixture,
} from "../fixtures/assistant-work/http-service.ts";

const roots: string[] = [];
const fixtures: HttpServiceFixture[] = [];
interface OwnerHttpHarness {
  readonly store: StateStore;
  readonly http: CustomTool;
  readonly observe: CustomTool;
  readonly ingress: OwnerTurnIngress;
  readonly laneTurns: readonly MainTurnInput[];
  readonly hubEvents: readonly { readonly topic: string; readonly payload: Record<string, unknown> }[];
}

interface ToolResult {
  readonly details?: Record<string, unknown>;
}

afterEach(async () => {
  for (const service of fixtures.splice(0)) await service.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serviceFixture(): Promise<HttpServiceFixture> {
  const service = await startHttpServiceFixture();
  fixtures.push(service);
  return service;
}

function createHarness(service: HttpServiceFixture, options: { readonly timeoutMs?: number } = {}): OwnerHttpHarness {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-owner-http-integration-"));
  roots.push(root);
  const store = openStateStore(join(root, "state.db"));
  const access = configuredHttpAccess({
    OI_HTTP_LOCAL_ORIGINS: JSON.stringify([service.origin]),
    OI_HTTP_MESSAGE_BINDINGS: JSON.stringify([{
      id: "fixture-release-message", version: 1, origin: service.origin,
      method: "POST", path: "/messaging/threads/release-42/entries", action: "send_release_status_note",
      allowedBodyKeys: ["payload", "recipient", "topic"], recipientPath: ["recipient"], topicPath: ["topic"],
      messagePath: ["payload", "blocks", 0, "text"],
    }]),
  });
  const http = createManagedHttpTool({
    repository: store.assistantWork,
    ...access,
    workerId: "owner-http-integration",
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const observe = requiredTool(createAssistantWorkTools({ repository: store.assistantWork }), "assistant_work_observe");
  const logger = new NdjsonLogger(join(root, "owner-http.ndjson"));
  const hub = new ChatHub(logger);
  const hubEvents: Array<{ readonly topic: string; readonly payload: Record<string, unknown> }> = [];
  hub.subscribe((topic, payload) => hubEvents.push({ topic, payload }));
  const outbox = new OwnerOutbox({ logger });
  const laneTurns: MainTurnInput[] = [];
  const lane = {
    session: {
      running: false,
      turn: (input: MainTurnInput) => {
        laneTurns.push(input);
        return Promise.resolve({ kind: "reply", text: "owner command admitted" } as const);
      },
      steer: () => Promise.resolve({ kind: "not_admitted", reason: "idle" } as const),
    } as unknown as MainSession,
  };
  const ingress = new OwnerTurnIngress({
    store,
    logger,
    hub,
    outbox,
    lanes: () => lane,
    transcript: () => [],
  });
  return { store, http, observe, ingress, laneTurns, hubEvents };
}

function requiredTool(tools: readonly CustomTool[], name: string): CustomTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

async function invoke(tool: CustomTool, callId: string, params: Record<string, unknown>) {
  return await tool.execute(callId, params as never, undefined, {} as never);
}

async function admitWork(harness: OwnerHttpHarness, suffix: string): Promise<string> {
  const result = await invoke(harness.observe, `observe-${suffix}`, {
    source: "fixture:owner-http",
    occurrenceKey: `occurrence-${suffix}`,
    workKey: `work-${suffix}`,
    workTitle: `Owner HTTP integration ${suffix}`,
    evidencePrincipal: "third_party",
    evidenceSubject: "fixture@example.test",
    evidenceSummary: "A fixture service operation remains unfinished.",
    involved: true, important: false, ongoing: true, confidence: "clear",
    unfinishedEvidence: ["The fixture request awaits a reply."],
    observedAt: "2026-09-05T11:59:00.000Z",
  });
  const id = (result.details?.work as { readonly id?: unknown } | undefined)?.id;
  if (typeof id !== "string") throw new Error("assistant observation did not return a work ID");
  return id;
}

function actionFrom(result: ToolResult, store: StateStore): ActionRecord {
  const summary = result.details?.action as { readonly id?: unknown } | undefined;
  if (typeof summary?.id !== "string") throw new Error("managed HTTP proposal did not return an action ID");
  const action = store.assistantWork.getAction(summary.id);
  if (!action) throw new Error(`managed HTTP action was not persisted: ${summary.id}`);
  return action;
}

function ownerRequest(turnId: string, text: string): OwnerTurnRequest {
  return {
    source: "panel",
    turnId,
    text,
    promptText: `${text}\n\n${PANEL_SOURCE_MARKER}`,
  };
}

function outcomeObject(value: JsonValue | undefined): Record<string, unknown> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attempt outcome was not an object");
  }
  return value as Record<string, unknown>;
}

describe("automatic managed HTTP execution with owner ingress", () => {
  test("executes planned mutations directly while obsolete approval text cannot bypass stale material checks", async () => {
    const service = await serviceFixture();
    const harness = createHarness(service);
    const path = "/account/preferences/feature-flags/quiet-mode";
    try {
      const workId = await admitWork(harness, "mutation");
      const proposed = await invoke(harness.http, "propose-owner-mutation", {
        operation: "propose",
        workId,
        semanticKey: "set-quiet-mode",
        method: "PATCH",
        url: service.url(path),
        headers: [{ name: "content-type", value: "application/json" }],
        body: JSON.stringify({ feature: { name: "quiet-mode", enabled: true } }),
        verification: {
          url: service.url(path),
          expected: {
            kind: "json_field",
            path: ["resource", "value", "feature", "enabled"],
            value: true,
          },
        },
      });
      const action = actionFrom(proposed, harness.store);
      expect(action).toMatchObject({ state: "planned", effectClass: "external_mutation" });
      expect(service.requestCount("PATCH", path)).toBe(0);

      const text = `/approve ${action.id} ${action.revision + 1} ${action.digest}`;
      expect(await harness.ingress.admit(ownerRequest("obsolete-http-approval", text))).toBe("started");
      expect(harness.laneTurns).toMatchObject([{
        owner: true,
        turnId: "obsolete-http-approval",
        text: `${text}\n\n${PANEL_SOURCE_MARKER}`,
      }]);
      expect(harness.store.assistantWork.getAction(action.id)).toEqual(action);
      for (const material of [
        { revision: action.revision + 1, digest: action.digest, reason: "stale_revision" },
        { revision: action.revision, digest: action.digest === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64), reason: "stale_digest" },
      ]) {
        const stale = await invoke(harness.http, `stale-${material.digest}-${material.revision}`, {
          operation: "execute",
          actionId: action.id,
          revision: material.revision,
          digest: material.digest,
        });
        expect(stale).toMatchObject({ details: { kind: "rejected", reason: material.reason } });
      }
      expect(harness.store.assistantWork.listAttempts(action.id)).toHaveLength(0);
      expect(service.requestCount("PATCH", path)).toBe(0);

      const executed = await invoke(harness.http, "execute-owner-mutation", {
        operation: "execute",
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
      });
      expect(executed).toMatchObject({
        details: {
          kind: "confirmed",
          action: { id: action.id, state: "confirmed" },
          attempt: { state: "confirmed" },
          evidence: {
            kind: "managed_http_verification",
            code: "http_effect_verified",
            request: { method: "PATCH", url: service.url(path), status: 200 },
            verification: { method: "GET", url: service.url(path), status: 200, matched: true },
          },
        },
      });
      expect(service.requestCount("PATCH", path)).toBe(1);
      expect(service.requestCount("GET", path)).toBe(1);
      expect(service.resource(path)).toMatchObject({
        method: "PATCH",
        value: { feature: { name: "quiet-mode", enabled: true } },
      });

      const attempt = harness.store.assistantWork.listAttempts(action.id)[0];
      expect(attempt).toMatchObject({ state: "confirmed" });
      expect(outcomeObject(attempt?.outcome)).toMatchObject({
        kind: "managed_http_verification",
        code: "http_effect_verified",
        verification: { matched: true },
      });
      const replay = await invoke(harness.http, "execute-owner-mutation-again", {
        operation: "execute", actionId: action.id, revision: action.revision, digest: action.digest,
      });
      expect(replay).toMatchObject({ details: { kind: "rejected", reason: "confirmed" } });
      expect(service.requestCount("PATCH", path)).toBe(1);
      expect(harness.store.assistantWork.listAttempts(action.id)).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  test("executes a semantic external message directly without changing its recipient and topic", async () => {
    const service = await serviceFixture();
    const harness = createHarness(service);
    const path = "/messaging/threads/release-42/entries";
    const messageOperation = {
      recipient: "release-team@example.test",
      topic: "release-42",
      action: "send_release_status_note",
    } as const;
    try {
      const workId = await admitWork(harness, "semantic-message");
      const proposed = await invoke(harness.http, "propose-semantic-message", {
        operation: "propose",
        workId,
        semanticKey: "release-status-note",
        method: "POST",
        url: service.url(path),
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "x-recipient", value: messageOperation.recipient },
          { name: "x-topic", value: messageOperation.topic },
        ],
        body: JSON.stringify({ recipient: messageOperation.recipient, topic: messageOperation.topic, payload: { format: "note", blocks: [{ text: "Release 42 is ready." }] } }),
        verification: {
          url: service.url(path),
          expected: {
            kind: "json_field",
            path: ["resource", "value", "payload", "blocks", 0, "text"],
            value: "Release 42 is ready.",
          },
        },
        messageOperation,
      });
      const action = actionFrom(proposed, harness.store);
      expect(action).toMatchObject({
        state: "planned",
        effectClass: "external_message",
        recipient: messageOperation.recipient,
        topic: messageOperation.topic,
        action: messageOperation.action,
      });

      const executed = await invoke(harness.http, "execute-semantic-message", {
        operation: "execute",
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
      });
      expect(executed).toMatchObject({
        details: {
          kind: "confirmed",
          action: {
            state: "confirmed",
            effectClass: "external_message",
            recipient: messageOperation.recipient,
            topic: messageOperation.topic,
            action: messageOperation.action,
          },
          attempt: { state: "confirmed" },
          evidence: { code: "http_effect_verified", verification: { matched: true } },
        },
      });
      expect(service.requestCount("POST", path)).toBe(1);
      expect(service.requestCount("GET", path)).toBe(1);
      expect(service.resource(path)).toMatchObject({
        method: "POST",
        recipient: messageOperation.recipient,
        topic: messageOperation.topic,
        value: { payload: { blocks: [{ text: "Release 42 is ready." }] } },
      });
      expect(outcomeObject(harness.store.assistantWork.listAttempts(action.id)[0]?.outcome)).toMatchObject({
        kind: "managed_http_verification",
        code: "http_effect_verified",
        request: { method: "POST", url: service.url(path) },
        verification: { method: "GET", url: service.url(path), matched: true },
      });
    } finally {
      harness.store.close();
    }
  });

  test("exact owner rejection cancels a planned mutation without making a request", async () => {
    const service = await serviceFixture();
    const harness = createHarness(service);
    const path = "/cancelled/mutation";
    try {
      const workId = await admitWork(harness, "cancelled");
      const proposed = await invoke(harness.http, "propose-cancelled", {
        operation: "propose", workId, semanticKey: "cancelled-mutation",
        method: "PATCH", url: service.url(path),
        headers: [{ name: "content-type", value: "application/json" }],
        body: JSON.stringify({ changed: true }),
        verification: {
          url: service.url(path),
          expected: { kind: "json_field", path: ["resource", "value", "changed"], value: true },
        },
      });
      const action = actionFrom(proposed, harness.store);
      const command = `/reject ${action.id} ${action.revision} ${action.digest}`;
      expect(await harness.ingress.admit(ownerRequest("cancel-http", command))).toBe("command");
      expect(harness.store.assistantWork.getAction(action.id)?.state).toBe("cancelled");
      expect(harness.laneTurns).toHaveLength(0);
      const result = await invoke(harness.http, "execute-cancelled", {
        operation: "execute", actionId: action.id, revision: action.revision, digest: action.digest,
      });
      expect(result).toMatchObject({ details: { kind: "rejected", reason: "cancelled" } });
      expect(service.requestCount("PATCH", path)).toBe(0);
      expect(service.requestCount("GET", path)).toBe(0);
      expect(harness.store.assistantWork.listAttempts(action.id)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  test("an automatically executed timed-out mutation remains ambiguous and cannot be replayed into a duplicate request", async () => {
    const service = await serviceFixture();
    const harness = createHarness(service, { timeoutMs: 20 });
    const path = "/slow/automatic-timeout";
    try {
      const workId = await admitWork(harness, "timeout");
      const proposed = await invoke(harness.http, "propose-owner-timeout", {
        operation: "propose",
        workId,
        semanticKey: "automatic-timeout",
        method: "PATCH",
        url: service.url(path),
        headers: [{ name: "content-type", value: "application/json" }],
        body: JSON.stringify({ transition: { phase: "applied-after-timeout" } }),
        verification: {
          url: service.url(path),
          expected: {
            kind: "json_field",
            path: ["resource", "value", "transition", "phase"],
            value: "applied-after-timeout",
          },
        },
      });
      const action = actionFrom(proposed, harness.store);
      expect(action.state).toBe("planned");

      const first = await invoke(harness.http, "execute-owner-timeout", {
        operation: "execute",
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
      });
      expect(first).toMatchObject({
        details: {
          kind: "ambiguous",
          action: { state: "ambiguous" },
          attempt: { state: "ambiguous" },
          evidence: {
            code: "http_effect_unconfirmed",
            request: { method: "PATCH", outcome: "timeout" },
            verification: { method: "GET", matched: false },
          },
        },
      });
      expect(service.requestCount("PATCH", path)).toBe(1);

      await Bun.sleep(130);
      expect(service.resource(path)).toMatchObject({
        value: { transition: { phase: "applied-after-timeout" } },
      });

      const replay = await invoke(harness.http, "execute-owner-timeout", {
        operation: "execute",
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
      });
      expect(replay).toMatchObject({ details: { kind: "rejected", reason: "ambiguous" } });
      expect(service.requestCount("PATCH", path)).toBe(1);
      expect(harness.store.assistantWork.listAttempts(action.id)).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });
});
