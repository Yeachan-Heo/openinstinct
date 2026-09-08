import Foundation

public enum ControlCodecError: Error, LocalizedError, Sendable {
    case invalidFrame(String)

    public var errorDescription: String? {
        switch self {
        case .invalidFrame(let message):
            return message
        }
    }
}

public enum ControlCapability: String, Codable, Sendable, Equatable {
    case statusGet = "status.get"
    case monitorsList = "monitors.list"
    case monitorsToggle = "monitors.toggle"
    case monitorsRun = "monitors.run"
    case monitorsDelete = "monitors.delete"
    case sessionReload = "session.reload"
    case sessionReset = "session.reset"
    case sessionNotify = "session.notify"
    case chatSend = "chat.send"
    case chatHistory = "chat.history"
    case chatSubscribe = "chat.subscribe"
    case chatActivity = "chat.activity"
    case assistantNotificationsList = "assistant.notifications.list"
    case assistantNotificationsAck = "assistant.notifications.ack"
    case assistantNotificationsRendered = "assistant.notifications.rendered"
    case settingsGet = "settings.get"
    case settingsSet = "settings.set"
    case modelsList = "models.list"
    case accountsList = "accounts.list"
    case accountsLogin = "accounts.login"
    case accountsLogout = "accounts.logout"
    case accountsLoginFinish = "accounts.login.finish"
    case accountsProviders = "accounts.providers"
    case accountsDiscover = "accounts.discover"
    case accountsAdopt = "accounts.adopt"
    case providersCustom = "providers.custom"
    case daemonRestart = "daemon.restart"
    case browserOpen = "browser.open"
    case daemonPause = "daemon.pause"
    case daemonResume = "daemon.resume"
    case sessionCompact = "session.compact"
    case sessionCompactStatus = "session.compact.status"
    case maintenanceRun = "maintenance.run"
    case memoryBackfillCaptures = "memory.backfillCaptures"
}

public enum ControlErrorCode: String, Codable, Sendable, Equatable {
    case bufferTooLarge = "buffer_too_large"
    case duplicateRequestID = "duplicate_request_id"
    case frameTooLarge = "frame_too_large"
    case helloRequired = "hello_required"
    case incompatibleVersion = "incompatible_version"
    case internalError = "internal_error"
    case invalidFrame = "invalid_frame"
    case malformedJSON = "malformed_json"
    case monitorBusy = "monitor_busy"
    case monitorNotFound = "monitor_not_found"
    case monitorProtected = "monitor_protected"
    case revisionConflict = "revision_conflict"
    case verbUnknown = "verb_unknown"
}

public enum BootstrapState: String, Codable, Sendable, Equatable {
    case starting
    case configBlocked = "config_blocked"
    case permissionBlocked = "permission_blocked"
    case identityBlocked = "identity_blocked"
    case credentialsBlocked = "credentials_blocked"
    case running
    case degraded
}

public enum SessionRuntimeState: String, Codable, Sendable, Equatable {
    case active
    case inactive
}

public enum ChildKind: String, Codable, Sendable, Equatable {
    case taskTool = "task_tool"
    case daemon
}

public enum ChildState: String, Codable, Sendable, Equatable {
    case requested
    case admitted
    case running
    case idle
    case cold
    case completed
    case failed
    case timeout
    case cancelled
    case orphaned
    case terminated
}

public enum CompactAcceptanceState: String, Codable, Sendable, Equatable {
    case accepted
    case alreadyRunning = "already_running"
}

public enum CompactOperationState: String, Codable, Sendable, Equatable {
    case running
    case succeeded
    case failed
    case canceled
}

public struct EmptyPayload: Codable, Sendable, Equatable {
    public init() {}

    public init(from decoder: Decoder) throws {
        _ = try decoder.container(keyedBy: EmptyCodingKeys.self)
    }

    public func encode(to encoder: Encoder) throws {
        _ = encoder.container(keyedBy: EmptyCodingKeys.self)
    }
}

public struct HelloFrame: Codable, Sendable, Equatable {
    public let v: Int
    public let client: String

    public init(v: Int = 1, client: String) {
        self.v = v
        self.client = client
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: FrameCodingKeys.self)
        try require(try container.decode(String.self, forKey: .type), equals: "hello", named: "frame.type")
        v = try container.decode(Int.self, forKey: .v)
        try require(v == 1, named: "hello.v must equal 1")
        client = try container.decode(String.self, forKey: .client)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: FrameCodingKeys.self)
        try container.encode("hello", forKey: .type)
        try container.encode(v, forKey: .v)
        try container.encode(client, forKey: .client)
    }
}

public struct NegotiatedFrame: Codable, Sendable, Equatable {
    public let v: Int
    public let capabilities: [ControlCapability]

    public init(v: Int = 1, capabilities: [ControlCapability]) {
        self.v = v
        self.capabilities = capabilities
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: FrameCodingKeys.self)
        try require(try container.decode(String.self, forKey: .type), equals: "negotiated", named: "frame.type")
        v = try container.decode(Int.self, forKey: .v)
        try require(v == 1, named: "negotiated.v must equal 1")
        capabilities = try container.decode([ControlCapability].self, forKey: .capabilities)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: FrameCodingKeys.self)
        try container.encode("negotiated", forKey: .type)
        try container.encode(v, forKey: .v)
        try container.encode(capabilities, forKey: .capabilities)
    }
}

public struct MonitorTogglePayload: Codable, Sendable, Equatable {
    public let id: String
    public let enabled: Bool
    public let expectedRevision: Int

    public init(id: String, enabled: Bool, expectedRevision: Int) {
        self.id = id
        self.enabled = enabled
        self.expectedRevision = expectedRevision
    }
}

public struct SessionCompactPayload: Codable, Sendable, Equatable {
    public let requestKey: String

    public init(requestKey: String) {
        self.requestKey = requestKey
    }
}

public struct SessionCompactStatusRequestPayload: Codable, Sendable, Equatable {
    public let operationId: String

    public init(operationId: String) {
        self.operationId = operationId
    }
}

public struct MonitorDeletePayload: Codable, Sendable, Equatable {
    public let id: String
    public let expectedRevision: Int

    public init(id: String, expectedRevision: Int) {
        self.id = id
        self.expectedRevision = expectedRevision
    }
}

public struct SettingsSetPayload: Codable, Sendable, Equatable {
    public let patch: [String: JSONValue]
    public init(patch: [String: JSONValue]) { self.patch = patch }
}
/// `refresh` is omitted on the wire when false so the request stays byte-identical to the historical `{}` payload.
public struct ModelsListPayload: Codable, Sendable, Equatable {
    public let refresh: Bool
    public init(refresh: Bool = false) { self.refresh = refresh }
    private enum CodingKeys: String, CodingKey { case refresh }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        refresh = try container.decodeIfPresent(Bool.self, forKey: .refresh) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if refresh { try container.encode(true, forKey: .refresh) }
    }
}
public struct AccountsLoginPayload: Codable, Sendable, Equatable {
    public let provider: String
    public init(provider: String) { self.provider = provider }
}
public struct MonitorRunPayload: Codable, Sendable, Equatable {
    public let id: String
    public init(id: String) { self.id = id }
}

public struct SessionNotifyPayload: Codable, Sendable, Equatable {
    public let text: String
    public init(text: String) { self.text = text }
}

public struct ChatSendPayload: Codable, Sendable, Equatable {
    public let text: String

    public init(text: String) {
        self.text = text
    }
}

public struct ChatHistoryPayload: Codable, Sendable, Equatable {
    public let limit: Int

    public init(limit: Int) {
        self.limit = limit
    }
}

public struct ChatActivityPayload: Codable, Sendable, Equatable {
    public let frontmost: Bool
    public let lastInputAgeSeconds: Double?

    public init(frontmost: Bool, lastInputAgeSeconds: Double?) {
        self.frontmost = frontmost
        self.lastInputAgeSeconds = lastInputAgeSeconds
    }

