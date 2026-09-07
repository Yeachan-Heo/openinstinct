import AppKit
import SwiftUI

/// Everything an owner can configure, in plain words. Opens as a normal window
/// (not the popover) so it survives clicks elsewhere.
@MainActor
final class SettingsWindowController {
    static let shared = SettingsWindowController()
    private var window: NSWindow?

    func show(model: PanelViewModel, tab: SettingsTab = .account) {
        if window == nil {
            let view = SettingsRootView(model: model, initialTab: tab)
            let w = NSWindow(contentViewController: NSHostingController(rootView: view))
            w.title = "Gajae Settings"
            w.setContentSize(NSSize(width: 560, height: 480))
            w.styleMask = [.titled, .closable, .miniaturizable]
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

enum SettingsTab: String, CaseIterable, Identifiable {
    case account = "AI account", owner = "You", imessage = "iMessage", browser = "Browser", limits = "Limits", personality = "Personality"
    var id: String { rawValue }
}

@MainActor
final class SettingsModel: ObservableObject {
    @Published var snapshot: SettingsSnapshotPayload?
    @Published var models: [ModelChoice] = []
    @Published var accounts: [AccountRow] = []
    @Published var busy = false
    @Published var discovered: [DiscoveredCredential] = []
    @Published var message: String?
    @Published var loginURL: String?
    @Published var loginCode = ""
    @Published var apiKeyProvider = "ANTHROPIC_API_KEY"
    @Published var apiKeyValue = ""
    @Published var selectedModel = ""
    @Published var modelQuery = ""

    var filteredModels: [ModelChoice] {
        let q = modelQuery.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return models }
        let terms = q.split(separator: " ").map(String.init)
        return models.filter { m in terms.allSatisfy { m.id.lowercased().contains($0) || m.canonical.lowercased().contains($0) } }
    }
    @Published var ownerName = ""
    @Published var ownerHandle = ""
    @Published var watchdogSec = 300
    @Published var childMax = 4
    @Published var childWarmTtlSec = 600
    @Published var childIdleTimeoutSec = 86_400
    @Published var childMaxLive = 16
    @Published var childInterimBatchSec = 3
    @Published var childInterimRatePerMinute = 6
    @Published var childInterimMaxBytes = 1_024
    @Published var childStatusListLimit = 20
    @Published var childStatusTextBytes = 512
    @Published var childToolGuardMs = 50
    @Published var soulText = ""
    @Published var providers: [OAuthProviderRow] = []
    @Published var selectedProvider = "anthropic"
    @Published var customId = ""
    @Published var customBaseUrl = ""
    @Published var customApi = "openai-responses"
    @Published var customKey = ""
    @Published var customModel = ""

    private let transport: UnixSocketTransport
    init(transport: UnixSocketTransport) { self.transport = transport }

    private func req(_ r: ControlRequest) async throws -> ControlFrame { try await transport.request(r) }
    private func id() -> String { UUID().uuidString.lowercased() }

    func load() async {
        busy = true; defer { busy = false }
        do {
            if case .response(.settingsGet(_, let s)) = try await req(.settingsGet(id: id())) {
                snapshot = s
                selectedModel = s.mainSessionModel
                ownerName = s.ownerName
                ownerHandle = s.ownerHandle
                watchdogSec = s.mainTurnWatchdogSec
                childMax = s.childMaxConcurrent
                childWarmTtlSec = s.childWarmTtlSec
                childIdleTimeoutSec = s.childIdleTimeoutSec
                childMaxLive = s.childMaxLive
                childInterimBatchSec = s.childInterimBatchSec
                childInterimRatePerMinute = s.childInterimRatePerMinute
                childInterimMaxBytes = s.childInterimMaxBytes
                childStatusListLimit = s.childStatusListLimit
                childStatusTextBytes = s.childStatusTextBytes
                childToolGuardMs = s.childToolGuardMs
                soulText = s.soulText
            }
            async let a = req(.accountsList(id: id()))
            async let m = req(.modelsList(id: id()))
            async let p = req(.accountsProviders(id: id()))
            if case .response(.accountsList(_, let r)) = try await a { accounts = r.accounts }
            if case .response(.modelsList(_, let r)) = try await m { models = r.models }
            if case .response(.accountsProviders(_, let r)) = try await p { providers = r.providers }
        } catch {
            message = "Gajae isn't running, so settings can't load yet."
        }
    }

    func loadAccounts() async {
        do {
            let frame = try await req(.accountsList(id: id()))
            if case .response(.accountsList(_, let r)) = frame {
                accounts = r.accounts
            }
        } catch {
            message = "Gajae isn't running, so settings can't load yet."
        }
    }

    func loadDiscovered() async {
        busy = true; defer { busy = false }
        do {
            let frame = try await req(.accountsDiscover(id: id()))
            if case .response(.accountsDiscover(_, let r)) = frame {
                discovered = r.credentials
            } else {
                discovered = []
            }
        } catch {
            discovered = []
        }
    }

    func adopt(_ id: String) async {
        busy = true; defer { busy = false }
        do {
            let frame = try await req(.accountsAdopt(id: self.id(), payload: AccountsAdoptPayload(id: id)))
            switch frame {
            case .response(.accountsAdopt(_, let r)):
                message = r.restarting
                    ? "Using your existing sign-in. Gajae is restarting to apply it…"
                    : "Using your existing sign-in."
                if r.restarting { await awaitRestart(then: "Using your existing sign-in.") }
                await loadAccounts()
            case .error(let e): message = e.message
            default: message = "Unexpected reply."
            }
        } catch { message = error.localizedDescription }
    }

    func save(_ patch: [String: JSONValue]) async {
        busy = true; defer { busy = false }
        do {
            let frame = try await req(.settingsSet(id: id(), payload: SettingsSetPayload(patch: patch)))
            switch frame {
            case .response(.settingsSet(_, let r)):
                message = r.restarting ? "Saved. Gajae is restarting to apply it…" : "Saved."
                if r.restarting { await awaitRestart(then: "Saved and applied.") } else { await load() }
            case .error(let e): message = e.message
            default: message = "Unexpected reply."
            }
        } catch { message = error.localizedDescription }
    }

    /// A `restarting: true` reply means the daemon will exit and launchd should
    /// bring it back. Wait for that cycle (down, then up) with a deadline; if it
    /// never comes back, kickstart it once and say what happened. Without this
    /// the window sat on "restarting…" forever when the relaunch failed.
    private func awaitRestart(then success: String) async {
        let deadline = Date().addingTimeInterval(20)
        var wentDown = false
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 400_000_000)
            if let state = await probeState() {
                if wentDown && state == "running" {
                    message = success
                    await load()
                    return
                }
            } else {
                wentDown = true
            }
        }
        message = "Gajae did not come back on its own; starting it again…"
        try? await PanelViewModel.kickstartDaemon()
        for _ in 0..<25 {
            try? await Task.sleep(nanoseconds: 400_000_000)
            if await probeState() == "running" {
                message = success
                await load()
                return
            }
        }
        message = "Gajae could not restart. Quick actions → Show log files, then open launchd.stderr.log for the reason."
    }

