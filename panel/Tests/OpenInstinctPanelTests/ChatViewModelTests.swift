import Foundation
@testable import OpenInstinctPanel

@MainActor
enum ChatViewModelChecks {
    static func run() async -> [String] {
        var failures: [String] = []
        failures.append(contentsOf: await historyThenLiveOrder())
        failures.append(contentsOf: await eventBetweenSubscribeAndHistory())
        failures.append(contentsOf: await bufferedWatermark())
        failures.append(contentsOf: await typingState())
        failures.append(contentsOf: await truncatedTailRepair())
        failures.append(contentsOf: await truncatedTailWithoutInFlight())
        failures.append(contentsOf: await reconnectDoesNotDuplicate())
        failures.append(contentsOf: await composerMatrix())
        failures.append(contentsOf: await sendErrorRefreshesStatus())
        failures.append(contentsOf: await suppressedPausedDoesNotAppend())
        failures.append(contentsOf: await resumeClearsPausedBanner())
        return failures
    }

    private static func historyThenLiveOrder() async -> [String] {
        let feed = EventFeed()
        let transport = ChatScriptedTransport(
            responses: [historyFrame(
                messages: [
                    message(role: "owner", text: "first"),
                    message(role: "assistant", text: "reply")
                ],
                seq: 2
            )],
            feeds: [feed]
        )
        let model = ChatViewModel(panel: PanelViewModel(), transport: transport)
        await model.open()
        feed.yield(.chatMessage(message(role: "owner", text: "second", seq: 3, turnId: "turn-2")))
        feed.yield(.chatMessage(message(role: "assistant", text: "last", seq: 4, turnId: "turn-2", final: true)))
        await settle()

        var failures: [String] = []
        if model.messages.map(\.text) != ["first", "reply", "second", "last"] {
            failures.append("history and live chat messages were not rendered in sequence")
        }
        if model.messages.map(\.id) != ["history:0", "history:1", "3", "4"] {
            failures.append("chat rows did not use history:<index> and live sequence ids")
        }
        if model.messages.map(\.isOwner) != [true, false, true, false] {
            failures.append("owner and assistant row alignment flags were incorrect")
        }
        if model.lastSeq != 4 {
            failures.append("live sequence watermark ended at \(model.lastSeq), expected 4")
        }
        model.close()
        return failures
    }

    private static func eventBetweenSubscribeAndHistory() async -> [String] {
        let feed = EventFeed()
        let event = ControlEvent.chatMessage(message(role: "assistant", text: "arrived during history", seq: 2))
        let transport = ChatScriptedTransport(
            responses: [historyFrame(messages: [message(role: "owner", text: "prompt")], seq: 1)],
            feeds: [feed],
            historyYields: [[(feed, event)]]
        )
        let model = ChatViewModel(panel: PanelViewModel(), transport: transport)
        await model.open()
        await settle()

        var failures: [String] = []
        let matches = model.messages.filter { $0.text == "arrived during history" }
        if matches.count != 1 {
            failures.append("event delivered between subscribe ack and history response rendered \(matches.count) times")
        }
        if model.lastSeq != 2 {
            failures.append("between-response event did not advance the watermark")
        }
        model.close()
        return failures
    }

    private static func bufferedWatermark() async -> [String] {
        let feed = EventFeed()
        let old = ControlEvent.chatMessage(message(role: "assistant", text: "already in watermark", seq: 4))
        let fresh = ControlEvent.chatMessage(message(role: "assistant", text: "after watermark", seq: 6))
        let transport = ChatScriptedTransport(
            responses: [historyFrame(messages: [], seq: 5)],
            feeds: [feed],
            historyYields: [[(feed, old), (feed, fresh)]]
        )
        let model = ChatViewModel(panel: PanelViewModel(), transport: transport)
        await model.open()
        await settle()

        var failures: [String] = []
        if model.messages.contains(where: { $0.text == "already in watermark" }) {
            failures.append("buffered event at or below the history watermark was not dropped")
        }
        if model.messages.filter({ $0.text == "after watermark" }).count != 1 {
            failures.append("buffered event above the history watermark was not kept exactly once")
        }
        if model.lastSeq != 6 {
            failures.append("buffered watermark replay ended at \(model.lastSeq), expected 6")
        }
        model.close()
        return failures
    }

