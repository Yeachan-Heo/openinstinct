import type { ChatActivity } from "./activity.ts";
import type {
  AdmitNotificationInput,
  JsonValue,
  NotificationRecord,
  NotificationRoute,
  NotificationRouteRecord,
  NotificationWithRoutes,
} from "./model.ts";
import type { AssistantWorkRepository } from "../store/assistant-work.ts";

/** `delivered` requires confirmation evidence; queue admission alone is not delivery. */
export type NotificationTransportResult =
  | { readonly kind: "delivered"; readonly externalId?: string; readonly evidence: JsonValue }
  | { readonly kind: "uncertain"; readonly detail: JsonValue }
  | { readonly kind: "failed_definitive"; readonly detail: JsonValue };

export interface NotificationTransportCallbacks {
  /** Delivered means the Chat transport confirmed delivery; render and owner acknowledgement stay separate. */
  readonly chat: (notification: NotificationRecord) => Promise<NotificationTransportResult>;
  /** Return delivered only after delivery-ledger or remote confirmation. */
  readonly imessage: (notification: NotificationRecord) => Promise<NotificationTransportResult>;
}

export interface NotificationRouterOptions {
  readonly repository: AssistantWorkRepository;
  readonly chatActivity: Pick<ChatActivity, "isActive">;
  readonly transports: NotificationTransportCallbacks;
  readonly workerId: string;
  readonly now?: () => string;
}

export type NotificationDispatchResult =
  | { readonly kind: "delivered"; readonly route: NotificationRouteRecord }
  | { readonly kind: "uncertain"; readonly route: NotificationRouteRecord }
  | { readonly kind: "failed_definitive"; readonly route: NotificationRouteRecord }
  | { readonly kind: "claimable"; readonly route: NotificationRouteRecord }
  | { readonly kind: "not_dispatched"; readonly reason: "acknowledged" | "already_claimed" | "superseded" | "terminal" }
  | { readonly kind: "reconcile_only"; readonly route: NotificationRouteRecord };

/**
 * Coordinates durable route ownership with injected Chat and iMessage transports.
 * A callback is invoked only after its route is durably claimed as dispatching.
 */
export class NotificationRouter {
  private readonly repository: AssistantWorkRepository;
  private readonly chatActivity: Pick<ChatActivity, "isActive">;
  private readonly transports: NotificationTransportCallbacks;
  private readonly workerId: string;
  private readonly now: () => string;

