import Foundation
import Observation

@Observable
@MainActor
final class InboxStore {
    var threads: [InboxThread] = []
    var loading: Bool = false
    var error: String?

    var accountFilter: String?
    var platformFilter: String?
    var viewFilter: InboxFilter = .all

    private(set) var mode: WorkPersonalMode
    nonisolated(unsafe) private var modeObserver: NSObjectProtocol?

    // MARK: - Derived list

    var filteredThreads: [InboxThread] {
        threads.filter { thread in
            if let af = accountFilter, af != thread.account { return false }
            if let pf = platformFilter, pf != thread.platform { return false }
            return viewFilter.matches(thread)
        }
    }

    var availableAccounts: [String] {
        Array(Set(threads.map(\.account))).sorted()
    }

    var availablePlatforms: [String] {
        Array(Set(threads.map(\.platform))).sorted()
    }

    init(mode: WorkPersonalMode = .work) {
        self.mode = mode
        subscribeToModeChanges()
    }

    deinit {
        if let obs = modeObserver {
            NotificationCenter.default.removeObserver(obs)
        }
    }

    // MARK: - Mode subscription (brain-split: clears before re-fetch)

    private func subscribeToModeChanges() {
        modeObserver = NotificationCenter.default.addObserver(
            forName: .vibeosModeChanged,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self else { return }
            let raw = notification.userInfo?["mode"] as? String ?? "work"
            let newMode = WorkPersonalMode(rawValue: raw) ?? .work
            Task { @MainActor in
                // BRAIN-SPLIT SAFETY: clear stale data before fetching new mode
                self.threads = []
                self.accountFilter = nil
                self.platformFilter = nil
                self.mode = newMode
                await self.refresh()
            }
        }
    }

    // MARK: - Refresh

    func refresh() async {
        loading = true
        error = nil
        defer { loading = false }

        let path = "/mesh/threads?mode=\(mode.rawValue)"
        do {
            let fetched = try await APIClient.shared.get(path, as: [InboxThread].self)
            self.threads = fetched.sorted { $0.lastTimestamp > $1.lastTimestamp }
        } catch let apiError as APIError {
            switch apiError {
            case .status(let code, _) where [404, 501, 405].contains(code):
                self.threads = InboxThread.mockThreads()
            case .transport:
                self.threads = InboxThread.mockThreads()
            default:
                self.error = apiError.errorDescription ?? "Unknown error"
                if self.threads.isEmpty {
                    self.threads = InboxThread.mockThreads()
                }
            }
        } catch {
            self.error = error.localizedDescription
            if self.threads.isEmpty {
                self.threads = InboxThread.mockThreads()
            }
        }
    }
}
