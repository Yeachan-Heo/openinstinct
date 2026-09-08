import AppKit
import CoreGraphics
import Foundation

public struct ChatActivitySample: Sendable, Equatable {
    public let frontmost: Bool
    public let lastInputAgeSeconds: Double?

    public init(frontmost: Bool, lastInputAgeSeconds: Double?) {
        self.frontmost = frontmost
        self.lastInputAgeSeconds = lastInputAgeSeconds
    }
}

@MainActor
final class ChatActivityReporter {
    private static let sampleInterval: TimeInterval = 5
    private static let anyInputEventType = CGEventType(rawValue: ~0)!

    private weak var window: NSWindow?
    private let onSample: @MainActor (ChatActivitySample) -> Void
    private var timer: Timer?
    private var running = false

    init(window: NSWindow, onSample: @MainActor @escaping (ChatActivitySample) -> Void) {
        self.window = window
        self.onSample = onSample
    }

    func start() {
        running = true
        if timer == nil {
            let timer = Timer(timeInterval: Self.sampleInterval, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.reportCurrentSample()
                }
            }
            self.timer = timer
            RunLoop.main.add(timer, forMode: .common)
        }
        reportCurrentSample()
    }

    func stop() {
        running = false
        timer?.invalidate()
        timer = nil
        report(frontmost: false)
    }

    static func isFrontmost(
        applicationIsActive: Bool,
        windowIsKey: Bool,
        windowIsVisible: Bool,
        windowIsMiniaturized: Bool
    ) -> Bool {
        applicationIsActive && windowIsKey && windowIsVisible && !windowIsMiniaturized
    }

    static func validInputAge(_ seconds: Double) -> Double? {
        guard seconds.isFinite, seconds >= 0 else { return nil }
        return seconds
    }

    private func reportCurrentSample() {
        guard running else { return }
        guard let window else {
            report(frontmost: false)
            return
        }
        report(frontmost: Self.isFrontmost(
            applicationIsActive: NSApp.isActive,
            windowIsKey: window.isKeyWindow,
            windowIsVisible: window.isVisible,
            windowIsMiniaturized: window.isMiniaturized
        ))
    }

    private func report(frontmost: Bool) {
        // This reads elapsed-time metadata only. It never installs an event tap or
        // inspects input events, key codes, text, or other event contents.
        let rawAge = CGEventSource.secondsSinceLastEventType(
            .combinedSessionState,
            eventType: Self.anyInputEventType
        )
        onSample(ChatActivitySample(
            frontmost: frontmost,
            lastInputAgeSeconds: Self.validInputAge(rawAge)
        ))
    }
}