    /// Bootstrap state when the control socket answers, nil when it does not.
    private func probeState() async -> String? {
        guard let frame = try? await req(.statusGet(id: id())),
              case .response(.status(_, let status)) = frame else { return nil }
        return status.bootstrap.state.rawValue
    }

    func startLogin(provider: String) async {
        busy = true; defer { busy = false }
        loginURL = nil; loginCode = ""
        do {
            let frame = try await req(.accountsLogin(id: id(), payload: AccountsLoginPayload(provider: provider)))
            switch frame {
            case .response(.accountsLogin(_, let r)):
                loginURL = r.url
                if let url = URL(string: r.url) { NSWorkspace.shared.open(url) }
                message = "Your browser opened. Sign in, then come back here — if it shows a code or the page won't load, paste what it shows below."
            case .error(let e): message = e.message
            default: message = "Unexpected reply."
            }
        } catch { message = error.localizedDescription }
    }

    func finishLogin() async {
        busy = true; defer { busy = false }
        do {
            let frame = try await req(.accountsLoginFinish(id: id(), payload: AccountsLoginFinishPayload(code: loginCode)))
            switch frame {
            case .response(.ok): message = "Signed in."; loginURL = nil; loginCode = ""; await load()
            case .error(let e): message = e.message
            default: message = "Unexpected reply."
            }
        } catch { message = error.localizedDescription }
    }

