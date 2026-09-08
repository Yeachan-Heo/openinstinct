import AppKit
import SwiftUI

struct MenuBarView: View {
    @ObservedObject var model: PanelViewModel
    @ObservedObject var updates: UpdateChecker
    @State private var showingSettings = false
    @State private var showingSetup = false

    /// The checklist is the home screen until Gajae has replied to the owner
    /// once: by then every earlier step (config, identity, permissions, AI
    /// account) has necessarily worked. Before that, a `running` daemon with
    /// no AI account would otherwise sit on "Awake and listening" and stall.
    private var bootstrapNeedsSetup: Bool {
        guard model.connectionState == .connected, let status = model.status else { return false }
        switch status.bootstrap.state {
        case .configBlocked, .identityBlocked, .permissionBlocked, .credentialsBlocked: return true
        case .running: return !status.session.hasReplied
        case .starting, .degraded: return false
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Gajae")
                        .font(.headline)
                    Spacer()
                    Button {
                        Task { await model.reload() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .help("Check again and reload the model list")
                }

                if bootstrapNeedsSetup {
                    SetupView(model: model)
                } else if showingSetup {
                    SetupView(model: model) {
                        showingSetup = false
                    }
                } else {
                    StatusView(model: model) {
                        showingSetup = true
                    }

                    Divider()

                    MonitorsView(model: model)
                }

                HStack {
                    Spacer()
                    Button("Quick actions…") {
                        showingSettings.toggle()
                    }
                    .popover(isPresented: $showingSettings) {
                        SettingsView(model: model)
                            .padding()
                            .frame(width: 320)
                    }
                    // Rendered unconditionally: chat works in every bootstrap
                    // state the daemon can serve, so it never consults health.
                    Button("Chat…") {
                        ChatWindowController.shared.show(model: model)
                    }
                    Button("Settings…") {
                        SettingsWindowController.shared.show(model: model)
                    }
                }

                if updates.canUpdate {
                    UpdateRow(updates: updates)
                }
            }
            .padding(.horizontal)
            .padding(.top, 36)
            .padding(.bottom)
        }
        .frame(minWidth: 400, minHeight: 380)
        .task {
            // Poll while the popover is open so a pause/resume or lane change
            // made elsewhere (Chat, iMessage, another panel action) is
            // reflected without closing and reopening. `.task` is cancelled
            // when the popover closes, which ends the loop.
            await model.refresh()
            await updates.checkIfDue()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard !Task.isCancelled else { return }
                await model.refresh()
            }
        }
    }
}

/// One line at the bottom of the popover: what is installed, and an update
/// button when GitHub has a newer release. Hidden for source-checkout installs.
struct UpdateRow: View {
    @ObservedObject var updates: UpdateChecker

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(updates.installedVersion.map { "Gajae \($0)" } ?? "")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                switch updates.state {
                case .idle, .upToDate:
                    Button("Check for updates") { Task { await updates.check() } }
                        .font(.caption)
                    if case .upToDate = updates.state {
                        Text("Up to date").font(.caption).foregroundStyle(.secondary)
                    }
                case .checking:
                    ProgressView().controlSize(.small)
                    Text("Checking…").font(.caption).foregroundStyle(.secondary)
                case .available(let tag):
                    Button("Update to \(tag)") { updates.update() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                case .updating(let tag):
                    ProgressView().controlSize(.small)
                    Text("Installing \(tag)… the menu bar icon will disappear and come back.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                case .failed(let reason):
                    Text(reason).font(.caption).foregroundStyle(.orange)
                    Button("Retry") { Task { await updates.check() } }.font(.caption)
                }
            }
            if let log = updates.lastFailureLog {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("The last update did not finish.").font(.caption).foregroundStyle(.orange)
                        Spacer()
                        Button("Dismiss") { updates.dismissFailureLog() }.font(.caption)
                    }
                    Text(log)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .lineLimit(12)
                }
            }
        }
    }
}
// MARK: - Human-readable status

/// Internal, not private: shared by the Chat window and panel checks.
enum Health {
    case starting, needsPermission(String), needsSetup(String), needsOwnMessagesAccount(String), asleep, awake(imessage: Bool), trouble(String), offline(String?)

