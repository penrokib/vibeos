import Foundation
import Observation

@Observable
@MainActor
final class DigestStore {
    var digest: Digest?
    var loading: Bool = false
    var error: String?

    // mode is owned by AppMode; this store mirrors it read-only for BFF requests
    private(set) var mode: WorkPersonalMode

    nonisolated(unsafe) private var modeObserver: NSObjectProtocol?

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
                self.digest = nil
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

        let path = "/digest?mode=\(mode.rawValue)"
        do {
            let fetched = try await APIClient.shared.get(path, as: Digest.self)
            self.digest = fetched
        } catch let apiError as APIError {
            switch apiError {
            case .status(let code, _) where code == 404 || code == 501 || code == 405:
                self.digest = .mock(mode: mode)
            case .transport:
                self.digest = .mock(mode: mode)
            default:
                self.error = apiError.errorDescription ?? "Unknown error"
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
