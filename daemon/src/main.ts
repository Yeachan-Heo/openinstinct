// Must be the first import: the SDK injects its own auto-imported provider
// credentials into process.env at module evaluation, and the owner's
// ~/.openinstinct/env has to win over them.
import { ENV_FILE } from "./env-bootstrap.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createSystemProbes, openChatDbReadonly } from "./bootstrap/probes.ts";

import { BootstrapMachine, type BootstrapProbes, type BootstrapSnapshot } from "./bootstrap/states.ts";
import { RetentionMaintenance } from "./maintenance/retention.ts";
import { createDrillProbes, DrillChildRunner, DrillConversationRunner, DrillDeliveryPort, DrillMainSessionFactory } from "./drills/runtime.ts";
import { readDrillSettings } from "./drills/hooks.ts";
import { readCoreConfig, type CoreConfig } from "./core-config.ts";

import { ChildLifecycle } from "./children/lifecycle.ts";
import { ChildRegistry } from "./children/registry.ts";
import { ReceiptInbox } from "./children/receipts.ts";
import { InterimInbox } from "./children/interim.ts";
import {
  SdkInProcessRunner,
  type ChildSessionFactory,
} from "./children/runners/sdk-inprocess.ts";
import { SdkConversationRunner } from "./children/runners/sdk-conversation.ts";
import type { ChildRunner } from "./children/runner.ts";
import type { ConversationalChildRunner } from "./children/conversation.ts";
import { TerminalJournal } from "./children/terminal-journal.ts";
import { StateStoreChildStatusReader } from "./children/status.ts";
import { memoryAudit } from "./memory/adapters/audit.ts";
import { backfillCapturesFromTranscript } from "./memory/adapters/session-backfill.ts";
import { MEMORY_CANONICALIZATION_CHILD_TITLE, MemoryCanonicalizer } from "./memory/adapters/canonicalize.ts";
import { MemoryClosureQueue } from "./memory/adapters/intents.ts";
import {
  MEMORY_AUDIT_MONITOR_ID,
  MEMORY_CANONICALIZE_MONITOR_ID,
  seedMemoryMaintenanceMonitors,
} from "./memory/maintenance.ts";
import {
  createMemoryAuditTool,
  createMemoryCaptureTool,
  createMemorySearchTool,
} from "./memory/tools.ts";
import { createMonitorAuthorTool } from "./monitors/author-tool.ts";
import { MonitorPropagation } from "./monitors/propagation.ts";
import { MonitorScheduler } from "./monitors/scheduler.ts";
import { MonitorStore } from "./monitors/store.ts";
import { manualTriggerEvent } from "./monitors/types.ts";
import type { MonitorSpec, MonitorTriggerEvent } from "./monitors/types.ts";
import { MonitorTriggerRuntime } from "./monitors/triggers.ts";

import {
  setNoCredentialHint,
  startControlServer,
  type ControlServer,
  type ControlStatusContext,
  type ImessageDetachReason,
} from "./control/socket.ts";

import type { JsonObject } from "./control/schema.ts";
import { OPERATOR_NOTE_PREFIX } from "./chat/history.ts";
import { PANEL_SOURCE_MARKER, ChatHub } from "./chat/hub.ts";
import { OwnerTurnIngress, type OwnerTurnRequest } from "./owner-turn.ts";
import { OwnerOutbox } from "./delivery/outbox.ts";
import { toPlainText } from "./delivery/plaintext.ts";

import {
  drainSuppressedWhilePaused,
  isDaemonPaused,
  recordSuppressedWhilePaused,
  suppressedNotice,
} from "./control/pause.ts";

import { DeliveryService } from "./delivery/service.ts";
import type { DeliveryPort } from "./delivery/port.ts";
import { isAllowedHandle } from "./imessage/allowlist.ts";
import { ChatDbReader, type InboundMessageReader, type InboundAttachment, type InboundMessage } from "./imessage/reader.ts";
import { ImessageSender } from "./imessage/sender.ts";
import { ImessageWatcher } from "./imessage/watcher.ts";
import { NdjsonLogger } from "./log.ts";
import { openVisibleChrome } from "./browser/open-visible.ts";
import { openVisibleChrome } from "./browser/open-visible.ts";
import { seedComputerUsageInsight } from "./insights/computer-usage.ts";
import { seedHeartbeat } from "./insights/heartbeat.ts";
import { buildOrientation } from "./persona/orientation.ts";
import { loadSoul, SOUL_PATH } from "./persona/soul.ts";
import {
  MANAGED_CREDENTIAL_ENV_KEYS,
  OI_API_KEY_PATTERN,
  SettingsService,
} from "./settings/service.ts";

import { dataPaths, type DataPaths } from "./paths.ts";
import {
  createChildNudgeTool,
  createChildStatusTool,
  MainSession,
  openMainSession,
  SdkMainSessionFactory,
  type ActiveTurn,
  type MainSessionFactory,
  type PromptImage,
  type SendImageOutcome,
} from "./sdk-session/main-session.ts";

import { openStateStore, type StateStore } from "./store/index.ts";

const DAEMON_ALLOWLIST_HANDLE_META = "daemon.allowlist_handle";
const DAEMON_MAIN_SESSION_MODEL_META = "daemon.main_session_model";
const DAEMON_FAST_MODE_AVAILABLE_META = "daemon.fast_mode_available";
const DAEMON_FAST_MODE_ENABLED_META = "daemon.fast_mode_enabled";
const DAEMON_SESSION_ACTIVE_META = "daemon.session.active";
export const EVENT_LOOP_P99_META = "runtime.event_loop_p99_ms";
export const EVENT_LOOP_P50_META = "runtime.event_loop_p50_ms";

interface CoreLane {
  readonly config: CoreConfig;
  readonly session: MainSession;
  readonly lifecycle: ChildLifecycle;
  readonly interim: InterimInbox;
  readonly childSweepTimer: ReturnType<typeof setInterval>;
  readonly inbox: ReceiptInbox;
  readonly propagation: MonitorPropagation;
  readonly scheduler: MonitorScheduler;
  readonly triggers: MonitorTriggerRuntime;
  readonly memory: MemoryClosureQueue;
  readonly monitorStore: MonitorStore;
}

interface ImessageLane {
  readonly handle: string;
  readonly delivery: DeliveryService;
  readonly watcher: ImessageWatcher;
}

export interface DaemonOptions {
  readonly paths?: DataPaths;
  readonly probes?: BootstrapProbes;
  readonly reprobeIntervalMs?: number;
  readonly chatDbPath?: string;
  readonly sender?: DeliveryPort;
  /** Test seam; production uses SdkMainSessionFactory with shared ~/.gjc auth. */
  readonly mainSessionFactory?: MainSessionFactory;
  /** Test seam; production uses SDK in-process sessions for daemon maintenance children. */
  readonly childRunner?: ChildRunner;
  readonly daemonRunner?: ChildRunner;
  readonly conversationRunner?: ConversationalChildRunner;
  readonly childSessionFactory?: ChildSessionFactory;
  readonly turnWatchdogMs?: number;
  /** Test seam; production runs retention every 24 hours. */
  readonly maintenanceIntervalMs?: number;
  /** Test seam for shutdown/restart; production exits the process. */
  readonly exit?: (code: number) => void;
}

