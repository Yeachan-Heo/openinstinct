import { randomUUID } from "node:crypto";

import {
  MAX_FRAME_BYTES,
  type ChatEvent,
  type ChatEventPayload,
  type ChatHistoryResponse,
  type JsonObject,
} from "./control/schema.ts";
import { isDaemonPaused, recordSuppressedWhilePaused } from "./control/pause.ts";
import { type OwnerOutbound, type OutboxBinding, OwnerOutbox } from "./delivery/outbox.ts";
import { toPlainText } from "./delivery/plaintext.ts";
import { ChatHub, type ChatMessage, type OwnerSource } from "./chat/hub.ts";
import { applyHistoryByteBudget, mergeOwnerHistory, readOwnerFacingHistory, stripOrientation, stripPanelMarker } from "./chat/history.ts";

import { MANAGED_LOCAL_FILE_ACTION } from "./assistant-work/local-effects.ts";
import { MANAGED_INSTALL_ACTION, parseManagedInstallPlan } from "./assistant-work/install.ts";
import { isManagedHttpActionRecord } from "./assistant-work/http-effects.ts";
import { isManagedOpaqueToolAction } from "./assistant-work/tool-gate.ts";
import {
  applyOwnerFollowupCommand,
  applyOwnerSendRuleCommand,
  ownerFollowupCommandResultText,
  ownerSendRuleCommandResultText,
  parseOwnerFollowupCommand,
  parseOwnerSendRuleCommand,
  type OwnerFollowupCommand,
  type OwnerFollowupCommandParseResult,
  type OwnerSendRuleCommand,
  type OwnerSendRuleCommandParseResult,
} from "./assistant-work/owner-policy.ts";
import { stableOwnerRuleId, type ActionRecord, type EvidenceProvenance } from "./assistant-work/model.ts";
import type { NdjsonLogger } from "./log.ts";
import type { MemoryClosureQueue } from "./memory/adapters/intents.ts";
import {
  readPersistedOwnerReplies,
  type ActiveTurn,
  type MainSession,
  type MainTurnInput,
  type MainTurnResult,
  type PromptImage,
  type SendImageOutcome,
  type SteerOutcome,
  visibleTurnFailure,
} from "./sdk-session/main-session.ts";
import type { StateStore } from "./store/index.ts";
import { setNoCredentialHint } from "./control/socket.ts";

export type { OwnerSource } from "./chat/hub.ts";

export interface OwnerTurnRequest {
  readonly source: OwnerSource;
  readonly turnId: string;
  readonly text: string;
  readonly promptText: string;
  readonly images?: readonly PromptImage[];
  readonly replyToGuid?: string;
}

export type AdmitOutcome = "started" | "steered" | "command" | "suppressed_paused" | "no_active_lane";

export type OwnerActionCommand = {
  readonly operation: "approve" | "reject";
  readonly actionId: string;
  readonly revision: number;
  readonly digest: string;
};

export type OwnerActionCommandParseResult =
  | { readonly kind: "valid"; readonly command: OwnerActionCommand }
  | { readonly kind: "invalid"; readonly message: string };

type OwnerHostCommandOperation = OwnerActionCommand["operation"] | OwnerSendRuleCommand["operation"] | OwnerFollowupCommand["operation"] | "invalid";

const OWNER_ACTION_COMMAND_USAGE = "Use exactly /approve ACTION_ID REVISION DIGEST or /reject ACTION_ID REVISION DIGEST. Approval execution is available only for managed local-file, managed-install, and managed-HTTP actions.";

/** Recognizes only exact standalone commands; ordinary text is never authority. */
export function parseOwnerActionCommand(text: string): OwnerActionCommandParseResult | undefined {
  const trimmed = text.trim();
  if (!/^\/(?:approve|reject)(?:\s|$)/.test(trimmed)) {
    return undefined;
  }
  const match = /^\/(approve|reject)\s+(\S+)\s+([1-9]\d*)\s+([a-f0-9]{64})$/.exec(trimmed);
  if (!match) {
    return { kind: "invalid", message: OWNER_ACTION_COMMAND_USAGE };
  }
  const revision = Number(match[3]);
  if (match[2]!.length > 512 || match[2]!.includes("\0")) {
    return { kind: "invalid", message: OWNER_ACTION_COMMAND_USAGE };
  }
  if (!Number.isSafeInteger(revision)) {
    return { kind: "invalid", message: OWNER_ACTION_COMMAND_USAGE };
  }
  return {
    kind: "valid",
    command: {
      operation: match[1] as OwnerActionCommand["operation"],
      actionId: match[2]!,
      revision,
      digest: match[4]!,
    },
  };
}

interface OwnerChatEvent extends ChatEvent {
  readonly topic: "chat.message";
}