    func addCustom() async {
        busy = true; defer { busy = false }
        do {
            let frame = try await req(.providersCustom(id: id(), payload: ProvidersCustomPayload(id: customId, baseUrl: customBaseUrl, api: customApi, apiKey: customKey, model: customModel)))
            switch frame {
            case .response(.providersCustom(_, let r)): message = "Saved. Gajae now uses \(r.modelId)."; customKey = ""; await load()
            case .error(let e): message = e.message
            default: message = "Unexpected reply."
            }
        } catch { message = error.localizedDescription }
    }

    func logout(_ row: AccountRow) async {
        busy = true; defer { busy = false }
        let selector = row.identity ?? row.id
        do {
            _ = try await req(.accountsLogout(id: id(), payload: AccountsLogoutPayload(provider: row.provider, account: selector)))
            await load()
        } catch { message = error.localizedDescription }
    }
}

struct SettingsRootView: View {
    @ObservedObject var model: PanelViewModel
    @StateObject private var settings: SettingsModel
    @State private var tab: SettingsTab

    init(model: PanelViewModel, initialTab: SettingsTab) {
        self.model = model
        _settings = StateObject(wrappedValue: SettingsModel(transport: UnixSocketTransport()))
        _tab = State(initialValue: initialTab)
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                ForEach(SettingsTab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding()
            Divider()
            ScrollView {
                Group {
                    switch tab {
                    case .account: AccountTab(s: settings)
                    case .owner: OwnerTab(s: settings)
                    case .imessage: ImessageTab(s: settings, model: model)
                    case .browser: BrowserTab(s: settings, model: model)
                    case .limits: LimitsTab(s: settings)
                    case .personality: PersonalityTab(s: settings)
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let m = settings.message {
                Divider()
                HStack {
                    Text(m).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    if settings.busy { ProgressView().controlSize(.small) }
                }
                .padding(.horizontal).padding(.vertical, 8)
            }
        }
        .frame(minWidth: 560, minHeight: 480)
        .task { await settings.load() }
    }
}

private struct AccountTab: View {
    @ObservedObject var s: SettingsModel
    private let oauthProviders: [(id: String, label: String)] = [
        ("anthropic", "Claude (Anthropic)"),
        ("openai-codex", "ChatGPT / Codex (OpenAI)"),
    ]
    private let keyProviders: [(env: String, label: String)] = [
        ("ANTHROPIC_API_KEY", "Anthropic API key"),
        ("OPENAI_API_KEY", "OpenAI API key"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Gajae needs an AI account to think with. Pick one way — a subscription you already pay for, or an API key.")
                .fixedSize(horizontal: false, vertical: true)

            GroupBox("Sign in with an account you already have") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Picker("", selection: $s.selectedProvider) {
                            Section("Popular") { ForEach(s.providers.filter { $0.popular }) { Text($0.label).tag($0.id) } }
                            Section("More") { ForEach(s.providers.filter { !$0.popular }) { Text($0.label).tag($0.id) } }
                        }
                        .labelsHidden().frame(maxWidth: 280)
                        Button("Sign in…") { Task { await s.startLogin(provider: s.selectedProvider) } }
                    }
                    if s.loginURL != nil {
                        Divider()
                        Text("If the browser didn't finish on its own, paste the code or the final address it showed:")
                            .font(.caption).foregroundStyle(.secondary)
                        HStack {
                            TextField("code or https://…", text: $s.loginCode)
                            Button("Done") { Task { await s.finishLogin() } }.disabled(s.loginCode.isEmpty)
                        }
                    }
                }
                .padding(6)
            }

            GroupBox("Or connect your own endpoint") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Any OpenAI- or Anthropic-compatible gateway: your company proxy, OpenRouter, a local server.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        TextField("Name (e.g. my-gateway)", text: $s.customId).frame(width: 160)
                        Picker("", selection: $s.customApi) {
                            Text("OpenAI Responses").tag("openai-responses")
                            Text("OpenAI Chat Completions").tag("openai-completions")
                            Text("Anthropic Messages").tag("anthropic-messages")
                        }.labelsHidden()
                    }
                    TextField("Base URL (https://…/v1)", text: $s.customBaseUrl)
                    HStack {
                        SecureField("API key", text: $s.customKey)
                        TextField("Model id (e.g. gpt-5)", text: $s.customModel).frame(width: 180)
                    }
                    Button("Connect and use") { Task { await s.addCustom() } }
                        .disabled(s.customId.isEmpty || s.customBaseUrl.isEmpty || s.customKey.isEmpty || s.customModel.isEmpty)
                }
                .padding(6)
            }

            GroupBox("Or paste an API key") {
                HStack {
                    Picker("", selection: $s.apiKeyProvider) {
                        ForEach(keyProviders, id: \.env) { Text($0.label).tag($0.env) }
                    }
                    .labelsHidden().frame(width: 180)
                    SecureField("sk-…", text: $s.apiKeyValue)
                    Button("Save") {
                        Task {
                            await s.save(["env": .object([s.apiKeyProvider: .string(s.apiKeyValue)])])
                            s.apiKeyValue = ""
                        }
                    }
                    .disabled(s.apiKeyValue.isEmpty)
                }
                .padding(6)
            }

            GroupBox("Signed in") {
                VStack(alignment: .leading, spacing: 6) {
                    if s.accounts.filter({ $0.kind == "oauth" }).isEmpty && (s.snapshot?.env.filter { $0.set }.isEmpty ?? true) {
                        Text("Nothing yet.").foregroundStyle(.secondary)
                    }
                    ForEach(s.accounts.filter { $0.kind == "oauth" }) { a in
                        HStack {
                            Image(systemName: "person.crop.circle.badge.checkmark")
                            Text("\(a.provider) — \(a.identity ?? "signed in")")
                            Spacer()
                            Button("Sign out") { Task { await s.logout(a) } }.controlSize(.small)
                        }
                    }
                    ForEach(s.snapshot?.env.filter { $0.set } ?? []) { e in
                        HStack {
                            Image(systemName: "key.fill")
                            Text(e.key.replacingOccurrences(of: "_API_KEY", with: " API key"))
                            Spacer()
                            Button("Remove") { Task { await s.save(["env": .object([e.key: .string("")])]) } }.controlSize(.small)
                        }
                    }
                }
                .padding(6)
            }

            GroupBox("Which model Gajae uses") {
                VStack(alignment: .leading, spacing: 8) {
                    if s.models.isEmpty && s.busy {
                        HStack { ProgressView().controlSize(.small); Text("Loading models…").font(.caption).foregroundStyle(.secondary) }
                    }
                    HStack {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField("Search models (e.g. sonnet, gpt-5, grok)", text: $s.modelQuery)
                            .textFieldStyle(.roundedBorder)
                    }
                    let filtered = s.filteredModels
                    List(selection: $s.selectedModel) {
                        if !filtered.contains(where: { $0.id == s.selectedModel }) && !s.selectedModel.isEmpty {
                            Text(s.selectedModel).tag(s.selectedModel)
                        }
                        ForEach(filtered) { m in
                            HStack {
                                Text(m.id)
                                Spacer()
                                Text(m.provider).font(.caption).foregroundStyle(.secondary)
                            }
                            .tag(m.id)
                        }
                    }
                    .frame(minHeight: 160, maxHeight: 220)
                    Text(filtered.count == s.models.count ? "\(s.models.count) models" : "\(filtered.count) of \(s.models.count) match")
                        .font(.caption2).foregroundStyle(.secondary)
                    Text("Only models your signed-in account can reach will work. Claude Sonnet or GPT-5 class models are good defaults.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Use this model") { Task { await s.save(["mainSessionModel": .string(s.selectedModel)]) } }
                        .disabled(s.selectedModel == s.snapshot?.mainSessionModel)
                }
                .padding(6)
            }
        }
    }
}