    private static func typingState() async -> [String] {
        let feed = EventFeed()
        let transport = ChatScriptedTransport(
            responses: [historyFrame(messages: [], seq: 0, inFlight: ChatInFlightPayload(turnId: "typing-turn", typing: true))],
            feeds: [feed]
        )
        let model = ChatViewModel(panel: PanelViewModel(), transport: transport)
        await model.open()

        var failures: [String] = []
        if !model.typing {
            failures.append("in-flight typing state did not initialise the typing bubble")
        }
        feed.yield(.chatPresence(presence(typing: false, seq: 1)))
        await settle()
        if model.typing {
            failures.append("typing:false presence did not hide the typing bubble")
        }
        feed.yield(.chatPresence(presence(typing: true, seq: 2)))
        await settle()
        if !model.typing {
            failures.append("typing:true presence did not show the typing bubble")
        }
        model.close()
        return failures
    }

    private static func truncatedTailRepair() async -> [String] {
        let feed = EventFeed()
        let first = historyFrame(
            messages: [message(role: "owner", text: "question")],
            seq: 2,
            tail: [message(role: "assistant", text: "partial", seq: 2, turnId: "turn-1")],
            inFlight: ChatInFlightPayload(turnId: "turn-1", typing: true),
            tailTruncated: true
        )
        let repaired = historyFrame(
            messages: [
                message(role: "owner", text: "question"),
                message(role: "assistant", text: "complete")
            ],
            seq: 4
        )
        let transport = ChatScriptedTransport(responses: [first, repaired], feeds: [feed])
        let model = ChatViewModel(panel: PanelViewModel(), transport: transport)
        await model.open()

        var failures: [String] = []
        if model.messages.filter(\.isGap).count != 1 {
            failures.append("tailTruncated did not insert exactly one gap row before repair")
        }
        let before = model.lastSeq
        feed.yield(.chatMessage(message(role: "assistant", text: "complete", seq: 3, turnId: "turn-1", final: true)))
        await settle()
        await settle()

        if model.messages.contains(where: \.isGap) {
            failures.append("repair refetch left the truncated-tail gap row visible")
        }
        if model.messages.filter({ $0.text == "complete" }).count != 1 {
            failures.append("repair refetch duplicated the settled assistant turn")
        }
        if model.lastSeq < before || model.lastSeq != 4 {
            failures.append("repair sequence watermark regressed or ended at \(model.lastSeq), expected 4")
        }
        let requests = await transport.requests()
        if requests.filter({ if case .chatHistory = $0 { return true }; return false }).count != 2 {
            failures.append("final event for a truncated turn did not trigger exactly one history refetch")
        }
        model.close()
        return failures
    }

    private static func truncatedTailWithoutInFlight() async -> [String] {
        let feed = EventFeed()
        let transport = ChatScriptedTransport(
            responses: [
                historyFrame(messages: [message(role: "owner", text: "old")], seq: 1, tailTruncated: true),
                historyFrame(messages: [message(role: "owner", text: "old"), message(role: "assistant", text: "settled")], seq: 2)
            ],
            feeds: [feed]
        )
        let model = ChatViewModel(panel: PanelViewModel(), transport: transport)
        await model.open()
        await settle()

        var failures: [String] = []
        if model.messages.contains(where: \.isGap) {
            failures.append("tailTruncated without inFlight did not immediately refetch")
        }
        if model.messages.map(\.text) != ["old", "settled"] {
            failures.append("immediate truncated-tail repair did not replace the history rows")
        }
        let requests = await transport.requests()
        if requests.filter({ if case .chatHistory = $0 { return true }; return false }).count != 2 {
            failures.append("tailTruncated without inFlight made the wrong number of history requests")
        }
        model.close()
        return failures
    }

