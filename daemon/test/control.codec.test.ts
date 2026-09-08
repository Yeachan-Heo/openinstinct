import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { decodeFrame, encodeFrame } from "../src/control/schema.ts";

const fixturesDirectory = fileURLToPath(new URL("./fixtures/control/", import.meta.url));

describe("control schema codecs", () => {
  for (const fixture of readdirSync(fixturesDirectory).filter((file) => file.endsWith(".json")).sort()) {
    test(`round-trips ${fixture}`, () => {
      const source = JSON.parse(readFileSync(`${fixturesDirectory}${fixture}`, "utf8"));
      const encoded = encodeFrame(decodeFrame(source));
      expect(JSON.parse(encoded)).toEqual(source);
    });
  }

  test("rejects request fields outside the closed schema", () => {
    expect(() => decodeFrame({
      type: "request",
      id: "status-1",
      verb: "status.get",
      payload: {},
      extra: true,
    })).toThrow("unknown field");
  });

  test("models.list accepts an optional boolean refresh and rejects other shapes", () => {
    const request = (payload: Record<string, unknown>) => ({ type: "request", id: "models-1", verb: "models.list", payload });
    expect(decodeFrame(request({})).type).toBe("request");
    expect(decodeFrame(request({ refresh: true })).type).toBe("request");
    expect(() => decodeFrame(request({ refresh: "yes" }))).toThrow("models.list.refresh must be boolean");
    expect(() => decodeFrame(request({ force: true }))).toThrow("unknown field");
  });
  test("chat.activity accepts bounded metadata without trusting client timestamps", () => {
    const frame = (payload: Record<string, unknown>) => ({ type: "request", id: "activity", verb: "chat.activity", payload });
    for (const age of [0, 120, 120.001, null]) {
      expect(decodeFrame(frame({ frontmost: true, lastInputAgeSeconds: age })).type).toBe("request");
    }
    for (const age of [-1, Infinity, NaN, "0", undefined]) {
      expect(() => decodeFrame(frame({ frontmost: true, lastInputAgeSeconds: age }))).toThrow();
    }
    expect(() => decodeFrame(frame({ frontmost: "true", lastInputAgeSeconds: 0 }))).toThrow();
    expect(() => decodeFrame(frame({ frontmost: true, lastInputAgeSeconds: 0, receivedAt: 0 }))).toThrow();
  });
  test("notification render and owner acknowledgement require a correlated nonblank id", () => {
    for (const verb of ["assistant.notifications.ack", "assistant.notifications.rendered"]) {
      const frame = (payload: Record<string, unknown>) => ({ type: "request", id: "notice", verb, payload });
      expect(decodeFrame(frame({ notificationId: "notice-123" })).type).toBe("request");
      for (const notificationId of [undefined, null, "", " ", 1]) {
        expect(() => decodeFrame(frame({ notificationId }))).toThrow();
      }
      expect(() => decodeFrame(frame({ notificationId: "notice-123", acknowledged: true }))).toThrow();
    }
  });
});