private struct OwnerTab: View {
    @ObservedObject var s: SettingsModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Gajae only ever talks to one person: you.")
            TextField("What Gajae should call you", text: $s.ownerName)
            Button("Save") { Task { await s.save(["ownerName": .string(s.ownerName)]) } }
        }
    }
}

private struct ImessageTab: View {
    @ObservedObject var s: SettingsModel
    @ObservedObject var model: PanelViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Optional. Gajae already talks to you in the Chat window; add your number to text it too.")
                .fixedSize(horizontal: false, vertical: true)

            TextField("Your phone number (with country code, e.g. +82…)", text: $s.ownerHandle)

            GroupBox("Status") {
                VStack(alignment: .leading, spacing: 8) {
                    laneStatusRow
                    probeStatusRow("Full Disk Access", key: "fda")
                    probeStatusRow("Automation", key: "accessibility")
                }
                .padding(6)
            }

            HStack {
                Button("Connect") { saveHandle(s.ownerHandle) }
                    .disabled(s.ownerHandle.isEmpty || s.busy)
                Button("Disconnect") { saveHandle("") }
                    .disabled(s.ownerHandle.isEmpty || s.busy)
            }
            Text("Connecting does not restart Gajae.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var laneStatusRow: some View {
        if let status = model.status {
            statusRow(
                "iMessage",
                value: status.imessage.state == .attached ? "Attached" : "Detached",
                detail: status.imessage.detail,
                color: status.imessage.state == .attached ? .green : .secondary
            )
        } else {
            statusRow("iMessage", value: "Waiting for status…", color: .secondary)
        }
    }

