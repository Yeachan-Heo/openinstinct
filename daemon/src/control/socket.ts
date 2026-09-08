import { Buffer } from "node:buffer";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import type { BootstrapSnapshot } from "../bootstrap/states.ts";
import type { NdjsonLogger } from "../log.ts";
import { MonitorStore } from "../monitors/store.ts";
import { nextCronRun } from "../monitors/scheduler.ts";
import { PROTECTED_MONITOR_IDS, MonitorBusyError, MonitorNotFoundError, MonitorProtectedError, MonitorRevisionConflictError } from "../monitors/types.ts";
import type { MonitorSpec } from "../monitors/types.ts";
import type { StateStore } from "../store/index.ts";
import { SessionCompaction, type CompactRunner, type CompactStatus } from "./compaction.ts";
import { isDaemonPaused, setDaemonPaused } from "./pause.ts";

import { applyHistoryByteBudget } from "../chat/history.ts";
import {
  CONTROL_CAPABILITIES,
  CONTROL_VERSION,
  type AssistantNotificationAckPayload,
  type AssistantNotificationRenderedPayload,
  type ChatActivityPayload,
  type ClientFrame,
  type ControlFrame,
  type ErrorCode,
  type JsonObject,
  decodeClientFrame,
  errorFrame,
  encodeFrame,
  isKnownVerb,
  MAX_CONNECTION_BUFFER_BYTES,
  MAX_FRAME_BYTES,
  type RequestFrame,
  type SessionCompactPayload,
  type SessionCompactStatusPayload,
} from "./schema.ts";

export interface ControlServerOptions {
  readonly path: string;
  readonly getStatus: () => BootstrapSnapshot;
  readonly getStatusContext?: () => ControlStatusContext;
  readonly store: StateStore;
  readonly logger?: NdjsonLogger;
  readonly onMonitorsChanged?: () => void | Promise<void>;
  readonly onPausedChanged?: (paused: boolean) => void | Promise<void>;
  readonly onMaintenanceRun?: () => JsonObject;
  /** Recreates the main session with the current system prompt; returns the live soul version. */
  readonly onSessionReload?: () => Promise<JsonObject>;
  readonly onSessionReset?: () => Promise<JsonObject>;
  /** Operator note delivered to the main session as an internal turn (not an owner text). */
  readonly onSessionNotify?: (text: string) => Promise<JsonObject>;
  /** Fires a monitor on demand, bypassing its schedule. */
  readonly onMonitorRun?: (monitor: MonitorSpec) => Promise<{ readonly dispatched: boolean; readonly reason?: string }>;
  /** Replays owner exchanges from the session transcript into the capture axis. */
  readonly onBackfillCaptures?: () => Promise<JsonObject>;
  /** Receives validated panel activity metadata; the consumer assigns receipt time. */
  readonly onChatActivity?: (activity: ChatActivityPayload) => void | Promise<void>;
  readonly onListAssistantNotifications?: () => JsonObject;
  readonly onAcknowledgeAssistantNotification?: (id: string) => void | Promise<void>;
  readonly onAssistantNotificationRendered?: (id: string) => void | Promise<void>;
  /** Settings surface; each returns the response payload. */
  readonly settings?: {
    readonly get: () => Promise<JsonObject>;
    readonly set: (patch: JsonObject) => Promise<JsonObject>;
    /** `refresh` bypasses the cache and awaits a fresh list. */
    readonly models: (options: { readonly refresh: boolean }) => Promise<JsonObject>;
    readonly accounts: () => Promise<JsonObject>;
    readonly login: (provider: string) => Promise<JsonObject>;
    readonly logout: (provider: string, account: string) => Promise<JsonObject>;
    readonly finishLogin: (code: string) => Promise<JsonObject>;
    readonly providers: () => Promise<JsonObject>;
    readonly customProvider: (input: JsonObject) => Promise<JsonObject>;
    readonly discoverCredentials: () => Promise<JsonObject>;
    readonly adoptCredential: (id: string) => Promise<JsonObject>;
    readonly restart: () => Promise<JsonObject>;
    /** Opens Gajae's dedicated Chrome profile visibly so the owner can sign into sites. */
    readonly openBrowser: () => Promise<JsonObject>;
  };
  readonly chat?: {
    readonly send: (text: string) => Promise<{ readonly turnId: string; readonly outcome: string }>;
    readonly history: (limit: number) => import("./schema.ts").ChatHistoryResponse;
    readonly subscribe: (sink: import("../chat/hub.ts").ChatEventSink) => () => void;
  };
  readonly now?: () => Date;
}

export type ImessageDetachReason =
  | "starting"
  | "core_lane_down"
  | "no_owner_handle"
  | "fda_denied"
  | "fda_probe_error"
  | "attach_failed"
  | "handle_changed"
  | "shutdown";

