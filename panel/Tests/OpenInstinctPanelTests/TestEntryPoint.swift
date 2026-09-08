import Foundation
import Testing

@_cdecl("openinstinct_panel_run_tests")
public func runOpenInstinctPanelTests() -> Int32 {
    let results = TestResults()
    results.append(ControlCodecChecks.run())
    results.append(FrameReaderChecks.run())
    if !LiveDecode.run() { results.append(["live status frame failed to decode"]) }

    let completion = DispatchSemaphore(value: 0)
    Task.detached {
        results.append(await PanelViewModelChecks.run())
        results.append(await SettingsTabChecks.run())
        results.append(await ChatSubscriptionChecks.run())
        results.append(await HealthMappingChecks.run())
        results.append(await ChatViewModelChecks.run())
        results.append(await UpdateCheckerChecks.run())
        results.append(await ChatActivityReporterChecks.run())
        completion.signal()
    }
    completion.wait()

    let failures = results.values
    let totalChecks = 10
    if failures.isEmpty {
        print("OpenInstinctPanelTests: \(totalChecks) checks passed")
        return 0
    }
    for failure in failures {
        fputs("OpenInstinctPanelTests failure: \(failure)\n", stderr)
    }
    fputs("OpenInstinctPanelTests: \(failures.count) failure(s) across \(totalChecks) checks\n", stderr)
    return 1
}

private final class TestResults: @unchecked Sendable {
    private let lock = NSLock()
    private var failures: [String] = []

    func append(_ values: [String]) {
        lock.lock()
        failures.append(contentsOf: values)
        lock.unlock()
    }

    var values: [String] {
        lock.lock()
        defer { lock.unlock() }
        return failures
    }
}