    private static func reconnectDoesNotDuplicate() async -> [String] {
        let firstFeed = EventFeed()
        let secondFeed = EventFeed()
        let transport = ChatScriptedTransport(
            responses: [
                historyFrame(
                    messages: [message(role: "owner", text: "question"), message(role: "assistant", text: "partial")],
                    seq: 2,
                    inFlight: ChatInFlightPayload(turnId: "turn-reconnect", typing: true)
                ),
                historyFrame(
                    messages: [message(role: "owner", text: "question"), message(role: "assistant", text: "partial")],
                    seq: 2,
                    inFlight: ChatInFlightPayload(turnId: "turn-reconnect", typing: true)
                )
            ],
            feeds: [firstFeed, secondFeed]
        )
        let model = ChatViewModel(panel: PanelViewModel(), transport: transport)
        await model.open()
        firstFeed.finish(throwing: StreamFailure.closed)
        try? await Task.sleep(nanoseconds: 3_200_000_000)
        await settle()

        var failures: [String] = []
        if model.messages.map(\.text) != ["question", "partial"] {
            failures.append("reconnect replaced the in-flight transcript with duplicates: \(model.messages.map(\.text))")
        }
        if model.lastSeq != 2 {
            failures.append("reconnect did not restore the history watermark")
        }
        model.close()
        return failures
    }

    private static func composerMatrix() async -> [String] {
        var failures: [String] = []
        let offlineTransport = ChatScriptedTransport(fails: true)
        let offlinePanel = PanelViewModel(transport: offlineTransport)
        await offlinePanel.refreshStatus()
        let offlineModel = ChatViewModel(panel: offlinePanel, transport: offlineTransport)
        let offlineDetail = "Gajae isn't running on this Mac right now. Reinstall it, or wait a moment and check again."
        if offlineModel.composerBlock != offlineDetail {
            failures.append("absent daemon composer text did not match the popover offline detail")
        }

        let blockedRemediation = "Sign in to an AI account first."
        let blockedTransport = ChatScriptedTransport(responses: [statusFrame(state: .credentialsBlocked, remediation: blockedRemediation)])
        let blockedPanel = PanelViewModel(transport: blockedTransport)
        await blockedPanel.refreshStatus()
        let blockedModel = ChatViewModel(panel: blockedPanel, transport: blockedTransport)
        await blockedModel.send("must not send")
        if blockedModel.composerBlock != blockedRemediation {
            failures.append("credentials-blocked composer did not use bootstrap remediation")
        }
        if (await blockedTransport.requests()).contains(where: { if case .chatSend = $0 { return true }; return false }) {
            failures.append("credentials-blocked send was not a no-op")
        }

        let pausedTransport = ChatScriptedTransport(responses: [statusFrame(paused: true)])
        let pausedPanel = PanelViewModel(transport: pausedTransport)
        await pausedPanel.refreshStatus()
        let pausedModel = ChatViewModel(panel: pausedPanel, transport: pausedTransport)
        if pausedModel.composerBlock != "Paused" {
            failures.append("paused composer did not expose the Paused block")
        }

        for lane in [ImessageLaneStatus(state: .detached, reason: "no_owner_handle"), ImessageLaneStatus(state: .detached, reason: "fda_denied")] {
            let runningTransport = ChatScriptedTransport(responses: [statusFrame(imessage: lane)])
            let runningPanel = PanelViewModel(transport: runningTransport)
            await runningPanel.refreshStatus()
            let runningModel = ChatViewModel(panel: runningPanel, transport: runningTransport)
            if runningModel.composerBlock != nil {
                failures.append("running daemon blocked the composer on iMessage lane state \(lane.reason ?? "unknown")")
            }
        }

        for state in [BootstrapState.starting, BootstrapState.degraded] {
            let remediation = state == .starting ? "Starting the daemon…" : "The daemon is recovering."
            let feed = EventFeed()
            let transport = ChatScriptedTransport(
                responses: [statusFrame(state: state, remediation: remediation), historyFrame(messages: [], seq: 0)],
                feeds: [feed]
            )
            let panel = PanelViewModel(transport: transport)
            await panel.refreshStatus()
            let model = ChatViewModel(panel: panel, transport: transport)
            await model.open()
            if model.composerBlock != nil {
                failures.append("bootstrap \(state.rawValue) incorrectly blocked the composer")
            }
            if model.banner != remediation {
                failures.append("bootstrap \(state.rawValue) did not expose its remediation banner")
            }
            model.close()
        }
        return failures
    }