export interface ControlStatusContext {
  readonly sessionState: "active" | "inactive";
  readonly mainSessionId?: string;
  readonly mainSessionFilePresent: boolean;
  /** The configured model used by the persistent main conversation. */
  readonly mainSessionModel?: string;
  readonly fastModeAvailable?: boolean;
  readonly fastModeEnabled?: boolean;
  readonly allowlistHandle?: string;
  readonly imessage:
    | { readonly state: "attached"; readonly handle: string }
    | {
        readonly state: "detached";
        readonly reason: ImessageDetachReason;
        readonly detail?: string;
        readonly handle?: string;
      };
  readonly credentialsReady: boolean;

}


export class ControlServer {
  private readonly server: Server;
  private readonly compaction: SessionCompaction;
  private readonly monitors: MonitorStore;
  private readonly connections = new Set<Socket>();
  private readonly subscriptions = new Map<Socket, () => void>();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  private constructor(private readonly options: ControlServerOptions) {
    this.compaction = new SessionCompaction(options.store, (status) => this.broadcastCompactTerminal(status));
    this.monitors = new MonitorStore(options.store);
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  public static async start(options: ControlServerOptions): Promise<ControlServer> {
    await prepareSocketPath(options.path);
    const control = new ControlServer(options);
    await listen(control.server, options.path);
    chmodSync(options.path, 0o600);
    options.logger?.write("info", "control", "socket_listening", { path: options.path });
    return control;
  }

  /** Installs the compactor once the main session is live (and clears it on stop). */
  public setCompactRunner(runner: CompactRunner | undefined): void {
    this.compaction.setRunner(runner);
  }

  /** Resolves once any in-flight compaction has settled. */
  public async drainCompaction(): Promise<void> {
    await this.compaction.drain();
  }

  /** Fans the advertised session.compact.terminal event out to connected clients. */
  private broadcastCompactTerminal(status: CompactStatus): void {
    const frame = {
      type: "event" as const,
      topic: "session.compact.terminal",
      payload: {
        operationId: status.operationId,
        state: status.state,
        ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
      },
    };
    for (const socket of this.connections) {
      this.send(socket, frame);
    }
  }

  public async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.closing = true;
    this.closePromise = (async () => {
      for (const socket of this.connections) {
        this.removeSubscription(socket);
        socket.end();
        const destroyTimer = setTimeout(() => socket.destroy(), 1_000);
        destroyTimer.unref?.();
      }

      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => (error ? reject(error) : resolve()));
      });
      if (existsSync(this.options.path)) {
        unlinkSync(this.options.path);
      }
    })();
    return this.closePromise;
  }

  private handleConnection(socket: Socket): void {
    this.connections.add(socket);
    socket.on("close", () => {
      this.connections.delete(socket);
      this.removeSubscription(socket);
    });
    socket.on("error", (error) => {
      this.options.logger?.write("warn", "control", "socket_error", { message: error.message });
    });

    if (this.closing) {
      socket.end();
      const destroyTimer = setTimeout(() => socket.destroy(), 1_000);
      destroyTimer.unref?.();
      return;
    }

    let buffer = Buffer.alloc(0);
    let negotiated = false;
    const requestIds = new Set<string>();
    let closing = false;

    const fail = (code: ErrorCode, message: string, id?: string): void => {
      if (closing) {
        return;
      }
      closing = true;
      this.send(socket, errorFrame(code, message, id));
      socket.end();
    };

    socket.on("data", (chunk: Buffer) => {
      if (closing) {
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_CONNECTION_BUFFER_BYTES) {
        fail("buffer_too_large", "connection buffer exceeds 1 MiB");
        return;
      }

      while (!closing) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) {
          if (buffer.byteLength > MAX_FRAME_BYTES) {
            fail("frame_too_large", "frame exceeds 256 KiB");
          }
          return;
        }

        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.byteLength > MAX_FRAME_BYTES) {
          fail("frame_too_large", "frame exceeds 256 KiB");
          return;
        }

        const text = line.toString("utf8").replace(/\r$/, "");
        let frame: ClientFrame;
        try {
          const parsed: unknown = JSON.parse(text);
          if (isWrongHelloVersion(parsed)) {
            fail("incompatible_version", `control protocol version must be ${CONTROL_VERSION}`);
            return;
          }
          frame = decodeClientFrame(parsed);
        } catch (error) {
          const code: ErrorCode = error instanceof SyntaxError ? "malformed_json" : "invalid_frame";
          fail(code, error instanceof Error ? error.message : "invalid control frame");
          return;
        }

        if (frame.type === "hello") {
          if (negotiated) {
            fail("invalid_frame", "hello may only be sent once");
            return;
          }
          negotiated = true;
          this.send(socket, {
            type: "negotiated",
            v: CONTROL_VERSION,
            capabilities: CONTROL_CAPABILITIES,
          });
          continue;
        }

        if (!negotiated) {
          fail("hello_required", "send hello before requests", frame.id);
          return;
        }
        if (requestIds.has(frame.id)) {
          this.send(socket, errorFrame("duplicate_request_id", "request id has already been used", frame.id));
          continue;
        }
        requestIds.add(frame.id);
        this.handleRequest(socket, frame);
      }
    });

  }

  private handleRequest(socket: Socket, request: RequestFrame): void {
    if (!isKnownVerb(request.verb)) {
      this.send(socket, errorFrame("verb_unknown", `unknown verb: ${request.verb}`, request.id));
      return;
    }

    switch (request.verb) {
      case "status.get":
        this.send(socket, {
          type: "response",
          id: request.id,
          ok: true,
          payload: statusPayload(
            this.options.getStatus(),
            this.options.store,
            this.options.getStatusContext?.(),
            (this.options.now ?? (() => new Date()))(),
          ),
        });
        return;
      case "chat.activity": {
        const onChatActivity = this.options.onChatActivity;
        if (onChatActivity === undefined) {
          this.send(socket, errorFrame("internal_error", "chat activity reporting is unavailable", request.id));
          return;
        }
        const payload = request.payload as ChatActivityPayload;
        const activity: ChatActivityPayload = {
          frontmost: payload.frontmost,
          lastInputAgeSeconds: payload.lastInputAgeSeconds,
        };
        void Promise.resolve()
          .then(() => onChatActivity(activity))
          .then(
            () => this.send(socket, {
              type: "response",
              id: request.id,
              ok: true,
              payload: { recorded: true },
            }),
            (error) => this.send(socket, errorFrame(
              "internal_error",
              error instanceof Error ? error.message : "chat activity reporting failed",
              request.id,
            )),
          );
        return;
      }
      case "assistant.notifications.list": {
        const onListAssistantNotifications = this.options.onListAssistantNotifications;
        if (onListAssistantNotifications === undefined) {
          this.send(socket, errorFrame("internal_error", "assistant notifications are unavailable", request.id));
          return;
        }
        try {
          this.send(socket, {
            type: "response",
            id: request.id,
            ok: true,
            payload: onListAssistantNotifications(),
          });
        } catch (error) {
          this.send(socket, errorFrame(
            "internal_error",
            error instanceof Error ? error.message : "assistant notification listing failed",
            request.id,
          ));
        }
        return;
      }
      case "assistant.notifications.ack": {
        const onAcknowledgeAssistantNotification = this.options.onAcknowledgeAssistantNotification;
        if (onAcknowledgeAssistantNotification === undefined) {
          this.send(socket, errorFrame("internal_error", "assistant notification acknowledgement is unavailable", request.id));
          return;
        }
        const payload = request.payload as AssistantNotificationAckPayload;
        void Promise.resolve()
          .then(() => onAcknowledgeAssistantNotification(payload.notificationId))
          .then(
            () => this.send(socket, {
              type: "response",
              id: request.id,
              ok: true,
              payload: { acknowledged: true },
            }),
            (error) => this.send(socket, errorFrame(
              "internal_error",
              error instanceof Error ? error.message : "assistant notification acknowledgement failed",
              request.id,
            )),
          );
        return;
      }
      case "assistant.notifications.rendered": {
        const onAssistantNotificationRendered = this.options.onAssistantNotificationRendered;
        if (onAssistantNotificationRendered === undefined) {
          this.send(socket, errorFrame("internal_error", "assistant notification rendering is unavailable", request.id));
          return;
        }
        const payload = request.payload as AssistantNotificationRenderedPayload;
        void Promise.resolve()
          .then(() => onAssistantNotificationRendered(payload.notificationId))
          .then(
            () => this.send(socket, {
              type: "response",
              id: request.id,
              ok: true,
              payload: { rendered: true },
            }),
            (error) => this.send(socket, errorFrame(
              "internal_error",
              error instanceof Error ? error.message : "assistant notification rendering failed",
              request.id,
            )),
          );
        return;
      }
      case "chat.send": {
        const chat = this.options.chat;
        if (chat === undefined) {
          this.send(socket, errorFrame("internal_error", "chat is unavailable", request.id));
          return;
        }
        const payload = request.payload as { readonly text: string };
        void Promise.resolve()
          .then(() => chat.send(payload.text))
          .then(
            (result) => {
              if (result.outcome === "no_active_lane") {
                this.send(socket, errorFrame("internal_error", "main session is not running", request.id));
                return;
              }
              this.send(socket, {
                type: "response",
                id: request.id,
                ok: true,
                payload: { turnId: result.turnId, outcome: result.outcome },
              });
            },
            (error) => this.send(socket, errorFrame(
              "internal_error",
              error instanceof Error ? error.message : "chat send failed",
              request.id,
            )),
          );
        return;
      }
      case "chat.history": {
        const chat = this.options.chat;
        if (chat === undefined) {
          this.send(socket, errorFrame("internal_error", "chat is unavailable", request.id));
          return;
        }
        const payload = request.payload as { readonly limit: number };
        try {
          const history = applyHistoryByteBudget(chat.history(payload.limit), MAX_FRAME_BYTES - 4_096);
          this.send(socket, {
            type: "response",
            id: request.id,
            ok: true,
            payload: { ...history } as unknown as JsonObject,
          });
        } catch (error) {
          this.send(socket, errorFrame(
            "internal_error",
            error instanceof Error ? error.message : "chat history failed",
            request.id,
          ));
        }
        return;
      }
      case "chat.subscribe": {
        const chat = this.options.chat;
        if (chat === undefined) {
          this.send(socket, errorFrame("internal_error", "chat is unavailable", request.id));
          return;
        }
        if (this.subscriptions.has(socket)) {
          this.send(socket, errorFrame("invalid_frame", "chat subscription already active", request.id));
          return;
        }

        let active = false;
        let cleaned = false;
        let unsubscribe: (() => void) | undefined;
        try {
          unsubscribe = chat.subscribe((topic, payload) => {
            if (!active || this.closing || socket.destroyed) {
              return;
            }
            this.send(socket, { type: "event", topic, payload });
          });
        } catch (error) {
          this.send(socket, errorFrame(
            "internal_error",
            error instanceof Error ? error.message : "chat subscription failed",
            request.id,
          ));
          return;
        }

        const cleanup = (): void => {
          if (cleaned) {
            return;
          }
          cleaned = true;
          unsubscribe?.();
        };
        this.subscriptions.set(socket, cleanup);
        this.send(socket, {
          type: "response",
          id: request.id,
          ok: true,
          payload: { subscribed: true },
        });
        if (this.closing || socket.destroyed) {
          this.removeSubscription(socket);
          return;
        }
        active = true;
        return;
      }

      case "monitors.list":
        this.send(socket, {
          type: "response",
          id: request.id,
          ok: true,
          payload: { monitors: this.monitors.list().map(monitorPayload) },
        });
        return;
      case "memory.backfillCaptures": {
        if (!this.options.onBackfillCaptures) {
          this.send(socket, errorFrame("internal_error", "capture backfill is unavailable", request.id));
          return;
        }
        this.options.onBackfillCaptures().then(
          (payload) => this.send(socket, { type: "response", id: request.id, ok: true, payload }),
          (error) => this.send(socket, errorFrame("internal_error", error instanceof Error ? error.message : "backfill failed", request.id)),
        );
        return;
      }
      case "monitors.run": {
        const payload = request.payload as { readonly id: string };
        if (!this.options.onMonitorRun) {
          this.send(socket, errorFrame("internal_error", "monitor runs are unavailable", request.id));
          return;
        }
        const monitor = this.monitors.get(payload.id);
        if (!monitor) {
          this.send(socket, errorFrame("monitor_not_found", `monitor ${payload.id} does not exist`, request.id));
          return;
        }
        this.options.onMonitorRun(monitor).then(
          (outcome) => this.send(socket, {
            type: "response",
            id: request.id,
            ok: true,
            payload: { dispatched: outcome.dispatched, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) },
          }),
          (error) => this.send(socket, errorFrame("internal_error", error instanceof Error ? error.message : "run failed", request.id)),
        );
        return;
      }
      case "monitors.toggle": {
        const payload = request.payload as { readonly id: string; readonly enabled: boolean; readonly expectedRevision: number };
        try {
          const monitor = this.monitors.toggle(payload.id, payload.enabled, payload.expectedRevision);
          this.send(socket, {
            type: "response",
            id: request.id,
            ok: true,
            payload: { monitor: monitorPayload(monitor) },
          });
          void Promise.resolve(this.options.onMonitorsChanged?.()).catch((changeError) => {
            this.options.logger?.write("warn", "control", "monitor_runtime_refresh_failed", {
              message: changeError instanceof Error ? changeError.message : String(changeError),
            });
          });
        } catch (error) {
          if (error instanceof MonitorNotFoundError) {
            this.send(socket, errorFrame("monitor_not_found", error.message, request.id));
            return;
          }
          if (error instanceof MonitorRevisionConflictError) {
            this.send(socket, errorFrame("revision_conflict", error.message, request.id));
            return;
          }
          if (error instanceof MonitorProtectedError) {
            this.send(socket, errorFrame("monitor_protected", error.message, request.id));
            return;
          }
          this.send(socket, errorFrame("internal_error", error instanceof Error ? error.message : "monitor toggle failed", request.id));
        }
        return;
      }
      case "monitors.delete": {
        const payload = request.payload as { readonly id: string; readonly expectedRevision: number };
        try {
          this.monitors.delete(payload.id, payload.expectedRevision);
          this.send(socket, { type: "response", id: request.id, ok: true, payload: { id: payload.id, deleted: true } });
          void Promise.resolve(this.options.onMonitorsChanged?.()).catch((changeError) => {
            this.options.logger?.write("warn", "control", "monitor_runtime_refresh_failed", {
              message: changeError instanceof Error ? changeError.message : String(changeError),
            });
          });
        } catch (error) {
          if (error instanceof MonitorNotFoundError) {
            this.send(socket, errorFrame("monitor_not_found", error.message, request.id));
            return;
          }
          if (error instanceof MonitorRevisionConflictError) {
            this.send(socket, errorFrame("revision_conflict", error.message, request.id));
            return;
          }
          if (error instanceof MonitorBusyError) {
            this.send(socket, errorFrame("monitor_busy", error.message, request.id));
            return;
          }
          if (error instanceof MonitorProtectedError) {
            this.send(socket, errorFrame("monitor_protected", error.message, request.id));
            return;
          }
          this.send(socket, errorFrame("internal_error", error instanceof Error ? error.message : "monitor delete failed", request.id));
        }
        return;
      }
      case "settings.get":
      case "settings.set":
      case "models.list":
      case "accounts.list":
      case "accounts.login":
      case "accounts.logout":
      case "accounts.login.finish":
      case "accounts.providers":
      case "accounts.discover":
      case "accounts.adopt":
      case "providers.custom":
      case "daemon.restart":
      case "browser.open": {
        const settings = this.options.settings;
        if (!settings) {
          this.send(socket, errorFrame("internal_error", "settings are unavailable", request.id));
          return;
        }
        const p = request.payload as Record<string, unknown>;
        const run = (): Promise<JsonObject> => {
          switch (request.verb) {
            case "settings.get": return settings.get();
            case "settings.set": return settings.set(p.patch as JsonObject);
            case "models.list": return settings.models({ refresh: p.refresh === true });
            case "accounts.list": return settings.accounts();
            case "accounts.login": return settings.login(String(p.provider));
            case "accounts.logout": return settings.logout(String(p.provider), String(p.account));
            case "browser.open": return settings.openBrowser();
            case "accounts.login.finish": return settings.finishLogin(String(p.code));
            case "accounts.providers": return settings.providers();
            case "accounts.discover": return settings.discoverCredentials();
            case "accounts.adopt": return settings.adoptCredential(String(p.id));
            case "providers.custom": return settings.customProvider(p as JsonObject);
            default: return settings.restart();
          }
        };
        // A synchronous throw inside run() (a missing adapter method, a bad
        // cast) would otherwise escape the data handler and leave the caller
        // waiting forever with no frame at all.
        let pending: Promise<JsonObject>;
        this.options.logger?.write("info", "control", "request_started", { verb: request.verb, id: request.id });
        try {
          pending = run();
        } catch (error) {
          this.options.logger?.write("warn", "control", "request_threw", { verb: request.verb, message: error instanceof Error ? error.message : String(error) });
          this.send(socket, errorFrame("internal_error", error instanceof Error ? error.message : "settings failed", request.id));
          return;
        }
        pending.then(
          (payload) => {
            this.options.logger?.write("info", "control", "request_resolved", { verb: request.verb, id: request.id });
            this.send(socket, { type: "response", id: request.id, ok: true, payload });
          },
          (error) => {
            const message = error instanceof Error ? error.message : "settings failed";
            const code = request.verb === "accounts.adopt"
              && (message.startsWith("no such credential:") || message.startsWith("credential cannot be used:"))
              ? "invalid_frame"
              : "internal_error";
            this.options.logger?.write("warn", "control", "request_rejected", { verb: request.verb, message });
            this.send(socket, errorFrame(code, message, request.id));
          },
        );
        return;
      }
      case "session.notify": {
        if (!this.options.onSessionNotify) {
          this.send(socket, errorFrame("internal_error", "no active session", request.id));
          return;
        }
        this.options.onSessionNotify(String((request.payload as { text: string }).text)).then(
          (payload) => this.send(socket, { type: "response", id: request.id, ok: true, payload }),
          (error) => this.send(socket, errorFrame("internal_error", error instanceof Error ? error.message : "notify failed", request.id)),
        );
        return;
      }
      case "session.reset": {
        if (!this.options.onSessionReset) {
          this.send(socket, errorFrame("internal_error", "no active session to reset", request.id));
          return;
        }
        this.options.onSessionReset().then(
          (payload) => this.send(socket, { type: "response", id: request.id, ok: true, payload }),
          (error) => this.send(socket, errorFrame("internal_error", error instanceof Error ? error.message : "reset failed", request.id)),
        );
        return;
      }
      case "session.reload": {
        if (!this.options.onSessionReload) {
          this.send(socket, errorFrame("internal_error", "no active session to reload", request.id));
          return;
        }
        this.options.onSessionReload().then(
          (payload) => this.send(socket, { type: "response", id: request.id, ok: true, payload }),
          (error) => this.send(socket, errorFrame("internal_error", error instanceof Error ? error.message : "reload failed", request.id)),
        );
        return;
      }
      case "daemon.pause":
      case "daemon.resume": {
        const paused = request.verb === "daemon.pause";
        setDaemonPaused(this.options.store, paused);
        this.send(socket, {
          type: "response",
          id: request.id,
          ok: true,
          payload: { paused },
        });
        void Promise.resolve()
          .then(() => this.options.onPausedChanged?.(paused))
          .catch((error) => {
            this.options.logger?.write("warn", "control", "pause_runtime_update_failed", {
              paused,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }
      case "maintenance.run": {
        if (!this.options.onMaintenanceRun) {
          this.send(socket, errorFrame("internal_error", "maintenance is unavailable", request.id));
          return;
        }
        try {
          this.send(socket, {
            type: "response",
            id: request.id,
            ok: true,
            payload: this.options.onMaintenanceRun(),
          });
        } catch (error) {
          this.send(socket, errorFrame("internal_error", error instanceof Error ? error.message : "maintenance failed", request.id));
        }
        return;
      }

      case "session.compact": {
        const payload = request.payload as SessionCompactPayload;
        const acceptance = this.compaction.accept(payload.requestKey);
        this.send(socket, {
          type: "response",
          id: request.id,
          ok: true,
          payload: {
            operationId: acceptance.operationId,
            state: acceptance.state,
          },
        });
        return;
      }
      case "session.compact.status": {
        const payload = request.payload as SessionCompactStatusPayload;
        const status = this.compaction.status(payload.operationId);
        if (!status) {
          this.send(socket, errorFrame("invalid_frame", "unknown session.compact operation", request.id));
          return;
        }
        this.send(socket, {
          type: "response",
          id: request.id,
          ok: true,
          payload: {
            operationId: status.operationId,
            state: status.state,
            ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
          },
        });
        return;
      }
    }
  }

  private send(socket: Socket, frame: ControlFrame): void {
    if (socket.destroyed || socket.writableEnded) {
      return;
    }

    const encoded = encodeFrame(frame);
    if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) {
      if (frame.type === "event") {
        this.options.logger?.write("warn", "control", "event_frame_oversized", {
          topic: frame.topic,
          seq: frame.payload.seq,
        });
        return;
      }
      if (frame.type === "response") {
        const fallback = encodeFrame(errorFrame("internal_error", "response frame exceeds 256 KiB", frame.id));
        socket.write(`${fallback}\n`);
      }
      return;
    }

    if (frame.type === "event") {
      if (socket.writableLength > MAX_CONNECTION_BUFFER_BYTES) {
        this.options.logger?.write("warn", "control", "subscriber_backpressure_closed", {
          topic: frame.topic,
          seq: frame.payload.seq,
        });
        this.removeSubscription(socket);
        socket.destroy();
        return;
      }
      socket.write(`${encoded}\n`);
      if (socket.writableLength > MAX_CONNECTION_BUFFER_BYTES) {
        this.options.logger?.write("warn", "control", "subscriber_backpressure_closed", {
          topic: frame.topic,
          seq: frame.payload.seq,
        });
        this.removeSubscription(socket);
        socket.destroy();
      }
      return;
    }

    socket.write(`${encoded}\n`);
  }

  private removeSubscription(socket: Socket): void {
    const unsubscribe = this.subscriptions.get(socket);
    if (unsubscribe === undefined) {
      return;
    }
    this.subscriptions.delete(socket);
    try {
      unsubscribe();
    } catch {
      // A subscriber cleanup failure must not block socket shutdown.
    }
  }
}

export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  return ControlServer.start(options);
}

