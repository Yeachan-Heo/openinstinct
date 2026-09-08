import { expect, test } from "bun:test";
import { assessObservation, nextRecontactAt } from "../../src/assistant-work/observation.ts";

test("involvement and incomplete evidence control discovery, not authorization", () => {
  const input = { involved: true, important: true, ongoing: false, confidence: "uncertain" as const, unfinishedEvidence: ["Owner promised a reply"] };
  expect(assessObservation(input)).toEqual({ disposition: "propose", intervalMs: 300_000 });
  expect(assessObservation({ ...input, confidence: "clear" }).disposition).toBe("track");
  expect(assessObservation({ ...input, involved: false }).disposition).toBe("ignore");
  expect(assessObservation({ ...input, unfinishedEvidence: [] }).disposition).toBe("ignore");
  expect(assessObservation({ ...input, important: false }).intervalMs).toBe(1_800_000);
  expect(assessObservation({ ...input, important: false, ongoing: true }).intervalMs).toBe(300_000);
  expect(() => assessObservation({ ...input, unfinishedEvidence: [" "] })).toThrow();
});

test("recontact requires an explicit bounded policy", () => {
  const state = { attempts: 0, lastConfirmedAt: 1_000 };
  const policy = { enabled: true, intervalMs: 60_000, maxAttempts: 2 };
  expect(nextRecontactAt(state)).toBeUndefined();
  expect(nextRecontactAt({ ...state, policy })).toBe(61_000);
  expect(nextRecontactAt({ ...state, policy, attempts: 2 })).toBeUndefined();
  expect(nextRecontactAt({ ...state, policy, deadlineAt: 61_000 })).toBeUndefined();
  expect(nextRecontactAt({ ...state, policy, deadlineAt: 61_001 })).toBe(61_000);
  expect(nextRecontactAt({ ...state, policy: { ...policy, enabled: false } })).toBeUndefined();
  expect(() => nextRecontactAt({ ...state, policy: { ...policy, intervalMs: 0 } })).toThrow();
  expect(() => nextRecontactAt({ ...state, attempts: -1, policy })).toThrow();
});