    private static func sendErrorRefreshesStatus() async -> [String] {
        let errorMessage = "main session is not running"
        let transport = ChatScriptedTransport(responses: [
            statusFrame(),
            .error(ControlError(id: "send-1", code: .internalError, message: errorMessage)),
            statusFrame()
        ])
        let panel = PanelViewModel(transport: transport)
        await panel.refreshStatus()
        let model = ChatViewModel(panel: panel, transport: transport)
        await model.send("hello")

        var failures: [String] = []
        if model.banner != errorMessage {
            failures.append("send error did not set the server error banner")
        }
        let requests = await transport.requests()
        if requests.count != 3 || !isStatus(requests[0]) || !isChatSend(requests[1]) || !isStatus(requests[2]) {
            failures.append("send error did not refresh status after the chat.send error")
        }
        model.close()
        return failures
    }

    private static func suppressedPausedDoesNotAppend() async -> [String] {
        let transport = ChatScriptedTransport(responses: [
            statusFrame(),
            .response(.chatSend(id: "send-1", payload: ChatSendResponsePayload(turnId: "paused-turn", outcome: "suppressed_paused")))
        ])
        let panel = PanelViewModel(transport: transport)
        await panel.refreshStatus()
        let model = ChatViewModel(panel: panel, transport: transport)
        await model.send("saved while paused")

        var failures: [String] = []
        if !model.messages.isEmpty {
            failures.append("suppressed_paused appended an optimistic owner bubble")
        }
        if model.banner != "Paused" {
            failures.append("suppressed_paused did not show the paused banner")
        }
        model.close()
        return failures
    }

    /// Pause -> resume observed through status polling must clear the banner and
    /// composer block; a resumed daemon that still shows "Paused" is the bug.
    private static func resumeClearsPausedBanner() async -> [String] {
        let transport = ChatScriptedTransport(responses: [
            statusFrame(),
            .response(.chatSend(id: "send-1", payload: ChatSendResponsePayload(turnId: "paused-turn", outcome: "suppressed_paused"))),
            statusFrame(paused: true),
            statusFrame(paused: false),
            statusFrame(state: .credentialsBlocked, remediation: "Sign in first."),
            statusFrame(paused: false),
        ])
        let panel = PanelViewModel(transport: transport)
        await panel.refreshStatus()
        let model = ChatViewModel(panel: panel, transport: transport)
        await model.send("saved while paused")

        var failures: [String] = []
        await panel.refreshStatus()
        model.syncPanelPresentation()
        if model.banner != "Paused" || model.composerBlock != "Paused" {
            failures.append("paused status poll did not keep the Paused banner/composer block")
        }

        await panel.refreshStatus()
        model.syncPanelPresentation()
        if model.banner != nil {
            failures.append("resume status poll left the banner as \(model.banner ?? "nil")")
        }
        if model.composerBlock != nil {
            failures.append("resume status poll left the composer blocked with \(model.composerBlock ?? "nil")")
        }

        await panel.refreshStatus()
        model.syncPanelPresentation()
        if model.banner != "Sign in first." {
            failures.append("blocked status poll did not surface remediation")
        }
        await panel.refreshStatus()
        model.syncPanelPresentation()
        if model.banner != nil {
            failures.append("recovery from blocked did not clear the remediation banner")
        }
        model.close()
        return failures
    }

    private static func settle() async {
        for _ in 0..<8 {
            await Task.yield()
        }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }

    private static func message(
        role: String,
        text: String? = nil,
        seq: Int? = nil,
        turnId: String? = nil,
        final: Bool? = nil
    ) -> ChatMessagePayload {
        ChatMessagePayload(role: role, text: text, at: "2026-01-05T08:00:00.000Z", turnId: turnId, seq: seq, final: final)
    }

    private static func presence(typing: Bool, seq: Int) -> ChatPresencePayload {
        ChatPresencePayload(source: "panel", turnId: "typing-turn", typing: typing, at: "2026-01-05T08:00:00.000Z", seq: seq)
    }

    private static func historyFrame(
        messages: [ChatMessagePayload],
        seq: Int,
        tail: [ChatMessagePayload] = [],
        inFlight: ChatInFlightPayload? = nil,
        tailTruncated: Bool? = nil
    ) -> ControlFrame {
        .response(.chatHistory(
            id: "history-\(seq)-\(UUID().uuidString)",
            payload: ChatHistoryResponsePayload(
                messages: messages,
                seq: seq,
                tail: tail.map { ChatEventPayload(topic: "chat.message", payload: $0) },
                inFlight: inFlight,
                tailTruncated: tailTruncated
            )
        ))
    }