  public constructor(options: NotificationRouterOptions) {
    if (options.workerId.trim().length === 0) {
      throw new Error("notification workerId must be non-empty");
    }
    if (typeof options.chatActivity.isActive !== "function") {
      throw new Error("notification chatActivity.isActive must be a function");
    }
    if (typeof options.transports.chat !== "function" || typeof options.transports.imessage !== "function") {
      throw new Error("notification transports must provide Chat and iMessage callbacks");
    }
    this.repository = options.repository;
    this.chatActivity = options.chatActivity;
    this.transports = options.transports;
    this.workerId = options.workerId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public admit(input: AdmitNotificationInput): NotificationRecord {
    return this.repository.admitNotification(input, this.now());
  }

  public async dispatchInitial(notificationId: string): Promise<NotificationDispatchResult> {
    const state = this.requiredState(notificationId);
    if (state.notification.ownerAckAt !== undefined) {
      return { kind: "not_dispatched", reason: "acknowledged" };
    }
    const reserved = state.routes.find((route) => route.state === "reserved");
    if (reserved) {
      return this.dispatchRoute(notificationId, reserved.route);
    }
    const unresolved = state.routes.find(
      (route) => route.state === "dispatching" || route.state === "uncertain",
    );
    if (unresolved) {
      return { kind: "reconcile_only", route: unresolved };
    }
    if (state.notification.renderedAt !== undefined) {
      return { kind: "not_dispatched", reason: "terminal" };
    }
    if (state.routes.length > 0) {
      return { kind: "not_dispatched", reason: "terminal" };
    }
    return this.dispatchRoute(notificationId, this.chatActivity.isActive() ? "chat" : "imessage");
  }

  /**
   * Render is not acknowledgement. Even a panel crash before render must allow
   * reservation of the same logical notice's iMessage route at most once.
   */
  public async routeUnacknowledgedAfterInactivity(
    notificationId: string,
  ): Promise<NotificationDispatchResult | { readonly kind: "no_fallback"; readonly reason: "active" | "no_chat_dispatch" | "acknowledged" }> {
    const state = this.requiredState(notificationId);
    if (state.notification.ownerAckAt !== undefined) {
      return { kind: "no_fallback", reason: "acknowledged" };
    }
    const chatRoute = state.routes.find((route) => route.route === "chat");
    if (!chatRoute || chatRoute.state === "reserved") {
      return { kind: "no_fallback", reason: "no_chat_dispatch" };
    }
    if (this.chatActivity.isActive()) {
      return { kind: "no_fallback", reason: "active" };
    }
    return this.dispatchRoute(notificationId, "imessage", true);
  }

  public markChatRendered(notificationId: string): NotificationRecord {
    return this.repository.markNotificationRendered(notificationId, "chat", this.now());
  }

  public acknowledge(notificationId: string): NotificationRecord {
    return this.repository.acknowledgeNotification(notificationId, this.now());
  }

  public recover(notificationId: string, route: NotificationRoute): NotificationDispatchResult {
    const recovery = this.repository.recoverNotificationRoute(notificationId, route, this.now());
    if (recovery.kind === "claimable") {
      return { kind: "claimable", route: recovery.route };
    }
    if (recovery.kind === "reconcile_only") {
      return { kind: "reconcile_only", route: recovery.route };
    }
    return { kind: "not_dispatched", reason: "terminal" };
  }

  /** Settles an uncertain route only from delivery-ledger or remote evidence; it never sends. */
  public reconcileDelivered(
    notificationId: string,
    route: NotificationRoute,
    evidence: { readonly externalId?: string; readonly detail: JsonValue },
  ): NotificationRouteRecord {
    return this.repository.markNotificationRouteDelivered({
      notificationId,
      route,
      workerId: this.workerId,
      ...(evidence.externalId === undefined ? {} : { externalId: evidence.externalId }),
      detail: evidence.detail,
    }, this.now()).route;
  }

  public reconcileFailedDefinitively(
    notificationId: string,
    route: NotificationRoute,
    detail: JsonValue,
  ): NotificationRouteRecord {
    return this.repository.markNotificationRouteFailedDefinitively({
      notificationId,
      route,
      workerId: this.workerId,
      detail,
    }, this.now()).route;
  }

  /** Converts interrupted dispatches to uncertain and returns all reconcile-only routes. */
  public recoverInterruptedRoutes(): readonly NotificationRouteRecord[] {
    const routes: NotificationRouteRecord[] = [];
    for (const candidate of this.repository.listNotificationRecoveryCandidates()) {
      if (candidate.state === "reserved") {
        continue;
      }
      if (candidate.state === "uncertain") {
        routes.push(candidate);
        continue;
      }
      const recovered = this.repository.recoverNotificationRoute(
        candidate.notificationId,
        candidate.route,
        this.now(),
      );
      if (recovered.kind === "reconcile_only") {
        routes.push(recovered.route);
      }
    }
    return routes;
  }

  private async dispatchRoute(
    notificationId: string,
    route: NotificationRoute,
    renderedFallback = false,
  ): Promise<NotificationDispatchResult> {
    const reservation = this.repository.reserveNotificationRoute(notificationId, route, this.now());
    if (reservation.kind === "rejected") {
      if (reservation.reason === "acknowledged") {
        return { kind: "not_dispatched", reason: "acknowledged" };
      }
      throw new Error(`unknown assistant notification: ${notificationId}`);
    }
    if (reservation.route.state === "dispatching" || reservation.route.state === "uncertain") {
      return { kind: "reconcile_only", route: reservation.route };
    }
    if (reservation.route.state !== "reserved") {
      return { kind: "not_dispatched", reason: "terminal" };
    }

    const claim = this.repository.claimNotificationRoute(
      notificationId,
      route,
      this.workerId,
      this.now(),
      { renderedFallback },
    );
    if (claim.kind === "rejected") {
      if (claim.reason === "acknowledged") {
        return { kind: "not_dispatched", reason: "acknowledged" };
      }
      if (claim.reason === "already_claimed") {
        return { kind: "not_dispatched", reason: "already_claimed" };
      }
      if (claim.reason === "superseded") {
        return { kind: "not_dispatched", reason: "superseded" };
      }
      if (claim.reason === "terminal") {
        return { kind: "not_dispatched", reason: "terminal" };
      }
      throw new Error(`notification route is not dispatchable: ${notificationId}/${route}`);
    }

    let result: NotificationTransportResult;
    try {
      result = await this.transports[route](claim.notification);
    } catch (error) {
      const settled = this.repository.markNotificationRouteUncertain({
        notificationId,
        route,
        workerId: this.workerId,
        detail: { reason: "transport_callback_threw", error: errorMessage(error) },
      }, this.now());
      return { kind: "uncertain", route: settled.route };
    }

    if (result.kind === "delivered") {
      const settled = this.repository.markNotificationRouteDelivered({
        notificationId,
        route,
        workerId: this.workerId,
        ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
        detail: result.evidence,
      }, this.now());
      return { kind: "delivered", route: settled.route };
    }
    if (result.kind === "failed_definitive") {
      const settled = this.repository.markNotificationRouteFailedDefinitively({
        notificationId,
        route,
        workerId: this.workerId,
        detail: result.detail,
      }, this.now());
      return { kind: "failed_definitive", route: settled.route };
    }
    const settled = this.repository.markNotificationRouteUncertain({
      notificationId,
      route,
      workerId: this.workerId,
      detail: result.detail,
    }, this.now());
    return { kind: "uncertain", route: settled.route };
  }

  private requiredState(notificationId: string): NotificationWithRoutes {
    const state = this.repository.getNotificationWithRoutes(notificationId);
    if (!state) {
      throw new Error(`unknown assistant notification: ${notificationId}`);
    }
    return state;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
