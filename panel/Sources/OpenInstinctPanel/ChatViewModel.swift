import Combine
import Foundation

/// A single owner-facing bubble in the shared chat transcript.
public struct ChatRow: Identifiable, Equatable, Sendable {
    public let id: String
    public let role: String
    public let source: String?
    public let text: String?
    public let image: ChatImageRef?
    public let at: String?
    public let turnId: String?
    public let seq: Int?
    public let final: Bool
    public let isOwner: Bool
    public let isGap: Bool

    public init(
        id: String,
        role: String,
        source: String? = nil,
        text: String? = nil,
        image: ChatImageRef? = nil,
        at: String? = nil,
        turnId: String? = nil,
        seq: Int? = nil,
        final: Bool = false,
        isOwner: Bool? = nil,
        isGap: Bool = false
    ) {
        self.id = id
        self.role = role
        self.source = source
        self.text = text
        self.image = image
        self.at = at
        self.turnId = turnId
        self.seq = seq
        self.final = final
        self.isOwner = isOwner ?? (role.lowercased() == "owner" || role.lowercased() == "user")
        self.isGap = isGap
    }

    public static func gap(id: String = "gap") -> ChatRow {
        ChatRow(id: id, role: "gap", text: "Earlier messages are unavailable.", isGap: true)
    }
}

@MainActor
public final class ChatViewModel: ObservableObject {
    @Published public private(set) var messages: [ChatRow] = []
    @Published public private(set) var typing = false
    @Published public private(set) var banner: String?
    @Published public private(set) var sending = false
    @Published public private(set) var pendingNotifications: [AssistantNotification] = []
    @Published public private(set) var notificationError: String?
    @Published public private(set) var notificationsLoading = false
    @Published public private(set) var acknowledgingNotificationIDs = Set<String>()

    /// The sequence watermark is intentionally not part of the view surface, but
    /// remains readable by the panel checks to prove reconnect/repair monotonicity.
    private(set) var lastSeq = 0

    /// The composer is derived from the shared panel state. In particular, the
    /// iMessage lane is deliberately absent from this decision.
    public var composerBlock: String? {
        if panel.connectionState == .absent {
            return Self.offlineDetail
        }
        guard let status = panel.status else {
            return nil
        }
        if status.bootstrap.state == .credentialsBlocked {
            return status.bootstrap.remediation
        }
        if status.session.paused {
            return "Paused"
        }
        return nil
    }

    private static let offlineDetail = "Gajae isn't running on this Mac right now. Reinstall it, or wait a moment and check again."
    private static let notificationLoadError = "알림을 불러오지 못했습니다. 다시 시도해 주세요."
    private static let notificationAckError = "알림을 확인 처리하지 못했습니다. 다시 시도해 주세요."

    private let panel: PanelViewModel
    private let transport: any ControlTransport
    private var subscription: ChatSubscription?
    private var streamTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var pending: [ControlEvent] = []
    private var loaded = false
    private var openState = false
    private var repairTurnId: String?
    private var repairDue = false
    private var pendingActivitySample: ChatActivitySample?
    private var activityTask: Task<Void, Never>?
    private var notificationRefreshPending = false
    private var acknowledgementRefreshPending = false
    private var renderedNotificationIDs = Set<String>()
    private var notificationRenderTasks: [String: Task<Void, Never>] = [:]

    public init(panel: PanelViewModel, transport: any ControlTransport = UnixSocketTransport()) {
        self.panel = panel
        self.transport = transport
    }

    /// Opens the lossless subscription/history view and returns once the first
    /// history response (including any required repair refetch) has settled.
    public func open() async {
        guard !openState else { return }
        openState = true
        loaded = false
        pending.removeAll()
        repairTurnId = nil
        repairDue = false
        startStatusPolling()
        syncPanelPresentation()
        await establishConnection()
        await refreshNotifications()
    }

    public func send(_ text: String) async {
        guard composerBlock == nil else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        sending = true
        defer { sending = false }

        let request = ControlRequest.chatSend(
            id: requestID(),
            payload: ChatSendPayload(text: text)
        )
        do {
            let frame = try await transport.request(request)
            switch frame {
            case .response(.chatSend(_, let payload)):
                if payload.outcome == "suppressed_paused" {
                    banner = "Paused"
                }
            case .error(let error):
                await panel.refreshStatus()
                syncPanelPresentation()
                banner = error.message
            default:
                banner = ChatViewModelError.unexpectedResponse.localizedDescription
            }
        } catch {
            await panel.refreshStatus()
            syncPanelPresentation()
            banner = error.localizedDescription
        }
    }