    private static func statusFrame(
        state: BootstrapState = .running,
        remediation: String = "Daemon is ready.",
        paused: Bool = false,
        imessage: ImessageLaneStatus = ImessageLaneStatus(state: .detached)
    ) -> ControlFrame {
        .response(.status(
            id: "status-\(UUID().uuidString)",
            payload: StatusResponsePayload(
                bootstrap: BootstrapStatus(state: state, remediation: remediation, probes: [:]),
                session: SessionStatus(state: .active, mainSessionId: "main", mainSessionFilePresent: true, paused: paused),
                activeChildren: [],
                monitors: [],
                settings: SettingsStatus(),
                imessage: imessage
            )
        ))
    }

    private static func isStatus(_ request: ControlRequest) -> Bool {
        if case .statusGet = request { return true }
        return false
    }

    private static func isChatSend(_ request: ControlRequest) -> Bool {
        if case .chatSend = request { return true }
        return false
    }
}

private enum StreamFailure: Error, Sendable {
    case closed
}

private final class EventFeed: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: AsyncThrowingStream<ControlEvent, Error>.Continuation?
    private var buffered: [ControlEvent] = []
    private var terminal: StreamFailure?
    private var finished = false

    lazy var events: AsyncThrowingStream<ControlEvent, Error> = AsyncThrowingStream { [weak self] continuation in
        guard let self else { return }
        self.lock.lock()
        self.continuation = continuation
        let buffered = self.buffered
        self.buffered.removeAll()
        let finished = self.finished
        let terminal = self.terminal
        self.lock.unlock()
        for event in buffered {
            continuation.yield(event)
        }
        if let terminal {
            continuation.finish(throwing: terminal)
        } else if finished {
            continuation.finish()
        }
    }

    func yield(_ event: ControlEvent) {
        lock.lock()
        if let continuation {
            continuation.yield(event)
        } else if !finished {
            buffered.append(event)
        }
        lock.unlock()
    }

    func finish(throwing error: StreamFailure? = nil) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        finished = true
        terminal = error
        let continuation = self.continuation
        lock.unlock()
        if let error {
            continuation?.finish(throwing: error)
        } else {
            continuation?.finish()
        }
    }
}

private actor ChatScriptedTransport: ControlTransport {
    private var queuedResponses: [ControlFrame]
    private var feeds: [EventFeed]
    private var historyYields: [[(EventFeed, ControlEvent)]]
    private var recordedRequests: [ControlRequest] = []
    private let fails: Bool

    init(
        responses: [ControlFrame] = [],
        feeds: [EventFeed] = [],
        historyYields: [[(EventFeed, ControlEvent)]] = [],
        fails: Bool = false
    ) {
        self.queuedResponses = responses
        self.feeds = feeds
        self.historyYields = historyYields
        self.fails = fails
    }

    func request(_ request: ControlRequest) async throws -> ControlFrame {
        recordedRequests.append(request)
        if fails {
            throw StreamFailure.closed
        }
        // Notification polling is an independent verb and must not consume a
        // history/send/status response scripted for another request.
        if case .assistantNotificationsList(let id) = request {
            return .response(.assistantNotificationsList(
                id: id,
                payload: AssistantNotificationsListResponsePayload(notifications: [])
            ))
        }
        if case .chatHistory = request, !historyYields.isEmpty {
            let actions = historyYields.removeFirst()
            for (feed, event) in actions {
                feed.yield(event)
            }
        }
        guard !queuedResponses.isEmpty else {
            throw StreamFailure.closed
        }
        return queuedResponses.removeFirst()
    }

    func subscribe() async throws -> ChatSubscription {
        if fails {
            throw StreamFailure.closed
        }
        guard !feeds.isEmpty else {
            let stream = AsyncThrowingStream<ControlEvent, Error> { $0.finish() }
            return ChatSubscription(events: stream, cancel: {})
        }
        let feed = feeds.removeFirst()
        return ChatSubscription(events: feed.events, cancel: { feed.finish() })
    }

    func requests() -> [ControlRequest] {
        recordedRequests
    }
}
