import { expect, test } from "bun:test";
import { configuredHttpAccess } from "../../src/assistant-work/http-policy.ts";
import type { ManagedHttpPlan } from "../../src/assistant-work/http-effects.ts";

const binding = { id: "fixture-send", version: 1, origin: "https://service.example", method: "POST", path: "/messages", action: "send", allowedBodyKeys: ["recipient", "topic", "message"], recipientPath: ["recipient"], topicPath: ["topic"], messagePath: ["message"] };
const plan: ManagedHttpPlan = { version: 1, method: "POST", url: "https://service.example/messages", headers: [], body: JSON.stringify({ recipient: "alice", topic: "schedule", message: "Friday works" }), verification: { url: "https://service.example/messages/1", headers: [], expected: { kind: "text_contains", text: "Friday works" } }, messageOperation: { recipient: "alice", topic: "schedule", action: "send" }, messageAuthorization: null };

test("message labels only gain send-rule classification through actual host-bound payload", () => {
  const access = configuredHttpAccess({ OI_HTTP_MESSAGE_BINDINGS: JSON.stringify([binding]) });
  expect(access.authorizeMessage(plan)).toEqual({ capabilityId: "fixture-send", capabilityVersion: 1 });
  expect(access.authorizeMessage({ ...plan, url: "https://service.example/delete-account" })).toBeUndefined();
  expect(access.authorizeMessage({ ...plan, method: "DELETE" })).toBeUndefined();
  expect(access.authorizeMessage({ ...plan, body: JSON.stringify({ recipient: "bob", topic: "schedule", message: "Friday works" }) })).toBeUndefined();
  expect(access.authorizeMessage({ ...plan, body: JSON.stringify({ recipient: "alice", topic: "schedule", message: "Friday works", deleteAll: true }) })).toBeUndefined();
  expect(configuredHttpAccess({}).authorizeMessage(plan)).toBeUndefined();
  expect(access.authorizeMessage({ ...plan, messageOperation: { recipient: "alice", topic: "other", action: "send" } })).toBeUndefined();
});