async function prepareSocketPath(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    return;
  }
  if (!lstatSync(path).isSocket()) {
    throw new Error(`control socket path exists and is not a socket: ${path}`);
  }

  const probe = await probeSocket(path);
  if (probe === "live") {
    throw new Error(`control socket is already live: ${path}`);
  }
  if (probe === "inaccessible") {
    throw new Error(`control socket cannot be probed safely: ${path}`);
  }
  unlinkSync(path);
}

function probeSocket(path: string): Promise<"live" | "stale" | "inaccessible"> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    let settled = false;
    const finish = (result: "live" | "stale" | "inaccessible"): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.once("connect", () => finish("live"));
    socket.once("timeout", () => finish("inaccessible"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : "inaccessible");
    });
    socket.setTimeout(250);
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function isWrongHelloVersion(value: unknown): boolean {
  return value !== null
    && !Array.isArray(value)
    && typeof value === "object"
    && (value as Record<string, unknown>).type === "hello"
    && (value as Record<string, unknown>).v !== CONTROL_VERSION;
}

function statusPayload(
  snapshot: BootstrapSnapshot,
  store: StateStore,
  context: ControlStatusContext | undefined,
  now: Date,
): JsonObject {
  const probes: Record<string, JsonObject[string]> = {
    config: probePayload(snapshot.probes.config),
  };
  if (snapshot.probes.messages) {
    probes.messages = probePayload(snapshot.probes.messages);
  }
  if (snapshot.probes.credentials) {
    probes.credentials = probePayload(snapshot.probes.credentials);
  }

  if (snapshot.probes.fda) {
    probes.fda = probePayload(snapshot.probes.fda);
  }
  if (snapshot.probes.accessibility) {
    probes.accessibility = probePayload(snapshot.probes.accessibility);
  }

  // Only the session/settings fields are read here; the iMessage lane is
  // resolved separately so a missing context still yields a full payload.
  const session: Pick<ControlStatusContext, "sessionState" | "mainSessionFilePresent" | "mainSessionId" | "mainSessionModel" | "fastModeAvailable" | "fastModeEnabled" | "allowlistHandle"> = context ?? {
    sessionState: "inactive",
    mainSessionFilePresent: false,
  };

  const imessage = imessagePayload(snapshot, context?.imessage);
  return {
    bootstrap: {
      state: snapshot.state,
      remediation: remediationText(snapshot),
      probes,
    },
    session: {
      state: session.sessionState,
      ...(session.mainSessionId === undefined ? {} : { mainSessionId: session.mainSessionId }),
      mainSessionFilePresent: session.mainSessionFilePresent,
      ...(session.mainSessionModel === undefined ? {} : { mainSessionModel: session.mainSessionModel }),
      ...(session.fastModeAvailable === undefined ? {} : { fastModeAvailable: session.fastModeAvailable }),
      ...(session.fastModeEnabled === undefined ? {} : { fastModeEnabled: session.fastModeEnabled }),
      paused: isDaemonPaused(store),
      hasReplied: store.hasConfirmedDelivery(),
    },
    activeChildren: store.listChildren().filter(isActiveChild).map(childSummaryPayload),
    recentChildren: recentChildren(store.listChildren()).map(childSummaryPayload),
    attention: attentionPayload(store, snapshot, context),

    monitors: new MonitorStore(store).list().map((monitor) => monitorSummaryPayload(monitor, now)),
    settings: {
      ...(session.allowlistHandle === undefined ? {} : { allowlistHandle: session.allowlistHandle }),
    },
    imessage,
  };
}