export interface Admission {
  readonly turnId: string;
  readonly request: OwnerTurnRequest;
  readonly sources: Set<OwnerSource>;
  readonly steered: string[];
  readonly events: ChatEvent[];
  readonly firstSeq: number;
}

export interface TurnContext extends Admission {
  readonly kind: "prompt" | "continuation" | "promoted";
  readonly binding: OutboxBinding;
  readonly transcriptIndex: number;
  readonly settled: Promise<MainTurnResult>;
  typingOn: boolean;
  typingKeepAlive?: ReturnType<typeof setInterval>;
}

export interface OwnerTurnDeps {
  readonly store: StateStore;
  readonly logger: NdjsonLogger;
  readonly hub: ChatHub;
  readonly outbox: OwnerOutbox;
  readonly lanes: () => { readonly session: MainSession; readonly memory?: MemoryClosureQueue } | undefined;
  /**
   * Read-only transcript access is deliberately separate from `lanes()`.
   * `lanes()` is the admission gate and becomes unavailable as soon as
   * shutdown starts; history remains readable until the session teardown
   * completes and the control server closes.
   */
  readonly transcript: () => unknown;
  readonly afterTurn?: (session: MainSession) => void;
}

type OwnerLane = NonNullable<ReturnType<OwnerTurnDeps["lanes"]>>;

type TranscriptRow = {
  readonly role?: unknown;
  readonly content?: unknown;
};

const MAX_CONSECUTIVE_FAILURE_NOTICES = 2;
const TYPING_KEEP_ALIVE_MS = 45_000;

/**
 * Shared ingress for owner text from iMessage and the Chat window. The
 * admission map is deliberately separate from the currently running context:
 * SDK steering can be admitted before the SDK tells us which run consumed it.
 */
export class OwnerTurnIngress {
  private readonly admissions = new Map<string, Admission>();
  private readonly laneByAdmission = new Map<string, OwnerLane>();
  private readonly preMerged = new Set<string>();
  private readonly startedAt = new WeakMap<TurnContext, number>();
  private readonly laneByContext = new WeakMap<TurnContext, OwnerLane>();
  private readonly settledContexts = new WeakSet<TurnContext>();
  private queued: string | undefined;
  private activeContext: TurnContext | undefined;
  private consecutiveTurnFailures = 0;
  private readonly presence: PresenceRouter;

  public constructor(private readonly deps: OwnerTurnDeps) {
    this.presence = new PresenceRouter({
      hub: deps.hub,
      outbox: deps.outbox,
      current: () => this.activeContext,
      now: () => new Date(),
      onTyping: (source, on, context) => {
        if (context !== undefined) {
          context.typingOn = on;
          if (on && source === "imessage") {
            this.ensureTypingKeepAlive(context);
          }
        }
      },
    });
  }

  public async admit(request: OwnerTurnRequest, options: { readonly markRead?: boolean } = {}): Promise<AdmitOutcome> {
    if (isDaemonPaused(this.deps.store)) {
      recordSuppressedWhilePaused(this.deps.store, 1);
      this.deps.logger.write("info", "sdk_session", "owner_turn_suppressed_paused", {
        turnId: request.turnId,
        source: request.source,
      });
      return "suppressed_paused";
    }
    const actionCommand = parseOwnerActionCommand(request.text);
    const sendRuleCommand = parseOwnerSendRuleCommand(request.text);
    const followupCommand = parseOwnerFollowupCommand(request.text);
    const command = actionCommand ?? sendRuleCommand ?? followupCommand;
    const commandHasAttachments = command !== undefined && (
      (request.images !== undefined && request.images.length > 0)
      || stripPanelMarker(request.promptText).text.trim() !== request.text.trim()
    );
    if (commandHasAttachments) {
      return this.completeOwnerActionCommand(request, "Owner authority commands must be sent as standalone text without attachments or quoted content.", options, {
        operation: "invalid",
        applied: false,
      });
    }
    if (actionCommand !== undefined) {
      return this.handleOwnerActionCommand(request, actionCommand, options);
    }
    if (sendRuleCommand !== undefined) {
      return this.handleOwnerSendRuleCommand(request, sendRuleCommand, options);
    }
    if (followupCommand !== undefined) {
      return this.handleOwnerFollowupCommand(request, followupCommand, options);
    }

    const lane = this.deps.lanes();
    if (lane === undefined) {
      this.deps.logger.write("info", "main", "owner_turn_skipped_no_active_lane", {
        turnId: request.turnId,
        source: request.source,
      });
      return "no_active_lane";
    }

    return this.admitToLane(request, lane, options);
  }