export interface DaemonRuntime {
  readonly paths: DataPaths;
  readonly bootstrap: BootstrapMachine;
  readonly store: StateStore;
  readonly control: ControlServer;
  readonly status: () => BootstrapSnapshot;
  readonly stop: (reason?: "stop" | "signal") => Promise<void>;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonRuntime> {
  const paths = options.paths ?? dataPaths();
  const logger = new NdjsonLogger(paths.daemonLog);
  // Assigned once the monitor lanes exist; the control socket and the
  // monitor_author tool both dispatch on-demand runs through it.
  let runMonitorNow: ((monitor: MonitorSpec) => Promise<{ readonly dispatched: boolean; readonly reason?: string }>) | undefined;
  if (ENV_FILE.loaded.length > 0 || ENV_FILE.overridden.length > 0) {
    logger.write("info", "main", "env_file_loaded", { loaded: ENV_FILE.loaded, overridden: ENV_FILE.overridden });
  }
  const drillMode = readDrillSettings().enabled;
  const settingsService = new SettingsService({ paths, soulPath: SOUL_PATH });
  settingsService.warm();
  const probes = options.probes ?? (drillMode
    ? createDrillProbes(paths)
    : createSystemProbes(paths, { accounts: () => settingsService.listAccounts() }));
  const bootstrap = new BootstrapMachine(probes);

  logger.write("info", "main", "starting");
  const initial = await bootstrap.evaluate();
  logger.write("info", "bootstrap", "state_changed", { state: initial.state, reason: initial.reason });

  const store = openStateStore(paths.stateDb);
  store.setMeta(DAEMON_SESSION_ACTIVE_META, "false");


  const chatDbPath = options.chatDbPath ?? join(paths.home, "Library", "Messages", "chat.db");
  const paused = (): boolean => isDaemonPaused(store);

  let core: CoreLane | undefined;
  let imessage: ImessageLane | undefined;
  // Read-only history outlives admission during shutdown. `core` is unpublished
  // before awaited teardown so no new owner turn can start, but the control
  // server remains live until teardown completes.
  let readableSession: MainSession | undefined;
  // Seeded from the PERSISTED handle, not the boot snapshot: a handle changed
  // while the daemon was down (settings write then crash/restart, or a manual
  // config.json edit) is still a configured-handle change, and plan (k2)
  // requires retirement on every such change. Seeding from the snapshot would
  // make boot look like a no-op, so the first syncImessage would attach and
  // DeliveryService.flushDue() would drain the retired handle's retained rows.
  let configuredHandle: string | undefined = store.getMeta(DAEMON_ALLOWLIST_HANDLE_META);
  let detachReason: ImessageDetachReason = "starting";
  let detachDetail: string | undefined;
  const publishHandleMeta = (handle: string | undefined): void => {
    if (handle === undefined) {
      store.deleteMeta(DAEMON_ALLOWLIST_HANDLE_META);
    } else {
      store.setMeta(DAEMON_ALLOWLIST_HANDLE_META, handle);
    }
  };
  publishHandleMeta(configuredHandle);

  const hub = new ChatHub(logger);
  const outbox = new OwnerOutbox({ logger });
  // `closing` is checked here so owner admission stops the moment shutdown
  // begins. Teardown awaits the delivery/watcher stops before clearing `core`,
  // so without this a chat.send arriving in that window would be queued into a
  // session that is already stopping, and MainSession.stop() waits on its
  // queued turns. The ingress turns this into its existing no_active_lane path.
  const lanes = (): { readonly session: MainSession; readonly memory: MemoryClosureQueue } | undefined => (
    core === undefined || closing ? undefined : { session: core.session, memory: core.memory }
  );

  // Compaction policy is ours, not gjc's default (~70%): a chat agent that
  // runs for weeks should compact early and often. Fires after a turn settles.
  const COMPACT_AT_PERCENT = 50;
  let compacting = false;
  const maybeCompact = async (active: MainSession): Promise<void> => {
    if (compacting) {
      return;
    }
    const usage = active.contextUsage();
    if (!usage || usage.percent === null || usage.percent < COMPACT_AT_PERCENT) {
      return;
    }
    compacting = true;
    logger.write("info", "sdk_session", "auto_compact_started", { percent: usage.percent, tokens: usage.tokens });
    try {
      await active.compact();
      logger.write("info", "sdk_session", "auto_compact_finished", {});
    } catch (error) {
      logger.write("warn", "sdk_session", "auto_compact_failed", { message: messageOf(error) });
    } finally {
      compacting = false;
    }
  };
  const forwardedImages = new Set<string>();
  const recentImageSends = new Map<string, { readonly outcome: SendImageOutcome; readonly at: number }>();
  const rememberImageSend = (path: string, outcome: SendImageOutcome): void => {
    const remembered = { outcome, at: Date.now() };
    recentImageSends.set(path, remembered);
    const timer = setTimeout(() => {
      if (recentImageSends.get(path) === remembered) {
        recentImageSends.delete(path);
      }
    }, 120_000);
    timer.unref?.();
  };

  const ingress = new OwnerTurnIngress({
    store,
    logger,
    hub,
    outbox,
    lanes,
    transcript: () => readableSession?.transcript,
    afterTurn: (session) => { void maybeCompact(session); },
  });


  async function refreshMonitorRuntime(): Promise<void> {
    const lane = core;
    lane?.scheduler.refresh();
    if (lane !== undefined) {
      await lane.triggers.refresh();
      await lane.propagation.drain();
    }
  }

  /** On resume, triage the paused backlog through MainSession; never text it directly. */
  const notifySuppressedBacklog = async (): Promise<void> => {
    const lane = core;
    if (lane === undefined) {
      logger.write("warn", "main", "suppressed_notice_undeliverable", { reason: "core_lane_down" });
      return;
    }
    const missed = drainSuppressedWhilePaused(store);
    if (missed === 0) {
      return;
    }
    const result = await lane.session.turn([
      `${OPERATOR_NOTE_PREFIX}, not from the owner] Owner messages arrived while the daemon was paused. This is internal evidence, not owner-facing text.`,
      suppressedNotice(missed),
      "Decide whether the owner needs a brief update. If not, reply exactly [[no-owner-message]]. If yes, write one concise plain-text sentence without internal state, paths, or codes.",
    ].join("\n\n"));
    if (result.kind !== "reply" || result.text.trim() === "[[no-owner-message]]" || result.text.trim().length === 0) {
      logger.write("info", "main", "suppressed_backlog_triaged_silent", { missed });
      return;
    }
    try {
      const admitted = lane.session.admitOwnerReply({ idempotencyKey: `paused-backlog:${randomUUID()}`, text: result.text.trim() });
      logger.write("info", "imessage", admitted.id.length === 0 ? "suppressed_backlog_triaged_chat_only" : "suppressed_backlog_notified", {
        missed,
        ...(admitted.id.length === 0 ? {} : { deliveryId: admitted.id }),
      });
    } catch (error) {
      logger.write("warn", "main", "suppressed_backlog_triage_failed", { missed, message: messageOf(error) });
    }
  };

  // Turns run detached so later texts can steer them, but the persisted
  // chat.db cursor must not move past a message whose turn has not finished:
  // a crash mid-turn would otherwise drop that text (failure drill "mid-turn").
  const inFlightTurns = new Set<Promise<void>>();
  let deferredCursor: number | undefined;
  let persistCursor: ((rowid: number) => void) | undefined;
  const settleCursor = (): void => {
    if (inFlightTurns.size === 0 && deferredCursor !== undefined) {
      persistCursor?.(deferredCursor);
      deferredCursor = undefined;
    }
  };
  const trackInFlightTurn = (settled: Promise<unknown>): void => {
    const tracked = settled.then(() => undefined, () => undefined);
    inFlightTurns.add(tracked);
    void tracked.then(() => {
      inFlightTurns.delete(tracked);
      settleCursor();
    });
  };
  const wireOwnerTurnDelivery = (session: MainSession, active: ActiveTurn): void => {
    if (!active.owner || active.turnId === undefined) {
      return;
    }
    void active.settled.then((result) => {
      // OwnerTurnIngress settles first and admits its outbound intent; this
      // microtask then wakes InterimInbox with the same turn correlation.
      queueMicrotask(() => {
        const delivery = store.getDeliveryByIdempotencyKey(`inbound-turn:${active.turnId}`);
        session.notifyTurnDelivered({
          turnId: active.turnId,
          turnKind: result.kind,
          ...(delivery === undefined ? {} : { deliveryId: delivery.id }),
        });
      });
    });
  };
  const handleOwnerMessages = async (messages: readonly InboundMessage[]): Promise<void> => {
    const inbound = messages.filter((message) => !message.isFromMe);
    const owner = configuredHandle;
    const accepted = owner === undefined
      ? []
      : inbound.filter((message) => isAllowedHandle(message.senderHandle, owner));
    const dropped = inbound.length - accepted.length;
    if (dropped > 0) {
      logger.write("info", "imessage", "allowlist_dropped", { count: dropped });
    }
    if (accepted.length > 0) {
      logger.write("info", "imessage", "owner_batch_received", { count: accepted.length });
    }
    if (accepted.length > 0 && paused()) {
      const total = recordSuppressedWhilePaused(store, accepted.length);
      logger.write("info", "imessage", "owner_batch_suppressed_paused", {
        count: accepted.length,
        suppressedTotal: total,
      });
      return;
    }
    if (accepted.length > 0 && (core === undefined || !outbox.attached)) {
      logger.write("info", "main", "owner_turn_skipped_no_active_lane", { count: accepted.length });
      return;
    }

    for (const [index, message] of accepted.entries()) {
      const attachmentInput = await readInboundAttachments(message.attachments, logger);
      // U+FFFC is Messages' object-replacement placeholder; a row that is only
      // placeholders (attachment stripped or not yet downloaded) is not a prompt.
      const ownerText = message.text.replace(/\uFFFC/g, "").trim();
      const promptText = attachmentInput.note.length === 0
        ? ownerText
        : `${ownerText}\n\n${attachmentInput.note}`.trim();
      if (promptText.length === 0 && attachmentInput.images.length === 0) {
        logger.write("info", "imessage", "owner_message_ignored_empty", { guid: message.guid });
        continue;
      }
      const turnId = message.guid || `rowid:${message.rowid}`;
      const replyToGuid = message.replyToGuid ?? (message.guid.length === 0 ? undefined : message.guid);
      const request: OwnerTurnRequest = {
        source: "imessage",
        turnId,
        text: ownerText,
        promptText: promptText.length === 0 ? "(the owner sent an image without text)" : promptText,
        ...(attachmentInput.images.length === 0 ? {} : { images: attachmentInput.images }),
        ...(replyToGuid === undefined ? {} : { replyToGuid }),
      };
      await ingress.admit(request, { markRead: index === 0 });
    }
  };

  let chain = Promise.resolve();
  let closing = false;
  let tickQueued = false;
  const enqueue = (label: string, job: () => Promise<void>): Promise<void> => {
    const run = chain.then(async () => {
      if (closing && label !== "shutdown") {
        return;
      }
      await job();
    });
    chain = run.catch((error) => {
      logger.write("error", "main", "lane_job_failed", { label, message: messageOf(error) });
    });
    return run;
  };
  const resync = (trigger: string): Promise<void> => enqueue(trigger, async () => {
    const snapshot = await bootstrap.evaluate();
    logger.write("info", "bootstrap", "state_changed", {
      state: snapshot.state,
      reason: snapshot.reason,
      trigger,
    });
    if (closing) {
      return;
    }
    await synchronizeLanes(snapshot);
  });

  let control: ControlServer;
  const loopLagWindow: number[] = [];
  let loopLagExpected = Date.now() + 100;
  const loopLagTimer = setInterval(() => {
    const lag = Math.max(0, Date.now() - loopLagExpected);
    loopLagExpected = Date.now() + 100;
    loopLagWindow.push(lag);
    if (loopLagWindow.length > 6_000) {
      loopLagWindow.shift();
    }
    if (loopLagWindow.length % 100 === 0) {
      const sorted = [...loopLagWindow].sort((left, right) => left - right);
      const at = (quantile: number): number =>
        sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]!;
      try {
        store.setMeta(EVENT_LOOP_P50_META, String(at(0.5)));
        store.setMeta(EVENT_LOOP_P99_META, String(at(0.99)));
      } catch {
        // Shutdown race: the store may already be closed.
      }
    }
  }, 100);

