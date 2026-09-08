import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import type { ActionRecord } from "./model.ts";
import { executeManagedLocalFileAction } from "./execution.ts";
import { MANAGED_LOCAL_FILE_ACTION } from "./local-effects.ts";
import { executeManagedInstall, MANAGED_INSTALL_ACTION } from "./install.ts";
import { executeManagedHttpAction, isManagedHttpActionRecord } from "./http-effects.ts";
import { configuredHttpAccess } from "./http-policy.ts";
import type { FollowupDispatcherResult } from "./recovery.ts";

export async function dispatchManagedAction(input: {
  readonly repository: AssistantWorkRepository;
  readonly action: ActionRecord;
  readonly attemptId: string;
  readonly workerId: string;
  readonly httpAccess?: ReturnType<typeof configuredHttpAccess>;
}): Promise<FollowupDispatcherResult> {
  const action = input.action;
  const common = {
    repository: input.repository,
    actionId: action.id,
    revision: action.revision,
    digest: action.digest,
    attemptId: input.attemptId,
    workerId: input.workerId,
  };
  const result = isManagedHttpActionRecord(action)
    ? await executeManagedHttpAction({ ...common, ...(input.httpAccess ?? configuredHttpAccess()) })
    : action.action === MANAGED_LOCAL_FILE_ACTION
      ? await executeManagedLocalFileAction(common)
      : action.action === MANAGED_INSTALL_ACTION
        ? await executeManagedInstall(common)
        : undefined;
  if (!result || result.kind === "preflight_rejected") return { kind: "rejected", reason: "blocked", action };
  return result;
}