  public onTurnStarted(active: ActiveTurn): void {
    if (!active.owner) {
      return;
    }

    const ids = active.kind === "continuation"
      ? [...(active.openingTurnIds ?? [])]
      : active.turnId === undefined ? [] : [active.turnId];
    const primary = ids[0];
    const admission = primary === undefined ? undefined : this.admissions.get(primary);
    if (admission === undefined) {
      this.deps.logger.write("warn", "sdk_session", "turn_context_missing", {
        turnId: primary ?? active.turnId,
      });
      return;
    }

    if (this.queued === primary) {
      this.queued = undefined;
    }

    const context: TurnContext = {
      ...admission,
      kind: active.kind,
      binding: this.deps.outbox.bind(primary),
      transcriptIndex: active.transcriptIndex,
      settled: active.settled,
      typingOn: true,
    };
    this.activeContext = context;
    this.startedAt.set(context, Date.now());
    const lane = this.laneByAdmission.get(primary) ?? this.deps.lanes();
    if (lane !== undefined) {
      this.laneByContext.set(context, lane);
    }
    this.ensureTypingKeepAlive(context);

    for (const id of ids.slice(1)) {
      this.mergeIntoContext(context, id);
    }

    void active.settled.then((result) => {
      this.settle(context, result);
    });
  }

  public onTurnPromoted(active: ActiveTurn, turnId: string): void {
    const admission = this.admissions.get(turnId);
    if (admission === undefined) {
      this.deps.logger.write("warn", "sdk_session", "turn_context_missing", { turnId });
      return;
    }

    const context: TurnContext = {
      ...admission,
      kind: "promoted",
      binding: this.deps.outbox.bind(turnId),
      transcriptIndex: active.transcriptIndex,
      settled: active.settled,
      typingOn: true,
    };
    this.activeContext = context;
    this.startedAt.set(context, Date.now());
    const lane = this.laneByAdmission.get(turnId) ?? this.deps.lanes();
    if (lane !== undefined) {
      this.laneByContext.set(context, lane);
    }
    this.ensureTypingKeepAlive(context);
    void active.settled.then((result) => {
      this.settle(context, result);
    });
  }

  public onSteerMerged(active: ActiveTurn, turnId: string): void {
    if (this.preMerged.has(turnId)) {
      return;
    }

    const context = this.activeContext;
    if (context !== undefined && context.steered.includes(turnId)) {
      return;
    }
    if (context === undefined || context.settled !== active.settled) {
      // No ingress-owned context: the live run is an owner-flagged turn the
      // ingress did not start (session.notify submits owner:true, so the
      // router opens it as a prompt and never takes the internal-run
      // promotion branch). Adopt the steer instead of dropping it, otherwise
      // an owner message sent during an operator note never settles: no
      // reply, no ledger row, and a permanent echo in history().tail.
      if (this.admissions.has(turnId)) {
        this.onTurnPromoted(active, turnId);
        return;
      }
      this.deps.logger.write("info", "sdk_session", "steer_merge_unowned", { turnId });
      return;
    }

    if (!this.mergeIntoContext(context, turnId)) {
      this.deps.logger.write("info", "sdk_session", "steer_merge_unowned", { turnId });
      return;
    }
    this.deps.logger.write("info", "sdk_session", "turn_steer_merged", {
      turnId: context.turnId,
      steered: turnId,
    });
  }

  public onSegment(text: string): void {
    const context = this.activeContext;
    if (context === undefined) {
      this.deps.outbox.admit({
        idempotencyKey: `segment:${randomUUID()}`,
        text,
      });
      return;
    }

    context.binding.admit(this.ownerOutbound(context, {
      idempotencyKey: `segment:${randomUUID()}`,
      text,
    }));
    const event = this.emitMessage({
      role: "assistant",
      text: toPlainText(text),
      turnId: context.turnId,
    });
    context.events.push(event);
  }

  public onImage(path: string, caption: string, outcome: SendImageOutcome): void {
    void outcome;
    const context = this.activeContext;
    if (context === undefined) {
      return;
    }

    const event = this.emitMessage({
      role: "assistant",
      image: { path, caption: toPlainText(caption) },
      turnId: context.turnId,
    });
    context.events.push(event);
  }

