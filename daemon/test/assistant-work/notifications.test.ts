import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotificationRouter } from "../../src/assistant-work/notifications.ts";
import { stableNotificationId } from "../../src/assistant-work/model.ts";
import { openStateStore } from "../../src/store/db.ts";

const directories: string[] = [];
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const T3 = "2026-01-01T00:03:00.000Z";

function stateDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "openinstinct-notifications-"));
  directories.push(directory);
  return join(directory, "state.db");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function clock(...values: readonly string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

describe("assistant-work notification ledger", () => {
  test("a panel crash before rendering still falls back once when inactive", async () => {
    const store = openStateStore(stateDbPath());
    let active = true;
    let sends = 0;
    const router = new NotificationRouter({
      repository: store.assistantWork,
      chatActivity: { isActive: () => active },
      workerId: "crash-test",
      transports: {
        chat: async () => ({ kind: "uncertain", detail: { panelDisconnected: true } }),
        imessage: async () => { sends++; return { kind: "delivered", evidence: { fixtureAccepted: true } }; },
      },
    });
    try {
      router.admit({ id: "crash-before-render", body: "Unseen result" });
      await router.dispatchInitial("crash-before-render");
      expect(store.assistantWork.getNotification("crash-before-render")?.renderedAt).toBeUndefined();
      active = false;
      expect((await router.routeUnacknowledgedAfterInactivity("crash-before-render")).kind).toBe("delivered");
      await router.routeUnacknowledgedAfterInactivity("crash-before-render");
      expect(sends).toBe(1);
    } finally { store.close(); }
  });
  test("stores one logical notice and one reservation per route", () => {
    const store = openStateStore(stateDbPath());
    try {
      const notificationId = stableNotificationId("monitor:important", "occurrence-42");
      const admitted = store.assistantWork.admitNotification({
        id: notificationId,
        body: "A durable update",
      }, T0);
      expect(store.assistantWork.admitNotification({
        id: notificationId,
        body: "A durable update",
      }, T1)).toEqual(admitted);
      expect(() => store.assistantWork.admitNotification({
        id: notificationId,
        body: "Changed payload",
      }, T1)).toThrow("notification identity collision");

      expect(store.assistantWork.reserveNotificationRoute(notificationId, "chat", T0))
        .toMatchObject({ kind: "reserved", created: true, route: { state: "reserved" } });
      expect(store.assistantWork.getNotificationWithRoutes(notificationId))
        .toMatchObject({ notification: { id: notificationId }, routes: [{ route: "chat" }] });
      expect(store.assistantWork.reserveNotificationRoute(notificationId, "chat", T1))
        .toMatchObject({ kind: "reserved", created: false, route: { state: "reserved" } });
      expect(store.assistantWork.reserveNotificationRoute(notificationId, "imessage", T1))
        .toMatchObject({ kind: "reserved", created: true, route: { state: "reserved" } });
      expect(store.assistantWork.listNotificationRoutes(notificationId)).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test("links an optional work and action without exposing database access", () => {
    const store = openStateStore(stateDbPath());
    try {
      const work = store.assistantWork.admitObservation({
        source: "fixture",
        occurrenceKey: "notice-link-occurrence",
        workKey: "notice-link-work",
        workTitle: "Linked notification",
        provenance: {
          principal: "system",
          channel: "fixture",
          subject: "test",
          evidenceId: "notice-link-evidence",
        },
        observedAt: T0,
        evidence: { found: true },
      }, T0).work;
      const action = store.assistantWork.proposeAction({
        workId: work.id,
        semanticKey: "linked-action",
        effectClass: "ordinary_local_edit",
        action: "write_file",
        payload: { path: "/tmp/linked" },
      }, T0);
      expect(store.assistantWork.admitNotification({
        id: "notice-linked",
        body: "Linked",
        workId: work.id,
        actionId: action.id,
      }, T1)).toMatchObject({
        id: "notice-linked",
        workId: work.id,
        actionId: action.id,
      });
    } finally {
      store.close();
    }
  });

  test("ack before claim blocks transport and ack after claim creates no new route", () => {
    const path = stateDbPath();
    const first = openStateStore(path);
    const second = openStateStore(path);
    try {
      first.assistantWork.admitNotification({ id: "notice-ack-before", body: "Before" }, T0);
      first.assistantWork.reserveNotificationRoute("notice-ack-before", "imessage", T0);
      second.assistantWork.acknowledgeNotification("notice-ack-before", T1);
      expect(first.assistantWork.claimNotificationRoute(
        "notice-ack-before",
        "imessage",
        "worker-a",
        T1,
      )).toMatchObject({ kind: "rejected", reason: "acknowledged" });

      first.assistantWork.admitNotification({ id: "notice-ack-after", body: "After" }, T0);
      first.assistantWork.reserveNotificationRoute("notice-ack-after", "imessage", T0);
      expect(first.assistantWork.claimNotificationRoute(
        "notice-ack-after",
        "imessage",
        "worker-a",
        T1,
      )).toMatchObject({ kind: "claimed", route: { state: "dispatching" } });
      second.assistantWork.acknowledgeNotification("notice-ack-after", T2);
      expect(first.assistantWork.reserveNotificationRoute("notice-ack-after", "chat", T2))
        .toMatchObject({ kind: "rejected", reason: "acknowledged" });
      expect(first.assistantWork.getNotificationRoute("notice-ack-after", "imessage"))
        .toMatchObject({ state: "dispatching", workerId: "worker-a" });
      expect(first.assistantWork.reserveNotificationRoute("notice-ack-after", "imessage", T3))
        .toMatchObject({ kind: "rejected", reason: "acknowledged", route: { state: "dispatching" } });
    } finally {
      second.close();
      first.close();
    }
  });

  test("only one concurrent claimant owns a reserved route", () => {
    const path = stateDbPath();
    const first = openStateStore(path);
    const second = openStateStore(path);
    try {
      first.assistantWork.admitNotification({ id: "notice-race", body: "Race" }, T0);
      first.assistantWork.reserveNotificationRoute("notice-race", "imessage", T0);

      expect(first.assistantWork.claimNotificationRoute("notice-race", "imessage", "worker-a", T1))
        .toMatchObject({ kind: "claimed", route: { workerId: "worker-a" } });
      expect(second.assistantWork.claimNotificationRoute("notice-race", "imessage", "worker-b", T1))
        .toMatchObject({ kind: "rejected", reason: "already_claimed", route: { workerId: "worker-a" } });
    } finally {
      second.close();
      first.close();
    }
  });

  test("a rendered Chat route supersedes an early iMessage reservation until explicit fallback", () => {
    const store = openStateStore(stateDbPath());
    try {
      store.assistantWork.admitNotification({ id: "notice-render-race", body: "Render race" }, T0);
      store.assistantWork.reserveNotificationRoute("notice-render-race", "chat", T0);
      store.assistantWork.reserveNotificationRoute("notice-render-race", "imessage", T0);
      store.assistantWork.claimNotificationRoute("notice-render-race", "chat", "chat-worker", T1);
      store.assistantWork.markNotificationRouteDelivered({
        notificationId: "notice-render-race",
        route: "chat",
        workerId: "chat-worker",
        externalId: "chat-event-render-race",
      }, T1);
      store.assistantWork.markNotificationRendered("notice-render-race", "chat", T2);

      expect(store.assistantWork.claimNotificationRoute(
        "notice-render-race",
        "imessage",
        "imessage-worker",
        T2,
      )).toMatchObject({ kind: "rejected", reason: "superseded", route: { state: "reserved" } });
      expect(store.assistantWork.claimNotificationRoute(
        "notice-render-race",
        "imessage",
        "imessage-worker",
        T2,
        { renderedFallback: true },
      )).toMatchObject({ kind: "claimed", route: { state: "dispatching" } });
    } finally {
      store.close();
    }
  });

  test("restart turns dispatching into uncertain and never makes it claimable again", () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    initial.assistantWork.admitNotification({ id: "notice-restart", body: "Restart" }, T0);
    initial.assistantWork.reserveNotificationRoute("notice-restart", "imessage", T0);
    initial.assistantWork.claimNotificationRoute("notice-restart", "imessage", "worker-before", T1);
    initial.close();

    const reopened = openStateStore(path);
    try {
      const restartRouter = new NotificationRouter({
        repository: reopened.assistantWork,
        chatActivity: { isActive: () => false },
        workerId: "reconciler",
        now: clock(T2, T3),
        transports: {
          chat: async () => { throw new Error("transport must not run during recovery"); },
          imessage: async () => { throw new Error("transport must not run during recovery"); },
        },
      });
      expect(restartRouter.recoverInterruptedRoutes()).toMatchObject([{
        notificationId: "notice-restart",
        route: "imessage",
        state: "uncertain",
        workerId: "worker-before",
        detail: { reason: "recovered_dispatching_without_outcome" },
      }]);
      const recovered = reopened.assistantWork.getNotification("notice-restart")!;
      expect(recovered.renderedAt).toBeUndefined();
      expect(recovered.ownerAckAt).toBeUndefined();
      expect(reopened.assistantWork.claimNotificationRoute(
        "notice-restart",
        "imessage",
        "worker-after",
        T3,
      )).toMatchObject({ kind: "rejected", reason: "terminal", route: { state: "uncertain" } });
      expect(reopened.assistantWork.reserveNotificationRoute("notice-restart", "imessage", T3))
        .toMatchObject({ kind: "reserved", created: false, route: { state: "uncertain" } });
      expect(restartRouter.reconcileDelivered("notice-restart", "imessage", {
        externalId: "remote-confirmation-1",
        detail: { confirmedBy: "delivery-ledger" },
      })).toMatchObject({
        state: "delivered",
        workerId: "reconciler",
        externalId: "remote-confirmation-1",
      });
    } finally {
      reopened.close();
    }
  });
});

describe("notification router", () => {
  test("uses Chat while active, keeps render distinct from ack, then falls back once after inactivity", async () => {
    const store = openStateStore(stateDbPath());
    let active = true;
    const chatCalls: string[] = [];
    const imessageCalls: string[] = [];
    const router = new NotificationRouter({
      repository: store.assistantWork,
      chatActivity: { isActive: () => active },
      workerId: "notification-worker",
      now: clock(T0, T0, T1, T1, T1, T2, T2, T3, T3, T3),
      transports: {
        chat: async (notification) => {
          chatCalls.push(notification.id);
          return { kind: "delivered", externalId: "chat-event-1", evidence: { transportConfirmed: true } };
        },
        imessage: async (notification) => {
          imessageCalls.push(notification.id);
          return { kind: "delivered", externalId: "message-guid-1", evidence: { confirmed: true } };
        },
      },
    });

    try {
      router.admit({ id: "notice-fallback", body: "Please review" });
      expect(await router.dispatchInitial("notice-fallback"))
        .toMatchObject({ kind: "delivered", route: { route: "chat", state: "delivered" } });
      expect(store.assistantWork.getNotificationRoute("notice-fallback", "chat"))
        .toMatchObject({ detail: { transportConfirmed: true } });
      expect(await router.routeUnacknowledgedAfterInactivity("notice-fallback"))
        .toEqual({ kind: "no_fallback", reason: "active" });
      const rendered = router.markChatRendered("notice-fallback");
      expect(rendered.renderedAt).toBeDefined();
      expect(rendered.ownerAckAt).toBeUndefined();
      expect(rendered.renderedAt).not.toBe(rendered.ownerAckAt);
      expect(await router.routeUnacknowledgedAfterInactivity("notice-fallback"))
        .toEqual({ kind: "no_fallback", reason: "active" });

      active = false;
      expect(await router.dispatchInitial("notice-fallback"))
        .toEqual({ kind: "not_dispatched", reason: "terminal" });
      expect(imessageCalls).toEqual([]);
      expect(await router.routeUnacknowledgedAfterInactivity("notice-fallback"))
        .toMatchObject({ kind: "delivered", route: { route: "imessage", state: "delivered" } });
      expect(store.assistantWork.getNotificationRoute("notice-fallback", "imessage"))
        .toMatchObject({ detail: { confirmed: true }, externalId: "message-guid-1" });
      expect(await router.routeUnacknowledgedAfterInactivity("notice-fallback"))
        .toMatchObject({ kind: "not_dispatched", reason: "terminal" });
      expect(chatCalls).toEqual(["notice-fallback"]);
      expect(imessageCalls).toEqual(["notice-fallback"]);
      expect(store.assistantWork.listNotificationRoutes("notice-fallback")).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test("owner ack after dispatch prevents fallback even when Chat becomes inactive", async () => {
    const store = openStateStore(stateDbPath());
    let active = true;
    let imessageCalls = 0;
    const router = new NotificationRouter({
      repository: store.assistantWork,
      chatActivity: { isActive: () => active },
      workerId: "notification-worker",
      now: clock(T0, T0, T1, T1, T2, T2, T3),
      transports: {
        chat: async (notification) => {
          active = false;
          store.assistantWork.acknowledgeNotification(notification.id, T1);
          return { kind: "delivered", externalId: "chat-event-acked", evidence: { transportConfirmed: true } };
        },
        imessage: async () => {
          imessageCalls += 1;
          return { kind: "delivered", externalId: "must-not-send", evidence: { confirmed: true } };
        },
      },
    });

    try {
      router.admit({ id: "notice-ack-after-dispatch", body: "Ack race" });
      expect(await router.dispatchInitial("notice-ack-after-dispatch"))
        .toMatchObject({ kind: "delivered", route: { route: "chat" } });
      const rendered = router.markChatRendered("notice-ack-after-dispatch");
      expect(rendered.ownerAckAt).toBe(T1);
      expect(rendered.renderedAt).toBeDefined();
      expect(rendered.renderedAt).not.toBe(rendered.ownerAckAt);
      expect(await router.routeUnacknowledgedAfterInactivity("notice-ack-after-dispatch"))
        .toEqual({ kind: "no_fallback", reason: "acknowledged" });
      expect(imessageCalls).toBe(0);
      expect(store.assistantWork.listNotificationRoutes("notice-ack-after-dispatch"))
        .toMatchObject([{ route: "chat", state: "delivered" }]);
    } finally {
      store.close();
    }
  });

  test("never calls a transport after owner acknowledgement and does not fake success", async () => {
    const store = openStateStore(stateDbPath());
    let chatCalls = 0;
    let imessageCalls = 0;
    const router = new NotificationRouter({
      repository: store.assistantWork,
      chatActivity: { isActive: () => false },
      workerId: "notification-worker",
      now: clock(T0, T1, T2, T3),
      transports: {
        chat: async () => {
          chatCalls += 1;
          return { kind: "delivered", evidence: { transportConfirmed: true } };
        },
        imessage: async () => {
          imessageCalls += 1;
          return { kind: "failed_definitive", detail: { code: "recipient_unavailable" } };
        },
      },
    });

    try {
      router.admit({ id: "notice-acked", body: "Acknowledged" });
      router.acknowledge("notice-acked");
      expect(await router.dispatchInitial("notice-acked"))
        .toEqual({ kind: "not_dispatched", reason: "acknowledged" });
      expect(chatCalls).toBe(0);
      expect(imessageCalls).toBe(0);

      router.admit({ id: "notice-definitive", body: "Unavailable" });
      expect(await router.dispatchInitial("notice-definitive"))
        .toMatchObject({
          kind: "failed_definitive",
          route: { state: "failed_definitive", detail: { code: "recipient_unavailable" } },
        });
      expect(imessageCalls).toBe(1);
      expect(await router.dispatchInitial("notice-definitive"))
        .toEqual({ kind: "not_dispatched", reason: "terminal" });
      expect(imessageCalls).toBe(1);
    } finally {
      store.close();
    }
  });

  test("persists an explicit uncertain result and suppresses blind retry", async () => {
    const store = openStateStore(stateDbPath());
    let calls = 0;
    const router = new NotificationRouter({
      repository: store.assistantWork,
      chatActivity: { isActive: () => false },
      workerId: "notification-worker",
      now: clock(T0, T0, T1, T1, T2, T3),
      transports: {
        chat: async () => ({ kind: "delivered", evidence: { transportConfirmed: true } }),
        imessage: async () => {
          calls += 1;
          return { kind: "uncertain", detail: { reason: "delivery_not_confirmed" } };
        },
      },
    });

    try {
      router.admit({ id: "notice-uncertain", body: "Uncertain" });
      expect(await router.dispatchInitial("notice-uncertain"))
        .toMatchObject({ kind: "uncertain", route: { state: "uncertain" } });
      expect(await router.dispatchInitial("notice-uncertain"))
        .toMatchObject({ kind: "reconcile_only", route: { state: "uncertain" } });
      expect(calls).toBe(1);
    } finally {
      store.close();
    }
  });

  test("a callback throwing after its effect is uncertain and repeated drain never resends", async () => {
    const store = openStateStore(stateDbPath());
    let calls = 0;
    const router = new NotificationRouter({
      repository: store.assistantWork,
      chatActivity: { isActive: () => false },
      workerId: "notification-worker",
      now: clock(T0, T0, T1, T1, T2, T3),
      transports: {
        chat: async () => ({ kind: "delivered", evidence: { transportConfirmed: true } }),
        imessage: async () => {
          calls += 1;
          throw new Error("connection_lost_after_send");
        },
      },
    });

    try {
      router.admit({ id: "notice-threw", body: "Threw after effect" });
      expect(await router.dispatchInitial("notice-threw"))
        .toMatchObject({
          kind: "uncertain",
          route: {
            state: "uncertain",
            detail: { reason: "transport_callback_threw", error: "connection_lost_after_send" },
          },
        });
      expect(await router.dispatchInitial("notice-threw"))
        .toMatchObject({ kind: "reconcile_only", route: { state: "uncertain" } });
      expect(router.recoverInterruptedRoutes()).toMatchObject([{
        notificationId: "notice-threw",
        route: "imessage",
        state: "uncertain",
      }]);
      expect(router.recoverInterruptedRoutes()).toHaveLength(1);
      expect(calls).toBe(1);
    } finally {
      store.close();
    }
  });
});