  const maintenance = new RetentionMaintenance({
    store,
    daemonLog: paths.daemonLog,
    isRunning: () => core !== undefined,
    ...(options.maintenanceIntervalMs === undefined ? {} : { intervalMs: options.maintenanceIntervalMs }),
    logger,
  });

  try {
    control = await startControlServer({
      path: paths.controlSocket,
      getStatus: () => bootstrap.snapshot,
      getStatusContext: (): ControlStatusContext => ({
        sessionState: store.getMeta(DAEMON_SESSION_ACTIVE_META) === "true" ? "active" : "inactive",
        ...(store.getMeta("sdk.main_session.id") === undefined ? {} : { mainSessionId: store.getMeta("sdk.main_session.id")! }),
        mainSessionFilePresent: store.getMeta("sdk.main_session.file") !== undefined,
        ...(configuredHandle === undefined ? {} : { allowlistHandle: configuredHandle }),
        imessage: imessage === undefined
          ? {
            state: "detached",
            reason: detachReason,
            ...(detachDetail === undefined ? {} : { detail: detachDetail }),
            ...(configuredHandle === undefined ? {} : { handle: configuredHandle }),
          }
          : { state: "attached", handle: imessage.handle },
        credentialsReady: bootstrap.snapshot.probes.credentials?.status === "passed",
      }),
      store,
      logger,
      onMonitorsChanged: () => refreshMonitorRuntime(),
      onPausedChanged: async (isPaused) => {
        logger.write("info", "control", isPaused ? "daemon_paused" : "daemon_resumed");
        if (isPaused) {
          return undefined;
        }
        await notifySuppressedBacklog();
        await refreshMonitorRuntime();
      },
      settings: {
        get: async () => ({ ...(await settingsService.snapshot()) }) as unknown as JsonObject,
        set: async (patch) => {
          const outcome = await settingsService.apply(patch as never);
          const credentialChange = hasCredentialEnvPatch(patch);
          if (outcome.ownerHandleChanged) {
            await resync("settings");
          } else if (credentialChange) {
            await resync("credentials");
          } else if (outcome.needsReload && core !== undefined && !outcome.needsRestart) {
            await core.session.reload();
          }
          if (outcome.needsRestart) {
            scheduleRestart();
          }
          return { ok: true, restarting: outcome.needsRestart, reloaded: outcome.needsReload };
        },
        models: async () => ({ models: (await settingsService.listModels()) as unknown as JsonObject[] }),
        accounts: async () => ({ accounts: (await settingsService.listAccounts()) as unknown as JsonObject[] }),
        discoverCredentials: async () => (await settingsService.discoverCredentials()) as unknown as JsonObject,
        adoptCredential: async (id) => {
          const result = await settingsService.adoptCredential(id);
          setNoCredentialHint(null);
          scheduleRestart();
          return result;
        },
        login: async (provider) => ({ ...(await settingsService.startLogin(provider)) }),
        logout: async (provider, account) => {
          await settingsService.logout(provider, account);
          await resync("credentials");
          return { ok: true };
        },
        providers: async () => ({ providers: (await settingsService.listOAuthProviders()) as unknown as JsonObject[] }),
        customProvider: async (input) => {
          const result = await settingsService.addCustomProvider(input as never);
          setNoCredentialHint(null);
          await resync("credentials");
          scheduleRestart();
          return { ...result, restarting: true };
        },
        finishLogin: async (code) => {
          await settingsService.finishLogin(code);
          setNoCredentialHint(null);
          await resync("credentials");
          return { ok: true };
        },
        restart: async () => {
          scheduleRestart();
          return { restarting: true };
        },
        openBrowser: async () => {
          const chrome = process.env.PUPPETEER_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
          if (!existsSync(chrome)) {
            throw new Error("Google Chrome is not installed at /Applications; install it or set PUPPETEER_EXECUTABLE_PATH in ~/.openinstinct/env");
          }
          mkdirSync(paths.chromeProfile, { recursive: true });
          const result = await openVisibleChrome({ chrome, profile: paths.chromeProfile, logger });
          logger.write("info", "browser", "profile_opened_for_owner", { profile: paths.chromeProfile, ...result });
          return { opened: true, profile: paths.chromeProfile, ...result };
        },
      },
      chat: {
        send: async (text) => {
          const turnId = `panel:${randomUUID()}`;
          const outcome = await ingress.admit({
            source: "panel",
            turnId,
            text,
            promptText: `${text}\n\n${PANEL_SOURCE_MARKER}`,
          });
          if (outcome === "no_active_lane") {
            throw new Error("main session is not running");
          }
          return { turnId, outcome };
        },
        history: (limit) => ingress.history(limit),
        subscribe: (sink) => hub.subscribe(sink),
      },
      onBackfillCaptures: async () => {
        const lane = core;
        const transcript = readableSession?.sessionFile;
        if (lane === undefined || transcript === undefined) {
          throw new Error("the main session transcript is not available yet");
        }
        const result = await backfillCapturesFromTranscript(transcript, lane.memory);
        logger.write("info", "memory", "capture_backfill", { ...result });
        return { ...result };
      },
      onMonitorRun: async (monitor) => runMonitorNow
        ? await runMonitorNow(monitor)
        : { dispatched: false, reason: "the daemon is still starting its monitor lanes" },
      onSessionNotify: async (text) => {
        const lane = core;
        if (lane === undefined) {
          throw new Error("main session is not running");
        }
        const result = await lane.session.turn({
          owner: false,
          turnId: `notify:${randomUUID()}`,
          text: `${OPERATOR_NOTE_PREFIX}, not from the owner] ${text}\n\nIf the owner should hear about this, tell them in one plain line; otherwise reply with exactly [[no-owner-message]].`,
        });
        const reply = result.kind === "reply" ? result.text.trim() : "";
        if (reply.length === 0 || reply === "[[no-owner-message]]") {
          return { delivered: false, reply } as unknown as JsonObject;
        }
        try {
          const admitted = lane.session.admitOwnerReply({ idempotencyKey: `notify:${randomUUID()}`, text: reply });
          return { delivered: admitted.id.length > 0, ...(admitted.id.length === 0 ? {} : { deliveryId: admitted.id }), reply } as unknown as JsonObject;
        } catch (error) {
          logger.write("warn", "sdk_session", "session_notify_delivery_failed", { message: messageOf(error) });
          return { delivered: false, reply } as unknown as JsonObject;
        }
      },
      onSessionReset: async () => {
        const lane = core;
        if (lane === undefined) {
          throw new Error("main session is not running");
        }
        await lane.session.reset();
        logger.write("info", "sdk_session", "session_reset", { sessionId: store.getMeta("sdk.main_session.id") });
        return { reset: true, sessionId: store.getMeta("sdk.main_session.id") ?? "" };
      },
      onSessionReload: async () => {
        const lane = core;
        if (lane === undefined) {
          throw new Error("main session is not running");
        }
        await lane.session.reload();
        const soul = loadSoul();
        logger.write("info", "sdk_session", "session_reloaded", { soulVersion: soul.version });
        return { reloaded: true, soulVersion: soul.version };
      },
      onMaintenanceRun: () => {
        const result = maintenance.run();
        return {
          ran: result.ran,
          deliveryLedgerPruned: result.deliveryLedgerPruned,
          monitorEventsPruned: result.monitorEventsPruned,
          receiptsPruned: result.receiptsPruned,
          journalsPruned: result.journalsPruned,
          logRotated: result.logRotated,
        };
      },
    });
  } catch (error) {
    clearInterval(loopLagTimer);
    store.close();
    throw error;
  }