  public history(limit: number): ChatHistoryResponse {
    const context = this.activeContext;
    const transcript = this.deps.transcript();
    const boundary = this.historyBoundary(transcript, context);
    const history = readOwnerFacingHistory(transcript, limit, boundary, () => new Date());

    const contextIds = new Set<string>();
    const events: OwnerChatEvent[] = [];
    if (context !== undefined) {
      contextIds.add(context.turnId);
      for (const id of context.steered) {
        contextIds.add(id);
      }
      events.push(...context.events.filter((event): event is OwnerChatEvent => event.topic === "chat.message"));
    }

    // Admissions are insertion ordered. A merged admission has already been
    // deleted (or is represented in the current context), so this contributes
    // only echoes that have no owner context yet.
    for (const admission of this.admissions.values()) {
      if (contextIds.has(admission.turnId)) {
        continue;
      }
      const echo = admission.events.find(
        (event): event is OwnerChatEvent => event.topic === "chat.message" && event.payload.role === "owner",
      );
      if (echo !== undefined) {
        events.push(echo);
      }
    }

    const durableReplies: ChatMessage[] = readPersistedOwnerReplies(this.deps.store).map((reply) => ({
      role: "assistant",
      text: toPlainText(reply.text),
      at: reply.at,
      turnId: `internal:${reply.idempotencyKey}`,
      final: true,
    }));
    const mergedHistory = mergeOwnerHistory(history.messages, durableReplies, limit);
    const firstUnmerged = [...this.admissions.values()].find((admission) => !contextIds.has(admission.turnId));
    const inFlight = context === undefined
      ? firstUnmerged === undefined ? undefined : { turnId: firstUnmerged.turnId, typing: true }
      : { turnId: context.turnId, typing: context.typingOn };
    events.sort((left, right) => left.payload.seq - right.payload.seq);

    return applyHistoryByteBudget({
      messages: mergedHistory as unknown as readonly JsonObject[],
      seq: this.deps.hub.lastSeq,
      tail: events,
      ...(inFlight === undefined ? {} : { inFlight }),
    }, MAX_FRAME_BYTES - 4_096);
  }

  public get current(): TurnContext | undefined {
    return this.activeContext;
  }

  private async admitToLane(
    request: OwnerTurnRequest,
    lane: OwnerLane,
    options: { readonly markRead?: boolean },
  ): Promise<AdmitOutcome> {
    const echo = this.emitMessage({
      role: "owner",
      source: request.source,
      text: request.text,
      turnId: request.turnId,
    });
    const admission: Admission = {
      turnId: request.turnId,
      request,
      sources: new Set([request.source]),
      steered: [],
      events: [echo],
      firstSeq: echo.payload.seq,
    };
    this.admissions.set(request.turnId, admission);
    this.laneByAdmission.set(request.turnId, lane);
    void this.presence.typing(request.source, true, request.turnId).catch(() => undefined);

    const turnInput = ownerTurnInput(request);
    const session = lane.session;
    const queued = this.queued;
    let queuedSteerAttempted = false;
    if (queued !== undefined) {
      queuedSteerAttempted = true;
      const outcome = await this.trySteer(session, turnInput);
      if (outcome.kind === "admitted" && this.mergeIntoAdmission(queued, request.turnId)) {
        this.preMerged.add(request.turnId);
        return "steered";
      }
    }
    if (!queuedSteerAttempted && (this.activeContext !== undefined || session.running)) {
      const outcome = await this.trySteer(session, turnInput);
      if (outcome.kind === "admitted") {
        return "steered";
      }
    }

    this.queued = request.turnId;
    if (options.markRead !== false) {
      void this.presence.read(request.source, request.turnId).catch(() => undefined);
    }
    this.deps.logger.write("info", "sdk_session", "turn_started", {
      turnId: request.turnId,
      source: request.source,
    });
    void session.turn(turnInput);
    return "started";
  }

  private async handleOwnerFollowupCommand(
    request: OwnerTurnRequest,
    parsed: OwnerFollowupCommandParseResult,
    options: { readonly markRead?: boolean },
  ): Promise<AdmitOutcome> {
    if (parsed.kind === "invalid") {
      return this.completeOwnerActionCommand(request, parsed.message, options, {
        operation: parsed.operation,
        applied: false,
      });
    }
    const command = parsed.command;
    try {
      const policy = applyOwnerFollowupCommand({
        repository: this.deps.store.assistantWork,
        command,
        provenance: ownerCommandProvenance(request, this.deps.outbox.handle),
        now: new Date().toISOString(),
      });
      return this.completeOwnerActionCommand(
        request,
        ownerFollowupCommandResultText(policy),
        options,
        {
          operation: command.operation,
          applied: true,
          workId: policy.workId,
          actionId: policy.actionId,
          revision: policy.revision,
        },
      );
    } catch (error) {
      return this.completeOwnerActionCommand(
        request,
        `Command was not applied: ${commandErrorMessage(error)}`,
        options,
        {
          operation: command.operation,
          applied: false,
          workId: command.policy.workId,
          actionId: command.policy.actionId,
        },
      );
    }
  }