    var title: String {
        switch self {
        case .starting: return "Waking up…"
        case .needsPermission: return "Needs a permission"
        case .needsSetup: return "Needs setup"
        case .needsOwnMessagesAccount: return "Needs its own iMessage account"
        case .asleep: return "Paused"
        case .awake: return "Awake and listening"
        case .trouble: return "Something's off"
        case .offline: return "Not running"
        }
    }

    var detail: String {
        switch self {
        case .starting: return "Give it a few seconds."
        case .needsPermission(let why), .needsSetup(let why), .needsOwnMessagesAccount(let why), .trouble(let why): return why
        case .asleep: return "Messages you send are saved but not answered until you resume."
        case .awake(let imessage):
            // Chat always works; iMessage is an optional extra surface.
            return imessage
                ? "Text Gajae on iMessage or open Chat."
                : "Open Chat to talk to Gajae. Add your number under Settings → iMessage to text it too."
        case .offline(let why): return why ?? "Gajae isn't running on this Mac right now. Reinstall it, or wait a moment and check again."
        }
    }

    var symbol: String {
        switch self {
        case .starting: return "hourglass"
        case .needsPermission: return "lock.shield"
        case .needsSetup: return "wrench.and.screwdriver"
        case .needsOwnMessagesAccount: return "exclamationmark.triangle"
        case .asleep: return "moon.zzz"
        case .awake: return "checkmark.circle.fill"
        case .trouble: return "exclamationmark.triangle.fill"
        case .offline: return "bolt.slash"
        }
    }

    var color: Color {
        switch self {
        case .awake: return .green
        case .asleep, .starting: return .secondary
        case .needsPermission, .needsSetup, .needsOwnMessagesAccount, .trouble: return .orange
        case .offline: return .red
        }
    }
}

@MainActor
func health(for model: PanelViewModel) -> Health {
    switch model.connectionState {
    case .loading: return .starting
    case .absent: return .offline(nil)
    case .connected:
        guard let status = model.status else { return .starting }
        switch status.bootstrap.state {
        case .starting: return .starting
        case .permissionBlocked: return .needsPermission(status.bootstrap.remediation)
        case .configBlocked: return .needsSetup(status.bootstrap.remediation)
        case .identityBlocked: return .needsOwnMessagesAccount(status.bootstrap.remediation)
        case .credentialsBlocked: return .needsSetup(status.bootstrap.remediation)
        case .degraded: return .trouble(status.bootstrap.remediation)
        case .running:
            if status.session.paused { return .asleep }
            return .awake(imessage: status.imessage.state == .attached)
        }
    }
}

struct StatusView: View {
    @ObservedObject var model: PanelViewModel
    @State private var showDetails = false
    private let onShowSetup: (() -> Void)?