    @ViewBuilder
    private func probeStatusRow(_ label: String, key: String) -> some View {
        if let probe = model.status?.bootstrap.probes[key] {
            statusRow(label, value: probe.status.capitalized, detail: probe.reason)
        } else {
            statusRow(label, value: "Not checked", detail: "Add a number to check this permission.", color: .secondary)
        }
    }

    private func statusRow(_ label: String, value: String, detail: String? = nil, color: Color = .primary) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(value).foregroundStyle(color)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
            }
        }
    }

    private func saveHandle(_ handle: String) {
        s.ownerHandle = handle
        Task {
            await s.save(["ownerHandle": .string(handle)])
            await model.refreshStatus()
        }
    }
}

private struct BrowserTab: View {
    @ObservedObject var s: SettingsModel
    @ObservedObject var model: PanelViewModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Gajae has its own Chrome, separate from yours. Sign into the sites you want it to use there once and it stays signed in.")
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Gajae's browser") { Task { await model.openBrowserProfile() } }
            Text("Close the window when you're done. Your own Chrome is never touched.").font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct LimitsTab: View {
    @ObservedObject var s: SettingsModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Stepper("Give up on a reply after \(s.watchdogSec / 60) min of silence", value: $s.watchdogSec, in: 60...1800, step: 60)
            Stepper("Background tasks at once: \(s.childMax)", value: $s.childMax, in: 1...16)
            Stepper(
                "Keep finished tasks warm for \(s.childWarmTtlSec / 60) min",
                value: Binding(get: { s.childWarmTtlSec / 60 }, set: { s.childWarmTtlSec = $0 * 60 }),
                in: 1...1_440
            )
            Stepper(
                "Forget idle tasks after \(max(1, s.childIdleTimeoutSec / 3_600)) h",
                value: Binding(get: { max(1, s.childIdleTimeoutSec / 3_600) }, set: { s.childIdleTimeoutSec = $0 * 3_600 }),
                in: 1...24
            )
            Stepper("Live background tasks at most \(s.childMaxLive)", value: $s.childMaxLive, in: 1...64)
            Stepper("Bundle task updates every \(s.childInterimBatchSec) s", value: $s.childInterimBatchSec, in: 1...60)
            Stepper("Updates per task per minute \(s.childInterimRatePerMinute)", value: $s.childInterimRatePerMinute, in: 1...60)
            DisclosureGroup("Advanced") {
                Stepper("Progress update size: \(s.childInterimMaxBytes) bytes", value: $s.childInterimMaxBytes, in: 128...8_192, step: 128)
                Stepper("Background task status list limit: \(s.childStatusListLimit)", value: $s.childStatusListLimit, in: 1...100)
                Stepper("Background task status text: \(s.childStatusTextBytes) bytes", value: $s.childStatusTextBytes, in: 128...8_192, step: 128)
                Stepper("Background task latency alert threshold: \(s.childToolGuardMs) ms", value: $s.childToolGuardMs, in: 5...1_000, step: 5)
            }
            Button("Save") {
                Task {
                    await s.save([
                        "mainTurnWatchdogSec": .number(Double(s.watchdogSec)),
                        "childMaxConcurrent": .number(Double(s.childMax)),
                        "childWarmTtlSec": .number(Double(s.childWarmTtlSec)),
                        "childIdleTimeoutSec": .number(Double(s.childIdleTimeoutSec)),
                        "childMaxLive": .number(Double(s.childMaxLive)),
                        "childInterimBatchSec": .number(Double(s.childInterimBatchSec)),
                        "childInterimRatePerMinute": .number(Double(s.childInterimRatePerMinute)),
                        "childInterimMaxBytes": .number(Double(s.childInterimMaxBytes)),
                        "childStatusListLimit": .number(Double(s.childStatusListLimit)),
                        "childStatusTextBytes": .number(Double(s.childStatusTextBytes)),
                        "childToolGuardMs": .number(Double(s.childToolGuardMs))
                    ])
                }
            }
            Text("Saving these restarts Gajae.").font(.caption).foregroundStyle(.secondary)

            Divider()

            GroupBox("Remove") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Stop Gajae and remove it from this Mac. Your memory folder is kept.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Uninstall Gajae…") {
                        uninstallGajae()
                    }
                }
                .padding(6)
            }
        }
    }
}