  private async handleOwnerSendRuleCommand(
    request: OwnerTurnRequest,
    parsed: OwnerSendRuleCommandParseResult,
    options: { readonly markRead?: boolean },
  ): Promise<AdmitOutcome> {
    if (parsed.kind === "invalid") {
      return this.completeOwnerActionCommand(request, parsed.message, options, {
        operation: parsed.operation,
        applied: false,
      });
    }
    const command = parsed.command;
    const existingRule = command.operation === "allow_send"
      ? this.deps.store.assistantWork.getOwnerRule(stableOwnerRuleId(command.matcher))
      : this.deps.store.assistantWork.getOwnerRule(command.ruleId);
    try {
      const rule = applyOwnerSendRuleCommand({
        repository: this.deps.store.assistantWork,
        command,
        provenance: ownerCommandProvenance(request, this.deps.outbox.handle),
        now: new Date().toISOString(),
      });
      return this.completeOwnerActionCommand(
        request,
        ownerSendRuleCommandResultText(command, rule, {
          changed: existingRule?.revision !== rule.revision || existingRule?.state !== rule.state,
        }),
        options,
        {
          operation: command.operation,
          applied: true,
          ruleId: rule.id,
          revision: rule.revision,
        },
      );
    } catch (error) {
      return this.completeOwnerActionCommand(
        request,
        `Command was not applied: ${commandErrorMessage(error)}`,
        options,
        {
          operation: command.operation,
          applied: false,
          ...(command.operation === "revoke_send" ? { ruleId: command.ruleId, revision: command.revision } : {}),
        },
      );
    }
  }

  private async handleOwnerActionCommand(
    request: OwnerTurnRequest,
    parsed: OwnerActionCommandParseResult,
    options: { readonly markRead?: boolean },
  ): Promise<AdmitOutcome> {
    if (parsed.kind === "invalid") {
      return this.completeOwnerActionCommand(request, parsed.message, options, {
        operation: "invalid",
        applied: false,
      });
    }

    const command = parsed.command;
    const provenance = ownerCommandProvenance(request, this.deps.outbox.handle);
    let current: ActionRecord | undefined;
    try {
      current = this.deps.store.assistantWork.getAction(command.actionId);
    } catch (error) {
      return this.completeOwnerActionCommand(
        request,
        `Command was not applied: ${commandErrorMessage(error)}`,
        options,
        { operation: command.operation, applied: false, actionId: command.actionId, revision: command.revision },
      );
    }
    if (current === undefined) {
      return this.completeOwnerActionCommand(
        request,
        `No assistant action exists with ID ${command.actionId}. No command was applied.`,
        options,
        { operation: command.operation, applied: false, actionId: command.actionId, revision: command.revision },
      );
    }
    if (current.revision !== command.revision || current.digest !== command.digest) {
      return this.completeOwnerActionCommand(
        request,
        `Command rejected as stale. Current action ${current.id} is revision ${current.revision} digest ${current.digest} in state ${current.state}.`,
        options,
        { operation: command.operation, applied: false, actionId: command.actionId, revision: command.revision },
      );
    }
    if (command.operation === "approve" && !supportsManagedApproval(current)) {
      return this.completeOwnerActionCommand(
        request,
        `Action ${command.actionId} uses unsupported executor ${current.action}. No approval or effect was applied.`,
        options,
        { operation: command.operation, applied: false, actionId: command.actionId, revision: command.revision },
      );
    }

    if (command.operation === "reject") {
      try {
        this.deps.store.assistantWork.cancelAction({
          actionId: command.actionId,
          revision: command.revision,
          digest: command.digest,
          reason: `authenticated owner rejection (${provenance.evidenceId})`,
        }, new Date().toISOString());
      } catch (error) {
        return this.completeOwnerActionCommand(
          request,
          `Command was not applied: ${commandErrorMessage(error)}`,
          options,
          { operation: command.operation, applied: false, actionId: command.actionId, revision: command.revision },
        );
      }
      return this.completeOwnerActionCommand(
        request,
        `Rejected and cancelled action ${command.actionId} revision ${command.revision} digest ${command.digest}. It was not executed by this command.`,
        options,
        { operation: command.operation, applied: true, actionId: command.actionId, revision: command.revision },
      );
    }
    const lane = this.deps.lanes();
    if (lane === undefined) {
      return this.completeOwnerActionCommand(
        request,
        `Action ${command.actionId} was not approved or executed because the assistant session is unavailable.`,
        options,
        { operation: command.operation, applied: false, actionId: command.actionId, revision: command.revision },
      );
    }

    try {
      this.deps.store.assistantWork.grantExplicitApproval({
        actionId: command.actionId,
        revision: command.revision,
        digest: command.digest,
        provenance,
      }, new Date().toISOString());
    } catch (error) {
      return this.completeOwnerActionCommand(
        request,
        `Command was not applied: ${commandErrorMessage(error)}`,
        options,
        { operation: command.operation, applied: false, actionId: command.actionId, revision: command.revision },
      );
    }

    this.logOwnerActionCommand(request, {
      operation: command.operation,
      applied: true,
      actionId: command.actionId,
      revision: command.revision,
    });
    return this.admitToLane(request, lane, options);
  }