function imessagePayload(
  snapshot: BootstrapSnapshot,
  lane: ControlStatusContext["imessage"] | undefined,
): JsonObject {
  const current = lane ?? fallbackImessage(snapshot);
  if (current.state === "attached") {
    return { state: "attached", handle: current.handle };
  }

  const detail = imessageDetail(snapshot, current);
  return {
    state: "detached",
    reason: current.reason,
    ...(detail === undefined ? {} : { detail }),
    ...(current.handle === undefined ? {} : { handle: current.handle }),
  };
}

function fallbackImessage(snapshot: BootstrapSnapshot): ControlStatusContext["imessage"] {
  if (snapshot.state === "starting") {
    return { state: "detached", reason: "starting" };
  }
  return {
    state: "detached",
    reason: "core_lane_down",
    ...(snapshot.imessageHandle === undefined ? {} : { handle: snapshot.imessageHandle }),
  };
}

function imessageDetail(
  snapshot: BootstrapSnapshot,
  lane: Extract<ControlStatusContext["imessage"], { readonly state: "detached" }>,
): string | undefined {
  switch (lane.reason) {
    case "no_owner_handle":
      return "Add your phone number under Settings → iMessage to text Gajae.";
    case "fda_denied":
    case "fda_probe_error":
      return snapshot.probes.fda?.reason ?? lane.detail;
    case "attach_failed":
      return lane.detail;
    case "core_lane_down":
      return "Gajae's session is not running yet.";
    case "starting":
      return "Connecting to Messages…";
    case "handle_changed":
      return "Switching iMessage number…";
    case "shutdown":
      return lane.detail;
  }
}

