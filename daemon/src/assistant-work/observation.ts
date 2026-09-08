export interface ObservationAssessment {
  readonly involved: boolean;
  readonly important: boolean;
  readonly unfinishedEvidence: readonly string[];
  readonly confidence: "clear" | "uncertain";
  readonly ongoing: boolean;
}

export interface ObservationDecision {
  readonly disposition: "ignore" | "propose" | "track";
  readonly intervalMs: number;
}

/** Assessment selects work candidates, never authorizes effects or external sends. */
export function assessObservation(input: ObservationAssessment): ObservationDecision {
  if (typeof input.involved !== "boolean" || typeof input.important !== "boolean"
    || typeof input.ongoing !== "boolean" || !Array.isArray(input.unfinishedEvidence)
    || input.unfinishedEvidence.some((value) => typeof value !== "string" || value.trim().length === 0)
    || (input.confidence !== "clear" && input.confidence !== "uncertain")) {
    throw new Error("invalid_observation_assessment");
  }
  const intervalMs = input.important || input.ongoing ? 5 * 60_000 : 30 * 60_000;
  if (!input.involved || input.unfinishedEvidence.length === 0) return { disposition: "ignore", intervalMs };
  return { disposition: input.confidence === "clear" ? "track" : "propose", intervalMs };
}

export interface RecontactPolicy {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly maxAttempts: number;
}

/** Missing policy never creates a follow-up. Dispatch must separately check current authority. */
export function nextRecontactAt(input: {
  readonly policy?: RecontactPolicy;
  readonly attempts: number;
  readonly lastConfirmedAt: number;
  readonly deadlineAt?: number;
}): number | undefined {
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 0 || !Number.isFinite(input.lastConfirmedAt)
    || (input.deadlineAt !== undefined && !Number.isFinite(input.deadlineAt))) throw new Error("invalid_recontact_state");
  const policy = input.policy;
  if (!policy) return undefined;
  if (typeof policy.enabled !== "boolean" || !Number.isSafeInteger(policy.intervalMs) || policy.intervalMs <= 0
    || !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 0) throw new Error("invalid_recontact_policy");
  if (!policy.enabled || input.attempts >= policy.maxAttempts) return undefined;
  const due = input.lastConfirmedAt + policy.intervalMs;
  if (!Number.isSafeInteger(due)) throw new Error("invalid_recontact_due");
  return input.deadlineAt !== undefined && due >= input.deadlineAt ? undefined : due;
}
