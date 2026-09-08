import { describe, expect, test } from "bun:test";
import { ChatActivity } from "../../src/assistant-work/activity.ts";

describe("Chat activity receipt freshness", () => {
  test("requires a foreground sample and known recent input", () => {
    const activity = new ChatActivity(() => 200_000);
    expect(activity.isActive()).toBe(false);
    activity.record({ frontmost: false, lastInputAgeSeconds: 0 });
    expect(activity.isActive()).toBe(false);
    activity.record({ frontmost: true, lastInputAgeSeconds: null });
    expect(activity.isActive()).toBe(false);
    activity.record({ frontmost: true, lastInputAgeSeconds: 120 });
    expect(activity.isActive()).toBe(true);
    activity.record({ frontmost: true, lastInputAgeSeconds: 120.001 });
    expect(activity.isActive()).toBe(false);
  });

  test("ages input and expires a disconnected reporter", () => {
    let clock = 200_000;
    const activity = new ChatActivity(() => clock);
    activity.record({ frontmost: true, lastInputAgeSeconds: 119 });
    clock += 1_001;
    expect(activity.isActive()).toBe(false);
    activity.record({ frontmost: true, lastInputAgeSeconds: 0 });
    clock += 15_000;
    expect(activity.isActive()).toBe(true);
    clock += 1;
    expect(activity.isActive()).toBe(false);
    activity.record({ frontmost: true, lastInputAgeSeconds: 0 });
    clock -= 1;
    expect(activity.isActive()).toBe(false);
  });

  test("rejects invalid metadata without replacing the last sample", () => {
    const activity = new ChatActivity(() => 200_000);
    activity.record({ frontmost: true, lastInputAgeSeconds: 1 });
    for (const age of [-1, NaN, Infinity]) {
      expect(() => activity.record({ frontmost: true, lastInputAgeSeconds: age })).toThrow("invalid_chat_activity");
    }
    expect(activity.isActive()).toBe(true);
  });
});
