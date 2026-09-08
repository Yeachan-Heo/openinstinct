import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchManagedAction } from "../../src/assistant-work/dispatch.ts";
import { configuredHttpAccess } from "../../src/assistant-work/http-policy.ts";
import { preflightManagedHttpAction } from "../../src/assistant-work/http-effects.ts";
import { preflightLocalFileAction } from "../../src/assistant-work/local-effects.ts";
import { stableAttemptId, type ActionRecord } from "../../src/assistant-work/model.ts";
import { ChatHub, PANEL_SOURCE_MARKER } from "../../src/chat/hub.ts";
import { OwnerOutbox } from "../../src/delivery/outbox.ts";
import { NdjsonLogger } from "../../src/log.ts";
import { OwnerTurnIngress, type OwnerTurnRequest } from "../../src/owner-turn.ts";
import type { MainSession, MainTurnInput } from "../../src/sdk-session/main-session.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";
import {
  HttpServiceFixture,
  startHttpServiceFixture,
} from "../fixtures/assistant-work/http-service.ts";

const roots: string[] = [];
const fixtures: HttpServiceFixture[] = [];
const T0 = "2026-09-05T12:00:00.000Z";

interface DispatchHarness {
  readonly root: string;
  readonly store: StateStore;
  readonly ingress: OwnerTurnIngress;
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

function createHarness(): DispatchHarness {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-dispatch-integration-"));
  roots.push(root);
  const store = openStateStore(join(root, "state.db"));
  const logger = new NdjsonLogger(join(root, "dispatch.ndjson"));
  const hub = new ChatHub(logger);
  const outbox = new OwnerOutbox({ logger });
  const lane = {
    session: {
      running: false,
      turn: (_input: MainTurnInput) => Promise.resolve({ kind: "reply", text: "dispatch approval admitted" } as const),
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
  return { root, store, ingress };
}

function admitWork(store: StateStore, suffix: string) {
  return store.assistantWork.admitObservation({
    source: "test:managed-dispatch",
    occurrenceKey: `occurrence-${suffix}`,
    workKey: `work-${suffix}`,
    workTitle: `Managed dispatch ${suffix}`,
    provenance: {
      principal: "system",
      channel: "test",
      subject: "dispatch-fixture",
      evidenceId: `dispatch-evidence-${suffix}`,
    },
    observedAt: T0,
    evidence: { fixture: suffix },
  }, T0).work;
}

function ownerRequest(turnId: string, action: ActionRecord): OwnerTurnRequest {
  const text = `/approve ${action.id} ${action.revision} ${action.digest}`;
  return {
    source: "panel",
    turnId,
    text,
    promptText: `${text}\n\n${PANEL_SOURCE_MARKER}`,
  };
}

describe("managed executor dispatch selection", () => {
  test("selects local and HTTP executors from persisted action material without invoking the wrong effect", async () => {
    const service = await serviceFixture();
    const harness = createHarness();
    const localPath = join(harness.root, "selected-local.txt");
    const httpPath = "/dispatch/selected-http";
    const access = configuredHttpAccess({
      OI_HTTP_LOCAL_ORIGINS: JSON.stringify([service.origin]),
    });
    writeFileSync(localPath, "delete only through the local executor", "utf8");
    try {
      const localWork = admitWork(harness.store, "local");
      const localPreflight = await preflightLocalFileAction({
        workId: localWork.id,
        semanticKey: "local-selected-executor",
        operations: [{ operation: "delete_file", path: localPath }],
      });
      const localAction = harness.store.assistantWork.proposeAction(localPreflight.proposal, T0);
      expect(localAction).toMatchObject({ state: "approval_pending", effectClass: "delete_existing" });
      expect(await harness.ingress.admit(ownerRequest("approve-dispatch-local", localAction))).toBe("started");
      expect(harness.store.assistantWork.getAction(localAction.id)).toMatchObject({ state: "authorized" });

      const httpWork = admitWork(harness.store, "http");
      const httpPreflight = await preflightManagedHttpAction({
        workId: httpWork.id,
        semanticKey: "http-selected-executor",
        method: "PATCH",
        url: service.url(httpPath),
        headers: [{ name: "content-type", value: "application/json" }],
        body: JSON.stringify({ selected: { executor: "http", confirmed: true } }),
        verification: {
          url: service.url(httpPath),
          expected: {
            kind: "json_field",
            path: ["resource", "value", "selected", "confirmed"],
            value: true,
          },
        },
      }, { endpointPolicy: access.endpointPolicy });
      const httpAction = harness.store.assistantWork.proposeAction(httpPreflight.proposal, T0);
      expect(httpAction).toMatchObject({ state: "approval_pending", effectClass: "external_mutation" });
      expect(await harness.ingress.admit(ownerRequest("approve-dispatch-http", httpAction))).toBe("started");
      expect(harness.store.assistantWork.getAction(httpAction.id)).toMatchObject({ state: "authorized" });

      const localAttemptId = stableAttemptId(localAction.id, localAction.revision, "dispatch-local");
      const localResult = await dispatchManagedAction({
        repository: harness.store.assistantWork,
        action: localAction,
        attemptId: localAttemptId,
        workerId: "dispatch-local-worker",
        httpAccess: access,
      });
      expect(localResult).toMatchObject({
        kind: "confirmed",
        action: { id: localAction.id, state: "confirmed" },
        attempt: { id: localAttemptId, state: "confirmed", authorizationSource: "owner_explicit" },
        evidence: { kind: "managed_local_file_receipt" },
      });
      expect(existsSync(localPath)).toBe(false);
      expect(service.requestCount("PATCH", httpPath)).toBe(0);
      expect(service.requestCount("GET", httpPath)).toBe(0);

      const httpAttemptId = stableAttemptId(httpAction.id, httpAction.revision, "dispatch-http");
      const httpResult = await dispatchManagedAction({
        repository: harness.store.assistantWork,
        action: httpAction,
        attemptId: httpAttemptId,
        workerId: "dispatch-http-worker",
        httpAccess: access,
      });
      expect(httpResult).toMatchObject({
        kind: "confirmed",
        action: { id: httpAction.id, state: "confirmed" },
        attempt: { id: httpAttemptId, state: "confirmed", authorizationSource: "owner_explicit" },
        evidence: {
          kind: "managed_http_verification",
          code: "http_effect_verified",
          request: { method: "PATCH", url: service.url(httpPath), status: 200 },
          verification: { method: "GET", url: service.url(httpPath), status: 200, matched: true },
        },
      });
      expect(service.requestCount("PATCH", httpPath)).toBe(1);
      expect(service.requestCount("GET", httpPath)).toBe(1);
      expect(existsSync(localPath)).toBe(false);
      expect(service.resource(httpPath)).toMatchObject({
        method: "PATCH",
        value: { selected: { executor: "http", confirmed: true } },
      });

      expect(harness.store.assistantWork.getAttempt(localAttemptId)).toMatchObject({
        actionId: localAction.id,
        state: "confirmed",
        outcome: { code: "local_effect_verified", evidence: { kind: "managed_local_file_receipt" } },
      });
      expect(harness.store.assistantWork.getAttempt(httpAttemptId)).toMatchObject({
        actionId: httpAction.id,
        state: "confirmed",
        outcome: { kind: "managed_http_verification", code: "http_effect_verified" },
      });
      expect(harness.store.assistantWork.listExplicitApprovals(localAction.id)).toMatchObject([{ state: "consumed" }]);
      expect(harness.store.assistantWork.listExplicitApprovals(httpAction.id)).toMatchObject([{ state: "consumed" }]);
      expect(harness.store.assistantWork.listAttempts(localAction.id)).toHaveLength(1);
      expect(harness.store.assistantWork.listAttempts(httpAction.id)).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  test("blocks unsupported material and never guesses either local or HTTP executor", async () => {
    const service = await serviceFixture();
    const harness = createHarness();
    const localPath = join(harness.root, "must-not-exist.txt");
    const httpPath = "/dispatch/must-not-run";
    const access = configuredHttpAccess({
      OI_HTTP_LOCAL_ORIGINS: JSON.stringify([service.origin]),
    });
    try {
      const work = admitWork(harness.store, "unsupported");
      const unsupported = harness.store.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "unsupported-dispatch-material",
        effectClass: "external_mutation",
        action: "model_claimed_executor",
        payload: {
          localPath,
          httpUrl: service.url(httpPath),
          method: "PATCH",
          body: { selected: "none" },
        },
      }, T0);
      expect(await harness.ingress.admit(ownerRequest("approve-unsupported-dispatch", unsupported))).toBe("command");
      expect(harness.store.assistantWork.listExplicitApprovals(unsupported.id)).toHaveLength(0);

      const result = await dispatchManagedAction({
        repository: harness.store.assistantWork,
        action: unsupported,
        attemptId: stableAttemptId(unsupported.id, unsupported.revision, "unsupported-dispatch"),
        workerId: "dispatch-unsupported-worker",
        httpAccess: access,
      });
      expect(result).toMatchObject({ kind: "rejected", reason: "blocked", action: { id: unsupported.id } });
      expect(existsSync(localPath)).toBe(false);
      expect(service.requestCount("PATCH", httpPath)).toBe(0);
      expect(service.requestCount("GET", httpPath)).toBe(0);
      expect(harness.store.assistantWork.listAttempts(unsupported.id)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });
});
