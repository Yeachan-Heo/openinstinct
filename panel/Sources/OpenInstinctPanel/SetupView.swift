import AppKit
import SwiftUI

struct SetupView: View {
    @ObservedObject var model: PanelViewModel
    @StateObject private var settings: SettingsModel
    private let onBack: (() -> Void)?

    init(model: PanelViewModel, onBack: (() -> Void)? = nil) {
        self.model = model
        self.onBack = onBack
        _settings = StateObject(wrappedValue: SettingsModel(transport: UnixSocketTransport()))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Setup checklist")
                        .font(.headline)
                    Text("Finish these steps to get Gajae ready.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let onBack {
                    Button("Back to status", action: onBack)
                        .controlSize(.small)
                }
            }

            if let status = model.status {
                let probes = status.bootstrap.probes
                ownerStep(probe: probes["config"])
                messagesStep(probe: probes["messages"])
                fdaStep(probe: probes["fda"])
                accessibilityStep(probe: probes["accessibility"])
                accountsStep
                if isDone(probes["config"]) && isDone(probes["messages"]) && isDone(probes["fda"]) && isDone(probes["accessibility"]) {
                    textStep(status: status)
                }
            } else {
                Text("Waiting for Gajae to report its setup status.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .task {
            await model.refreshStatus()
            await settings.load()
            if settings.accounts.isEmpty {
                await settings.loadDiscovered()
            }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard !Task.isCancelled else { break }
                await model.refreshStatus()
                await settings.loadAccounts()
            }
        }
    }

    @ViewBuilder
    private func ownerStep(probe: ProbeInfo?) -> some View {
        SetupStepRow(
            state: state(for: probe),
            title: "Who you are",
            detail: ownerDetail(probe: probe)
        ) {
            if probe?.status != "passed" {
                VStack(alignment: .leading, spacing: 6) {
                    TextField("Your phone number (with country code, e.g. +82…)", text: $settings.ownerHandle)
                    TextField("What Gajae should call you", text: $settings.ownerName)
                    HStack {
                        Button("Save") {
                            Task {
                                await settings.save([
                                    "ownerHandle": .string(settings.ownerHandle),
                                    "ownerName": .string(settings.ownerName),
                                ])
                            }
                        }
                        .disabled(settings.busy || settings.ownerHandle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || settings.ownerName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        if let message = settings.message {
                            Text(message)
                                .font(.caption)
                                .foregroundStyle(message.hasPrefix("Saved") ? Color.secondary : Color.red)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func messagesStep(probe: ProbeInfo?) -> some View {
        SetupStepRow(
            state: state(for: probe),
            title: "Gajae's own iMessage account",
            detail: messagesDetail(probe: probe)
        ) {
            if let probe, probe.status != "passed" {
                VStack(alignment: .leading, spacing: 4) {
                    Button("Open Messages") {
                        NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/Messages.app"))
                    }
                    .controlSize(.small)
                    Text(probe.status == "invalid"
                        ? "In Messages: Settings (⌘,) → iMessage → Sign Out, then sign in with the Apple ID you made for Gajae. Your iPhone keeps your own account."
                        : "In Messages: Settings (⌘,) → iMessage → sign in with the Apple ID you made for Gajae.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private func fdaStep(probe: ProbeInfo?) -> some View {
        SetupStepRow(
            state: state(for: probe),
            title: "Full Disk Access — required baseline",
            detail: "A one-time macOS switch, not a per-action prompt. " + probeDetail(probe: probe, passed: "Verified by the access probe.")
        ) {
            if probe?.status != "passed" {
                VStack(alignment: .leading, spacing: 4) {
                    Button("Open Full Disk Access") {
                        let path = NSHomeDirectory() + "/.openinstinct/bin/openinstinctd"
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(path, forType: .string)
                        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .controlSize(.small)
                    Text("Press +, then ⌘⇧G, paste, Enter, and switch on openinstinctd. The path is already copied. Gajae cannot grant this permission itself; Chat keeps running with limited OS access until the probe verifies it.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private func accessibilityStep(probe: ProbeInfo?) -> some View {
        SetupStepRow(
            state: state(for: probe),
            title: "Let Gajae control Messages",
            detail: probeDetail(probe: probe, passed: "Gajae can control Messages.")
        ) {
            if let probe, probe.status != "passed" {
                VStack(alignment: .leading, spacing: 4) {
                    Button("Open Automation") {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .controlSize(.small)
                    Text("Find openinstinctd and switch on Messages. If macOS asked you already, just click Allow.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var accountsStep: some View {
        let adoptableRows = settings.discovered.filter { $0.adoptable }
        let detail: String
        if !settings.accounts.isEmpty {
            detail = "An AI account is connected."
        } else if !adoptableRows.isEmpty {
            detail = "Found a sign-in you already have. Gajae can use it, or sign in separately."
        } else {
            detail = "Sign in to an AI account so Gajae can think."
        }

        return SetupStepRow(
            state: settings.accounts.isEmpty ? .pending : .done,
            title: "AI account",
            detail: detail
        ) {
            if settings.accounts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(settings.discovered) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.label)
                                .font(.subheadline.weight(.semibold))
                            if row.adoptable {
                                Text("\(row.source) · \(row.identity ?? row.redactedToken)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Button("Use this login") {
                                    Task {
                                        await settings.adopt(row.id)
                                        await settings.loadDiscovered()
                                    }
                                }
                                .controlSize(.small)
                                .disabled(settings.busy)
                            } else {
                                Text(row.reason ?? "")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button(adoptableRows.isEmpty ? "Sign in…" : "Sign in separately") {
                        SettingsWindowController.shared.show(model: model, tab: .account)
                    }
                    .controlSize(.small)
                }
            }
        }
    }

    @ViewBuilder
    private func textStep(status: StatusResponsePayload) -> some View {
        let alias = status.bootstrap.probes["messages"]?.aliases?.first ?? "Gajae's iMessage address"
        let ownerHandle = status.settings.allowlistHandle ?? "your phone number"
        SetupStepRow(
            state: status.session.hasReplied ? .done : .pending,
            title: "Text Gajae",
            detail: status.session.hasReplied
                ? "Gajae has replied to you. You're all set."
                : "Save \(alias) in your iPhone contacts as Gajae, then text it from \(ownerHandle)."
        ) {
            EmptyView()
        }
    }

    private func isDone(_ probe: ProbeInfo?) -> Bool {
        probe?.status == "passed"
    }

    private func state(for probe: ProbeInfo?) -> SetupStepState {
        guard let probe else { return .pending }
        switch probe.status {
        case "passed": return .done
        case "invalid", "denied": return .warning
        default: return .pending
        }
    }

    private func ownerDetail(probe: ProbeInfo?) -> String {
        guard let probe else { return "Enter your phone number and name." }
        if probe.status == "passed" {
            let handle = model.status?.settings.allowlistHandle
            return handle.map { "Gajae answers \($0) only. Change it under Settings… → You." } ?? "Gajae knows who to text."
        }
        return probe.reason ?? "Enter your phone number and name."
    }

    private func messagesDetail(probe: ProbeInfo?) -> String {
        guard let probe else { return "After the step above." }
        if probe.status == "passed" {
            let aliases = probe.aliases ?? []
            return aliases.isEmpty ? "Signed in to iMessage." : "Signed in as \(aliases.joined(separator: ", "))."
        }
        return probe.reason ?? "After the step above."
    }

    private func probeDetail(probe: ProbeInfo?, passed: String) -> String {
        guard let probe else { return "After the step above." }
        if probe.status == "passed" { return passed }
        return probe.reason ?? "After the step above."
    }
}

private enum SetupStepState {
    case done
    case pending
    case warning

    var symbol: String {
        switch self {
        case .done: return "checkmark.circle.fill"
        case .pending: return "circle"
        case .warning: return "exclamationmark.triangle"
        }
    }

    var color: Color {
        switch self {
        case .done: return .green
        case .pending: return .secondary
        case .warning: return .orange
        }
    }
}

private struct SetupStepRow<Action: View>: View {
    let state: SetupStepState
    let title: String
    let detail: String
    let action: Action

    init(state: SetupStepState, title: String, detail: String, @ViewBuilder action: () -> Action) {
        self.state = state
        self.title = title
        self.detail = detail
        self.action = action()
    }

    private var backgroundColor: Color {
        switch state {
        case .warning: return Color.orange.opacity(0.12)
        case .done, .pending: return Color.secondary.opacity(0.08)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: state.symbol)
                .foregroundStyle(state.color)
                .font(.title3)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                action
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .background(backgroundColor, in: RoundedRectangle(cornerRadius: 8))
    }
}