/**
 * Owner-facing "you need to do something" signal for the panel. Only things
 * that need a human hand: a missing TCC grant, or image sends that keep
 * degrading to captions (= attachment paste is broken).
 */
/** Set by main.ts when the last owner turn failed for auth reasons (401/no credential). */
export let noCredentialHint: string | null = null;
export function setNoCredentialHint(hint: string | null): void {
  noCredentialHint = hint;
}

function attentionPayload(
  store: StateStore,
  snapshot: BootstrapSnapshot,
  context: ControlStatusContext | undefined,
): JsonObject | null {
  const imessageAttached = context?.imessage.state === "attached";
  const accessibility = snapshot.probes.accessibility;
  if (imessageAttached && accessibility && accessibility.status !== "passed") {
    return {
      id: "accessibility",
      title: "Gajae can't send messages yet",
      detail: "macOS needs your OK for Gajae to control Messages. In System Settings → Privacy & Security → Automation, turn on Messages under openinstinctd.",
      action: "open_automation",
    };
  }
  if (snapshot.state === "running" && noCredentialHint !== null) {
    return { id: "no_model", title: "Gajae has no AI account yet", detail: noCredentialHint, action: "open_settings" };
  }
  if (imessageAttached) {
    const recent = store.listDeliveries().filter((d) => d.kind === "file").slice(-3);
    if (recent.length >= 2 && recent.every((d) => d.degraded)) {
      return {
        id: "image_paste",
        title: "Pictures are arriving as text",
        detail: "The last few images could not be sent, so you only got their captions. Check that Messages is signed in and that openinstinctd is allowed to control Messages under Automation.",
        action: "open_automation",
      };
    }
  }
  return null;
}