    private func scheduleNotificationRefresh() {
        if notificationsLoading {
            notificationRefreshPending = true
            return
        }
        Task { [weak self] in
            await self?.refreshNotifications()
        }
    }

    public func refreshNotifications() async {
        guard !notificationsLoading else {
            notificationRefreshPending = true
            return
        }
        notificationsLoading = true
        defer {
            notificationsLoading = false
            if notificationRefreshPending || acknowledgementRefreshPending {
                notificationRefreshPending = false
                acknowledgementRefreshPending = false
                scheduleNotificationRefresh()
            }
        }

        do {
            let frame = try await transport.request(.assistantNotificationsList(id: requestID()))
            switch frame {
            case .response(.assistantNotificationsList(_, let payload)):
                pendingNotifications = payload.notifications.filter { !$0.acknowledged }
                notificationError = nil
            case .error:
                notificationError = Self.notificationLoadError
            default:
                notificationError = Self.notificationLoadError
            }
        } catch {
            notificationError = Self.notificationLoadError
        }
    }

    public func acknowledgeNotification(_ notificationID: String) async {
        guard !notificationID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            notificationError = Self.notificationAckError
            return
        }
        guard !acknowledgingNotificationIDs.contains(notificationID) else { return }
        acknowledgingNotificationIDs.insert(notificationID)
        defer { acknowledgingNotificationIDs.remove(notificationID) }
        acknowledgementRefreshPending = true

