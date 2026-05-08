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

    // MARK: - Refresh

    func refresh() async {
        loading = true
        error = nil
        defer { loading = false }

        do {
            let fetched = try await APIClient.shared.get("/mesh/threads", as: [InboxThread].self)
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