  private async completeOwnerActionCommand(
    request: OwnerTurnRequest,
    reply: string,
    options: { readonly markRead?: boolean },
    fields: {
      readonly operation: OwnerHostCommandOperation;
      readonly applied: boolean;
      readonly workId?: string;
      readonly actionId?: string;
      readonly ruleId?: string;
      readonly revision?: number;
    },
  ): Promise<AdmitOutcome> {
    this.emitMessage({
      role: "owner",
      source: request.source,
      text: request.text,
      turnId: request.turnId,
    });
    if (options.markRead !== false) {
      void this.presence.read(request.source, request.turnId).catch(() => undefined);
    }
    try {
      const binding = this.deps.outbox.bind(request.turnId);
      binding.admit(this.ownerOutboundForRequest(request, {
        idempotencyKey: `owner-command:${request.turnId}`,
        text: reply,
      }));
    } catch (error) {
      this.deps.logger.write("warn", "assistant_work", "owner_action_command_delivery_failed", {
        turnId: request.turnId,
        source: request.source,
        message: commandErrorMessage(error),
      });
    }
    this.emitMessage({
      role: "assistant",
      text: toPlainText(reply),
      turnId: request.turnId,
      final: true,
    });
    this.logOwnerActionCommand(request, fields);
    return "command";
  }

  private logOwnerActionCommand(
    request: OwnerTurnRequest,
    fields: {
      readonly operation: OwnerHostCommandOperation;
      readonly applied: boolean;
      readonly workId?: string;
      readonly actionId?: string;
      readonly ruleId?: string;
      readonly revision?: number;
    },
  ): void {
    this.deps.logger.write(fields.applied ? "info" : "warn", "assistant_work", "owner_action_command", {
      turnId: request.turnId,
      source: request.source,
      ...fields,
    });
  }

  private ownerOutboundForRequest(request: OwnerTurnRequest, outbound: OwnerOutbound): OwnerOutbound {
    return request.replyToGuid === undefined
      ? outbound
      : { ...outbound, replyToGuid: request.replyToGuid };
  }

  private async trySteer(session: MainSession, input: MainTurnInput): Promise<SteerOutcome> {
    try {
      return await session.steer(input);
    } catch (error) {
      return { kind: "not_admitted", reason: "rejected", error };
    }
  }

  private mergeIntoAdmission(targetId: string, sourceId: string): boolean {
    const target = this.admissions.get(targetId);
    const source = this.admissions.get(sourceId);
    if (target === undefined || source === undefined || targetId === sourceId || target.steered.includes(sourceId)) {
      return false;
    }

    target.steered.push(sourceId);
    for (const sourceKind of source.sources) {
      target.sources.add(sourceKind);
    }
    target.events.push(...source.events);
    this.admissions.delete(sourceId);
    this.laneByAdmission.delete(sourceId);
    return true;
  }

  private mergeIntoContext(context: TurnContext, sourceId: string): boolean {
    if (context.turnId === sourceId || context.steered.includes(sourceId)) {
      return false;
    }
    const source = this.admissions.get(sourceId);
    if (source === undefined) {
      return false;
    }

    context.steered.push(sourceId);
    for (const sourceKind of source.sources) {
      context.sources.add(sourceKind);
    }
    context.events.push(...source.events);
    this.admissions.delete(sourceId);
    this.laneByAdmission.delete(sourceId);
    this.preMerged.delete(sourceId);
    if (context.sources.has("imessage")) {
      this.ensureTypingKeepAlive(context);
    }
    return true;
  }