        do {
            let frame = try await transport.request(.assistantNotificationsAck(
                id: requestID(),
                payload: AssistantNotificationAckPayload(notificationId: notificationID)
            ))
            switch frame {
            case .response(.assistantNotificationsAck(_, let payload)) where payload.acknowledged:
                notificationError = nil
                if notificationsLoading {
                    notificationRefreshPending = true
                } else {
                    acknowledgementRefreshPending = false
                    await refreshNotifications()
                }
            case .error:
                acknowledgementRefreshPending = false
                notificationError = Self.notificationAckError
            default:
                acknowledgementRefreshPending = false
                notificationError = Self.notificationAckError
            }
        } catch {
            acknowledgementRefreshPending = false
            notificationError = Self.notificationAckError
        }
    }

    public func reportNotificationRendered(_ notificationID: String) {
        guard !notificationID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !renderedNotificationIDs.contains(notificationID),
              notificationRenderTasks[notificationID] == nil else { return }
        notificationRenderTasks[notificationID] = Task { [weak self] in
            guard let self else { return }
            await self.reportNotificationRenderedUntilSuccessful(notificationID)
        }
    }

    private func reportNotificationRenderedUntilSuccessful(_ notificationID: String) async {
        defer { notificationRenderTasks[notificationID] = nil }
        while openState,
              pendingNotifications.contains(where: { $0.id == notificationID }),
              !Task.isCancelled {
            if await sendNotificationRendered(notificationID) {
                renderedNotificationIDs.insert(notificationID)
                return
            }
            do {
                try await Task.sleep(nanoseconds: 5_000_000_000)
            } catch {
                return
            }
        }
    }

    private func sendNotificationRendered(_ notificationID: String) async -> Bool {
        do {
            let frame = try await transport.request(.assistantNotificationsRendered(
                id: requestID(),
                payload: AssistantNotificationRenderedPayload(notificationId: notificationID)
            ))
            if case .response(.assistantNotificationsRendered(_, let payload)) = frame {
                return payload.rendered
            }
        } catch {
            // Retried while the notification row remains visible.
        }
        return false
    }

    /// Coalesces periodic native samples while one socket request is in flight.
    /// The worker is intentionally independent of the chat subscription lifecycle
    /// so the final inactive sample can drain after the window closes.
    public func reportActivity(_ sample: ChatActivitySample) {
        pendingActivitySample = sample
        guard activityTask == nil else { return }
        activityTask = Task { [self] in
            await drainActivityReports()
        }
    }

    public func close() {
        openState = false
        loaded = false
        pending.removeAll()
        pollTask?.cancel()
        pollTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        tearDownConnection()
        for task in notificationRenderTasks.values {
            task.cancel()
        }
        notificationRenderTasks.removeAll()
    }

    private func drainActivityReports() async {
        while let sample = pendingActivitySample {
            pendingActivitySample = nil
            do {
                try await sendActivity(sample)
            } catch {
                // Activity is best-effort metadata and must not disrupt Chat UI.
                // A newer queued sample, especially the close sample, still drains.
            }
        }
        activityTask = nil
    }

    private func sendActivity(_ sample: ChatActivitySample) async throws {
        let frame = try await transport.request(.chatActivity(
            id: requestID(),
            payload: ChatActivityPayload(
                frontmost: sample.frontmost,
                lastInputAgeSeconds: sample.lastInputAgeSeconds
            )
        ))
        switch frame {
        case .response(.chatActivity(_, let payload)) where payload.recorded:
            return
        case .error(let error):
            throw ChatViewModelError.server(error.message)
        default:
            throw ChatViewModelError.unexpectedResponse
        }
    }

    private func establishConnection() async {
        guard openState else { return }
        tearDownConnection()
        loaded = false
        pending.removeAll()

        do {
            let sub = try await transport.subscribe()
            guard openState else {
                sub.cancel()
                return
            }
            subscription = sub
            let events = sub.events
            streamTask = Task { [weak self] in
                guard let self else { return }
                await self.consume(events)
            }
            try await loadHistory(resetWatermark: true)
        } catch {
            guard openState else { return }
            banner = error.localizedDescription
            tearDownConnection()
            scheduleReconnect()
        }
    }

    private func consume(_ events: AsyncThrowingStream<ControlEvent, Error>) async {
        do {
            for try await event in events {
                guard openState else { return }
                if !loaded {
                    pending.append(event)
                    continue
                }
                if apply(event) {
                    await repairIfNeeded()
                }
            }
        } catch {
            guard openState, !Task.isCancelled else { return }
            scheduleReconnect()
        }
    }

    private func loadHistory(resetWatermark: Bool) async throws {
        guard openState else { return }
        let previousWatermark = lastSeq
        loaded = false

        let history = try await requestHistory()
        guard openState else { return }

        // (i) Replace history rows before touching the sequence watermark.
        messages = history.messages.enumerated().map { index, payload in
            row(from: payload, id: "history:\(index)")
        }
        lastSeq = resetWatermark ? 0 : previousWatermark

        // (ii) Arm repair before replaying either tail or buffered events.
        repairTurnId = nil
        repairDue = false
        if history.tailTruncated == true {
            repairTurnId = history.inFlight?.turnId
            messages.append(.gap())
            if repairTurnId == nil {
                repairDue = true
            }
        }

        // (iii) Replay the daemon tail, then buffered events in sequence order.
        let tail = history.tail.map { ControlEvent.chatMessage($0.payload) }
        for event in sortedBySequence(tail) {
            _ = apply(event)
        }

        let buffered = pending
        pending.removeAll()
        let pendingWatermark = max(lastSeq, history.seq)
        for event in sortedBySequence(buffered) {
            guard let seq = sequence(of: event), seq > pendingWatermark else { continue }
            _ = apply(event)
        }

        lastSeq = max(lastSeq, history.seq)
        typing = history.inFlight?.typing ?? false
        loaded = true

        // (iv) A truncated tail is repaired only after the initial snapshot and
        // replay have been made visible. Refetch keeps the current watermark so
        // settled tail events cannot be appended a second time.
        await repairIfNeeded()
    }

    private func repairIfNeeded() async {
        guard openState, repairDue else { return }
        repairDue = false
        repairTurnId = nil
        do {
            try await loadHistory(resetWatermark: false)
        } catch {
            guard openState else { return }
            banner = error.localizedDescription
            tearDownConnection()
            scheduleReconnect()
        }
    }

    private func requestHistory() async throws -> ChatHistoryResponsePayload {
        let frame = try await transport.request(
            .chatHistory(id: requestID(), payload: ChatHistoryPayload(limit: 50))
        )
        switch frame {
        case .response(.chatHistory(_, let payload)):
            return payload
        case .error(let error):
            throw ChatViewModelError.server(error.message)
        default:
            throw ChatViewModelError.unexpectedResponse
        }
    }

    /// Returns true when this event completed the turn whose truncated tail is
    /// represented by the gap row.
    @discardableResult
    private func apply(_ event: ControlEvent) -> Bool {
        guard let seq = sequence(of: event), seq > lastSeq else { return false }
        switch event {
        case .chatMessage(let payload):
            lastSeq = seq
            append(row(from: payload, id: String(seq)))
            if !isOwner(payload) {
                typing = false
            }
            if payload.final == true, payload.turnId == repairTurnId {
                repairDue = true
                return true
            }
        case .chatPresence(let payload):
            lastSeq = seq
            if let nextTyping = payload.typing {
                typing = nextTyping
            }
        default:
            break
        }
        return false
    }

    private func append(_ row: ChatRow) {
        guard let seq = row.seq else {
            let gapIndex = messages.firstIndex(where: \.isGap) ?? messages.endIndex
            messages.insert(row, at: gapIndex)
            return
        }

        // History rows have no sequence and stay before live rows. A gap stays
        // last until the repair refetch removes it.
        let end = messages.firstIndex(where: \.isGap) ?? messages.endIndex
        let insertion = messages[..<end].firstIndex { existing in
            guard let existingSeq = existing.seq else { return false }
            return existingSeq > seq
        } ?? end
        messages.insert(row, at: insertion)
    }

    private func row(from payload: ChatMessagePayload, id: String) -> ChatRow {
        ChatRow(
            id: id,
            role: payload.role,
            source: payload.source,
            text: payload.text,
            image: payload.image,
            at: payload.at,
            turnId: payload.turnId,
            seq: payload.seq,
            final: payload.final ?? false,
            isOwner: isOwner(payload)
        )
    }

    private func isOwner(_ payload: ChatMessagePayload) -> Bool {
        let role = payload.role.lowercased()
        return role == "owner" || role == "user"
    }

    private func sequence(of event: ControlEvent) -> Int? {
        switch event {
        case .chatMessage(let payload): return payload.seq
        case .chatPresence(let payload): return payload.seq
        default: return nil
        }
    }

    private func sortedBySequence(_ events: [ControlEvent]) -> [ControlEvent] {
        events.enumerated().sorted { lhs, rhs in
            let left = sequence(of: lhs.element) ?? Int.max
            let right = sequence(of: rhs.element) ?? Int.max
            if left == right { return lhs.offset < rhs.offset }
            return left < right
        }.map(\.element)
    }

    private func startStatusPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while let self, self.openState, !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 5_000_000_000)
                } catch {
                    return
                }
                guard self.openState, !Task.isCancelled else { return }
                await self.panel.refreshStatus()
                self.syncPanelPresentation()
                await self.refreshNotifications()
            }
        }
    }

    /// The banner is derived from panel status on every poll so a state
    /// transition (paused -> running, blocked -> running, absent -> back) clears
    /// it without reopening the window. Transient send/stream errors set it
    /// directly and are cleared here on the next healthy poll.
    func syncPanelPresentation() {
        if panel.connectionState == .absent {
            if banner == nil {
                banner = Self.offlineDetail
            }
            objectWillChange.send()
            return
        }
        guard let status = panel.status else {
            objectWillChange.send()
            return
        }
        switch status.bootstrap.state {
        case .starting, .configBlocked, .identityBlocked, .permissionBlocked, .credentialsBlocked, .degraded:
            banner = status.bootstrap.remediation
        case .running:
            banner = status.session.paused ? "Paused" : nil
        }
        objectWillChange.send()
    }

    private func scheduleReconnect() {
        guard openState, reconnectTask == nil else { return }
        reconnectTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 3_000_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled, let self, self.openState else { return }
            self.reconnectTask = nil
            await self.establishConnection()
        }
    }

    private func tearDownConnection() {
        streamTask?.cancel()
        streamTask = nil
        subscription?.cancel()
        subscription = nil
    }

    private func requestID() -> String {
        UUID().uuidString.lowercased()
    }
}

private enum ChatViewModelError: LocalizedError {
    case unexpectedResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .unexpectedResponse:
            return "The daemon returned an unexpected control response."
        case .server(let message):
            return message
        }
    }
}