  async function enqueueReload(): Promise<void> {
    const lane = core;
    if (lane === undefined || closing) {
      return;
    }
    try {
      await lane.session.reload();
      logger.write("info", "sdk_session", "session_reloaded", { trigger: "imessage_lane" });
    } catch (error) {
      logger.write("warn", "sdk_session", "session_reload_failed", { trigger: "imessage_lane", message: messageOf(error) });
    }
  }

  async function detachImessageLane(
    reason: ImessageDetachReason,
    detail?: string,
    reload = true,
  ): Promise<void> {
    detachReason = reason;
    detachDetail = detail;
    const lane = imessage;
    if (lane === undefined) {
      outbox.detach(reason);
      return;
    }
    // Invalidate bindings before stopping either adapter so no new delivery can
    // enter the ledger while the lane is unwinding.
    outbox.detach(reason);
    await lane.watcher.stop();
    await lane.delivery.stop();
    if (imessage === lane) {
      imessage = undefined;
    }
    logger.write("info", "imessage", "imessage_lane_detached", { reason });
    if (reload && reason !== "shutdown" && reason !== "core_lane_down") {
      void enqueueReload();
    }
  }

  async function retireHandle(oldHandle: string | undefined, nextHandle: string | undefined): Promise<void> {
    if (oldHandle !== undefined) {
      await detachImessageLane(nextHandle ? "handle_changed" : "no_owner_handle", undefined, false);
      const lane = core;
      if (lane !== undefined) {
        await lane.session.reload();
        logger.write("info", "sdk_session", "session_reloaded", { trigger: "owner_handle" });
      }
      const count = store.expirePendingDeliveriesForHandle(oldHandle, {
        code: "handle_retired",
        message: nextHandle ? "owner handle changed before delivery" : "owner handle removed before delivery",
      }, new Date().toISOString());
      logger.write("info", "delivery", "deliveries_expired_for_handle", { handle: oldHandle, count });
    }
    configuredHandle = nextHandle;
    publishHandleMeta(nextHandle);
  }

