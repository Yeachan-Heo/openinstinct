import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../../src/store/db.ts";
import { NdjsonLogger } from "../../src/log.ts";
import { OwnerOutbox } from "../../src/delivery/outbox.ts";
import { DeliveryService } from "../../src/delivery/service.ts";
import { ChatActivity } from "../../src/assistant-work/activity.ts";
import { AssistantNotificationService } from "../../src/assistant-work/notification-service.ts";

test("queue admission is uncertain until ledger confirms and repeated drain never resends", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-notice-"));
  const store = StateStore.open(join(root, "state.db"));
  const logger = new NdjsonLogger(join(root, "events.ndjson"));
  const outbox = new OwnerOutbox({ logger });
  let sends = 0;
  const delivery = new DeliveryService({ store, port: {
    async sendText() { sends++; return { messageId: "confirmed-message" }; },
    async sendReply() { throw new Error("unexpected reply"); },
    async sendFile() { throw new Error("unexpected file"); },
  } });
  outbox.attach(delivery, "+15555550123");
  const errors: unknown[] = [];
  const service = new AssistantNotificationService({ store, outbox, activity: new ChatActivity(), onError: (error) => errors.push(error) });
  try {
    const notice = service.admit("test", "one", "A unique result");
    await service.drain();
    expect(store.assistantWork.getNotificationRoute(notice.id, "imessage")?.state).toBe("uncertain");
    expect(sends).toBe(0);
    await delivery.flush();
    await service.drain();
    expect(store.assistantWork.getNotificationRoute(notice.id, "imessage")?.state).toBe("delivered");
    await service.drain();
    expect(sends).toBe(1);
    expect(store.listDeliveries()).toHaveLength(1);
    service.rendered(notice.id);
    expect(store.assistantWork.getNotification(notice.id)?.renderedAt).toBeDefined();
    expect(store.assistantWork.getNotification(notice.id)?.ownerAckAt).toBeUndefined();
    expect(store.assistantWork.getNotificationRoute(notice.id, "chat")).toBeUndefined();
    expect(errors).toEqual([]);
  } finally { await service.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("paused notices remain durable without admitting a delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-notice-pause-"));
  const store = StateStore.open(join(root, "state.db"));
  const logger = new NdjsonLogger(join(root, "events.ndjson"));
  const outbox = new OwnerOutbox({ logger });
  let paused = true;
  const activity = new ChatActivity();
  activity.record({ frontmost: true, lastInputAgeSeconds: 0 });
  const service = new AssistantNotificationService({ store, outbox, activity, isPaused: () => paused, onError: () => {} });
  try {
    const notice = service.admit("test", "paused", "Pending result");
    await service.drain();
    expect(service.list().notifications).toContainEqual({ id: notice.id, text: "Pending result", acknowledged: false });
    expect(store.assistantWork.listNotificationRoutes(notice.id)).toHaveLength(0);
    paused = false;
    await service.drain();
    expect(store.assistantWork.getNotificationRoute(notice.id, "chat")?.state).toBe("uncertain");
    service.rendered(notice.id);
    expect(store.assistantWork.getNotification(notice.id)?.ownerAckAt).toBeUndefined();
    service.acknowledge(notice.id);
    expect(store.assistantWork.getNotification(notice.id)?.ownerAckAt).toBeDefined();
  } finally { await service.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
