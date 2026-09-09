import type { StateStore } from "../store/db.ts";
import { FollowupRecoveryService, type AuthoredRecoveryReport, type FollowupRecoveryScope } from "./recovery.ts";
import { dispatchManagedAction } from "./dispatch.ts";
import { configuredHttpAccess } from "./http-policy.ts";
import { reconcileManagedAttempt } from "./reconcile.ts";

export class AssistantWorkRuntime {
  private readonly recovery: FollowupRecoveryService;
  private readonly startupScope: FollowupRecoveryScope;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private recovered = false;
  private stopped = true;
  private readonly verificationDue = new Map<string, number>();

  public constructor(private readonly options: {
    readonly store: StateStore;
    readonly isPaused: () => boolean;
    readonly report: (report: AuthoredRecoveryReport, key: string) => Promise<boolean>;
    readonly onError: (error: unknown) => void;
  }) {
    const httpAccess = configuredHttpAccess();
    this.recovery = new FollowupRecoveryService({
      repository: options.store.assistantWork,
      workerId: "assistant-work-runtime",
      dispatch: (action, attemptId, workerId) => dispatchManagedAction({
        repository: options.store.assistantWork, action, attemptId, workerId, httpAccess,
      }),
      authoredReport: async () => undefined,
    });
    // Capture before delayed/paused startup can admit live work owned by other workers.
    this.startupScope = this.recovery.captureRecoveryScope();
  }

  public start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.drain().catch(this.options.onError); }, 1_000);
    void this.drain().catch(this.options.onError);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  public drain(): Promise<void> {
    if (this.running) return this.running;
    const run = this.drainOnce();
    this.running = run;
    void run.finally(() => { if (this.running === run) this.running = undefined; }).catch(() => {});
    return run;
  }

  private async drainOnce(): Promise<void> {
    if (this.stopped || this.options.isPaused()) return;
    if (!this.recovered) {
      try {
        const results = await this.recovery.recover(this.startupScope);
        this.recovered = !results.some((result) => result.kind === "recovery_failed");
        for (const result of results) {
          if (result.kind === "recovery_failed") this.options.onError(result.error);
        }
      } catch (error) {
        this.options.onError(new Error("Assistant work startup recovery failed", { cause: error }));
      }
    }
    for (const attempt of this.options.store.assistantWork.listRecoveryCandidates()) {
      if (this.stopped || this.options.isPaused()) return;
      if (attempt.state !== "ambiguous" || (this.verificationDue.get(attempt.id) ?? 0) > Date.now()) continue;
      this.verificationDue.set(attempt.id, Date.now() + 60_000);
      try {
        await reconcileManagedAttempt(this.options.store.assistantWork, attempt.id, "assistant-work-runtime");
      } catch (error) {
        this.options.onError(error);
      }
    }
    for (const policy of this.options.store.assistantWork.listFollowupPolicies()) {
      if (this.stopped || this.options.isPaused()) return;
      if (!policy.enabled) continue;
      try {
        await this.recovery.tick(policy.workId);
      } catch (error) {
        this.options.onError(new Error(`Assistant work followup failed for work ${policy.workId} action ${policy.actionId}`, { cause: error }));
      }
    }
    for (const entry of this.options.store.assistantWork.listPendingFollowupReports()) {
      if (this.stopped || this.options.isPaused()) return;
      const report: AuthoredRecoveryReport = {
        code: entry.code,
        ...(entry.workId === undefined ? {} : { workId: entry.workId }),
        ...(entry.actionId === undefined ? {} : { actionId: entry.actionId }),
        ...(entry.attemptId === undefined ? {} : { attemptId: entry.attemptId }),
        ...(entry.dispatchId === undefined ? {} : { dispatchId: entry.dispatchId }),
        detail: entry.detail,
      };
      try {
        if (await this.options.report(report, entry.id)) {
          this.options.store.assistantWork.markFollowupReportAdmitted(entry.id, new Date().toISOString());
        }
      } catch (error) {
        this.options.onError(new Error(`Assistant work report ${entry.id} failed`, { cause: error }));
      }
    }
  }
}