  private settle(context: TurnContext, result: MainTurnResult): void {
    if (this.settledContexts.has(context)) {
      return;
    }
    this.settledContexts.add(context);

    const startedAt = this.startedAt.get(context) ?? Date.now();
    const lane = this.laneByContext.get(context);
    try {
      if (context.kind === "promoted") {
        const text = result.kind === "reply" ? result.text : visibleTurnFailure(result);
        if (text.length > 0) {
          const event = this.emitMessage({
            role: "assistant",
            text: toPlainText(text),
            turnId: context.turnId,
            final: true,
          });
          context.events.push(event);
        }
        return;
      }

      if (context.steered.length > 0) {
        this.deps.logger.write("info", "sdk_session", "turn_merged_steers", {
          turnId: context.turnId,
          steered: [...context.steered],
        });
      }

      if (result.kind === "failed") {
        this.consecutiveTurnFailures += 1;
        if (/401|invalid api key|no credential|unauthori[sz]ed|authentication/i.test(result.message)) {
          setNoCredentialHint(`The AI provider rejected the request (${result.message.slice(0, 80)}). Open Settings → AI account to sign in or paste an API key.`);
        }
      } else {
        this.consecutiveTurnFailures = 0;
        setNoCredentialHint(null);
      }

      if (result.kind === "failed" && this.consecutiveTurnFailures > MAX_CONSECUTIVE_FAILURE_NOTICES) {
        this.deps.logger.write("error", "sdk_session", "turn_failure_notice_suppressed", {
          turnId: context.turnId,
          code: result.code,
          consecutiveTurnFailures: this.consecutiveTurnFailures,
        });
        return;
      }

      lane === undefined ? undefined : this.deps.afterTurn?.(lane.session);
      const text = result.kind === "reply" ? result.text : visibleTurnFailure(result);
      if (text.length > 0) {
        context.binding.admit(this.ownerOutbound(context, {
          idempotencyKey: `inbound-turn:${context.turnId}`,
          text,
          quotedText: context.request.text,
        }));
        const finalEvent = this.emitMessage({
          role: "assistant",
          text: toPlainText(text),
          turnId: context.turnId,
          final: true,
        });
        context.events.push(finalEvent);
      }

      // What the owner actually saw: the final text when there is one, else
      // the streamed segments joined. A reply delivered entirely as segments
      // (the common case since final-after-segments was deduplicated) is a
      // real exchange and must reach the daily memory file, or there is
      // nothing for canonicalization to work from.
      const delivered = text.length > 0 ? text : deliveredSegmentText(context.events);
      const memory = lane?.memory;
      if (memory !== undefined && delivered.length > 0) {
        try {
          memory.enqueueCapture({
            origin: { kind: "owner-chat", reference: context.turnId },
            userText: memoryDigest(context.request.text),
            replyText: memoryDigest(delivered),
            idempotencyKey: `memory:owner-turn:${context.turnId}`,
          });
        } catch (error) {
          this.deps.logger.write("error", "memory", "capture_admission_failed", {
            turnId: context.turnId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (text.length === 0) {
        this.deps.logger.write("info", "sdk_session", "turn_finished", {
          turnId: context.turnId,
          durationMs: Date.now() - startedAt,
          segmentsOnly: true,
          captured: delivered.length > 0,
        });
        return;
      }

      this.deps.logger.write(result.kind === "reply" ? "info" : "warn", "sdk_session", "turn_finished", {
        turnId: context.turnId,
        durationMs: Date.now() - startedAt,
        ...(result.kind === "reply"
          ? { replyBytes: new TextEncoder().encode(result.text).byteLength }
          : { code: result.code }),
      });
      if (result.kind === "failed" && result.code === "watchdog_timeout") {
        this.deps.logger.write("warn", "sdk_session", "watchdog_timeout", {
          turnId: context.turnId,
          durationMs: Date.now() - startedAt,
        });
      }
    } finally {
      context.typingOn = false;
      if (context.typingKeepAlive !== undefined) {
        clearInterval(context.typingKeepAlive);
        context.typingKeepAlive = undefined;
      }
      for (const source of context.sources) {
        void this.presence.typing(source, false, context.turnId, context).catch(() => undefined);
      }
      this.admissions.delete(context.turnId);
      this.laneByAdmission.delete(context.turnId);
      for (const id of context.steered) {
        this.admissions.delete(id);
        this.laneByAdmission.delete(id);
      }
      if (this.activeContext === context) {
        this.activeContext = undefined;
      }
    }
  }

  private ownerOutbound(context: TurnContext, outbound: OwnerOutbound): OwnerOutbound {
    return context.request.replyToGuid === undefined
      ? outbound
      : { ...outbound, replyToGuid: context.request.replyToGuid };
  }

  private emitMessage(message: Omit<ChatMessage, "at">): OwnerChatEvent {
    const at = new Date().toISOString();
    const seq = this.deps.hub.message({ ...message, at });
    const payload: ChatEventPayload = {
      seq,
      role: message.role,
      ...(message.source === undefined ? {} : { source: message.source }),
      ...(message.text === undefined ? {} : { text: message.text }),
      ...(message.image === undefined ? {} : { image: message.image }),
      at,
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      ...(message.final === undefined ? {} : { final: message.final }),
    } as unknown as ChatEventPayload;
    return { topic: "chat.message", payload };
  }

  private ensureTypingKeepAlive(context: TurnContext): void {
    if (!context.sources.has("imessage") || context.typingKeepAlive !== undefined) {
      return;
    }
    const timer = setInterval(() => {
      void this.presence.typing("imessage", true, context.turnId, context).catch(() => undefined);
    }, TYPING_KEEP_ALIVE_MS);
    timer.unref?.();
    context.typingKeepAlive = timer;
  }

  private historyBoundary(transcript: unknown, context: TurnContext | undefined): number | undefined {
    const boundary = context?.transcriptIndex;
    if (context === undefined || (boundary !== undefined && boundary >= 0)) {
      return boundary;
    }
    if (!Array.isArray(transcript)) {
      return boundary;
    }

    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const row = transcript[index] as TranscriptRow | null | undefined;
      if (row?.role !== "user") {
        continue;
      }
      const text = transcriptUserText(row.content);
      if (text === undefined) {
        continue;
      }
      const stripped = stripPanelMarker(stripOrientation(text)).text;
      if (stripped === context.request.text || stripped.trim() === context.request.text.trim()) {
        return index;
      }
    }
    return boundary;
  }
}

interface PresenceRouterDeps {
  readonly hub: ChatHub;
  readonly outbox: OwnerOutbox;
  readonly current: () => TurnContext | undefined;
  readonly now: () => Date;
  readonly onTyping: (source: OwnerSource, on: boolean, context: TurnContext | undefined) => void;
}

/** Routes iMessage presence through a pinned binding and panel presence to the hub. */
class PresenceRouter {
  public constructor(private readonly deps: PresenceRouterDeps) {}

  public async read(source: OwnerSource, turnId?: string, contextOverride?: TurnContext): Promise<boolean> {
    const context = contextOverride ?? this.deps.current();
    if (source === "panel") {
      const resolvedTurnId = turnId ?? context?.turnId;
      if (resolvedTurnId === undefined) {
        return false;
      }
      this.deps.hub.presence({
        source: "panel",
        turnId: resolvedTurnId,
        read: true,
        at: this.deps.now().toISOString(),
      });
      return true;
    }

    const binding = context?.binding ?? (turnId === undefined ? undefined : this.deps.outbox.bind(turnId));
    if (binding === undefined) {
      return false;
    }
    try {
      return await binding.markRead();
    } catch {
      return false;
    }
  }

  public async typing(source: OwnerSource, on: boolean, turnId?: string, contextOverride?: TurnContext): Promise<boolean> {
    const context = contextOverride ?? this.deps.current();
    if (source === "panel") {
      const resolvedTurnId = turnId ?? context?.turnId;
      if (resolvedTurnId === undefined) {
        return false;
      }
      this.deps.hub.presence({
        source: "panel",
        turnId: resolvedTurnId,
        typing: on,
        at: this.deps.now().toISOString(),
      });
      this.deps.onTyping(source, on, context);
      return true;
    }

    const binding = context?.binding ?? (turnId === undefined ? undefined : this.deps.outbox.bind(turnId));
    if (binding === undefined) {
      return false;
    }
    try {
      const result = await binding.setTyping(on);
      this.deps.onTyping(source, on, context);
      return result;
    } catch {
      return false;
    }
  }
}

function ownerTurnInput(request: OwnerTurnRequest): MainTurnInput {
  return {
    owner: true,
    text: request.promptText,
    ...(request.images === undefined || request.images.length === 0 ? {} : { images: [...request.images] }),
    turnId: request.turnId,
  };
}


function transcriptUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) => {
      if (block === null || typeof block !== "object" || Array.isArray(block)) {
        return undefined;
      }
      const candidate = block as { readonly type?: unknown; readonly text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : undefined;
    })
    .filter((part): part is string => part !== undefined)
    .join("\n");
  return text.length === 0 ? undefined : text;
}

/** Assistant text the owner received during a turn as streamed segments, in order. */
function deliveredSegmentText(events: readonly ChatEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.topic !== "chat.message") {
      continue;
    }
    const payload = event.payload as { readonly role?: unknown; readonly text?: unknown; readonly final?: unknown };
    if (payload.role === "assistant" && payload.final !== true && typeof payload.text === "string" && payload.text.length > 0) {
      parts.push(payload.text);
    }
  }
  return parts.join("\n");
}

function memoryDigest(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return Array.from(compact).slice(0, 500).join("");
}

function ownerCommandProvenance(request: OwnerTurnRequest, ownerHandle: string | undefined): EvidenceProvenance {
  return {
    principal: "owner",
    channel: `owner_${request.source}`,
    subject: request.source === "imessage"
      ? ownerHandle ?? "authenticated-owner"
      : "authenticated-local-owner",
    evidenceId: `owner-command:${request.source}:${request.turnId}`,
  };
}

function supportsManagedApproval(action: ActionRecord): boolean {
  if (action.action === MANAGED_LOCAL_FILE_ACTION) return true;
  if (isManagedHttpActionRecord(action)) return true;
  if (isManagedOpaqueToolAction(action)) return true;
  if (action.action !== MANAGED_INSTALL_ACTION) return false;
  try {
    parseManagedInstallPlan(action.payload);
    return true;
  } catch {
    return false;
  }
}

function commandErrorMessage(error: unknown): string {
  return Array.from(error instanceof Error ? error.message : String(error)).slice(0, 500).join("");
}
