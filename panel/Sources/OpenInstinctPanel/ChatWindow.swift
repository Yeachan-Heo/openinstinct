import AppKit
import SwiftUI

/// The Chat window is a separate `NSWindow` rather than popover content: the
/// popover is fixed-size and dismisses on focus loss, which a live conversation
/// cannot tolerate. Mirrors `SettingsWindowController`.
@MainActor
final class ChatWindowController: NSObject, NSWindowDelegate {
    static let shared = ChatWindowController()
    private var window: NSWindow?
    private var chat: ChatViewModel?
    private var activityReporter: ChatActivityReporter?

    func show(model: PanelViewModel) {
        if window == nil {
            let chat = ChatViewModel(panel: model)
            self.chat = chat
            let view = ChatView(chat: chat)
            let w = NSWindow(contentViewController: NSHostingController(rootView: view))
            w.title = "Chat with Gajae"
            w.setContentSize(NSSize(width: 420, height: 560))
            w.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.center()
            window = w
            activityReporter = ChatActivityReporter(window: w) { [weak chat] sample in
                chat?.reportActivity(sample)
            }
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        activityReporter?.start()
    }

    /// Closing the window ends the subscription; reopening starts a fresh one
    /// so the open protocol re-runs and history is reloaded.
    func windowWillClose(_ notification: Notification) {
        activityReporter?.stop()
        activityReporter = nil
        chat?.close()
        chat = nil
        window = nil
    }
}

struct ChatView: View {
    @ObservedObject var chat: ChatViewModel
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 0) {
            if let banner = chat.banner {
                Text(banner)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.quaternary)
            }
            if !chat.pendingNotifications.isEmpty || chat.notificationError != nil {
                notificationSection
                Divider()
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(chat.messages) { row in
                            BubbleView(row: row)
                                .id(row.id)
                        }
                        if chat.typing {
                            TypingBubble()
                                .id(Self.typingAnchor)
                        }
                    }
                    .padding(12)
                }
                .onChange(of: chat.messages.count) { _ in
                    scrollToEnd(proxy)
                }
                .onChange(of: chat.typing) { _ in
                    scrollToEnd(proxy)
                }
            }
            Divider()
            composer
        }
        .frame(minWidth: 360, minHeight: 420)
        .task {
            await chat.open()
        }
    }

    private static let typingAnchor = "typing-indicator"

    private var notificationSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("알림")
                    .font(.headline)
                Spacer()
                if chat.notificationsLoading {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            ForEach(chat.pendingNotifications) { notification in
                HStack(alignment: .top, spacing: 8) {
                    Text(notification.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                    Button("확인") {
                        Task { await chat.acknowledgeNotification(notification.id) }
                    }
                    .disabled(chat.acknowledgingNotificationIDs.contains(notification.id))
                }
                .padding(8)
                .background(Color(nsColor: .windowBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .onAppear {
                    chat.reportNotificationRendered(notification.id)
                }
            }
            if let error = chat.notificationError {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("다시 시도") {
                        Task { await chat.refreshNotifications() }
                    }
                    .disabled(chat.notificationsLoading)
                }
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                TextField(chat.composerBlock ?? "Message Gajae", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .disabled(chat.composerBlock != nil)
                    .onSubmit(send)
                Button("Send", action: send)
                    .keyboardShortcut(.return, modifiers: [])
                    .disabled(chat.composerBlock != nil || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || chat.sending)
            }
            if let block = chat.composerBlock {
                Text(block)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, chat.composerBlock == nil else { return }
        draft = ""
        Task { await chat.send(text) }
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        let anchor = chat.typing ? Self.typingAnchor : chat.messages.last?.id
        guard let anchor else { return }
        withAnimation(.easeOut(duration: 0.15)) {
            proxy.scrollTo(anchor, anchor: .bottom)
        }
    }
}

/// iMessage-like layout: owner right and blue, Gajae left and grey, one bubble
/// per segment, plain text only (no Markdown rendering).
struct BubbleView: View {
    let row: ChatRow

    var body: some View {
        HStack {
            if row.isOwner { Spacer(minLength: 40) }
            VStack(alignment: row.isOwner ? .trailing : .leading, spacing: 2) {
                content
                if let stamp = friendlyTime(row.at) {
                    Text(stamp)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            if !row.isOwner { Spacer(minLength: 40) }
        }
    }

    @ViewBuilder
    private var content: some View {
        if row.isGap {
            Text(row.text ?? "Earlier messages are unavailable.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        } else if let image = row.image {
            VStack(alignment: .leading, spacing: 4) {
                if let loaded = NSImage(contentsOfFile: image.path) {
                    Image(nsImage: loaded)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 240, maxHeight: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                } else {
                    Text("(image unavailable)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if !image.caption.isEmpty {
                    Text(image.caption)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(8)
            .background(bubbleBackground)
            .clipShape(RoundedRectangle(cornerRadius: 14))
        } else {
            Text(row.text ?? "")
                .textSelection(.enabled)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .foregroundStyle(row.isOwner ? Color.white : Color.primary)
                .background(bubbleBackground)
                .clipShape(RoundedRectangle(cornerRadius: 14))
        }
    }

    private var bubbleBackground: Color {
        row.isOwner ? Color.accentColor : Color(nsColor: .controlBackgroundColor)
    }

    private func friendlyTime(_ iso: String?) -> String? {
        guard let iso else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

struct TypingBubble: View {
    var body: some View {
        HStack {
            Text("…")
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 14))
            Spacer(minLength: 40)
        }
    }
}