    init(model: PanelViewModel, onShowSetup: (() -> Void)? = nil) {
        self.model = model
        self.onShowSetup = onShowSetup
    }
    var body: some View {
        let state = health(for: model)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: state.symbol)
                    .foregroundStyle(state.color)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.title)
                        .font(.subheadline.weight(.semibold))
                    Text(state.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let status = model.status, model.connectionState == .connected {
                if let modelID = status.session.mainSessionModel, !modelID.isEmpty {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "cpu")
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text(PanelViewModel.modelDisplayName(modelID))
                                    .font(.subheadline.weight(.semibold))
                                if status.session.fastModeAvailable == true {
                                    Toggle("Fast", isOn: Binding(
                                        get: { status.session.fastModeEnabled == true },
                                        set: { enabled in Task { await model.setFastMode(enabled) } }
                                    ))
                                    .toggleStyle(.switch)
                                    .controlSize(.mini)
                                    .disabled(model.recoveryInProgress)
                                }
                            }
                            Text(status.session.fastModeEnabled == true
                                ? "Faster replies are on"
                                : "Current AI model for Gajae's replies")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if let attention = status.attention {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(attention.title, systemImage: "hand.raised.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.orange)
                        Text(attention.detail)
                            .font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                        if attention.action == "open_settings" {
                            Button("Open Settings") { SettingsWindowController.shared.show(model: model, tab: .account) }
                                .controlSize(.small)
                        }
                        if attention.action == "open_automation" {
                            Button("Open Automation settings") {
                                                                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")!)
                            }
                            .controlSize(.small)
                            Text("Find openinstinctd in the list and switch on Messages.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(8)
                    .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                }
                if !status.activeChildren.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Working on")
                            .font(.subheadline.weight(.semibold))
                        ForEach(status.activeChildren) { child in
                            HStack(alignment: .top) {
                                Image(systemName: child.state == .running ? "circle.dotted" : "clock")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(child.title)
                                    Text(childCaption(child))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                        }
                    }
                }

                DisclosureGroup("Details", isExpanded: $showDetails) {
                    VStack(alignment: .leading, spacing: 4) {
                        LabeledContent("Engine", value: status.bootstrap.state.rawValue)
                        LabeledContent("Conversation", value: status.session.state == .active ? "open" : "closed")
                        if let mainSessionID = status.session.mainSessionId {
                            LabeledContent("Conversation ID", value: mainSessionID)
                        }
                        if let modelID = status.session.mainSessionModel, !modelID.isEmpty {
                            LabeledContent("AI model", value: PanelViewModel.modelDisplayName(modelID))
                            LabeledContent("Model ID", value: modelID)
                        }
                        if status.bootstrap.state == .running && !status.bootstrap.remediation.isEmpty {
                            Text(status.bootstrap.remediation)
                                .foregroundStyle(.orange)
                        }
                        if status.bootstrap.state == .running, let onShowSetup {
                            Button("Setup checklist", action: onShowSetup)
                                .controlSize(.small)
                        }
                        if !status.recentChildren.isEmpty {
                            Text("Recent tasks")
                                .font(.caption.weight(.semibold))
                                .padding(.top, 4)
                            ForEach(status.recentChildren) { child in
                                HStack(alignment: .top, spacing: 6) {
                                    Image(systemName: recentChildSymbol(child.state))
                                        .foregroundStyle(child.state == .completed || child.state == .cold ? Color.secondary : Color.orange)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(child.title)
                                            .lineLimit(1)
                                        Text(recentChildCaption(child))
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    .font(.caption)
                    .textSelection(.enabled)
                }
                .font(.caption)
            }

            if case .offline = state, let error = model.connectionError {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            RecoveryView(model: model)
        }
    }
}

private struct RecoveryView: View {
    @ObservedObject var model: PanelViewModel
    @State private var showingForceConfirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Recovery", systemImage: "arrow.triangle.2.circlepath")
                .font(.subheadline.weight(.semibold))
            Text("Having trouble? Restarting keeps your memory, settings, and sign-ins safe.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("Restart Gajae") {
                    Task { await model.restartDaemon() }
                }
                .controlSize(.small)
                .disabled(model.recoveryInProgress)

                Button("Force Restart & Reset", role: .destructive) {
                    showingForceConfirmation = true
                }
                .controlSize(.small)
                .disabled(model.recoveryInProgress)
            }
            if model.recoveryInProgress {
                ProgressView("Working…")
                    .controlSize(.small)
                    .font(.caption)
            }
        }
        .padding(8)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .confirmationDialog(
            "Start fresh and restart Gajae?",
            isPresented: $showingForceConfirmation,
            titleVisibility: .visible
        ) {
            Button("Force Restart & Reset", role: .destructive) {
                Task { await model.forceRestartAndReset() }
            }
            Button("Keep current conversation", role: .cancel) {}
        } message: {
            Text("This starts a fresh conversation and restarts Gajae. Your memory, settings, and sign-ins stay safe.")
        }
    }
}

// MARK: - Monitors (scheduled tasks)

struct MonitorsView: View {
    @ObservedObject var model: PanelViewModel
    @State private var pendingDelete: Monitor?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Scheduled tasks")
                        .font(.subheadline.weight(.semibold))
                    Text("Things Gajae does on its own and tells you about. Ask in Chat or iMessage to add one.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            if let notice = model.notice {
                HStack {
                    Image(systemName: "info.circle")
                    Text(notice)
                        .font(.caption)
                    Spacer()
                    Button("OK") {
                        model.clearNotice()
                    }
                    .font(.caption)
                }
                .foregroundStyle(.orange)
            }

            if model.connectionState == .connected && model.monitors.isEmpty {
                Text("Nothing scheduled yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            ForEach(model.monitors) { monitor in
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(friendlyName(monitor))
                        Text(scheduleText(monitor))
                            .font(.caption)
                            .foregroundStyle(monitor.enabled ? Color.secondary : Color.orange)
                    }
                    Spacer()
                    Button {
                        Task { await model.runMonitor(id: monitor.id) }
                    } label: {
                        Image(systemName: "play.circle")
                    }
                    .buttonStyle(.borderless)
                    .help("Run now, whatever the schedule says")
                    .disabled(model.runningMonitorIDs.contains(monitor.id))
                    Toggle("", isOn: Binding(
                        get: { monitor.enabled },
                        set: { enabled in
                            Task { await model.toggleMonitor(id: monitor.id, enabled: enabled) }
                        }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .disabled(model.togglingMonitorIDs.contains(monitor.id))
                    .help(monitor.enabled ? "Turn off" : "Turn on")
                    Button(role: .destructive) {
                        pendingDelete = monitor
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.borderless)
                    .help(monitor.enabled ? "Turn it off first, then you can delete it" : "Delete")
                    .disabled(monitor.enabled || model.togglingMonitorIDs.contains(monitor.id))
                }
            }
        }
        .confirmationDialog(
            "Delete \u{201C}\(pendingDelete.map(friendlyName) ?? "")\u{201D}?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let monitor = pendingDelete {
                    Task { await model.deleteMonitor(id: monitor.id) }
                }
                pendingDelete = nil
            }
            Button("Keep it", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("Gajae will stop doing this. You can always ask for it again in Chat or iMessage.")
        }
    }

    private func friendlyName(_ monitor: Monitor) -> String {
        switch monitor.id {
        case "memory-canonicalize": return "Tidy up memory"
        case "memory-audit": return "Check memory health"
        case "computer-usage-insight": return "Daily ideas from how you use this Mac"
        case "heartbeat": return "Check-in (only texts if something's new)"
        default: return monitor.name
        }
    }

    private func scheduleText(_ monitor: Monitor) -> String {
        let expired = monitor.expiresAt.flatMap(parseISO).map { $0 <= Date() } ?? false
        if expired {
            return "Ended \(friendlyTime(monitor.expiresAt!))"
        }
        if !monitor.enabled {
            return "Off"
        }
        var parts: [String] = []
        if let next = model.status?.monitors.first(where: { $0.id == monitor.id })?.nextFire {
            parts.append("Next \(friendlyTime(next))")
        }
        if let last = monitor.lastFiredAt {
            parts.append("Last \(friendlyTime(last))")
        }
        if let until = monitor.expiresAt {
            parts.append("until \(friendlyTime(until))")
        }
        return parts.isEmpty ? "On" : parts.joined(separator: " · ")
    }
}