    private enum CodingKeys: String, CodingKey {
        case frontmost
        case lastInputAgeSeconds
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        frontmost = try container.decode(Bool.self, forKey: .frontmost)
        guard container.contains(.lastInputAgeSeconds) else {
            throw ControlCodecError.invalidFrame("chat.activity.lastInputAgeSeconds must be a nonnegative finite number or null")
        }
        if try container.decodeNil(forKey: .lastInputAgeSeconds) {
            lastInputAgeSeconds = nil
            return
        }
        let age = try container.decode(Double.self, forKey: .lastInputAgeSeconds)
        guard age.isFinite, age >= 0 else {
            throw ControlCodecError.invalidFrame("chat.activity.lastInputAgeSeconds must be a nonnegative finite number or null")
        }
        lastInputAgeSeconds = age
    }

    public func encode(to encoder: Encoder) throws {
        if let lastInputAgeSeconds, !lastInputAgeSeconds.isFinite || lastInputAgeSeconds < 0 {
            throw ControlCodecError.invalidFrame("chat.activity.lastInputAgeSeconds must be a nonnegative finite number or null")
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(frontmost, forKey: .frontmost)
        if let lastInputAgeSeconds {
            try container.encode(lastInputAgeSeconds, forKey: .lastInputAgeSeconds)
        } else {
            try container.encodeNil(forKey: .lastInputAgeSeconds)
        }
    }
}

public struct AssistantNotificationAckPayload: Codable, Sendable, Equatable {
    public let notificationId: String

    public init(notificationId: String) {
        self.notificationId = notificationId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let object = try container.decode([String: String].self)
        guard object.count == 1, let notificationId = object["notificationId"], !notificationId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ControlCodecError.invalidFrame("assistant.notifications.ack.notificationId must be a non-empty string")
        }
        self.notificationId = notificationId
    }

    public func encode(to encoder: Encoder) throws {
        guard !notificationId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ControlCodecError.invalidFrame("assistant.notifications.ack.notificationId must be a non-empty string")
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(notificationId, forKey: .notificationId)
    }

    private enum CodingKeys: String, CodingKey {
        case notificationId
    }
}

public struct AssistantNotificationRenderedPayload: Codable, Sendable, Equatable {
    public let notificationId: String

    public init(notificationId: String) {
        self.notificationId = notificationId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let object = try container.decode([String: String].self)
        guard object.count == 1, let notificationId = object["notificationId"], !notificationId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ControlCodecError.invalidFrame("assistant.notifications.rendered.notificationId must be a non-empty string")
        }
        self.notificationId = notificationId
    }

    public func encode(to encoder: Encoder) throws {
        guard !notificationId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ControlCodecError.invalidFrame("assistant.notifications.rendered.notificationId must be a non-empty string")
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(notificationId, forKey: .notificationId)
    }

    private enum CodingKeys: String, CodingKey {
        case notificationId
    }
}
public struct AccountsLoginFinishPayload: Codable, Sendable, Equatable {
    public let code: String
    public init(code: String) { self.code = code }
}
public struct ProvidersCustomPayload: Codable, Sendable, Equatable {
    public let id: String
    public let baseUrl: String
    public let api: String
    public let apiKey: String
    public let model: String
    public init(id: String, baseUrl: String, api: String, apiKey: String, model: String) { self.id = id; self.baseUrl = baseUrl; self.api = api; self.apiKey = apiKey; self.model = model }
}
public struct AccountsLogoutPayload: Codable, Sendable, Equatable {
    public let provider: String
    public let account: String
    public init(provider: String, account: String) { self.provider = provider; self.account = account }
}
public struct AccountsAdoptPayload: Codable, Sendable, Equatable {
    public let id: String
    public init(id: String) { self.id = id }
}

public enum ControlRequest: Codable, Sendable, Equatable {
    case statusGet(id: String)
    case monitorsList(id: String)
    case monitorsToggle(id: String, payload: MonitorTogglePayload)
    case monitorsRun(id: String, payload: MonitorRunPayload)
    case monitorsDelete(id: String, payload: MonitorDeletePayload)
    case daemonPause(id: String)
    case daemonResume(id: String)
    case sessionCompact(id: String, payload: SessionCompactPayload)
    case sessionCompactStatus(id: String, payload: SessionCompactStatusRequestPayload)
    case maintenanceRun(id: String)
    case memoryBackfillCaptures(id: String)
    case sessionReload(id: String)
    case sessionReset(id: String)
    case sessionNotify(id: String, payload: SessionNotifyPayload)
    case chatSend(id: String, payload: ChatSendPayload)
    case chatHistory(id: String, payload: ChatHistoryPayload)
    case chatSubscribe(id: String)
    case chatActivity(id: String, payload: ChatActivityPayload)
    case assistantNotificationsList(id: String)
    case assistantNotificationsAck(id: String, payload: AssistantNotificationAckPayload)
    case assistantNotificationsRendered(id: String, payload: AssistantNotificationRenderedPayload)
    case settingsGet(id: String)
    case settingsSet(id: String, payload: SettingsSetPayload)
    case modelsList(id: String, payload: ModelsListPayload = ModelsListPayload())
    case accountsList(id: String)
    case accountsLogin(id: String, payload: AccountsLoginPayload)
    case accountsLogout(id: String, payload: AccountsLogoutPayload)
    case accountsLoginFinish(id: String, payload: AccountsLoginFinishPayload)
    case accountsProviders(id: String)
    case accountsDiscover(id: String)
    case accountsAdopt(id: String, payload: AccountsAdoptPayload)
    case providersCustom(id: String, payload: ProvidersCustomPayload)
    case daemonRestart(id: String)
    case browserOpen(id: String)

    public var id: String {
        switch self {
        case .statusGet(let id), .monitorsList(let id), .daemonPause(let id), .daemonResume(let id), .maintenanceRun(let id), .memoryBackfillCaptures(let id), .sessionReload(let id), .sessionReset(let id):
            return id
        case .settingsGet(let id), .modelsList(let id, _), .accountsList(let id), .daemonRestart(let id), .browserOpen(let id), .accountsProviders(let id):
            return id
        case .accountsDiscover(let id):
            return id
        case .settingsSet(let id, _), .accountsLogin(let id, _), .accountsLogout(let id, _), .accountsLoginFinish(let id, _), .providersCustom(let id, _), .sessionNotify(let id, _), .chatSend(let id, _), .chatHistory(let id, _), .chatActivity(let id, _), .assistantNotificationsAck(let id, _), .assistantNotificationsRendered(let id, _), .chatSubscribe(let id):
            return id
        case .assistantNotificationsList(let id):
            return id
        case .accountsAdopt(let id, _):
            return id
        case .monitorsToggle(let id, _), .monitorsRun(let id, _), .monitorsDelete(let id, _), .sessionCompact(let id, _), .sessionCompactStatus(let id, _):
            return id
        }
    }

