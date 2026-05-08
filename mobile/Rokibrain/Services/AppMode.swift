import Foundation
import Observation

// MARK: - App-wide work / personal mode

@Observable
@MainActor
final class AppMode {
    var current: WorkPersonalMode {
        didSet {
            UserDefaults.standard.set(current.rawValue, forKey: "vibeos_app_mode")
            NotificationCenter.default.post(
                name: .vibeosModeChanged,
                object: nil,
                userInfo: ["mode": current.rawValue]
            )
        }
    }

    init() {
        let raw = UserDefaults.standard.string(forKey: "vibeos_app_mode") ?? "work"
        current = WorkPersonalMode(rawValue: raw) ?? .work
    }
}

// MARK: - Notification name

extension Notification.Name {
    static let vibeosModeChanged = Notification.Name("vibeos.mode.changed")
}