function remediationText(snapshot: BootstrapSnapshot): string {
  switch (snapshot.state) {
    case "credentials_blocked":
      return "Sign in to an AI account or paste an API key in Settings → AI account.";
    case "config_blocked":
      return "Configure ~/.openinstinct/config.json with a valid allowlist handle.";
    case "permission_blocked":
      return "Grant Full Disk Access to openinstinctd, and allow it to control Messages under Automation.";
    case "identity_blocked":
      return "Sign Messages on this Mac into Gajae's own Apple ID.";
    case "degraded":
      return `Gajae's session failed to start: ${snapshot.reason ?? "unknown error"}. Inspect ~/.openinstinct/logs.`;
    case "starting":
      return snapshot.reason ?? "Daemon startup checks are in progress.";
    case "running":
      if (snapshot.probes.config.status === "invalid") {
        return `Gajae is running with default settings; ~/.openinstinct/config.json is invalid: ${snapshot.probes.config.reason ?? "unknown reason"}.`;
      }
      return snapshot.reason ?? "Daemon is ready.";
  }
}

type RecentChild = { readonly state: string; readonly updatedAt: string; readonly lastActivityAt?: string };

/**
 * Asleep (cold) children are done-but-revivable, so every one of them stays
 * visible; finished children fill the remaining slots, newest first.
 */