  async function attachImessageLane(handle: string): Promise<void> {
    const ownerCore = core;
    if (ownerCore === undefined || imessage?.handle === handle) {
      return;
    }

    let delivery: DeliveryService | undefined;
    let watcher: ImessageWatcher | undefined;
    try {
      // Preflight before constructing any lane object. A directory or unreadable
      // chat.db must leave the core lane entirely untouched.
      openChatDbReadonly(chatDbPath);
      const runtimeConfig = ownerCore.config.runtime;
      const port = options.sender ?? (drillMode
        ? new DrillDeliveryPort()
        : (() => {
          const sender = new ImessageSender({ timeoutMs: runtimeConfig.delivery.timeoutMs, presence: runtimeConfig.presence });
          sender.onPresence = (argv, result) => {
            const failed = result instanceof Error || result.exitCode !== 0;
            if (!(result instanceof Error) && result.stderr.startsWith("skipped")) {
              return;
            }
            logger.write(failed ? "warn" : "info", "imessage", "presence", {
              op: argv.slice(0, 1).concat(argv.slice(2)).join(" "),
              ...(result instanceof Error
                ? { message: result.message }
                : { exitCode: result.exitCode, stderr: result.stderr.trim().slice(0, 200) }),
            });
          };
          return sender;
        })());
      delivery = new DeliveryService({
        store,
        port,
        maxAttempts: runtimeConfig.delivery.maxAttempts,
        retryBackoffMs: runtimeConfig.delivery.retryBackoffMs,
        logger,
      });
      const reader = new ChatDbReader({
        chatDbPath,
        store,
        onCursorAnchored: (event) => logger.write("info", "imessage", "cursor_anchored", { ...event }),
      });
      persistCursor = (rowid) => reader.advanceCursor(rowid);
      // Reads continue from the newest row handed out (so a batch is never
      // re-read), while the durable cursor waits for its turns to finish.
      let readPosition: number | undefined;
      const gatedReader: InboundMessageReader = {
        readNewMessages: () => {
          const messages = reader.readNewMessages(readPosition);
          if (messages.length > 0) readPosition = messages.at(-1)!.rowid;
          return messages;
        },
        advanceCursor: (rowid) => {
          deferredCursor = Math.max(deferredCursor ?? 0, rowid);
          settleCursor();
        },
      };
      watcher = new ImessageWatcher({
        chatDbPath,
        reader: gatedReader,
        gate: () => bootstrap.snapshot.state === "running",

        onMessages: handleOwnerMessages,
        onError: (error) => logger.write("warn", "imessage", "watcher_error", { message: error.message }),
      });
      const nextLane: ImessageLane = { handle, delivery, watcher };
      imessage = nextLane;
      outbox.attach(delivery, handle);
      if (options.sender === undefined) {
        ensureMessagesRunning(logger);
      }
      delivery.start();
      watcher.start();
      logger.write("info", "imessage", "imessage_lane_attached", { handle, generation: outbox.generation });
      void enqueueReload();
    } catch (error) {
      outbox.detach("attach_failed");
      await watcher?.stop().catch(() => undefined);
      await delivery?.stop().catch(() => undefined);
      imessage = undefined;
      detachReason = "attach_failed";
      detachDetail = messageOf(error);
      logger.write("warn", "imessage", "imessage_lane_attach_failed", { handle, message: messageOf(error) });
    }
  }

  async function syncImessage(snapshot: BootstrapSnapshot): Promise<void> {
    const next = snapshot.imessageHandle ?? snapshot.probes.config.allowlistHandle;
    if (configuredHandle !== next) {
      await retireHandle(configuredHandle, next);
    }
    if (core === undefined) {
      await detachImessageLane("core_lane_down");
      return;
    }
    if (next === undefined) {
      await detachImessageLane("no_owner_handle");
      return;
    }
    const messages = snapshot.probes.messages;
    if (messages?.status === "missing" || messages?.status === "invalid") {
      await detachImessageLane("attach_failed", messages.reason);
      return;
    }
    const fda = snapshot.probes.fda;
    if (fda?.status === "error") {
      await detachImessageLane("fda_probe_error", fda.reason);
      return;
    }
    if (fda?.status !== "passed") {
      await detachImessageLane("fda_denied", fda?.reason);
      return;
    }
    await attachImessageLane(next);
  }

