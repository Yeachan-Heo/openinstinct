import Foundation
@testable import OpenInstinctPanel

@MainActor
enum ChatActivityReporterChecks {
    static func run() -> [String] {
        var failures = frontmostDecisionChecks()
        failures.append(contentsOf: inputAgeChecks())
        return failures
    }

    private static func frontmostDecisionChecks() -> [String] {
        let cases: [(
            name: String,
            applicationIsActive: Bool,
            windowIsKey: Bool,
            windowIsVisible: Bool,
            windowIsMiniaturized: Bool,
            expected: Bool
        )] = [
            ("active key visible window", true, true, true, false, true),
            ("inactive application", false, true, true, false, false),
            ("non-key Chat window", true, false, true, false, false),
            ("hidden Chat window", true, true, false, false, false),
            ("miniaturized Chat window", true, true, true, true, false),
        ]

        var failures: [String] = []
        for testCase in cases {
            let actual = ChatActivityReporter.isFrontmost(
                applicationIsActive: testCase.applicationIsActive,
                windowIsKey: testCase.windowIsKey,
                windowIsVisible: testCase.windowIsVisible,
                windowIsMiniaturized: testCase.windowIsMiniaturized
            )
            if actual != testCase.expected {
                failures.append("Chat activity frontmost decision was \(actual) for \(testCase.name), expected \(testCase.expected)")
            }
        }
        return failures
    }

    private static func inputAgeChecks() -> [String] {
        var failures: [String] = []
        for age in [0.0, 0.25, 120.0, 120.001, 86_400.0] {
            if ChatActivityReporter.validInputAge(age) != age {
                failures.append("Chat activity changed valid raw input age \(age)")
            }
        }
        for age in [-0.001, .nan, .infinity, -.infinity] {
            if ChatActivityReporter.validInputAge(age) != nil {
                failures.append("Chat activity accepted invalid input age \(age)")
            }
        }
        return failures
    }
}