// MARK: - More

struct SettingsView: View {
    @ObservedObject var model: PanelViewModel
    @State private var confirmReset = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("More")
                .font(.headline)
            VStack(alignment: .leading, spacing: 4) {
                Text("Gajae only answers this number")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.status?.settings.allowlistHandle ?? "Not set up yet")
                    .textSelection(.enabled)
            }
            Divider()
            let paused = model.status?.session.paused == true
            Button(paused ? "Resume — start answering again" : "Pause — stop answering for now") {
                Task { await model.setPaused(!paused) }
            }
            .disabled(model.connectionState != .connected)
            Text(paused
                 ? "Messages sent while paused are kept; Gajae will tell you how many it missed."
                 : "Use this if you want quiet for a while. Nothing is lost.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Divider()
            VStack(alignment: .leading, spacing: 4) {
                Button("Open Gajae's browser") {
                    Task { await model.openBrowserProfile() }
                }
                .disabled(model.connectionState != .connected)
                Text("Gajae has its own Chrome. Sign into sites there once (Gmail, Kakao, your bank) and it stays signed in — your own Chrome is never touched.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            HStack {
                Button("Reset conversation", role: .destructive) {
                    confirmReset = true
                }
                .disabled(model.connectionState != .connected || model.status?.session.state != .active)
                .confirmationDialog("Start a fresh conversation?", isPresented: $confirmReset, titleVisibility: .visible) {
                    Button("Reset", role: .destructive) { Task { await model.resetSession() } }
                    Button("Keep it", role: .cancel) {}
                } message: {
                    Text("Gajae forgets the current chat thread. Long-term memory and scheduled tasks stay.")
                }
            }
            HStack {
                Button("Refresh personality") {
                    Task { await model.reloadPersona() }
                }
                .help("Apply the latest Gajae personality without losing the conversation")
                .disabled(model.connectionState != .connected || model.status?.session.state != .active)
                Spacer()
                Button("Show log files") {
                    NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".openinstinct/logs"))
                }
                .font(.caption)
            }
        }
    }
}