  async function stopCoreLane(): Promise<void> {
    await detachImessageLane("core_lane_down");
    const lane = core;
    if (lane === undefined) {
      return;
    }
    core = undefined;
    readableSession = lane.session;
    store.setMeta(DAEMON_SESSION_ACTIVE_META, "false");
    control.setCompactRunner(undefined);

    // Teardown is total: one failing adapter must not strand the remaining
    // resources or retain a stopped transcript forever. Preserve ordering,
    // finish every cleanup step, then surface the first failure.
    let firstError: unknown;
    const cleanup = async (work: () => void | Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        firstError ??= error;
      }
    };
    await cleanup(() => lane.triggers.stop());
    clearInterval(lane.childSweepTimer);
    await cleanup(() => lane.scheduler.stop());
    await cleanup(() => lane.propagation.stop());
    await cleanup(() => lane.inbox.stop());
    await cleanup(() => lane.interim.stop());
    await cleanup(() => lane.lifecycle.stop());
    await cleanup(() => lane.session.stop());
    await cleanup(() => lane.memory.drain());
    if (readableSession === lane.session) {
      readableSession = undefined;
    }
    if (firstError !== undefined) {
      logger.write("error", "main", "core_lane_stop_failed", { message: messageOf(firstError) });
      throw firstError;
    }
    logger.write("info", "main", "core_lane_stopped");
  }

  async function startCoreLane(): Promise<void> {
    if (core !== undefined) {
      return;
    }

    let config: CoreConfig | undefined;
    let closure: MemoryClosureQueue | undefined;
    let lifecycle: ChildLifecycle | undefined;
    let session: MainSession | undefined;
    let inbox: ReceiptInbox | undefined;
    let interim: InterimInbox | undefined;
    let statusReader: StateStoreChildStatusReader | undefined;
    let childSweepTimer: ReturnType<typeof setInterval> | undefined;
    let propagation: MonitorPropagation | undefined;
    let canonicalizer: MemoryCanonicalizer | undefined;
    let scheduler: MonitorScheduler | undefined;
    let triggers: MonitorTriggerRuntime | undefined;
    let monitorStore: MonitorStore | undefined;
    try {
      config = await readCoreConfig(paths.config, logger);
      const runtimeConfig = config.runtime;
      monitorStore = new MonitorStore(store);
      if (seedComputerUsageInsight(store, monitorStore)) {
        logger.write("info", "insights", "computer_usage_monitor_seeded");
      }
      if (runtimeConfig.heartbeatMinutes > 0 && seedHeartbeat(store, monitorStore, runtimeConfig.heartbeatMinutes)) {
        logger.write("info", "insights", "heartbeat_monitor_seeded", { minutes: runtimeConfig.heartbeatMinutes });
      }
      if (seedMemoryMaintenanceMonitors(store, monitorStore)) {
        logger.write("info", "memory", "maintenance_monitors_seeded");
      }

      closure = new MemoryClosureQueue({
        store,
        home: paths.root,
        onEvent: (event, fields) => logger.write(event.includes("failed") ? "error" : "info", "memory", event, fields),
      });
      await closure.initialize();
      const registry = new ChildRegistry(store);
      const journal = new TerminalJournal(paths.childrenJournal);
      statusReader = new StateStoreChildStatusReader(store);
      const taskRunner = options.childRunner ?? (drillMode
        ? new DrillChildRunner()
        : new SdkInProcessRunner({
          root: paths.children,
          modelPattern: runtimeConfig.mainSessionModel,
          ...(options.childSessionFactory === undefined ? {} : { factory: options.childSessionFactory }),
        }));
      const conversation = options.conversationRunner ?? (drillMode
        ? new DrillConversationRunner()
        : new SdkConversationRunner({
          root: paths.children,
          modelPattern: runtimeConfig.mainSessionModel,
          ...(options.childSessionFactory === undefined ? {} : { factory: options.childSessionFactory }),
          interimMaxBytes: runtimeConfig.children.interimMaxBytes,
          interimRatePerMinute: runtimeConfig.children.interimRatePerMinute,
          onEvent: (event, fields) => logger.write(event.includes("failed") ? "error" : "info", "children", event, fields),
        }));
      const daemonRunner = options.daemonRunner ?? options.childRunner ?? taskRunner;
      lifecycle = new ChildLifecycle({
        registry,
        journal,
        runner: taskRunner,
        conversation,
        daemonRunner,
        daemonRunnerSelector: (child) => child.origin === "memory" ? taskRunner : undefined,
        maxConcurrent: runtimeConfig.children.maxConcurrent,
        maxLive: runtimeConfig.children.maxLive,
        warmTtlMs: runtimeConfig.children.warmTtlMs,
        idleTimeoutMs: runtimeConfig.children.idleTimeoutMs,
        defaultConversationalTimeoutMs: runtimeConfig.children.conversationalTimeoutMs,
        defaultDaemonTimeoutMs: runtimeConfig.children.daemonTimeoutMs,
        onChildUpdated: (child) => statusReader?.update(child),
        onReceipt: async (receipt) => {
          const origin = store.getChild(receipt.childId)?.origin ?? "owner";
          if (origin === "memory" && canonicalizer && await canonicalizer.onChildReceipt(receipt)) {
            return;
          }
          if (origin !== "owner") {
            if (!propagation) {
              throw new Error("monitor propagation was not initialized");
            }
            if (await propagation.onChildReceipt(receipt)) {
              return;
            }
            if (await propagation.onUncorrelatedChildReceipt(receipt)) {
              return;
            }
            throw new Error(`receipt ${receipt.id} for ${origin} child ${receipt.childId} was not consumed`);
          }
          if (!inbox) {
            throw new Error("receipt inbox was not initialized");
          }
          await inbox.process(receipt);
        },
        onReport: (report) => {
          if (!interim) {
            throw new Error("interim inbox is not initialized");
          }
          return interim.admit(report);
        },
        onEvent: (event, fields) => {
          queueMicrotask(() => {
            logger.write(event.includes("failed") || event === "terminal_not_exposed" ? "error" : "info", "children", event, fields);
          });
        },
      });

      const sendImage = (request: { readonly filePath: string; readonly caption: string }): SendImageOutcome => {
        const remembered = recentImageSends.get(request.filePath);
        if (remembered !== undefined) {
          if (Date.now() - remembered.at < 120_000) {
            return remembered.outcome;
          }
          recentImageSends.delete(request.filePath);
        }
        const context = ingress.current;
        const admitted = context === undefined
          ? outbox.admit({
            idempotencyKey: `outbound-image:${randomUUID()}`,
            filePath: request.filePath,
            caption: request.caption,
          })
          : context.binding.admit({
            idempotencyKey: `outbound-image:${randomUUID()}`,
            filePath: request.filePath,
            caption: request.caption,
          });
        const outcome: SendImageOutcome = admitted === undefined
          ? { kind: "chat_only" }
          : { kind: "queued", deliveryId: admitted.id };
        rememberImageSend(request.filePath, outcome);
        ingress.onImage(request.filePath, request.caption, outcome);
        return outcome;
      };

      const customTools = [
        createChildNudgeTool({
          nudge: (childId, text, input) => lifecycle!.nudge(childId, text, input),
          release: (childId) => lifecycle!.release(childId),
          latencyAlertMs: runtimeConfig.children.toolLatencyGuardMs,
          onEvent: (event, fields) => queueMicrotask(() => logger.write("info", "children", event, fields)),
        }),
        createChildStatusTool({
          reader: statusReader!,
          latencyAlertMs: runtimeConfig.children.toolLatencyGuardMs,
          statusListLimit: runtimeConfig.children.statusListLimit,
          statusTextMaxBytes: runtimeConfig.children.statusTextMaxBytes,
          onEvent: (event, fields) => queueMicrotask(() => logger.write("info", "children", event, fields)),
        }),
        createMonitorAuthorTool(monitorStore!, {
          onChanged: () => refreshMonitorRuntime(),
          onRun: async (monitor) => runMonitorNow
            ? await runMonitorNow(monitor)
            : { dispatched: false, reason: "the monitor lanes are not running yet" },
        }),
        createMemorySearchTool(closure!),
        createMemoryCaptureTool(closure!),
        createMemoryAuditTool(closure!),
      ];
      const factory = options.mainSessionFactory ?? (drillMode
        ? new DrillMainSessionFactory({ customTools })
        : new SdkMainSessionFactory({
          persona: () => ({ ownerHandle: outbox.handle, imessage: outbox.attached ? "attached" : "detached" }),
          ownerName: runtimeConfig.ownerName,
          chromeProfile: paths.chromeProfile,
          modelPattern: runtimeConfig.mainSessionModel,
          delegateBackground: (request) => lifecycle!.delegate(request),
          sendImage,
          customTools,
        }));
      session = await openMainSession({
        store,
        workingDirectory: paths.session,
        factory,
        ownerHandle: () => outbox.handle,
        ownerDelivery: (outbound) => {
          const { handle: _handle, ...ownerOutbound } = outbound;
          return outbox.admit(ownerOutbound);
        },
        onOwnerReply: (reply) => {
          hub.message({
            role: "assistant",
            text: toPlainText(reply.text),
            at: new Date().toISOString(),
            turnId: `internal:${reply.idempotencyKey}`,
            final: true,
          });
        },
        watchdogMs: options.turnWatchdogMs ?? runtimeConfig.mainTurnWatchdogMs,
        onEvent: (event, fields) => logger.write("info", "sdk_session", event, fields),
        onFastModeRejected: async () => {
          await settingsService.disableFastMode();
          store.setMeta(DAEMON_FAST_MODE_ENABLED_META, "false");
          logger.write("warn", "sdk_session", "fast_mode_auto_disabled", {
            model: runtimeConfig.mainSessionModel,
            reason: "provider_rejected_priority",
          });
        },
        onTurnStarted: (active) => {
          ingress.onTurnStarted(active);
          wireOwnerTurnDelivery(session!, active);
          if (active.owner) {
            trackInFlightTurn(active.settled);
          }
        },

        onTurnPromoted: (active, turnId) => {
          ingress.onTurnPromoted(active, turnId);
          wireOwnerTurnDelivery(session!, active);
          trackInFlightTurn(active.settled);
        },
        onSteerMerged: (active, turnId) => ingress.onSteerMerged(active, turnId),
        onSegment: (text) => ingress.onSegment(text),

        onImageRead: (path) => {
          if (forwardedImages.has(path)) {
            return;
          }
          forwardedImages.add(path);
          if (forwardedImages.size > 200) {
            forwardedImages.clear();
          }
          const remembered = recentImageSends.get(path);
          if (remembered !== undefined && Date.now() - remembered.at < 120_000) {
            return;
          }
          const caption = `(looking at ${path.split("/").pop()})`;
          const context = ingress.current;
          const admitted = context === undefined
            ? outbox.admit({ idempotencyKey: `image-read:${path}:${Date.now()}`, filePath: path, caption })
            : context.binding.admit({ idempotencyKey: `image-read:${path}:${Date.now()}`, filePath: path, caption });
          const outcome: SendImageOutcome = admitted === undefined
            ? { kind: "chat_only" }
            : { kind: "queued", deliveryId: admitted.id };
          rememberImageSend(path, outcome);
          ingress.onImage(path, caption, outcome);
          logger.write("info", "imessage", "image_read_forwarded", {
            path,
            lane: admitted === undefined ? "detached" : "attached",
          });
        },
        orientation: () => buildOrientation(paths.memory),
      });
      store.setMeta(DAEMON_FAST_MODE_AVAILABLE_META, String(session.fastModeAvailable));
      store.setMeta(DAEMON_FAST_MODE_ENABLED_META, String(session.fastModeEnabled));
      inbox = new ReceiptInbox({
        store,
        mainSession: session,
        onEvent: (event, fields) => logger.write("info", "receipt_inbox", event, fields),
      });
      const interimTurner = {
        get busy(): boolean { return session!.busy; },
        steer: async (input: import("./sdk-session/main-session.ts").MainTurnInput): Promise<boolean> => (
          (await session!.steer({
            ...input,
            text: `${OPERATOR_NOTE_PREFIX}, not from the owner] ${input.text}`,
          })).kind === "admitted"
        ),
        turn: (prompt: string) => session!.turn(`${OPERATOR_NOTE_PREFIX}, not from the owner]\n\n${prompt}`),
        onTurnDelivered: (listener: (delivery: import("./children/interim.ts").InterimTurnDelivery) => void) => session!.onTurnDelivered(listener),
        currentOwnerTurnId: () => session!.currentOwnerTurnId(),
        transcriptContains: (marker: string) => session!.transcriptContains(marker),
        get messages(): unknown { return session!.messages; },
        admitOwnerReply: (input: import("./sdk-session/main-session.ts").OwnerReplyInput) => session!.admitOwnerReply(input),
      };
      interim = new InterimInbox({
        store,
        mainSession: interimTurner,
        batchMs: runtimeConfig.children.interimBatchMs,
        ratePerMinute: runtimeConfig.children.interimRatePerMinute,
        maxBytes: runtimeConfig.children.interimMaxBytes,
        onEvent: (event, fields) => logger.write(event.includes("failed") ? "error" : "info", "interim_inbox", event, fields),
      });
      propagation = new MonitorPropagation({
        store,
        monitors: monitorStore,
        lifecycle,
        mainSession: session,
        isPaused: paused,
        ...(drillMode ? { leaseMs: 100 } : {}),
        onEvent: (event, fields) => logger.write(event === "failed" ? "error" : "info", "monitors", event, fields),
      });
      canonicalizer = new MemoryCanonicalizer({
        store,
        lifecycle,
        closure,
        onEvent: (event, fields) => logger.write(event.includes("failed") ? "error" : "info", "memory", event, fields),
      });

      const admitMonitorTrigger = async (monitor: MonitorSpec, event: MonitorTriggerEvent): Promise<void> => {
        if (paused()) {
          logger.write("info", "monitors", "trigger_skipped_paused", { monitorId: monitor.id, eventType: event.eventType });
          return;
        }
        if (monitor.id === MEMORY_CANONICALIZE_MONITOR_ID) {
          await canonicalizer!.canonicalize();
          return;
        }
        if (monitor.id === MEMORY_AUDIT_MONITOR_ID) {
          const report = await memoryAudit(closure!.corpusRoot);
          const occurrence = event.occurrenceKey ?? `${event.eventType}:${JSON.stringify(event.payload)}`;
          const triage = await session!.turn([
            `${OPERATOR_NOTE_PREFIX}, not from the owner] A memory audit completed. This is internal evidence, not owner-facing text.`,
            report.ok ? "The audit found no structural issues." : `Internal audit evidence: ${report.issues.length} issue(s).`,
            "Decide whether action is needed. If the owner needs to know, write one concise natural-language sentence without raw paths, JSON, stack traces, or internal codes. Otherwise reply exactly [[no-owner-message]].",
          ].join("\n\n"));
          if (triage.kind === "reply" && triage.text.trim() !== "[[no-owner-message]]" && triage.text.trim().length > 0) {
            try {
              session!.admitOwnerReply({ idempotencyKey: `memory:audit:${occurrence}`, text: triage.text.trim() });
            } catch (error) {
              logger.write("warn", "memory", "audit_owner_reply_suppressed", { message: messageOf(error) });
            }
          }
          return;
        }
        await propagation!.admitTrigger(monitor, event);
      };
      // An explicit run overrides the schedule, and deliberately also runs a
      // disabled monitor: the owner asking for it outranks the switch.
      runMonitorNow = async (monitor) => {
        if (paused()) {
          return { dispatched: false, reason: "the daemon is paused" };
        }
        logger.write("info", "monitors", "manual_run", { monitorId: monitor.id, enabled: monitor.enabled });
        await admitMonitorTrigger(monitor, manualTriggerEvent(monitor, new Date()));
        return { dispatched: true };
      };

      scheduler = new MonitorScheduler({
        monitors: monitorStore,
        onTrigger: (monitor, event) => admitMonitorTrigger(monitor, event),
        isPaused: paused,
        onEvent: (event, fields) => logger.write("info", "monitors", event, fields),
      });
      triggers = new MonitorTriggerRuntime({
        monitors: monitorStore,
        config: config.monitors,
        onTrigger: (monitor, event) => admitMonitorTrigger(monitor, event),
        onEvent: (event, fields) => logger.write("info", "monitors", event, fields),
      });

      childSweepTimer = setInterval(() => lifecycle!.sweep(), 30_000);
      childSweepTimer?.unref();
      const lane: CoreLane = {
        config,
        session,
        lifecycle,
        inbox,
        interim,
        childSweepTimer,
        propagation,
        scheduler,
        triggers,
        memory: closure,
        monitorStore,
      };
      core = lane;
      readableSession = session;
      store.setMeta(DAEMON_SESSION_ACTIVE_META, "true");
      control.setCompactRunner(() => session!.compact());
      await lifecycle.reconcile();
      await canonicalizer.reconcile();
      await propagation.reconcile();
      // Receipt/interim replay runs model turns; it must not delay the
      // iMessage lane attach or the control server behind a large backlog.
      const replayInbox = inbox;
      const replayInterim = interim;
      void replayInbox.drain().catch((error) => {
        logger.write("error", "receipt_inbox", "boot_replay_failed", { message: messageOf(error) });
      }).then(() => replayInterim.replay()).catch((error) => {
        logger.write("error", "interim_inbox", "boot_replay_failed", { message: messageOf(error) });
      });
      await scheduler.start();
      triggers.start();
      logger.write("info", "main", "core_lane_started", {
        sessionFile: session.sessionFile,
        sessionId: session.sessionId,
      });
    } catch (error) {
      if (core?.session === session) {
        core = undefined;
      }
      store.setMeta(DAEMON_SESSION_ACTIVE_META, "false");
      control.setCompactRunner(undefined);
      if (childSweepTimer) {
        clearInterval(childSweepTimer);
      }
      await triggers?.stop().catch(() => undefined);
      scheduler?.stop();
      propagation?.stop();
      inbox?.stop();
      interim?.stop();
      await lifecycle?.stop().catch(() => undefined);
      await session?.stop().catch(() => undefined);
      await closure?.drain().catch(() => undefined);
      if (readableSession === session) {
        readableSession = undefined;
      }
      throw error;
    }
  }

  async function synchronizeLanes(snapshot: BootstrapSnapshot): Promise<void> {
    try {
      const next = snapshot.imessageHandle ?? snapshot.probes.config.allowlistHandle;
      if (snapshot.state === "credentials_blocked") {
        await stopCoreLane();
        if (configuredHandle !== next) {
          await retireHandle(configuredHandle, next);
        }
        return;
      }
      if (snapshot.state !== "running") {
        if (configuredHandle !== next) {
          await retireHandle(configuredHandle, next);
        }
        return;
      }
      await startCoreLane();
      await syncImessage(snapshot);
    } catch (error) {
      const degraded = bootstrap.markDegraded(messageOf(error));
      logger.write("error", "main", "core_lane_start_failed", {
        state: degraded.state,
        reason: degraded.reason,
      });
    }
  }

  let interval: ReturnType<typeof setInterval> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const shutdown = (opts: { readonly exitCode?: number; readonly reason: "stop" | "signal" | "restart_requested" }): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }
    closing = true;
    if (interval !== undefined) {
      clearInterval(interval);
    }
    clearInterval(loopLagTimer);
    maintenance.stop();
    logger.write("info", "main", opts.reason);
    shutdownPromise = (async () => {
      let failure: unknown;
      try {
        await enqueue("shutdown", async () => {
          await detachImessageLane("shutdown");
          await stopCoreLane();
        });
      } catch (error) {
        failure = error;
      }
      try {
        await control.close();
      } catch (error) {
        failure ??= error;
      }
      try {
        store.close();
      } catch (error) {
        failure ??= error;
      }
      logger.write("info", "main", "stopped");
      if (opts.exitCode !== undefined) {
        exit(opts.exitCode);
      }
      if (failure !== undefined) {
        throw failure;
      }
    })();
    return shutdownPromise;
  };

  function scheduleRestart(): void {
    const timer = setTimeout(() => {
      logger.write("info", "main", "restart_requested");
      // macOS 26 launchd can leave a KeepAlive job "pending spawn" indefinitely
      // after a non-zero exit, so schedule an explicit detached kickstart that
      // fires after this process has exited.
      try {
        const uid = process.getuid?.() ?? 501;
        Bun.spawn(["/bin/sh", "-c", `sleep 3; /bin/launchctl kickstart gui/${uid}/co.openinstinct.daemon`], {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        }).unref();
      } catch (error) {
        logger.write("warn", "main", "restart_kickstart_schedule_failed", { message: messageOf(error) });
      }
      const hard = setTimeout(() => exit(75), 8_000);
      hard.unref?.();
      void shutdown({ exitCode: 75, reason: "restart_requested" }).finally(() => clearTimeout(hard));
    }, 500);
    timer.unref?.();
  }

  await resync("boot");
  maintenance.start();
  interval = setInterval(() => {
    if (tickQueued) {
      return;
    }
    tickQueued = true;
    void resync("interval").catch((error) => {
      logger.write("error", "main", "probe_refresh_failed", { message: messageOf(error) });
    }).finally(() => {
      tickQueued = false;
    });
  }, options.reprobeIntervalMs ?? 5_000);

  return {
    paths,
    bootstrap,
    store,
    control,
    status: () => bootstrap.snapshot,
    stop: (reason = "stop") => shutdown({ reason }),
  };
}

