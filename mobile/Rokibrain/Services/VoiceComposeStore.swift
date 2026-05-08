import Foundation
import Observation

// MARK: - VoiceComposeStore (Cycle 25)
//
// Manages the lifecycle of a voice-compose request:
//   1. POST /compose/voice with base64 audio + metadata
//   2. Poll /compose/:requestId until status == "done" (max 60s)
//   3. Trigger DraftsStore.refresh() so new draft appears in the queue
//
// Hardwall: no third-party packages.
// Hardwall: PTT audio NEVER auto-sends — it lands in Drafts pending user approval.

@Observable
@MainActor
final class VoiceComposeStore {

    enum State: Equatable {
        case idle
        case uploading
        case processing(requestId: String)
        case done(draftId: String?)
        case failed(String)
    }

    var state: State = .idle

    private var baseURL: String {
        UserDefaults.standard.string(forKey: "bffURL") ?? "https://app.rokibrain.com"
    }
    private var jwt: String? { Keychain.read(account: "jwt") }

    // MARK: - recordAndSend

    /// Upload encrypted audio blob to BFF then poll until draft is ready.
    func recordAndSend(
        audioData: Data,
        account: String?,
        recipient: String?,
        persona: String,
        draftsStore: DraftsStore
    ) async {
        state = .uploading

        struct VoiceComposeRequest: Encodable {
            let audio: String          // base64-encoded M4A/AAC
            let mimeType: String
            let persona: String
            let account: String?
            let recipient: String?
        }

        struct VoiceComposeResponse: Decodable {
            let requestId: String
        }

        let b64 = audioData.base64EncodedString()
        let requestBody = VoiceComposeRequest(
            audio: b64,
            mimeType: "audio/m4a",
            persona: persona,
            account: account,
            recipient: recipient
        )

        do {
            let encoded = try JSONEncoder().encode(requestBody)
            var req = URLRequest(url: URL(string: "\(baseURL)/compose/voice")!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let jwt { req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization") }
            req.httpBody = encoded
            req.timeoutInterval = 30

            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let body = String(data: data, encoding: .utf8) ?? ""
                throw VoiceError.uploadFailed(body)
            }

            let parsed = try JSONDecoder().decode(VoiceComposeResponse.self, from: data)
            state = .processing(requestId: parsed.requestId)
            await poll(requestId: parsed.requestId, draftsStore: draftsStore)

        } catch let e as VoiceError {
            state = .failed(e.localizedDescription)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    // MARK: - Polling

    private struct ComposeStatus: Decodable {
        let status: String  // "pending" | "processing" | "done" | "error"
        let draftId: String?
    }

    private func poll(requestId: String, draftsStore: DraftsStore) async {
        let deadline = Date().addingTimeInterval(60)
        var interval: TimeInterval = 1.5

        while Date() < deadline {
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            interval = min(interval * 1.4, 8)   // back off gently

            guard let url = URL(string: "\(baseURL)/compose/\(requestId)") else { break }
            var req = URLRequest(url: url)
            req.timeoutInterval = 10
            if let jwt { req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization") }

            do {
                let (data, _) = try await URLSession.shared.data(for: req)
                let status = try JSONDecoder().decode(ComposeStatus.self, from: data)
                switch status.status {
                case "done":
                    await draftsStore.refresh()
                    state = .done(draftId: status.draftId)
                    return
                case "error":
                    state = .failed("Compose pipeline returned error")
                    return
                default:
                    break   // still processing — keep polling
                }
            } catch {
                // Transient network error — keep polling until deadline
            }
        }

        state = .failed("Timed out waiting for draft (60s)")
    }

    // MARK: - Reset

    func reset() {
        state = .idle
    }
}

// MARK: - VoiceError

private enum VoiceError: LocalizedError {
    case uploadFailed(String)

    var errorDescription: String? {
        switch self {
        case .uploadFailed(let msg): return "Upload failed: \(msg)"
        }
    }
}
