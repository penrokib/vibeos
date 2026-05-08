import Foundation

// MARK: - Digest mode

enum WorkPersonalMode: String, Codable, CaseIterable, Identifiable {
    case work = "work"
    case personal = "personal"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .work: return "Work"
        case .personal: return "Personal"
        }
    }
}

// MARK: - Digest models

struct Digest: Codable, Identifiable {
    let id: String
    let generatedAt: Date
    let needsYou: [DigestItem]
    let whatHappened: [DigestItem]
    let stuck: [DigestItem]

    enum CodingKeys: String, CodingKey {
        case id
        case generatedAt = "generated_at"
        case needsYou = "needs_you"
        case whatHappened = "what_happened"
        case stuck
    }
}

struct DigestItem: Codable, Identifiable {
    let id: String
    let kind: String       // "draft" | "decision" | "persona" | "alert"
    let title: String
    let subtitle: String?
    let deepLink: String?
    let ts: Date

    enum CodingKeys: String, CodingKey {
        case id, kind, title, subtitle, ts
        case deepLink = "deep_link"
    }
}

// MARK: - Mock data (fallback when BFF /digest endpoint is not yet live)

extension Digest {
    static func mock(mode: WorkPersonalMode) -> Digest {
        let now = Date()
        switch mode {
        case .work:
            return Digest(
                id: "mock-work-\(Int(now.timeIntervalSince1970))",
                generatedAt: now,
                needsYou: [
                    DigestItem(id: "d1", kind: "decision", title: "Approve Dewx billing copy", subtitle: "Blocked since 2h — persona: maya", deepLink: nil, ts: now.addingTimeInterval(-7200)),
                    DigestItem(id: "dr1", kind: "draft", title: "LinkedIn reply to Sarah Chen", subtitle: "maya → linkedin", deepLink: nil, ts: now.addingTimeInterval(-1800)),
                ],
                whatHappened: [
                    DigestItem(id: "a1", kind: "alert", title: "12 leads enriched overnight", subtitle: "prospect-engine campaign", deepLink: nil, ts: now.addingTimeInterval(-28800)),
                    DigestItem(id: "a2", kind: "alert", title: "Dewx deploy succeeded", subtitle: "beta — commit 3f9a", deepLink: nil, ts: now.addingTimeInterval(-14400)),
                ],
                stuck: [
                    DigestItem(id: "p1", kind: "persona", title: "robert is idle (>4h)", subtitle: "Last seen: enriching contacts", deepLink: nil, ts: now.addingTimeInterval(-14400)),
                ]
            )
        case .personal:
            return Digest(
                id: "mock-personal-\(Int(now.timeIntervalSince1970))",
                generatedAt: now,
                needsYou: [
                    DigestItem(id: "p-d1", kind: "decision", title: "Grocery order — confirm or skip?", subtitle: "Scheduled for tonight", deepLink: nil, ts: now.addingTimeInterval(-3600)),
                ],
                whatHappened: [
                    DigestItem(id: "p-a1", kind: "alert", title: "Morning log captured", subtitle: "health pillar", deepLink: nil, ts: now.addingTimeInterval(-21600)),
                ],
                stuck: []
            )
        }
    }
}