let lastMessagesEnsure = 0;
function ensureMessagesRunning(logger: NdjsonLogger): void {
  if (process.env.OI_DRILL_MODE === "1" || Date.now() - lastMessagesEnsure < 60_000) {
    return;
  }
  lastMessagesEnsure = Date.now();
  try {
    const running = Bun.spawnSync(["pgrep", "-x", "Messages"]).exitCode === 0;
    if (!running) {
      Bun.spawnSync(["open", "-gja", "Messages"]);
      logger.write("info", "imessage", "messages_app_relaunched");
    }
    // Attachment paste targets the main window; a running Messages with zero
    // windows (owner pressed ⌘W) fails with "Could not get main Messages window".
    const windows = Bun.spawnSync(["osascript", "-e", 'tell application "Messages" to count windows']).stdout.toString().trim();
    if (windows === "0") {
      // `reopen` brings Messages forward; put the owner's app back afterwards.
      Bun.spawnSync(["osascript", "-e", [
        'tell application "System Events" to set prev to name of first process whose frontmost is true',
        'tell application "Messages" to reopen',
        'delay 0.3',
        'tell application "System Events" to set frontmost of process prev to true',
      ].join("\n")]);
      logger.write("info", "imessage", "messages_window_reopened");
    }
  } catch {
    // best effort
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCredentialEnvPatch(patch: JsonObject): boolean {
  const env = patch.env;
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    return false;
  }
  return Object.keys(env as Record<string, unknown>).some((key) => (
    MANAGED_CREDENTIAL_ENV_KEYS.includes(key) || OI_API_KEY_PATTERN.test(key)
  ));
}

function memoryDigest(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return Array.from(compact).slice(0, 500).join("");
}

const IMAGE_MIME = /^image\/(png|jpeg|jpg|gif|webp|heic|heif)$/i;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|heic|heif)$/i;
/** Guards the main session against a single oversized attachment. */
const MAX_INBOUND_IMAGE_BYTES = 8 * 1024 * 1024;

