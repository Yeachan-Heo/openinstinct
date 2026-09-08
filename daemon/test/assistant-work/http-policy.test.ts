import { expect, test } from "bun:test";
import { configuredHttpAccess } from "../../src/assistant-work/http-policy.ts";

test("HTTP credentials require exact host-owned origin and header binding", async () => {
  const config = configuredHttpAccess({
    OI_HTTP_LOCAL_ORIGINS: '["http://127.0.0.1:8123"]',
    OI_HTTP_SECRET_BINDINGS: JSON.stringify({ test: { origin: "https://service.example", header: "Authorization", environment: "TEST_TOKEN" } }),
    TEST_TOKEN: "not-a-real-credential",
  });
  const context = { url: "https://service.example/messages", headerName: "Authorization", purpose: "mutation" as const };
  expect(await config.resolveSecret("test", context)).toBe("not-a-real-credential");
  expect(() => config.resolveSecret("test", { ...context, url: "https://other.example" })).toThrow();
  expect(() => config.resolveSecret("test", { ...context, headerName: "Cookie" })).toThrow();
  expect(() => config.resolveSecret("unknown", context)).toThrow();
  const endpoint = { url: "http://127.0.0.1:8123/", origin: "http://127.0.0.1:8123", scheme: "http" as const, hostname: "127.0.0.1", port: 8123, method: "GET" as const, purpose: "read" as const, resolvedAddresses: ["127.0.0.1"] };
  expect(await config.endpointPolicy(endpoint)).toEqual({ allowed: true, allowPrivateNetwork: true });
  expect(await config.endpointPolicy({ ...endpoint, origin: "http://127.0.0.1:8124", port: 8124 })).toEqual({ allowed: true, allowPrivateNetwork: false });
});

test("malformed and overbroad host bindings fail closed", () => {
  for (const origin of ["http://localhost/path", "http://localhost/", "http://name:password@localhost", "file:///tmp"]) {
    expect(() => configuredHttpAccess({ OI_HTTP_LOCAL_ORIGINS: JSON.stringify([origin]) })).toThrow();
  }
  expect(() => configuredHttpAccess({ OI_HTTP_SECRET_BINDINGS: "[]" })).toThrow();
});
