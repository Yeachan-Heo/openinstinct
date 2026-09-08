import { createHash } from "node:crypto";
import type { AssistantWorkRepository, AmbiguousAttemptResolutionInput } from "../store/assistant-work.ts";
import { canonicalJson, type JsonValue } from "./model.ts";
import { isManagedHttpActionRecord, parseManagedHttpPlan, verifyManagedHttpPlan } from "./http-effects.ts";
import { configuredHttpAccess } from "./http-policy.ts";
import { MANAGED_LOCAL_FILE_ACTION, parseLocalFilePlan, inspectLocalFilePlan, localContentDigest } from "./local-effects.ts";

/** Reads independently observable state only. Never retries the original effect. */
export async function reconcileManagedAttempt(repository: AssistantWorkRepository, attemptId: string, workerId: string, httpAccess = configuredHttpAccess()): Promise<boolean> {
  const attempt = repository.getAttempt(attemptId);
  if (!attempt || attempt.state !== "ambiguous") return false;
  const action = repository.getAction(attempt.actionId);
  if (!action || action.state !== "ambiguous" || action.activeAttemptId !== attemptId) return false;
  let evidence: JsonValue;
  let source: string;
  if (isManagedHttpActionRecord(action)) {
    const plan = parseManagedHttpPlan(action.payload);
    const verified = await verifyManagedHttpPlan(plan, httpAccess);
    if (verified === undefined) return false;
    evidence = verified;
    source = "managed-http-independent-get";
  } else if (action.action === MANAGED_LOCAL_FILE_ACTION) {
    const plan = parseLocalFilePlan(action.payload);
    const inspection = await inspectLocalFilePlan(plan);
    if (!plan.operations.every((operation, index) => {
      const current = inspection.inventory[index];
      return operation.operation === "delete_file" ? current?.state === "absent"
        : current?.state === "file" && current.sha256 === localContentDigest(operation.content);
    })) return false;
    evidence = { inventory: inspection.inventory.map((entry) => ({ path: entry.path, state: entry.state, ...("sha256" in entry ? { sha256: entry.sha256 } : {}) })) };
    source = "managed-local-independent-inventory";
  } else return false;
  const evidenceId = createHash("sha256").update(canonicalJson(evidence)).digest("hex");
  const input: AmbiguousAttemptResolutionInput = { attemptId, workerId, resolution: "confirmed", evidenceSource: source, evidenceId, evidence };
  const now = new Date().toISOString();
  const dispatch = repository.listFollowupDispatches(action.workId).find((row) => row.actionId === action.id);
  if (dispatch) {
    repository.resolveFollowupAmbiguity(dispatch.id, input, { id: `followup-verified:${dispatch.id}:${evidenceId}`, code: "followup_verified", workId: action.workId, actionId: action.id, dispatchId: dispatch.id, detail: evidence }, now);
  } else {
    repository.resolveAmbiguousAttempt(input, now);
  }
  return true;
}
