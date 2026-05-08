import Foundation
import Observation

@Observable
@MainActor
final class DraftsStore {
    var drafts: [DraftDetail] = []
    var loading: Bool = false
    var error: String?
    var processing: Set<String> = []

    // MARK: - Refresh

    func refresh() async {
        loading = true
        error = nil
        defer { loading = false }

        do {
            let fetched = try await APIClient.shared.get(
                "/agency/drafts/pending?detail=true",
                as: [DraftDetail].self
            )
            self.drafts = fetched
        } catch let apiError as APIError {
            switch apiError {
            case .status(let code, _) where code == 404 || code == 501 || code == 405:
                self.drafts = DraftDetail.mockDrafts()
            case .transport:
                self.drafts = DraftDetail.mockDrafts()
            default:
                self.error = apiError.errorDescription ?? "Unknown error"
                if self.drafts.isEmpty {
                    self.drafts = DraftDetail.mockDrafts()
                }
            }
        } catch {
            self.error = error.localizedDescription
            if self.drafts.isEmpty {
                self.drafts = DraftDetail.mockDrafts()
            }
        }
    }

    // MARK: - Approve (optimistic remove, rollback on error)

    func approve(id: String) async throws {
        processing.insert(id)
        defer { processing.remove(id) }

        // Optimistic remove
        let snapshot = drafts
        drafts.removeAll { $0.id == id }

        do {
            _ = try await APIClient.shared.postNoBody(
                "/agency/drafts/\(id)/approve",
                as: AckResponse.self
            )
        } catch {
            // Rollback
            drafts = snapshot
            throw error
        }
    }

    // MARK: - Reject

    func reject(id: String, reason: String? = nil) async throws {
        processing.insert(id)
        defer { processing.remove(id) }

        let snapshot = drafts
        drafts.removeAll { $0.id == id }

        do {
            if let reason = reason, !reason.isEmpty {
                struct RejectBody: Encodable { let reason: String }
                _ = try await APIClient.shared.post(
                    "/agency/drafts/\(id)/reject",
                    body: RejectBody(reason: reason),
                    as: AckResponse.self
                )
            } else {
                _ = try await APIClient.shared.postNoBody(
                    "/agency/drafts/\(id)/reject",
                    as: AckResponse.self
                )
            }
        } catch {
            drafts = snapshot
            throw error
        }
    }

    // MARK: - Update body

    func update(id: String, newBody: String) async throws {
        processing.insert(id)
        defer { processing.remove(id) }

        struct UpdateBody: Encodable { let body: String }
        try await APIClient.shared.patch(
            "/agency/drafts/\(id)",
            body: UpdateBody(body: newBody)
        )

        // Update local copy
        if let idx = drafts.firstIndex(where: { $0.id == id }) {
            let old = drafts[idx]
            drafts[idx] = DraftDetail(
                id: old.id,
                account: old.account,
                platform: old.platform,
                recipient: old.recipient,
                recipientName: old.recipientName,
                body: newBody,
                persona: old.persona,
                personaReasoning: old.personaReasoning,
                createdAt: old.createdAt,
                threadContext: old.threadContext,
                similarPastDrafts: old.similarPastDrafts,
                recipientProfile: old.recipientProfile,
                status: old.status,
                refusalReason: old.refusalReason
            )
        }
    }
}