    public var capability: ControlCapability {
        switch self {
        case .statusGet:
            return .statusGet
        case .monitorsList:
            return .monitorsList
        case .monitorsToggle:
            return .monitorsToggle
        case .monitorsRun:
            return .monitorsRun
        case .monitorsDelete:
            return .monitorsDelete
        case .sessionReload:
            return .sessionReload
        case .sessionReset: return .sessionReset
        case .sessionNotify: return .sessionNotify
        case .chatSend: return .chatSend
        case .chatHistory: return .chatHistory
        case .chatSubscribe: return .chatSubscribe
        case .chatActivity: return .chatActivity
        case .assistantNotificationsList: return .assistantNotificationsList
        case .assistantNotificationsAck: return .assistantNotificationsAck
        case .assistantNotificationsRendered: return .assistantNotificationsRendered
        case .settingsGet: return .settingsGet
        case .settingsSet: return .settingsSet
        case .modelsList: return .modelsList
        case .accountsList: return .accountsList
        case .accountsLogin: return .accountsLogin
        case .accountsLogout: return .accountsLogout
        case .accountsLoginFinish: return .accountsLoginFinish
        case .accountsProviders: return .accountsProviders
        case .accountsDiscover: return .accountsDiscover
        case .accountsAdopt: return .accountsAdopt
        case .providersCustom: return .providersCustom
        case .daemonRestart: return .daemonRestart
        case .browserOpen: return .browserOpen
        case .daemonPause:
            return .daemonPause
        case .daemonResume:
            return .daemonResume
        case .sessionCompact:
            return .sessionCompact
        case .sessionCompactStatus:
            return .sessionCompactStatus
        case .maintenanceRun:
            return .maintenanceRun
        case .memoryBackfillCaptures:
            return .memoryBackfillCaptures
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: FrameCodingKeys.self)
        try require(try container.decode(String.self, forKey: .type), equals: "request", named: "frame.type")
        let id = try container.decode(String.self, forKey: .id)
        let verb = try container.decode(ControlCapability.self, forKey: .verb)
        switch verb {
        case .statusGet:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .statusGet(id: id)
        case .monitorsList:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .monitorsList(id: id)
        case .monitorsToggle:
            self = .monitorsToggle(id: id, payload: try container.decode(MonitorTogglePayload.self, forKey: .payload))
        case .monitorsRun:
            self = .monitorsRun(id: id, payload: try container.decode(MonitorRunPayload.self, forKey: .payload))
        case .monitorsDelete:
            self = .monitorsDelete(id: id, payload: try container.decode(MonitorDeletePayload.self, forKey: .payload))
        case .daemonPause:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .daemonPause(id: id)
        case .daemonResume:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .daemonResume(id: id)
        case .sessionReload:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .sessionReload(id: id)
        case .sessionReset:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .sessionReset(id: id)
        case .sessionNotify:
            self = .sessionNotify(id: id, payload: try container.decode(SessionNotifyPayload.self, forKey: .payload))
        case .chatSend:
            self = .chatSend(id: id, payload: try container.decode(ChatSendPayload.self, forKey: .payload))
        case .chatHistory:
            self = .chatHistory(id: id, payload: try container.decode(ChatHistoryPayload.self, forKey: .payload))
        case .chatSubscribe:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .chatSubscribe(id: id)
        case .chatActivity:
            self = .chatActivity(id: id, payload: try container.decode(ChatActivityPayload.self, forKey: .payload))
        case .assistantNotificationsList:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .assistantNotificationsList(id: id)
        case .assistantNotificationsAck:
            self = .assistantNotificationsAck(id: id, payload: try container.decode(AssistantNotificationAckPayload.self, forKey: .payload))
        case .assistantNotificationsRendered:
            self = .assistantNotificationsRendered(id: id, payload: try container.decode(AssistantNotificationRenderedPayload.self, forKey: .payload))
        case .settingsGet:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .settingsGet(id: id)
        case .settingsSet:
            self = .settingsSet(id: id, payload: try container.decode(SettingsSetPayload.self, forKey: .payload))
        case .modelsList:
            self = .modelsList(id: id, payload: try container.decode(ModelsListPayload.self, forKey: .payload))
        case .accountsList:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .accountsList(id: id)
        case .accountsLogin:
            self = .accountsLogin(id: id, payload: try container.decode(AccountsLoginPayload.self, forKey: .payload))
        case .accountsLogout:
            self = .accountsLogout(id: id, payload: try container.decode(AccountsLogoutPayload.self, forKey: .payload))
        case .accountsLoginFinish:
            self = .accountsLoginFinish(id: id, payload: try container.decode(AccountsLoginFinishPayload.self, forKey: .payload))
        case .accountsProviders:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .accountsProviders(id: id)
        case .accountsDiscover:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .accountsDiscover(id: id)
        case .accountsAdopt:
            self = .accountsAdopt(id: id, payload: try container.decode(AccountsAdoptPayload.self, forKey: .payload))
        case .providersCustom:
            self = .providersCustom(id: id, payload: try container.decode(ProvidersCustomPayload.self, forKey: .payload))
        case .daemonRestart:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .daemonRestart(id: id)
        case .browserOpen:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .browserOpen(id: id)
        case .sessionCompact:
            self = .sessionCompact(id: id, payload: try container.decode(SessionCompactPayload.self, forKey: .payload))
        case .sessionCompactStatus:
            self = .sessionCompactStatus(
                id: id,
                payload: try container.decode(SessionCompactStatusRequestPayload.self, forKey: .payload)
            )
        case .maintenanceRun:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .maintenanceRun(id: id)
        case .memoryBackfillCaptures:
            _ = try container.decode(EmptyPayload.self, forKey: .payload)
            self = .memoryBackfillCaptures(id: id)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: FrameCodingKeys.self)
        try container.encode("request", forKey: .type)
        try container.encode(id, forKey: .id)
        try container.encode(capability, forKey: .verb)
        switch self {
        case .statusGet, .monitorsList, .daemonPause, .daemonResume, .maintenanceRun, .memoryBackfillCaptures, .sessionReload, .sessionReset, .settingsGet, .accountsList, .daemonRestart, .browserOpen, .accountsProviders, .chatSubscribe, .assistantNotificationsList:
            try container.encode(EmptyPayload(), forKey: .payload)
        case .modelsList(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .accountsDiscover:
            try container.encode(EmptyPayload(), forKey: .payload)
        case .accountsAdopt(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .providersCustom(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .sessionNotify(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .chatSend(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .chatHistory(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .chatActivity(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .assistantNotificationsAck(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .assistantNotificationsRendered(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .settingsSet(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .accountsLogin(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .accountsLogout(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .accountsLoginFinish(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .monitorsToggle(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .monitorsRun(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .monitorsDelete(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .sessionCompact(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .sessionCompactStatus(_, let payload):
            try container.encode(payload, forKey: .payload)
        }
    }
}

public struct ProbeInfo: Codable, Sendable, Equatable {
    public let status: String
    public let reason: String?
    public let aliases: [String]?

    public init(status: String, reason: String? = nil, aliases: [String]? = nil) {
        self.status = status
        self.reason = reason
        self.aliases = aliases
    }

    private enum CodingKeys: String, CodingKey {
        case status
        case reason
        case aliases
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(String.self, forKey: .status)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        aliases = try container.decodeIfPresent([String].self, forKey: .aliases)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status, forKey: .status)
        try container.encodeIfPresent(reason, forKey: .reason)
        try container.encodeIfPresent(aliases, forKey: .aliases)
    }
}

public struct BootstrapStatus: Codable, Sendable, Equatable {
    public let state: BootstrapState
    public let remediation: String
    public let probes: [String: ProbeInfo]

    public init(state: BootstrapState, remediation: String, probes: [String: ProbeInfo]) {
        self.state = state
        self.remediation = remediation
        self.probes = probes
    }
}

public struct SessionStatus: Codable, Sendable, Equatable {
    public let state: SessionRuntimeState
    public let mainSessionId: String?
    public let mainSessionModel: String?
    public let fastModeAvailable: Bool?
    public let fastModeEnabled: Bool?
    public let mainSessionFilePresent: Bool
    public let paused: Bool
    /// A reply has been confirmed as sent to the owner at least once.
    public let hasReplied: Bool

    public init(state: SessionRuntimeState, mainSessionId: String? = nil, mainSessionModel: String? = nil, fastModeAvailable: Bool? = nil, fastModeEnabled: Bool? = nil, mainSessionFilePresent: Bool, paused: Bool, hasReplied: Bool = false) {
        self.state = state
        self.mainSessionId = mainSessionId
        self.mainSessionModel = mainSessionModel
        self.fastModeAvailable = fastModeAvailable
        self.fastModeEnabled = fastModeEnabled
        self.mainSessionFilePresent = mainSessionFilePresent
        self.paused = paused
        self.hasReplied = hasReplied
    }

    private enum CodingKeys: String, CodingKey {
        case state
        case mainSessionId
        case mainSessionModel
        case fastModeAvailable
        case fastModeEnabled
        case mainSessionFilePresent
        case paused
        case hasReplied
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(SessionRuntimeState.self, forKey: .state)
        mainSessionId = try container.decodeIfPresent(String.self, forKey: .mainSessionId)
        mainSessionModel = try container.decodeIfPresent(String.self, forKey: .mainSessionModel)
        fastModeAvailable = try container.decodeIfPresent(Bool.self, forKey: .fastModeAvailable)
        fastModeEnabled = try container.decodeIfPresent(Bool.self, forKey: .fastModeEnabled)
        mainSessionFilePresent = try container.decode(Bool.self, forKey: .mainSessionFilePresent)
        paused = try container.decode(Bool.self, forKey: .paused)
        hasReplied = try container.decodeIfPresent(Bool.self, forKey: .hasReplied) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(state, forKey: .state)
        try container.encodeIfPresent(mainSessionId, forKey: .mainSessionId)
        try container.encodeIfPresent(mainSessionModel, forKey: .mainSessionModel)
        try container.encodeIfPresent(fastModeAvailable, forKey: .fastModeAvailable)
        try container.encodeIfPresent(fastModeEnabled, forKey: .fastModeEnabled)
        try container.encode(mainSessionFilePresent, forKey: .mainSessionFilePresent)
        try container.encode(paused, forKey: .paused)
        try container.encode(hasReplied, forKey: .hasReplied)
    }
}

public struct ActiveChild: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let kind: ChildKind
    public let origin: String?
    public let state: ChildState
    public let createdAt: String?
    public let updatedAt: String?
    public let startedAt: String?
    public let lastActivityAt: String?
    public let tokens: Int?
    public let toolCalls: Int?

    public init(
        id: String,
        title: String,
        kind: ChildKind,
        origin: String? = nil,
        state: ChildState,
        createdAt: String? = nil,
        updatedAt: String? = nil,
        startedAt: String? = nil,
        lastActivityAt: String? = nil,
        tokens: Int? = nil,
        toolCalls: Int? = nil
    ) {
        self.id = id
        self.title = title
        self.kind = kind
        self.origin = origin
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.startedAt = startedAt
        self.lastActivityAt = lastActivityAt
        self.tokens = tokens
        self.toolCalls = toolCalls
    }
}

public struct MonitorSummary: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let enabled: Bool
    public let revision: Int
    public let nextFire: String?

    public init(id: String, name: String, enabled: Bool, revision: Int, nextFire: String? = nil) {
        self.id = id
        self.name = name
        self.enabled = enabled
        self.revision = revision
        self.nextFire = nextFire
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        enabled = try container.decode(Bool.self, forKey: .enabled)
        revision = try container.decode(Int.self, forKey: .revision)
        nextFire = try container.decodeIfPresent(String.self, forKey: .nextFire)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(enabled, forKey: .enabled)
        try container.encode(revision, forKey: .revision)
        try container.encode(nextFire, forKey: .nextFire)
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case enabled
        case revision
        case nextFire
    }
}

public struct SettingsStatus: Codable, Sendable, Equatable {
    public let allowlistHandle: String?

    public init(allowlistHandle: String? = nil) {
        self.allowlistHandle = allowlistHandle
    }
}

public struct Attention: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    public let detail: String
    public let action: String

    public init(id: String, title: String, detail: String, action: String) {
        self.id = id
        self.title = title
        self.detail = detail
        self.action = action
    }
}

public enum ImessageLaneState: String, Codable, Sendable, Equatable {
    case attached
    case detached
}

public struct ImessageLaneStatus: Codable, Sendable, Equatable {
    public let state: ImessageLaneState
    public let reason: String?
    public let detail: String?
    public let handle: String?

    public init(state: ImessageLaneState, reason: String? = nil, detail: String? = nil, handle: String? = nil) {
        self.state = state
        self.reason = reason
        self.detail = detail
        self.handle = handle
    }
}

public struct StatusResponsePayload: Codable, Sendable, Equatable {
    public let bootstrap: BootstrapStatus
    public let session: SessionStatus
    public let activeChildren: [ActiveChild]
    public let recentChildren: [ActiveChild]
    public let monitors: [MonitorSummary]
    public let settings: SettingsStatus
    public let imessage: ImessageLaneStatus
    public let attention: Attention?

    public init(
        bootstrap: BootstrapStatus,
        session: SessionStatus,
        activeChildren: [ActiveChild],
        recentChildren: [ActiveChild] = [],
        monitors: [MonitorSummary],
        settings: SettingsStatus,
        imessage: ImessageLaneStatus = ImessageLaneStatus(state: .detached),
        attention: Attention? = nil
    ) {
        self.bootstrap = bootstrap
        self.session = session
        self.activeChildren = activeChildren
        self.recentChildren = recentChildren
        self.monitors = monitors
        self.settings = settings
        self.imessage = imessage
        self.attention = attention
    }

    enum CodingKeys: String, CodingKey { case bootstrap, session, activeChildren, recentChildren, monitors, settings, imessage, attention }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bootstrap = try container.decode(BootstrapStatus.self, forKey: .bootstrap)
        session = try container.decode(SessionStatus.self, forKey: .session)
        activeChildren = try container.decode([ActiveChild].self, forKey: .activeChildren)
        recentChildren = try container.decodeIfPresent([ActiveChild].self, forKey: .recentChildren) ?? []
        monitors = try container.decode([MonitorSummary].self, forKey: .monitors)
        settings = try container.decode(SettingsStatus.self, forKey: .settings)
        imessage = try container.decodeIfPresent(ImessageLaneStatus.self, forKey: .imessage)
            ?? ImessageLaneStatus(state: .detached)
        attention = try container.decodeIfPresent(Attention.self, forKey: .attention)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(bootstrap, forKey: .bootstrap)
        try c.encode(session, forKey: .session)
        try c.encode(activeChildren, forKey: .activeChildren)
        try c.encode(recentChildren, forKey: .recentChildren)
        try c.encode(monitors, forKey: .monitors)
        try c.encode(settings, forKey: .settings)
        try c.encode(imessage, forKey: .imessage)
        try c.encode(attention, forKey: .attention)
    }
}

public enum MonitorTrigger: Codable, Sendable, Equatable {
    case cron(expression: String)
    case webhook(token: String)
    case watcher(roots: [String])
    case script(argv: [String], intervalMs: Int)

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: MonitorTriggerCodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "cron":
            self = .cron(expression: try container.decode(String.self, forKey: .expression))
        case "webhook":
            self = .webhook(token: try container.decode(String.self, forKey: .token))
        case "watcher":
            self = .watcher(roots: try container.decode([String].self, forKey: .roots))
        case "script":
            self = .script(
                argv: try container.decode([String].self, forKey: .argv),
                intervalMs: try container.decode(Int.self, forKey: .intervalMs)
            )
        default:
            throw ControlCodecError.invalidFrame("unknown monitor trigger kind")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: MonitorTriggerCodingKeys.self)
        switch self {
        case .cron(let expression):
            try container.encode("cron", forKey: .kind)
            try container.encode(expression, forKey: .expression)
        case .webhook(let token):
            try container.encode("webhook", forKey: .kind)
            try container.encode(token, forKey: .token)
        case .watcher(let roots):
            try container.encode("watcher", forKey: .kind)
            try container.encode(roots, forKey: .roots)
        case .script(let argv, let intervalMs):
            try container.encode("script", forKey: .kind)
            try container.encode(argv, forKey: .argv)
            try container.encode(intervalMs, forKey: .intervalMs)
        }
    }
}

public struct Monitor: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let trigger: MonitorTrigger
    public let instruction: String
    public let eventTypes: [String]
    public let burstPolicy: String
    public let tz: String
    public let timeoutSec: Int
    public let enabled: Bool
    public let revision: Int
    public let createdAt: String
    public let updatedAt: String
    public let lastFiredAt: String?
    public let isProtected: Bool?
    public let expiresAt: String?

    public init(
        id: String,
        name: String,
        trigger: MonitorTrigger,
        instruction: String,
        eventTypes: [String],
        burstPolicy: String,
        tz: String,
        timeoutSec: Int,
        enabled: Bool,
        revision: Int,
        createdAt: String,
        updatedAt: String,
        lastFiredAt: String? = nil,
        isProtected: Bool? = nil,
        expiresAt: String? = nil
    ) {
        self.id = id
        self.name = name
        self.isProtected = isProtected
        self.expiresAt = expiresAt
        self.trigger = trigger
        self.instruction = instruction
        self.eventTypes = eventTypes
        self.burstPolicy = burstPolicy
        self.tz = tz
        self.timeoutSec = timeoutSec
        self.enabled = enabled
        self.revision = revision
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastFiredAt = lastFiredAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, trigger, instruction, eventTypes, burstPolicy, tz, timeoutSec, enabled, revision, createdAt, updatedAt, lastFiredAt, expiresAt
        case isProtected = "protected"
    }
}

public struct MonitorsListResponsePayload: Codable, Sendable, Equatable {
    public let monitors: [Monitor]

    public init(monitors: [Monitor]) {
        self.monitors = monitors
    }
}

public struct MonitorToggleResponsePayload: Codable, Sendable, Equatable {
    public let monitor: Monitor

    public init(monitor: Monitor) {
        self.monitor = monitor
    }
}

public struct MonitorDeleteResponsePayload: Codable, Sendable, Equatable {
    public let id: String
    public let deleted: Bool

    public init(id: String, deleted: Bool) {
        self.id = id
        self.deleted = deleted
    }
}

public struct EnvKeyStatus: Codable, Sendable, Equatable, Identifiable {
    public let key: String
    public let set: Bool
    public var id: String { key }
    public init(key: String, set: Bool) { self.key = key; self.set = set }
}
public struct SettingsSnapshotPayload: Codable, Sendable, Equatable {
    public let ownerHandle: String
    public let ownerName: String
    public let mainSessionModel: String
    public let mainTurnWatchdogSec: Int
    public let childMaxConcurrent: Int
    public let childConversationalTimeoutSec: Int
    public let childDaemonTimeoutSec: Int
    public let childWarmTtlSec: Int
    public let childIdleTimeoutSec: Int
    public let childMaxLive: Int
    public let childInterimBatchSec: Int
    public let childInterimRatePerMinute: Int
    public let childInterimMaxBytes: Int
    public let childStatusListLimit: Int
    public let childStatusTextBytes: Int
    public let childToolGuardMs: Int
    public let env: [EnvKeyStatus]
    public let soulVersion: String
    public let soulText: String
    public let configPath: String
    public init(ownerHandle: String, ownerName: String, mainSessionModel: String, mainTurnWatchdogSec: Int, childMaxConcurrent: Int, childConversationalTimeoutSec: Int, childDaemonTimeoutSec: Int, childWarmTtlSec: Int, childIdleTimeoutSec: Int, childMaxLive: Int, childInterimBatchSec: Int, childInterimRatePerMinute: Int, childInterimMaxBytes: Int, childStatusListLimit: Int, childStatusTextBytes: Int, childToolGuardMs: Int, env: [EnvKeyStatus], soulVersion: String, soulText: String, configPath: String) {
        self.ownerHandle = ownerHandle; self.ownerName = ownerName; self.mainSessionModel = mainSessionModel; self.mainTurnWatchdogSec = mainTurnWatchdogSec; self.childMaxConcurrent = childMaxConcurrent; self.childConversationalTimeoutSec = childConversationalTimeoutSec; self.childDaemonTimeoutSec = childDaemonTimeoutSec; self.childWarmTtlSec = childWarmTtlSec; self.childIdleTimeoutSec = childIdleTimeoutSec; self.childMaxLive = childMaxLive; self.childInterimBatchSec = childInterimBatchSec; self.childInterimRatePerMinute = childInterimRatePerMinute; self.childInterimMaxBytes = childInterimMaxBytes; self.childStatusListLimit = childStatusListLimit; self.childStatusTextBytes = childStatusTextBytes; self.childToolGuardMs = childToolGuardMs; self.env = env; self.soulVersion = soulVersion; self.soulText = soulText; self.configPath = configPath
    }
}
public struct SettingsSetResponsePayload: Codable, Sendable, Equatable {
    public let ok: Bool
    public let restarting: Bool
    public let reloaded: Bool
    public init(ok: Bool, restarting: Bool, reloaded: Bool) { self.ok = ok; self.restarting = restarting; self.reloaded = reloaded }
}
public struct ModelChoice: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let provider: String
    public let canonical: String
    public init(id: String, provider: String, canonical: String) { self.id = id; self.provider = provider; self.canonical = canonical }
}
public struct ModelsListResponsePayload: Codable, Sendable, Equatable {
    public let models: [ModelChoice]
    public init(models: [ModelChoice]) { self.models = models }
}
public struct AccountRow: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let provider: String
    public let kind: String
    public let identity: String?
    public let health: String
    public init(id: String, provider: String, kind: String, identity: String?, health: String) { self.id = id; self.provider = provider; self.kind = kind; self.identity = identity; self.health = health }
}
public struct AccountsListResponsePayload: Codable, Sendable, Equatable {
    public let accounts: [AccountRow]
    public init(accounts: [AccountRow]) { self.accounts = accounts }
}
public struct AccountsLoginResponsePayload: Codable, Sendable, Equatable {
    public let url: String
    public let manual: Bool?
    public init(url: String, manual: Bool? = nil) { self.url = url; self.manual = manual }
}
public struct OkResponsePayload: Codable, Sendable, Equatable {
    public let ok: Bool
    public init(ok: Bool) { self.ok = ok }
}
public struct OAuthProviderRow: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let popular: Bool
    public init(id: String, label: String, popular: Bool) { self.id = id; self.label = label; self.popular = popular }
}
public struct AccountsProvidersResponsePayload: Codable, Sendable, Equatable {
    public let providers: [OAuthProviderRow]
    public init(providers: [OAuthProviderRow]) { self.providers = providers }
}
public struct DiscoveredCredential: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let provider: String
    public let label: String
    public let source: String
    public let kind: String
    public let redactedToken: String
    public let identity: String?
    public let expiresAt: String?
    public let adoptable: Bool
    public let reason: String?

    public init(
        id: String,
        provider: String,
        label: String,
        source: String,
        kind: String,
        redactedToken: String,
        identity: String? = nil,
        expiresAt: String? = nil,
        adoptable: Bool,
        reason: String? = nil
    ) {
        self.id = id
        self.provider = provider
        self.label = label
        self.source = source
        self.kind = kind
        self.redactedToken = redactedToken
        self.identity = identity
        self.expiresAt = expiresAt
        self.adoptable = adoptable
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey {
        case id, provider, label, source, kind, redactedToken, identity, expiresAt, adoptable, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        provider = try container.decode(String.self, forKey: .provider)
        label = try container.decode(String.self, forKey: .label)
        source = try container.decode(String.self, forKey: .source)
        kind = try container.decode(String.self, forKey: .kind)
        redactedToken = try container.decode(String.self, forKey: .redactedToken)
        identity = try container.decodeIfPresent(String.self, forKey: .identity)
        expiresAt = try container.decodeIfPresent(String.self, forKey: .expiresAt)
        adoptable = try container.decode(Bool.self, forKey: .adoptable)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(provider, forKey: .provider)
        try container.encode(label, forKey: .label)
        try container.encode(source, forKey: .source)
        try container.encode(kind, forKey: .kind)
        try container.encode(redactedToken, forKey: .redactedToken)
        try container.encodeIfPresent(identity, forKey: .identity)
        try container.encodeIfPresent(expiresAt, forKey: .expiresAt)
        try container.encode(adoptable, forKey: .adoptable)
        try container.encodeIfPresent(reason, forKey: .reason)
    }
}
public struct AccountsDiscoverResponsePayload: Codable, Sendable, Equatable {
    public let credentials: [DiscoveredCredential]
    public init(credentials: [DiscoveredCredential]) { self.credentials = credentials }
}
public struct AccountsAdoptResponsePayload: Codable, Sendable, Equatable {
    public let adopted: Bool
    public let provider: String
    public let restarting: Bool
    public init(adopted: Bool, provider: String, restarting: Bool) {
        self.adopted = adopted
        self.provider = provider
        self.restarting = restarting
    }
}
public struct ProvidersCustomResponsePayload: Codable, Sendable, Equatable {
    public let modelId: String
    public init(modelId: String) { self.modelId = modelId }
}

public struct BrowserOpenResponsePayload: Codable, Sendable, Equatable {
    public let opened: Bool
    public let profile: String
    public init(opened: Bool, profile: String) { self.opened = opened; self.profile = profile }
}

public struct DaemonRestartResponsePayload: Codable, Sendable, Equatable {
    public let restarting: Bool
    public init(restarting: Bool) { self.restarting = restarting }
}

public struct MemoryBackfillResponsePayload: Codable, Sendable, Equatable {
    public let scanned: Int
    public let captured: Int
    public let skippedInjected: Int
    public let skippedAlreadyPresent: Int
    public init(scanned: Int, captured: Int, skippedInjected: Int, skippedAlreadyPresent: Int) {
        self.scanned = scanned
        self.captured = captured
        self.skippedInjected = skippedInjected
        self.skippedAlreadyPresent = skippedAlreadyPresent
    }
}

public struct MonitorRunResponsePayload: Codable, Sendable, Equatable {
    public let dispatched: Bool
    public let reason: String?
    public init(dispatched: Bool, reason: String? = nil) { self.dispatched = dispatched; self.reason = reason }
}

public struct SessionNotifyResponsePayload: Codable, Sendable, Equatable {
    public let delivered: Bool
    public let reply: String
    public init(delivered: Bool, reply: String) { self.delivered = delivered; self.reply = reply }
}

public struct SessionResetResponsePayload: Codable, Sendable, Equatable {
    public let reset: Bool
    public let sessionId: String
    public init(reset: Bool, sessionId: String) { self.reset = reset; self.sessionId = sessionId }
}

public struct SessionReloadResponsePayload: Codable, Sendable, Equatable {
    public let reloaded: Bool
    public let soulVersion: String

    public init(reloaded: Bool, soulVersion: String) {
        self.reloaded = reloaded
        self.soulVersion = soulVersion
    }
}

public struct DaemonPauseResponsePayload: Codable, Sendable, Equatable {
    public let paused: Bool

    public init(paused: Bool) {
        self.paused = paused
    }
}

public struct SessionCompactAcceptedPayload: Codable, Sendable, Equatable {
    public let operationId: String
    public let state: CompactAcceptanceState

    public init(operationId: String, state: CompactAcceptanceState) {
        self.operationId = operationId
        self.state = state
    }
}

public struct SessionCompactStatusResponsePayload: Codable, Sendable, Equatable {
    public let operationId: String
    public let state: CompactOperationState
    public let errorCode: String?

    public init(operationId: String, state: CompactOperationState, errorCode: String? = nil) {
        self.operationId = operationId
        self.state = state
        self.errorCode = errorCode
    }
}

public struct MaintenanceRunResponsePayload: Codable, Sendable, Equatable {
    public let ran: Bool
    public let deliveryLedgerPruned: Int
    public let monitorEventsPruned: Int
    public let receiptsPruned: Int
    public let journalsPruned: Int
    public let logRotated: Bool

    public init(ran: Bool, deliveryLedgerPruned: Int, monitorEventsPruned: Int, receiptsPruned: Int, journalsPruned: Int, logRotated: Bool) {
        self.ran = ran
        self.deliveryLedgerPruned = deliveryLedgerPruned
        self.monitorEventsPruned = monitorEventsPruned
        self.receiptsPruned = receiptsPruned
        self.journalsPruned = journalsPruned
        self.logRotated = logRotated
    }
}

public struct ChatImageRef: Codable, Sendable, Equatable {
    public let path: String
    public let caption: String

    public init(path: String, caption: String) {
        self.path = path
        self.caption = caption
    }
}

public struct ChatMessagePayload: Codable, Sendable, Equatable {
    public let role: String
    public let source: String?
    public let text: String?
    public let image: ChatImageRef?
    public let at: String?
    public let turnId: String?
    public let seq: Int?
    public let final: Bool?

    public init(
        role: String,
        source: String? = nil,
        text: String? = nil,
        image: ChatImageRef? = nil,
        at: String? = nil,
        turnId: String? = nil,
        seq: Int? = nil,
        final: Bool? = nil
    ) {
        self.role = role
        self.source = source
        self.text = text
        self.image = image
        self.at = at
        self.turnId = turnId
        self.seq = seq
        self.final = final
    }
}

public struct ChatPresencePayload: Codable, Sendable, Equatable {
    public let source: String
    public let turnId: String
    public let typing: Bool?
    public let read: Bool?
    public let at: String
    public let seq: Int

    public init(source: String, turnId: String, typing: Bool? = nil, read: Bool? = nil, at: String, seq: Int) {
        self.source = source
        self.turnId = turnId
        self.typing = typing
        self.read = read
        self.at = at
        self.seq = seq
    }
}

public struct ChatEventPayload: Codable, Sendable, Equatable {
    public let topic: String
    public let payload: ChatMessagePayload

    public init(topic: String, payload: ChatMessagePayload) {
        self.topic = topic
        self.payload = payload
    }
}

public struct ChatInFlightPayload: Codable, Sendable, Equatable {
    public let turnId: String
    public let typing: Bool

    public init(turnId: String, typing: Bool) {
        self.turnId = turnId
        self.typing = typing
    }
}

public struct ChatSendResponsePayload: Codable, Sendable, Equatable {
    public let turnId: String
    public let outcome: String

    public init(turnId: String, outcome: String) {
        self.turnId = turnId
        self.outcome = outcome
    }
}

public struct ChatHistoryResponsePayload: Codable, Sendable, Equatable {
    public let messages: [ChatMessagePayload]
    public let seq: Int
    public let tail: [ChatEventPayload]
    public let inFlight: ChatInFlightPayload?
    public let truncated: Bool?
    public let tailTruncated: Bool?

    public init(
        messages: [ChatMessagePayload],
        seq: Int,
        tail: [ChatEventPayload],
        inFlight: ChatInFlightPayload? = nil,
        truncated: Bool? = nil,
        tailTruncated: Bool? = nil
    ) {
        self.messages = messages
        self.seq = seq
        self.tail = tail
        self.inFlight = inFlight
        self.truncated = truncated
        self.tailTruncated = tailTruncated
    }
}

public struct ChatSubscribeResponsePayload: Codable, Sendable, Equatable {
    public let subscribed: Bool

    public init(subscribed: Bool) {
        self.subscribed = subscribed
    }
}

public struct ChatActivityResponsePayload: Codable, Sendable, Equatable {
    public let recorded: Bool

    public init(recorded: Bool) {
        self.recorded = recorded
    }
}

public struct AssistantNotification: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let text: String
    public let acknowledged: Bool

    public init(id: String, text: String, acknowledged: Bool) {
        self.id = id
        self.text = text
        self.acknowledged = acknowledged
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ControlCodecError.invalidFrame("assistant notification id must be a non-empty string")
        }
        self.id = id
        text = try container.decode(String.self, forKey: .text)
        acknowledged = try container.decode(Bool.self, forKey: .acknowledged)
    }

    public func encode(to encoder: Encoder) throws {
        guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ControlCodecError.invalidFrame("assistant notification id must be a non-empty string")
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(text, forKey: .text)
        try container.encode(acknowledged, forKey: .acknowledged)
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case text
        case acknowledged
    }
}

public struct AssistantNotificationsListResponsePayload: Codable, Sendable, Equatable {
    public let notifications: [AssistantNotification]

    public init(notifications: [AssistantNotification]) {
        self.notifications = notifications
    }
}

public struct AssistantNotificationAckResponsePayload: Codable, Sendable, Equatable {
    public let acknowledged: Bool

    public init(acknowledged: Bool) {
        self.acknowledged = acknowledged
    }
}

public struct AssistantNotificationRenderedResponsePayload: Codable, Sendable, Equatable {
    public let rendered: Bool

    public init(rendered: Bool) {
        self.rendered = rendered
    }
}

public enum ControlResponse: Codable, Sendable, Equatable {
    case status(id: String, payload: StatusResponsePayload)
    case monitorsList(id: String, payload: MonitorsListResponsePayload)
    case monitorsToggle(id: String, payload: MonitorToggleResponsePayload)
    case monitorsRun(id: String, payload: MonitorRunResponsePayload)
    case monitorsDelete(id: String, payload: MonitorDeleteResponsePayload)
    case daemonPause(id: String, payload: DaemonPauseResponsePayload)
    case sessionCompactAccepted(id: String, payload: SessionCompactAcceptedPayload)
    case sessionCompactStatus(id: String, payload: SessionCompactStatusResponsePayload)
    case maintenanceRun(id: String, payload: MaintenanceRunResponsePayload)
    case memoryBackfillCaptures(id: String, payload: MemoryBackfillResponsePayload)
    case sessionReload(id: String, payload: SessionReloadResponsePayload)
    case sessionReset(id: String, payload: SessionResetResponsePayload)
    case sessionNotify(id: String, payload: SessionNotifyResponsePayload)
    case chatSend(id: String, payload: ChatSendResponsePayload)
    case chatHistory(id: String, payload: ChatHistoryResponsePayload)
    case chatSubscribe(id: String, payload: ChatSubscribeResponsePayload)
    case chatActivity(id: String, payload: ChatActivityResponsePayload)
    case assistantNotificationsList(id: String, payload: AssistantNotificationsListResponsePayload)
    case assistantNotificationsAck(id: String, payload: AssistantNotificationAckResponsePayload)
    case assistantNotificationsRendered(id: String, payload: AssistantNotificationRenderedResponsePayload)
    case settingsGet(id: String, payload: SettingsSnapshotPayload)
    case settingsSet(id: String, payload: SettingsSetResponsePayload)
    case modelsList(id: String, payload: ModelsListResponsePayload)
    case accountsList(id: String, payload: AccountsListResponsePayload)
    case accountsLogin(id: String, payload: AccountsLoginResponsePayload)
    case ok(id: String, payload: OkResponsePayload)
    case daemonRestart(id: String, payload: DaemonRestartResponsePayload)
    case browserOpen(id: String, payload: BrowserOpenResponsePayload)
    case accountsProviders(id: String, payload: AccountsProvidersResponsePayload)
    case accountsDiscover(id: String, payload: AccountsDiscoverResponsePayload)
    case accountsAdopt(id: String, payload: AccountsAdoptResponsePayload)
    case providersCustom(id: String, payload: ProvidersCustomResponsePayload)

    public var id: String {
        switch self {
        case .status(let id, _), .monitorsList(let id, _), .monitorsToggle(let id, _), .monitorsRun(let id, _), .monitorsDelete(let id, _), .daemonPause(let id, _):
            return id
        case .sessionCompactAccepted(let id, _), .sessionCompactStatus(let id, _), .maintenanceRun(let id, _), .memoryBackfillCaptures(let id, _), .sessionReload(let id, _), .sessionReset(let id, _), .sessionNotify(let id, _), .chatSend(let id, _), .chatHistory(let id, _), .chatSubscribe(let id, _), .chatActivity(let id, _), .assistantNotificationsList(let id, _), .assistantNotificationsAck(let id, _), .assistantNotificationsRendered(let id, _):
            return id
        case .settingsGet(let id, _), .settingsSet(let id, _), .modelsList(let id, _), .accountsList(let id, _), .accountsLogin(let id, _), .ok(let id, _), .daemonRestart(let id, _), .browserOpen(let id, _), .accountsProviders(let id, _), .providersCustom(let id, _):
            return id
        case .accountsDiscover(let id, _), .accountsAdopt(let id, _):
            return id
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: FrameCodingKeys.self)
        try require(try container.decode(String.self, forKey: .type), equals: "response", named: "frame.type")
        try require(try container.decode(Bool.self, forKey: .ok), named: "response.ok must be true")
        let id = try container.decode(String.self, forKey: .id)
        if let payload = try? container.decode(SessionNotifyResponsePayload.self, forKey: .payload) {
            self = .sessionNotify(id: id, payload: payload)
        } else if let payload = try? container.decode(SessionResetResponsePayload.self, forKey: .payload) {
            self = .sessionReset(id: id, payload: payload)
        } else if let payload = try? container.decode(SettingsSnapshotPayload.self, forKey: .payload) {
            self = .settingsGet(id: id, payload: payload)
        } else if let payload = try? container.decode(SettingsSetResponsePayload.self, forKey: .payload) {
            self = .settingsSet(id: id, payload: payload)
        } else if let payload = try? container.decode(ModelsListResponsePayload.self, forKey: .payload) {
            self = .modelsList(id: id, payload: payload)
        } else if let payload = try? container.decode(AccountsListResponsePayload.self, forKey: .payload) {
            self = .accountsList(id: id, payload: payload)
        } else if let payload = try? container.decode(AccountsLoginResponsePayload.self, forKey: .payload) {
            self = .accountsLogin(id: id, payload: payload)
        } else if let payload = try? container.decode(AccountsDiscoverResponsePayload.self, forKey: .payload) {
            self = .accountsDiscover(id: id, payload: payload)
        } else if let payload = try? container.decode(AccountsAdoptResponsePayload.self, forKey: .payload) {
            self = .accountsAdopt(id: id, payload: payload)
        } else if let payload = try? container.decode(AccountsProvidersResponsePayload.self, forKey: .payload) {
            self = .accountsProviders(id: id, payload: payload)
        } else if let payload = try? container.decode(ProvidersCustomResponsePayload.self, forKey: .payload) {
            self = .providersCustom(id: id, payload: payload)
        } else if let payload = try? container.decode(BrowserOpenResponsePayload.self, forKey: .payload) {
            self = .browserOpen(id: id, payload: payload)
        } else if let payload = try? container.decode(DaemonRestartResponsePayload.self, forKey: .payload) {
            self = .daemonRestart(id: id, payload: payload)
        } else if let payload = try? container.decode(StatusResponsePayload.self, forKey: .payload) {
            self = .status(id: id, payload: payload)
        } else if let payload = try? container.decode(MonitorsListResponsePayload.self, forKey: .payload) {
            self = .monitorsList(id: id, payload: payload)
        } else if let payload = try? container.decode(MemoryBackfillResponsePayload.self, forKey: .payload) {
            self = .memoryBackfillCaptures(id: id, payload: payload)
        } else if let payload = try? container.decode(MonitorRunResponsePayload.self, forKey: .payload) {
            self = .monitorsRun(id: id, payload: payload)
        } else if let payload = try? container.decode(MonitorToggleResponsePayload.self, forKey: .payload) {
            self = .monitorsToggle(id: id, payload: payload)
        } else if let payload = try? container.decode(SessionReloadResponsePayload.self, forKey: .payload) {
            self = .sessionReload(id: id, payload: payload)
        } else if let payload = try? container.decode(MonitorDeleteResponsePayload.self, forKey: .payload) {
            self = .monitorsDelete(id: id, payload: payload)
        } else if let payload = try? container.decode(ChatSendResponsePayload.self, forKey: .payload) {
            self = .chatSend(id: id, payload: payload)
        } else if let payload = try? container.decode(ChatHistoryResponsePayload.self, forKey: .payload) {
            self = .chatHistory(id: id, payload: payload)
        } else if let payload = try? container.decode(ChatSubscribeResponsePayload.self, forKey: .payload) {
            self = .chatSubscribe(id: id, payload: payload)
        } else if let payload = try? container.decode(ChatActivityResponsePayload.self, forKey: .payload) {
            self = .chatActivity(id: id, payload: payload)
        } else if let payload = try? container.decode(AssistantNotificationsListResponsePayload.self, forKey: .payload) {
            self = .assistantNotificationsList(id: id, payload: payload)
        } else if let payload = try? container.decode(AssistantNotificationAckResponsePayload.self, forKey: .payload) {
            self = .assistantNotificationsAck(id: id, payload: payload)
        } else if let payload = try? container.decode(AssistantNotificationRenderedResponsePayload.self, forKey: .payload) {
            self = .assistantNotificationsRendered(id: id, payload: payload)
        } else if let payload = try? container.decode(OkResponsePayload.self, forKey: .payload), (try? container.decode(SessionReloadResponsePayload.self, forKey: .payload)) == nil {
            self = .ok(id: id, payload: payload)
        } else if let payload = try? container.decode(DaemonPauseResponsePayload.self, forKey: .payload) {
            self = .daemonPause(id: id, payload: payload)
        } else if let payload = try? container.decode(SessionCompactAcceptedPayload.self, forKey: .payload) {
            self = .sessionCompactAccepted(id: id, payload: payload)
        } else if let payload = try? container.decode(SessionCompactStatusResponsePayload.self, forKey: .payload) {
            self = .sessionCompactStatus(id: id, payload: payload)
        } else if let payload = try? container.decode(MaintenanceRunResponsePayload.self, forKey: .payload) {
            self = .maintenanceRun(id: id, payload: payload)
        } else {
            throw ControlCodecError.invalidFrame("response payload does not match control schema")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: FrameCodingKeys.self)
        try container.encode("response", forKey: .type)
        try container.encode(id, forKey: .id)
        try container.encode(true, forKey: .ok)
        switch self {
        case .status(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .monitorsList(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .monitorsToggle(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .monitorsRun(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .memoryBackfillCaptures(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .monitorsDelete(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .daemonPause(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .sessionCompactAccepted(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .sessionCompactStatus(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .maintenanceRun(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .sessionReload(_, let payload):
            try container.encode(payload, forKey: .payload)
        case .sessionReset(_, let payload): try container.encode(payload, forKey: .payload)
        case .sessionNotify(_, let payload): try container.encode(payload, forKey: .payload)
        case .chatSend(_, let payload): try container.encode(payload, forKey: .payload)
        case .chatHistory(_, let payload): try container.encode(payload, forKey: .payload)
        case .chatSubscribe(_, let payload): try container.encode(payload, forKey: .payload)
        case .chatActivity(_, let payload): try container.encode(payload, forKey: .payload)
        case .assistantNotificationsList(_, let payload): try container.encode(payload, forKey: .payload)
        case .assistantNotificationsAck(_, let payload): try container.encode(payload, forKey: .payload)
        case .assistantNotificationsRendered(_, let payload): try container.encode(payload, forKey: .payload)
        case .settingsGet(_, let payload): try container.encode(payload, forKey: .payload)
        case .settingsSet(_, let payload): try container.encode(payload, forKey: .payload)
        case .modelsList(_, let payload): try container.encode(payload, forKey: .payload)
        case .accountsList(_, let payload): try container.encode(payload, forKey: .payload)
        case .accountsLogin(_, let payload): try container.encode(payload, forKey: .payload)
        case .accountsDiscover(_, let payload): try container.encode(payload, forKey: .payload)
        case .accountsAdopt(_, let payload): try container.encode(payload, forKey: .payload)
        case .ok(_, let payload): try container.encode(payload, forKey: .payload)
        case .daemonRestart(_, let payload): try container.encode(payload, forKey: .payload)
        case .browserOpen(_, let payload): try container.encode(payload, forKey: .payload)
        case .accountsProviders(_, let payload): try container.encode(payload, forKey: .payload)
        case .providersCustom(_, let payload): try container.encode(payload, forKey: .payload)
        }
    }
}

public struct ControlError: Codable, Sendable, Equatable {
    public let id: String?
    public let code: ControlErrorCode
    public let message: String

    public init(id: String? = nil, code: ControlErrorCode, message: String) {
        self.id = id
        self.code = code
        self.message = message
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: FrameCodingKeys.self)
        try require(try container.decode(String.self, forKey: .type), equals: "error", named: "frame.type")
        let ok = try container.decode(Bool.self, forKey: .ok)
        try require(!ok, named: "error.ok must be false")
        id = try container.decodeIfPresent(String.self, forKey: .id)
        code = try container.decode(ControlErrorCode.self, forKey: .code)
        message = try container.decode(String.self, forKey: .message)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: FrameCodingKeys.self)
        try container.encode("error", forKey: .type)
        if let id {
            try container.encode(id, forKey: .id)
        }
        try container.encode(false, forKey: .ok)
        try container.encode(code, forKey: .code)
        try container.encode(message, forKey: .message)
    }
}

public struct SessionCompactTerminalPayload: Codable, Sendable, Equatable {
    public let operationId: String
    public let state: CompactOperationState
    public let errorCode: String?

    public init(operationId: String, state: CompactOperationState, errorCode: String? = nil) {
        self.operationId = operationId
        self.state = state
        self.errorCode = errorCode
    }
}

public enum ControlEvent: Codable, Sendable, Equatable {
    case sessionCompactTerminal(SessionCompactTerminalPayload)
    case chatMessage(ChatMessagePayload)
    case chatPresence(ChatPresencePayload)
    case unknown(topic: String, payload: [String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: FrameCodingKeys.self)
        try require(try container.decode(String.self, forKey: .type), equals: "event", named: "frame.type")
        let topic = try container.decode(String.self, forKey: .topic)
        if topic == "session.compact.terminal" {
            self = .sessionCompactTerminal(try container.decode(SessionCompactTerminalPayload.self, forKey: .payload))
        } else if topic == "chat.message" {
            self = .chatMessage(try container.decode(ChatMessagePayload.self, forKey: .payload))
        } else if topic == "chat.presence" {
            self = .chatPresence(try container.decode(ChatPresencePayload.self, forKey: .payload))
        } else {
            self = .unknown(topic: topic, payload: try container.decode([String: JSONValue].self, forKey: .payload))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: FrameCodingKeys.self)
        try container.encode("event", forKey: .type)
        switch self {
        case .sessionCompactTerminal(let payload):
            try container.encode("session.compact.terminal", forKey: .topic)
            try container.encode(payload, forKey: .payload)
        case .chatMessage(let payload):
            try container.encode("chat.message", forKey: .topic)
            try container.encode(payload, forKey: .payload)
        case .chatPresence(let payload):
            try container.encode("chat.presence", forKey: .topic)
            try container.encode(payload, forKey: .payload)
        case .unknown(let topic, let payload):
            try container.encode(topic, forKey: .topic)
            try container.encode(payload, forKey: .payload)
        }
    }
}

public enum ControlFrame: Codable, Sendable, Equatable {
    case hello(HelloFrame)
    case negotiated(NegotiatedFrame)
    case request(ControlRequest)
    case response(ControlResponse)
    case error(ControlError)
    case event(ControlEvent)

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: FrameCodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "hello":
            self = .hello(try HelloFrame(from: decoder))
        case "negotiated":
            self = .negotiated(try NegotiatedFrame(from: decoder))
        case "request":
            self = .request(try ControlRequest(from: decoder))
        case "response":
            self = .response(try ControlResponse(from: decoder))
        case "error":
            self = .error(try ControlError(from: decoder))
        case "event":
            self = .event(try ControlEvent(from: decoder))
        default:
            throw ControlCodecError.invalidFrame("unknown frame type")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .hello(let frame):
            try frame.encode(to: encoder)
        case .negotiated(let frame):
            try frame.encode(to: encoder)
        case .request(let frame):
            try frame.encode(to: encoder)
        case .response(let frame):
            try frame.encode(to: encoder)
        case .error(let frame):
            try frame.encode(to: encoder)
        case .event(let frame):
            try frame.encode(to: encoder)
        }
    }
}

public enum ControlCodec {
    public static func decode(_ data: Data) throws -> ControlFrame {
        try JSONDecoder().decode(ControlFrame.self, from: data)
    }

    public static func encode(_ frame: ControlFrame) throws -> Data {
        try JSONEncoder().encode(frame)
    }
}

public indirect enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if var values = try? decoder.unkeyedContainer() {
            var result: [JSONValue] = []
            while !values.isAtEnd {
                result.append(try values.decode(JSONValue.self))
            }
            self = .array(result)
        } else {
            let values = try decoder.container(keyedBy: DynamicCodingKey.self)
            var result: [String: JSONValue] = [:]
            for key in values.allKeys {
                result[key.stringValue] = try values.decode(JSONValue.self, forKey: key)
            }
            self = .object(result)
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .null:
            var container = encoder.singleValueContainer()
            try container.encodeNil()
        case .bool(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .number(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .string(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .array(let values):
            var container = encoder.unkeyedContainer()
            for value in values {
                try container.encode(value)
            }
        case .object(let values):
            var container = encoder.container(keyedBy: DynamicCodingKey.self)
            for (key, value) in values {
                try container.encode(value, forKey: DynamicCodingKey(key))
            }
        }
    }
}

private enum FrameCodingKeys: String, CodingKey {
    case type
    case v
    case client
    case capabilities
    case id
    case verb
    case payload
    case ok
    case code
    case message
    case topic
}

private struct EmptyCodingKeys: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

private enum MonitorTriggerCodingKeys: String, CodingKey {
    case kind
    case expression
    case token
    case roots
    case argv
    case intervalMs
}

private struct DynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init(_ stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(stringValue: String) {
        self.init(stringValue)
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

private func require(_ condition: @autoclosure () throws -> Bool, named message: String) throws {
    guard try condition() else {
        throw ControlCodecError.invalidFrame(message)
    }
}

private func require(_ value: String, equals expected: String, named message: String) throws {
    try require(value == expected, named: message)
}