function recentChildren<T extends RecentChild>(children: readonly T[]): T[] {
  const byActivity = (a: T, b: T): number => (b.lastActivityAt ?? b.updatedAt).localeCompare(a.lastActivityAt ?? a.updatedAt);
  const asleep = children.filter((child) => child.state === "cold").sort(byActivity);
  const finished = children.filter((child) => !isActiveChild(child) && child.state !== "cold").sort(byActivity);
  return [...asleep, ...finished.slice(0, Math.max(0, 10 - asleep.length))];
}

/** Cold children are resumable transcripts, not work in progress; they belong in "Recent tasks". */
function isActiveChild(child: { readonly state: string }): boolean {
  return child.state === "requested" || child.state === "admitted" || child.state === "running"
    || child.state === "idle";
}

function childSummaryPayload(child: {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly origin: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly lastActivityAt?: string;
  readonly tokens?: number;
  readonly toolCalls?: number;
}): JsonObject {
  return {
    id: child.id,
    title: child.title,
    kind: child.kind,
    origin: child.origin,
    state: child.state,
    createdAt: child.createdAt,
    updatedAt: child.updatedAt,
    ...(child.startedAt === undefined ? {} : { startedAt: child.startedAt }),
    ...(child.lastActivityAt === undefined ? {} : { lastActivityAt: child.lastActivityAt }),
    ...(child.tokens === undefined ? {} : { tokens: child.tokens }),
    toolCalls: child.toolCalls ?? 0,
  };
}