function isImageAttachment(attachment: InboundAttachment): boolean {
  if (attachment.mime !== undefined && attachment.mime.length > 0) {
    return IMAGE_MIME.test(attachment.mime);
  }
  return IMAGE_EXTENSION.test(attachment.path);
}

function imageMimeOf(attachment: InboundAttachment): string {
  if (attachment.mime !== undefined && IMAGE_MIME.test(attachment.mime)) {
    return attachment.mime.toLowerCase() === "image/jpg" ? "image/jpeg" : attachment.mime.toLowerCase();
  }
  const extension = attachment.path.toLowerCase().split(".").at(-1) ?? "";
  return extension === "jpg" ? "image/jpeg" : `image/${extension}`;
}

/**
 * Turns chat.db attachment rows into SDK image parts. Anything that is not a
 * readable image is described in text instead of being silently dropped, so the
 * agent can still tell the owner that something arrived.
 */
async function readInboundAttachments(
  attachments: readonly InboundAttachment[],
  logger: NdjsonLogger,
): Promise<{ readonly images: readonly PromptImage[]; readonly note: string }> {
  if (attachments.length === 0) {
    return { images: [], note: "" };
  }

  const images: PromptImage[] = [];
  const notes: string[] = [];
  for (const attachment of attachments) {
    const label = attachment.transferName ?? attachment.path;
    if (!isImageAttachment(attachment)) {
      notes.push(`[owner attached a non-image file: ${label}]`);
      continue;
    }
    try {
      const bytes = await readFile(attachment.path);
      if (bytes.byteLength > MAX_INBOUND_IMAGE_BYTES) {
        notes.push(`[owner attached an image too large to read: ${label}]`);
        continue;
      }
      images.push({ type: "image", data: bytes.toString("base64"), mimeType: imageMimeOf(attachment) });
    } catch (error) {
      logger.write("warn", "imessage", "attachment_unreadable", {
        path: attachment.path,
        message: error instanceof Error ? error.message : String(error),
      });
      notes.push(`[owner attached an image that could not be read: ${label}]`);
    }
  }
  return { images, note: notes.join("\n") };
}

if (import.meta.main) {
  const runtime = await startDaemon();
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void runtime.stop("signal").finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
