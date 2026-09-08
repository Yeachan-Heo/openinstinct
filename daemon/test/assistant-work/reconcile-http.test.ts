import { expect, test } from "bun:test";
import { startHttpServiceFixture } from "../fixtures/assistant-work/http-service.ts";
import { verifyManagedHttpPlan, type ManagedHttpPlan } from "../../src/assistant-work/http-effects.ts";

test("reconciliation does not match JSON object numeric keys as array indices", async () => {
  const service = await startHttpServiceFixture();
  try {
    await fetch(service.url("/numeric-object"), { method: "POST", body: JSON.stringify({ "0": "expected" }) });
    const plan: ManagedHttpPlan = { version: 1, method: "POST", url: service.url("/numeric-object"), headers: [], body: "{}", messageOperation: null, messageAuthorization: null,
      verification: { url: service.url("/numeric-object"), headers: [], expected: { kind: "json_field", path: ["resource", "value", 0], value: "expected" } } };
    const options = { endpointPolicy: () => ({ allowed: true, allowPrivateNetwork: true }) };
    expect(await verifyManagedHttpPlan(plan, options)).toBeUndefined();
    expect(await verifyManagedHttpPlan({ ...plan, verification: { ...plan.verification, expected: { kind: "json_field", path: ["resource", "value", "0"], value: "expected" } } }, options)).toBeDefined();
    expect(service.requestCount("POST", "/numeric-object")).toBe(1);
  } finally { await service.stop(); }
});

test("redacted display tokens cannot falsely confirm raw remote evidence", async () => {
  const service = await startHttpServiceFixture();
  try {
    const plan: ManagedHttpPlan = { version: 1, method: "POST", url: service.url("/unused"), headers: [], body: "{}", messageOperation: null, messageAuthorization: null,
      verification: { url: service.url("/read/echo-auth"), headers: [{ name: "authorization", secretRef: "secret://fixture/token" }], expected: { kind: "text_contains", text: "[REDACTED]" } } };
    expect(await verifyManagedHttpPlan(plan, { endpointPolicy: () => ({ allowed: true, allowPrivateNetwork: true }), resolveSecret: () => "fixture-token-never-display" })).toBeUndefined();
    expect(service.requestCount("POST", "/unused")).toBe(0);
  } finally { await service.stop(); }
});
