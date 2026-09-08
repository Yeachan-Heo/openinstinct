import type { StateStore } from "../store/db.ts";
import type { OwnerOutbox } from "../delivery/outbox.ts";
import type { ChatActivity } from "./activity.ts";
import { NotificationRouter } from "./notifications.ts";
import { stableNotificationId, type NotificationRecord } from "./model.ts";

/** Bridges durable notices to the panel polling surface and confirmed iMessage ledger. */
export class AssistantNotificationService {
  private readonly router: NotificationRouter;
  private draining: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(private readonly options: {
    readonly store: StateStore;
    readonly outbox: OwnerOutbox;
    readonly activity: ChatActivity;
    readonly isPaused?: () => boolean;
    readonly onError: (error: unknown) => void;
  }) {
    this.router = new NotificationRouter({
      repository: options.store.assistantWork,
      chatActivity: options.activity,
      workerId: "assistant-notifications",
      transports: {
        // Listing is durable, but no renderer has confirmed receipt yet.
        chat: async () => ({ kind: "uncertain", detail: { awaitingPanelRender: true } }),
        imessage: async (notice) => {
          const delivery = options.outbox.admit({
            idempotencyKey: `assistant-notification:${notice.id}`,
            text: notice.body,
          });
          if (!delivery) throw new Error("notification_imessage_lane_detached");
          return delivery.state === "confirmed"
            ? { kind: "delivered", externalId: delivery.id, evidence: { ledgerConfirmed: true, deliveryId: delivery.id } }
            : { kind: "uncertain", detail: { deliveryId: delivery.id, state: delivery.state } };
        },
      },
    });
  }

  public start(): void {
    if (this.timer) return;
    this.router.recoverInterruptedRoutes();
    this.timer = setInterval(() => { void this.drain().catch(this.options.onError); }, 1_000);
    void this.drain().catch(this.options.onError);
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  public admit(source: string, occurrenceKey: string, body: string): NotificationRecord {
    const notice = this.router.admit({ id: stableNotificationId(source, occurrenceKey), body });
    void this.drain().catch(this.options.onError);
    return notice;
  }

  public list(): { notifications: { id: string; text: string; acknowledged: boolean }[] } {
    return { notifications: this.options.store.assistantWork.listNotifications().map((notice) => ({
      id: notice.id, text: notice.body, acknowledged: notice.ownerAckAt !== undefined,
    })) };
  }

  public acknowledge(id: string): void { this.router.acknowledge(id); }

  public rendered(id: string): void {
    const route = this.options.store.assistantWork.getNotificationRoute(id, "chat");
    if (route?.state === "uncertain") {
      this.router.reconcileDelivered(id, "chat", { detail: { renderedByPanel: true } });
    }
    this.router.markChatRendered(id);
  }

  public drain(): Promise<void> {
    if (this.draining) return this.draining;
    const operation = this.drainOnce();
    this.draining = operation;
    void operation.finally(() => { if (this.draining === operation) this.draining = undefined; }).catch(() => {});
    return operation;
  }

  private async drainOnce(): Promise<void> {
    if (this.options.isPaused?.()) return;
    const repository = this.options.store.assistantWork;
    for (const notice of repository.listNotifications()) {
      if (this.options.isPaused?.()) return;
      const state = repository.getNotificationWithRoutes(notice.id);
      if (!state) continue;
      const phone = state.routes.find((route) => route.route === "imessage");
      if (phone?.state === "uncertain") {
        // The stable key also recovers a crash between queue admission and route settlement.
        const record = this.options.store.getDeliveryByIdempotencyKey(`assistant-notification:${notice.id}`);
        if (record?.state === "confirmed") {
          this.router.reconcileDelivered(notice.id, "imessage", { externalId: record.id, detail: { ledgerConfirmed: true } });
        }
      }
      if (notice.ownerAckAt !== undefined) continue;
      if (!this.options.activity.isActive() && !this.options.outbox.attached) continue;
      if (state.routes.length === 0) await this.router.dispatchInitial(notice.id);
      else await this.router.routeUnacknowledgedAfterInactivity(notice.id);
    }
  }
}
