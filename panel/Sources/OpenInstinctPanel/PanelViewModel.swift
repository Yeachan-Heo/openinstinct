import Combine
import Darwin
import Foundation

public enum DaemonConnectionState: Equatable, Sendable {
    case loading
    case connected
    case absent
}

@MainActor
public final class PanelViewModel: ObservableObject {
    @Published public private(set) var connectionState: DaemonConnectionState = .loading
    @Published public private(set) var status: StatusResponsePayload?
    @Published public private(set) var monitors: [Monitor] = []
    @Published public private(set) var notice: String?
    @Published public private(set) var connectionError: String?
    @Published public private(set) var togglingMonitorIDs: Set<String> = []
    @Published public private(set) var runningMonitorIDs: Set<String> = []
    @Published public private(set) var recoveryInProgress = false

    private let transport: any ControlTransport
    private let daemonKickstart: @Sendable () async throws -> Void

    public init(
        transport: any ControlTransport = UnixSocketTransport(),
        daemonKickstart: (@Sendable () async throws -> Void)? = nil
    ) {
        self.transport = transport
        self.daemonKickstart = daemonKickstart ?? { try await PanelViewModel.kickstartDaemon() }
    }

    /// Turns a provider/model id into a short label suitable for the status popover.
    /// The exact id remains available in Details so this is only a readability aid.
    public nonisolated static func modelDisplayName(_ modelID: String) -> String {
        let trimmed = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true)
        guard let providerPart = parts.first else { return trimmed }
        guard parts.count == 2 else { return prettyModelWords(String(providerPart)) }
        let provider = prettyProviderName(String(providerPart))
        let model = prettyModelWords(String(parts[1]))
        return provider.isEmpty ? model : "\(provider) · \(model)"
    }

    private nonisolated static func prettyProviderName(_ raw: String) -> String {
        let normalized = raw.lowercased()
        if normalized.contains("anthropic") { return "Anthropic" }
        if normalized.contains("openai") { return "OpenAI" }
        if normalized.contains("google") || normalized.contains("gemini") { return "Google" }
        if normalized.contains("mistral") { return "Mistral" }
        return prettyModelWords(raw)
    }

    private nonisolated static func prettyModelWords(_ raw: String) -> String {
        raw.replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { String($0).capitalized }
            .joined(separator: " ")
    }

    public func refresh() async {
        await refreshStatus()
        guard connectionState == .connected else {
            return
        }
        await refreshMonitors()
    }

    public func refreshStatus() async {
        do {
            let frame = try await transport.request(.statusGet(id: requestID()))
            guard case .response(.status(_, let payload)) = frame else {
                throw PanelModelError.unexpectedFrame
            }
            status = payload
            connectionState = .connected
            connectionError = nil
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func refreshMonitors() async {
        do {
            let frame = try await transport.request(.monitorsList(id: requestID()))
            guard case .response(.monitorsList(_, let payload)) = frame else {
                throw PanelModelError.unexpectedFrame
            }
            monitors = payload.monitors
            connectionState = .connected
            connectionError = nil
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func openBrowserProfile() async {
        do {
            let frame = try await transport.request(.browserOpen(id: requestID()))
            switch frame {
            case .response(.browserOpen): notice = "Gajae's browser opened. Sign into the sites you want it to use, then just close the window."
            case .error(let error): notice = error.message
            default: throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func resetSession() async {
        do {
            let frame = try await transport.request(.sessionReset(id: requestID()))
            switch frame {
            case .response(.sessionReset): notice = "Fresh conversation started. Memory is kept."; await refresh()
            case .error(let error): notice = error.message
            default: throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func setFastMode(_ enabled: Bool) async {
        guard status?.session.fastModeAvailable == true else { return }
        do {
            let frame = try await transport.request(.settingsSet(
                id: requestID(),
                payload: SettingsSetPayload(patch: ["fastMode": .bool(enabled)])
            ))
            switch frame {
            case .response(.settingsSet):
                notice = enabled ? "Fast mode is on." : "Fast mode is off."
                await refreshStatus()
            case .error(let error):
                notice = error.message
            default:
                throw PanelModelError.unexpectedFrame
            }
        } catch {
            notice = "Fast mode could not be changed. Gajae will keep using normal speed."
            await refreshStatus()
        }
    }

    /// Restarts the daemon, using launchd directly when the control socket cannot answer.
    public func restartDaemon() async {
        await runRecovery(resetConversation: false)
    }

    /// Starts a fresh conversation without touching memory, settings, or credentials.
    public func forceRestartAndReset() async {
        await runRecovery(resetConversation: true)
    }

    private func runRecovery(resetConversation: Bool) async {
        guard !recoveryInProgress else { return }
        recoveryInProgress = true
        defer { recoveryInProgress = false }
        notice = resetConversation ? "Starting a fresh conversation safely…" : "Restarting Gajae…"

        do {
            var resetCompleted = !resetConversation
            if resetConversation {
                if connectionState != .connected || status?.session.state != .active {
                    try await kickstartAndReconnect()
                }
                do {
                    try await requestSessionReset()
                    resetCompleted = true
                } catch {
                    // Retry on the clean process after the forced restart.
                    resetCompleted = false
                }
            }

            try await restartDaemonReliably()
            if resetConversation && !resetCompleted {
                try await requestSessionReset()
            }
            await refreshStatus()
            guard connectionState == .connected,
                  status?.bootstrap.state == .running,
                  status?.session.state == .active else {
                throw RecoveryError.daemonUnavailable
            }
            notice = resetConversation
                ? "Fresh conversation started. Your memory and settings are safe."
                : "Gajae restarted. Your conversation and settings are unchanged."
        } catch {
            notice = resetConversation
                ? "Gajae could not finish the fresh start. Your memory and settings are safe; try again in a moment."
                : "Gajae could not restart automatically. Try Force Restart & Reset again in a moment."
        }
    }

    private func requestSessionReset() async throws {
        let frame = try await transport.request(.sessionReset(id: requestID()))
        switch frame {
        case .response(.sessionReset):
            return
        case .error:
            throw RecoveryError.controlUnavailable
        default:
            throw PanelModelError.unexpectedFrame
        }
    }

    private func requestDaemonRestart() async throws {
        let frame = try await transport.request(.daemonRestart(id: requestID()))
        switch frame {
        case .response(.daemonRestart(_, let payload)) where payload.restarting:
            return
        case .response(.daemonRestart):
            throw RecoveryError.controlUnavailable
        case .error:
            throw RecoveryError.controlUnavailable
        default:
            throw PanelModelError.unexpectedFrame
        }
    }

    private func restartDaemonReliably() async throws {
        do {
            try await requestDaemonRestart()
            try await waitForRestartCycle()
        } catch {
            try await daemonKickstart()
            try await waitForDaemon()
        }
    }

    private func kickstartAndReconnect() async throws {
        try await daemonKickstart()
        try await waitForDaemon()
    }

    private func waitForDaemon() async throws {
        for attempt in 0..<50 {
            if attempt > 0 {
                try await Task.sleep(nanoseconds: 300_000_000)
            }
            await refreshStatus()
            if connectionState == .connected,
               status?.bootstrap.state == .running,
               status?.session.state == .active {
                return
            }
        }
        throw RecoveryError.daemonUnavailable
    }

    private func waitForRestartCycle() async throws {
        var crossedRestartBoundary = false
        for _ in 0..<50 {
            try await Task.sleep(nanoseconds: 300_000_000)
            await refreshStatus()
            let ready = connectionState == .connected
                && status?.bootstrap.state == .running
                && status?.session.state == .active
            if !ready {
                crossedRestartBoundary = true
            } else if crossedRestartBoundary {
                return
            }
        }
        throw RecoveryError.daemonUnavailable
    }

    public func reloadPersona() async {
        do {
            let frame = try await transport.request(.sessionReload(id: requestID()))
            switch frame {
            case .response(.sessionReload(_, let payload)):
                notice = "Persona reloaded (soul v\(payload.soulVersion))."
            case .error(let error):
                notice = error.message
            default:
                throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func deleteMonitor(id: String) async {
        guard let monitor = monitors.first(where: { $0.id == id }) else {
            return
        }
        togglingMonitorIDs.insert(id)
        defer { togglingMonitorIDs.remove(id) }
        do {
            let request = ControlRequest.monitorsDelete(
                id: requestID(),
                payload: MonitorDeletePayload(id: id, expectedRevision: monitor.revision)
            )
            let frame = try await transport.request(request)
            switch frame {
            case .response(.monitorsDelete(_, let payload)) where payload.deleted:
                monitors.removeAll { $0.id == id }
                notice = nil
            case .error(let error) where error.code == .revisionConflict:
                await refreshMonitors()
                if connectionState == .connected {
                    notice = "Monitor changed elsewhere. Refreshed its current state."
                }
            case .error(let error) where error.code == .monitorBusy:
                notice = "It's in the middle of a run. Try again in a minute."
            case .error(let error):
                notice = error.message
            default:
                throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func toggleMonitor(id: String, enabled: Bool) async {
        guard let monitor = monitors.first(where: { $0.id == id }) else {
            return
        }
        togglingMonitorIDs.insert(id)
        defer { togglingMonitorIDs.remove(id) }

        do {
            let request = ControlRequest.monitorsToggle(
                id: requestID(),
                payload: MonitorTogglePayload(id: id, enabled: enabled, expectedRevision: monitor.revision)
            )
            let frame = try await transport.request(request)
            switch frame {
            case .response(.monitorsToggle(_, let payload)):
                replaceMonitor(payload.monitor)
                notice = nil
            case .error(let error) where error.code == .revisionConflict:
                await refreshMonitors()
                if connectionState == .connected {
                    notice = "Monitor changed elsewhere. Refreshed its current state."
                }
            case .error(let error):
                notice = error.message
            default:
                throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    /// Fires a monitor now, whatever its schedule says. Works for disabled and
    /// built-in monitors too: an explicit request outranks the switch.
    public func runMonitor(id: String) async {
        guard let monitor = monitors.first(where: { $0.id == id }) else { return }
        runningMonitorIDs.insert(id)
        defer { runningMonitorIDs.remove(id) }
        do {
            let request = ControlRequest.monitorsRun(id: requestID(), payload: MonitorRunPayload(id: id))
            switch try await transport.request(request) {
            case .response(.monitorsRun(_, let payload)):
                notice = payload.dispatched
                    ? "Running \"\(monitor.name)\" now."
                    : (payload.reason.map { "Did not run \"\(monitor.name)\": \($0)." } ?? "Did not run \"\(monitor.name)\".")
            case .error(let error):
                notice = error.message
            default:
                throw PanelModelError.unexpectedFrame
            }
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func setPaused(_ paused: Bool) async {
        do {
            let request: ControlRequest = paused
                ? .daemonPause(id: requestID())
                : .daemonResume(id: requestID())
            let frame = try await transport.request(request)
            guard case .response(.daemonPause(_, let payload)) = frame, payload.paused == paused else {
                throw PanelModelError.unexpectedFrame
            }
            await refreshStatus()
        } catch {
            markDaemonAbsent(error)
        }
    }

    public func clearNotice() {
        notice = nil
    }

    private func replaceMonitor(_ monitor: Monitor) {
        guard let index = monitors.firstIndex(where: { $0.id == monitor.id }) else {
            monitors.append(monitor)
            return
        }
        monitors[index] = monitor
    }

    private func markDaemonAbsent(_ error: Error) {
        // Only a transport failure means "not running". A frame we cannot decode
        // means the daemon is newer than this panel: keep the last good state.
        if error is PanelModelError || error is DecodingError || error is ControlCodecError {
            connectionError = "Gajae is running but this panel is out of date. Reinstall to update it."
            if status == nil { connectionState = .absent }
            return
        }
        connectionState = .absent
        status = nil
        monitors = []
        connectionError = "Gajae is not responding. Try Restart Gajae or Force Restart & Reset."
    }

    private struct LaunchctlResult: Sendable {
        let status: Int32
    }

    nonisolated static func kickstartDaemon() async throws {
        let result = await Task.detached(priority: .userInitiated) {
            PanelViewModel.runLaunchctlKickstart()
        }.value
        guard result.status == 0 else {
            throw RecoveryError.kickstartFailed
        }
    }

    private nonisolated static func runLaunchctlKickstart() -> LaunchctlResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart", "-k", "gui/\(getuid())/co.openinstinct.daemon"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return LaunchctlResult(status: process.terminationStatus)
        } catch {
            return LaunchctlResult(status: -1)
        }
    }

    private func requestID() -> String {
        UUID().uuidString.lowercased()
    }
}

private enum RecoveryError: Error {
    case controlUnavailable
    case daemonUnavailable
    case kickstartFailed
}

private enum PanelModelError: LocalizedError {
    case unexpectedFrame

    var errorDescription: String? {
        switch self {
        case .unexpectedFrame:
            return "The daemon returned an unexpected control response."
        }
    }
}