@MainActor
private func uninstallGajae() {
    let confirmation = NSAlert()
    confirmation.messageText = "Uninstall Gajae?"
    confirmation.informativeText = "This stops Gajae and removes it from this Mac. Your memory folder at ~/.openinstinct/memory is kept."
    confirmation.alertStyle = .warning
    confirmation.addButton(withTitle: "Uninstall")
    confirmation.addButton(withTitle: "Cancel")
    guard confirmation.runModal() == .alertFirstButtonReturn else { return }

    let process = Process()
    let stderr = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = [NSHomeDirectory() + "/.openinstinct/src/scripts/uninstall.sh"]
    process.standardError = stderr

    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        showUninstallFailure(error.localizedDescription)
        return
    }

    guard process.terminationStatus == 0 else {
        let message = (String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        showUninstallFailure(message.isEmpty ? "The uninstall script exited with status \(process.terminationStatus)." : message)
        return
    }

    NSApp.terminate(nil)
}

@MainActor
private func showUninstallFailure(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Couldn’t uninstall Gajae"
    alert.informativeText = message
    alert.alertStyle = .warning
    alert.addButton(withTitle: "OK")
    alert.runModal()
}

private struct PersonalityTab: View {
    @ObservedObject var s: SettingsModel
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("This is who Gajae is. Edit freely; it takes effect right away without losing the conversation.")
            TextEditor(text: $s.soulText).font(.system(.body, design: .monospaced)).frame(minHeight: 260)
            HStack {
                Text("v\(s.snapshot?.soulVersion ?? "?")").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Apply") { Task { await s.save(["soulText": .string(s.soulText)]) } }.disabled(s.soulText == s.snapshot?.soulText)
            }
        }
    }
}
