import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CustomTool } from "@gajae-code/coding-agent";

import { createManagedHttpTool } from "../../src/assistant-work/http-effects.ts";
import { configuredHttpAccess } from "../../src/assistant-work/http-policy.ts";
import type { ActionRecord, JsonValue } from "../../src/assistant-work/model.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";
import {
  HttpServiceFixture,
  startHttpServiceFixture,
} from "../fixtures/assistant-work/http-service.ts";

const roots: string[] = [];
const fixtures: HttpServiceFixture[] = [];
interface NovelHarness {
  readonly store: StateStore;
  readonly tool: CustomTool;
}

interface DiscoveredContract {
  readonly mutation: {
    readonly href: string;
    readonly method: "PATCH";
    readonly contentType: string;
  };
  readonly verification: {
    readonly href: string;
    readonly fieldPath: readonly (string | number)[];
    readonly equals: JsonValue;
  };
  readonly decoy: {
    readonly href: string;
    readonly method: "PATCH";
  };
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

function createHarness(service: HttpServiceFixture): NovelHarness {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-novel-service-integration-"));
  roots.push(root);
  const store = openStateStore(join(root, "state.db"));
  const access = configuredHttpAccess({
    OI_HTTP_LOCAL_ORIGINS: JSON.stringify([service.origin]),
  });
  const tool = createManagedHttpTool({
    repository: store.assistantWork,
    ...access,
    workerId: "novel-service-integration",
  });
  return { store, tool };
}

async function invoke(tool: CustomTool, callId: string, params: Record<string, unknown>) {
  return await tool.execute(callId, params as never, undefined, {} as never);
}


function actionFrom(result: ToolResult, store: StateStore): ActionRecord {
  const id = (result.details?.action as { readonly id?: unknown } | undefined)?.id;
  if (typeof id !== "string") throw new Error("managed HTTP proposal omitted its action ID");
  const action = store.assistantWork.getAction(id);
  if (!action) throw new Error(`managed HTTP action was not persisted: ${id}`);
  return action;
}

function responseBody(result: ToolResult): string {
  const details = result.details as {
    readonly kind?: unknown;
    readonly response?: { readonly body?: unknown };
  } | undefined;
  if (details?.kind !== "response" || typeof details.response?.body !== "string") {
    throw new Error("managed HTTP discovery did not return a readable response body");
  }
  return details.response.body;
}

function parseDiscoveredContract(body: string): DiscoveredContract {
  const document: unknown = JSON.parse(body);
  if (!isRecord(document) || !isRecord(document.resource) || !isRecord(document.resource.value)) {
    throw new Error("novel discovery document was not wrapped by the fixture resource response");
  }
  const value = document.resource.value;
  if (!isRecord(value.protocol) || !Array.isArray(value.protocol.transitions)) {
    throw new Error("novel discovery document omitted protocol transitions");
  }
  const transitions = value.protocol.transitions;
  const apply = transitions.find((candidate) => isRecord(candidate) && candidate.rel === "urn:example:apply-phase");
  const decoy = transitions.find((candidate) => isRecord(candidate) && candidate.rel === "urn:example:decoy-origin");
  if (!isRecord(apply) || !isRecord(apply.request) || !isRecord(apply.confirmation)) {
    throw new Error("novel discovery document omitted the apply transition contract");
  }
  if (!isRecord(decoy) || !isRecord(decoy.request)) {
    throw new Error("novel discovery document omitted the decoy transition contract");
  }
  const request = apply.request;
  const confirmation = apply.confirmation;
  const decoyRequest = decoy.request;
  if (
    typeof request.href !== "string"
    || request.verb !== "PATCH"
    || typeof request.mediaType !== "string"
    || typeof confirmation.href !== "string"
    || !Array.isArray(confirmation.fieldPath)
    || !isJsonValue(confirmation.equals)
    || typeof decoyRequest.href !== "string"
    || decoyRequest.verb !== "PATCH"
  ) {
    throw new Error("novel discovery transition fields were invalid");
  }
  const fieldPath = confirmation.fieldPath.map((segment) => {
    if (typeof segment !== "string" && typeof segment !== "number") {
      throw new Error("novel verification path contained a non-string/non-number segment");
    }
    return segment;
  });
  return {
    mutation: {
      href: request.href,
      method: "PATCH",
      contentType: request.mediaType,
    },
    verification: {
      href: confirmation.href,
      fieldPath,
      equals: confirmation.equals,
    },
    decoy: {
      href: decoyRequest.href,
      method: "PATCH",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

describe("novel service discovery through the generic managed HTTP tool", () => {
  test("discovers an unfamiliar hypermedia contract, preserves the host origin boundary, then executes and verifies it", async () => {
    const service = await serviceFixture();
    const untrustedOrigin = await serviceFixture();
    const harness = createHarness(service);
    const discoveryPath = "/.well-known/strange-protocol/v17/workspaces/amber-9";
    const mutationPath = "/rpc/v17/workspaces/amber-9/transitions/apply-phase";
    const discoveryDocument = {
      protocol: {
        name: "vendor-independent-fixture-v17",
        transitions: [
          {
            rel: "urn:example:apply-phase",
            request: {
              href: service.url(mutationPath),
              verb: "PATCH",
              mediaType: "application/vnd.fixture.transition+json",
            },
            confirmation: {
              href: service.url(mutationPath),
              fieldPath: ["resource", "value", "envelope", "state", "phase"],
              equals: "settled-from-discovery",
            },
          },
          {
            rel: "urn:example:decoy-origin",
            request: {
              href: untrustedOrigin.url("/rpc/v17/workspaces/amber-9/transitions/decoy"),
              verb: "PATCH",
            },
          },
        ],
      },
    };

    try {
      const seeded = await fetch(service.url(discoveryPath), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(discoveryDocument),
        redirect: "manual",
      });
      expect(seeded.status).toBe(200);
      await seeded.text();
      expect(service.requestCount("PUT", discoveryPath)).toBe(1);

      const discovered = await invoke(harness.tool, "discover-novel-service", {
        operation: "get",
        url: service.url(discoveryPath),
      });
      expect(discovered).toMatchObject({
        details: {
          operation: "get",
          kind: "response",
          response: { status: 200, truncated: false },
        },
      });
      expect(service.requestCount("GET", discoveryPath)).toBe(1);
      const contract = parseDiscoveredContract(responseBody(discovered));
      expect(contract).toEqual({
        mutation: {
          href: service.url(mutationPath),
          method: "PATCH",
          contentType: "application/vnd.fixture.transition+json",
        },
        verification: {
          href: service.url(mutationPath),
          fieldPath: ["resource", "value", "envelope", "state", "phase"],
          equals: "settled-from-discovery",
        },
        decoy: {
          href: untrustedOrigin.url("/rpc/v17/workspaces/amber-9/transitions/decoy"),
          method: "PATCH",
        },
      });

      const work = harness.store.assistantWork.admitObservation({
        source: "test:novel-service-discovery",
        occurrenceKey: "amber-9-transition",
        workKey: "novel-service:amber-9",
        workTitle: "Apply the discovered amber-9 transition",
        provenance: {
          principal: "system",
          channel: "test",
          subject: "novel-service-fixture",
          evidenceId: "novel-service-discovery-document",
        },
        observedAt: "2026-09-05T12:00:00.000Z",
        evidence: {
          discoveryUrl: service.url(discoveryPath),
          relation: "urn:example:apply-phase",
        },
      }, "2026-09-05T12:00:00.000Z").work;

      await expect(invoke(harness.tool, "propose-decoy-origin", {
        operation: "propose",
        workId: work.id,
        semanticKey: "decoy-origin-must-not-run",
        method: contract.decoy.method,
        url: contract.decoy.href,
        headers: [{ name: "content-type", value: contract.mutation.contentType }],
        body: JSON.stringify({ envelope: { state: { phase: "must-not-run" } } }),
        verification: {
          url: contract.decoy.href,
          expected: { kind: "json_field", path: contract.verification.fieldPath, value: "must-not-run" },
        },
      })).rejects.toThrow("did not allow the local address");
      expect(untrustedOrigin.requestCount("PATCH", "/rpc/v17/workspaces/amber-9/transitions/decoy")).toBe(0);

      const requestBody = {
        envelope: {
          command: { namespace: "urn:fixture:phase", operation: "advance" },
          state: { phase: "settled-from-discovery", ordinal: 17 },
          arguments: [{ key: "workspace", value: "amber-9" }],
        },
      };
      const proposed = await invoke(harness.tool, "propose-discovered-transition", {
        operation: "propose",
        workId: work.id,
        semanticKey: "apply-discovered-phase-transition",
        method: contract.mutation.method,
        url: contract.mutation.href,
        headers: [{ name: "content-type", value: contract.mutation.contentType }],
        body: JSON.stringify(requestBody),
        verification: {
          url: contract.verification.href,
          expected: {
            kind: "json_field",
            path: contract.verification.fieldPath,
            value: contract.verification.equals,
          },
        },
      });
      const action = actionFrom(proposed, harness.store);
      expect(action).toMatchObject({ state: "planned", effectClass: "external_mutation" });
      expect(service.requestCount("PATCH", mutationPath)).toBe(0);

      const executed = await invoke(harness.tool, "execute-discovered-transition", {
        operation: "execute",
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
      });
      expect(executed).toMatchObject({
        details: {
          kind: "confirmed",
          action: { id: action.id, state: "confirmed", effectClass: "external_mutation" },
          attempt: { state: "confirmed" },
          evidence: {
            kind: "managed_http_verification",
            code: "http_effect_verified",
            request: { method: "PATCH", url: service.url(mutationPath), status: 200 },
            verification: {
              method: "GET",
              url: service.url(mutationPath),
              status: 200,
              matched: true,
            },
          },
        },
      });
      expect(service.requestCount("PATCH", mutationPath)).toBe(1);
      expect(service.requestCount("GET", mutationPath)).toBe(1);
      expect(service.resource(mutationPath)).toMatchObject({
        method: "PATCH",
        value: requestBody,
      });

      const attempt = harness.store.assistantWork.listAttempts(action.id)[0];
      expect(attempt).toMatchObject({ state: "confirmed" });
      expect(attempt?.outcome).toMatchObject({
        kind: "managed_http_verification",
        code: "http_effect_verified",
        request: { method: "PATCH", url: service.url(mutationPath) },
        verification: { method: "GET", url: service.url(mutationPath), matched: true },
      });
    } finally {
      harness.store.close();
    }
  });
});
