import Foundation
import Observation

@Observable
@MainActor
final class DigestStore {
    var digest: Digest?
    var loading: Bool = false
    var error: String?
    var mode: WorkPersonalMode {
        didSet {
            UserDefaults.standard.set(mode.rawValue, forKey: "digestMode")
            Task { await refresh() }
        }
    }

    init() {
        let saved = UserDefaults.standard.string(forKey: "digestMode") ?? ""
        self.mode = WorkPersonalMode(rawValue: saved) ?? .work
    }

    // MARK: - Refresh

    func refresh() async {
        loading = true
        error = nil
        defer { loading = false }

        let path = "/digest?mode=\(mode.rawValue)"
        do {
            let fetched = try await APIClient.shared.get(path, as: Digest.self)
            self.digest = fetched
        } catch let apiError as APIError {
            // If BFF endpoint is not yet live (404 / 501 / transport), fall back to mock
            switch apiError {
            case .status(let code, _) where code == 404 || code == 501 || code == 405:
                self.digest = .mock(mode: mode)
            case .transport:
                self.digest = .mock(mode: mode)
            default:
                self.error = apiError.errorDescription ?? "Unknown error"
                // Still show mock so the screen isn't empty
                if self.digest == nil {
                    self.digest = .mock(mode: mode)
                }
            }
        } catch {
            self.error = error.localizedDescription
            if self.digest == nil {
                self.digest = .mock(mode: mode)
            }
        }
    }
}