function monitorSummaryPayload(monitor: MonitorSpec, now: Date): JsonObject {
  const nextFire = monitor.trigger.kind === "cron"
    ? nextCronRun(monitor.trigger.expression, monitor.tz, now)?.toISOString() ?? null
    : null;
  return {
    id: monitor.id,
    name: monitor.name,
    enabled: monitor.enabled,
    revision: monitor.revision,
    nextFire,
  };
}

function probePayload(probe: { readonly status: string; readonly reason?: string; readonly aliases?: readonly string[] }): JsonObject {
  return {
    status: probe.status,
    ...(probe.reason === undefined ? {} : { reason: probe.reason }),
    ...(probe.aliases === undefined ? {} : { aliases: [...probe.aliases] }),
  };
}

function monitorPayload(monitor: MonitorSpec): JsonObject {
  return {
    protected: PROTECTED_MONITOR_IDS.has(monitor.id),
    ...(monitor.expiresAt === undefined ? {} : { expiresAt: monitor.expiresAt }),
    id: monitor.id,
    name: monitor.name,
    trigger: triggerPayload(monitor),
    instruction: monitor.instruction,
    eventTypes: [...monitor.eventTypes],
    burstPolicy: monitor.burstPolicy,
    tz: monitor.tz,
    timeoutSec: monitor.timeoutSec,
    enabled: monitor.enabled,
    revision: monitor.revision,
    createdAt: monitor.createdAt,
    updatedAt: monitor.updatedAt,
    ...(monitor.lastFiredAt === undefined ? {} : { lastFiredAt: monitor.lastFiredAt }),
  };
}

function triggerPayload(monitor: MonitorSpec): JsonObject {
  switch (monitor.trigger.kind) {
    case "cron":
      return { kind: "cron", expression: monitor.trigger.expression };
    case "webhook":
      return { kind: "webhook", token: monitor.trigger.token };
    case "watcher":
      return { kind: "watcher", roots: [...monitor.trigger.roots] };
    case "script":
      return { kind: "script", argv: [...monitor.trigger.argv], intervalMs: monitor.trigger.intervalMs };
  }
}