/// ISO-8601 (usually UTC) → "Today 9:00 AM", "Tomorrow 6:00 AM", "Sep 5, 3:15 PM" in the Mac's own time zone.
func parseISO(_ iso: String) -> Date? {
    let a = ISO8601DateFormatter(); a.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let b = ISO8601DateFormatter(); b.formatOptions = [.withInternetDateTime]
    return a.date(from: iso) ?? b.date(from: iso)
}

func friendlyTime(_ iso: String) -> String {
    guard let date = parseISO(iso) else { return iso }
    let cal = Calendar.current
    let time = DateFormatter()
    time.locale = Locale(identifier: "en_US_POSIX")
    time.timeZone = .current
    time.dateFormat = "h:mm a"
    let t = time.string(from: date)
    if cal.isDateInToday(date) { return "today \(t)" }
    if cal.isDateInTomorrow(date) { return "tomorrow \(t)" }
    if cal.isDateInYesterday(date) { return "yesterday \(t)" }
    let day = DateFormatter()
    day.locale = Locale(identifier: "en_US_POSIX")
    day.timeZone = .current
    day.dateFormat = cal.isDate(date, equalTo: Date(), toGranularity: .year) ? "MMM d" : "MMM d, yyyy"
    return "\(day.string(from: date)) \(t)"
}


/// "started 12:27 AM · 6m · 8 tools · 41k tokens" — or "waiting for a slot" while queued.
func childCaption(_ child: ActiveChild) -> String {
    switch child.state {
    case .idle:
        return "finished, waiting for a nudge"
    case .cold:
        return "asleep"
    case .running:
        var parts: [String] = []
        if let iso = child.startedAt ?? child.createdAt, let date = parseISO(iso) {
            let t = DateFormatter(); t.locale = Locale(identifier: "en_US_POSIX"); t.timeZone = .current; t.dateFormat = "h:mm a"
            parts.append("started \(t.string(from: date))")
            let secs = Int(Date().timeIntervalSince(date))
            parts.append(secs < 60 ? "\(secs)s" : secs < 3600 ? "\(secs / 60)m" : "\(secs / 3600)h \((secs % 3600) / 60)m")
        }
        if let n = child.toolCalls, n > 0 { parts.append("\(n) tool\(n == 1 ? "" : "s")") }
        if let tok = child.tokens { parts.append(tok >= 1000 ? "\(tok / 1000)k tokens" : "\(tok) tokens") }
        return parts.isEmpty ? "in progress" : parts.joined(separator: " · ")
    default:
        return "waiting for a slot"
    }
}

func recentChildSymbol(_ state: ChildState) -> String {
    switch state {
    case .completed: return "checkmark.circle"
    case .cancelled: return "xmark.circle"
    case .terminated, .cold: return "moon.zzz"
    default: return "exclamationmark.triangle"
    }
}

/// "finished 11:38 AM · 4m · 8 tools · 41k tokens" (or "failed …") for the Details list.
func recentChildCaption(_ child: ActiveChild) -> String {
    var parts: [String] = []
    let verb: String
    switch child.state {
    case .completed: verb = "finished"
    case .cancelled: verb = "cancelled"
    case .cold: verb = "asleep since"
    default: verb = child.state.rawValue
    }
    if let iso = child.updatedAt, let end = parseISO(iso) {
        parts.append("\(verb) \(friendlyTime(iso))")
        if let startISO = child.startedAt, let start = parseISO(startISO) {
            let secs = Int(end.timeIntervalSince(start))
            parts.append(secs < 60 ? "\(secs)s" : secs < 3600 ? "\(secs / 60)m" : "\(secs / 3600)h \((secs % 3600) / 60)m")
        }
    } else {
        parts.append(verb)
    }
    if let n = child.toolCalls, n > 0 { parts.append("\(n) tool\(n == 1 ? "" : "s")") }
    if let tok = child.tokens { parts.append(tok >= 1000 ? "\(tok / 1000)k tokens" : "\(tok) tokens") }
    return parts.joined(separator: " · ")
}
