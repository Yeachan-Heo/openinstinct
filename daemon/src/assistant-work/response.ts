import type { CustomTool } from "@gajae-code/coding-agent";
import { Type } from "@gajae-code/coding-agent/extensibility/typebox";
import type { AssistantWorkRepository } from "../store/assistant-work.ts";

export function createResponseCompletionTool(repository: AssistantWorkRepository): CustomTool {
  return {
    name: "assistant_response_received", label: "Record response to assistant work", strict: true, concurrency: "exclusive",
    description: "Record an observed incoming response tied to an existing confirmed outgoing action. Explicit source evidence and clear completion judgment are required to close work. Uncertain evidence records a proposal only, never owner authority.",
    parameters: Type.Object({
      workId: Type.String({ minLength: 1, maxLength: 200 }),
      responseToActionId: Type.String({ minLength: 1, maxLength: 200 }),
      source: Type.String({ minLength: 1, maxLength: 240 }),
      observedWorkKey: Type.String({ minLength: 1, maxLength: 512, description: "Conversation/work correlation key from the observed response, not a replacement chosen to fit the target work." }),
      occurrenceKey: Type.String({ minLength: 1, maxLength: 512 }),
      reference: Type.String({ minLength: 1, maxLength: 2048 }),
      summary: Type.String({ minLength: 1, maxLength: 12000 }),
      observedAt: Type.String({ minLength: 1, maxLength: 64 }),
      confidence: Type.Enum(["clear", "uncertain"]),
      satisfiesOutstandingRequest: Type.Boolean(),
    }, { additionalProperties: false }),
    async execute(_id, raw) {
      const input = raw as { workId: string; responseToActionId: string; source: string; observedWorkKey: string; occurrenceKey: string; reference: string; summary: string; observedAt: string; confidence: "clear" | "uncertain"; satisfiesOutstandingRequest: boolean };
      for (const value of [input.reference, input.summary, input.occurrenceKey, input.source]) if (typeof value !== "string" || !value.trim()) throw new Error("response evidence must be nonblank");
      if (!["clear", "uncertain"].includes(input.confidence) || typeof input.satisfiesOutstandingRequest !== "boolean") throw new Error("invalid response assessment");
      const work = repository.getWork(input.workId);
      const action = repository.getAction(input.responseToActionId);
      if (!work || !action || action.workId !== work.id || action.state !== "confirmed") throw new Error("response must refer to a confirmed action in this work");
      if (input.observedWorkKey !== work.stableKey) throw new Error("response conversation key does not match the tracked work");
      const observedAt = Date.parse(input.observedAt);
      const confirmed = repository.listAttempts(action.id).filter((attempt) => attempt.state === "confirmed");
      if (!Number.isFinite(observedAt) || observedAt > Date.now() || !confirmed.some((attempt) => attempt.settledAt && Date.parse(attempt.settledAt) <= observedAt)) throw new Error("response predates confirmed outgoing action or has invalid time");
      if (!repository.listObservations(work.id).some((observation) => observation.source === input.source)) throw new Error("response source does not match the tracked work");
      const now = new Date().toISOString();
      const evidence = repository.admitObservation({ source: input.source, occurrenceKey: input.occurrenceKey, workKey: work.stableKey, workTitle: work.title, observedAt: input.observedAt,
        provenance: { principal: "third_party", channel: "response_observation", subject: input.reference, evidenceId: `${input.source}:${input.occurrenceKey}` },
        evidence: { responseToActionId: action.id, observedWorkKey: input.observedWorkKey, reference: input.reference, summary: input.summary, confidence: input.confidence, satisfiesOutstandingRequest: input.satisfiesOutstandingRequest },
      }, now);
      const completed = input.confidence === "clear" && input.satisfiesOutstandingRequest;
      if (completed && work.state === "open") repository.setWorkState(work.id, "completed", now);
      return { content: [{ type: "text" as const, text: completed ? `Work ${work.id} completed from recorded incoming response evidence.` : `Response evidence recorded for ${work.id}; work remains pending review.` }], details: { workId: work.id, observationId: evidence.observation.id, completed: repository.getWork(work.id)?.state === "completed" } };
    },
  };
}
