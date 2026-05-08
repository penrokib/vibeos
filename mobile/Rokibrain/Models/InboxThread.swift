import Foundation

// MARK: - InboxThread

struct InboxThread: Codable, Identifiable {
    let id: String
    let account: String           // "wap" / "was" / "tg-personal" / etc.
    let platform: String          // "whatsapp" / "telegram" / "email" / "discord" / "linkedin"
    let participantName: String
    let participantHandle: String // phone / email / username
    let lastMessage: String
    let lastTimestamp: Date
    let unreadCount: Int
    let isMention: Bool
}

// MARK: - InboxFilter

enum InboxFilter: String, CaseIterable, Identifiable {
    case all, unread, mentions

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all:      return "All"
        case .unread:   return "Unread"
        case .mentions: return "Mentions"
        }
    }

    func matches(_ thread: InboxThread) -> Bool {
        switch self {
        case .all:      return true
        case .unread:   return thread.unreadCount > 0
        case .mentions: return thread.isMention
        }
    }
}

// MARK: - Mock fixture data

extension InboxThread {
    static func mockThreads() -> [InboxThread] {
        let now = Date()
        func ago(_ seconds: TimeInterval) -> Date { now.addingTimeInterval(-seconds) }

        return [
            InboxThread(
                id: "wap-1",
                account: "wap",
                platform: "whatsapp",
                participantName: "Ali Hassan",
                participantHandle: "+60123456789",
                lastMessage: "Can we reschedule the call to tomorrow?",
                lastTimestamp: ago(120),
                unreadCount: 3,
                isMention: false
            ),
            InboxThread(
                id: "wap-2",
                account: "wap",
                platform: "whatsapp",
                participantName: "Dewx Team",
                participantHandle: "+60198765432",
                lastMessage: "Deploy is live on prod ✓",
                lastTimestamp: ago(600),
                unreadCount: 0,
                isMention: false
            ),
            InboxThread(
                id: "was-1",
                account: "was",
                platform: "whatsapp",
                participantName: "Roki Sandbox Group",
                participantHandle: "+60112233445",
                lastMessage: "Hey @Roki the BFF test passed",
                lastTimestamp: ago(900),
                unreadCount: 1,
                isMention: true
            ),
            InboxThread(
                id: "tg-1",
                account: "tg-personal",
                platform: "telegram",
                participantName: "AHN Alerts",
                participantHandle: "@ahn_alerts_bot",
                lastMessage: "New provider signup: Ahmad Farid",
                lastTimestamp: ago(1800),
                unreadCount: 5,
                isMention: false
            ),
            InboxThread(
                id: "tg-2",
                account: "tg-personal",
                platform: "telegram",
                participantName: "VibeOS Build",
                participantHandle: "@vibeos_build",
                lastMessage: "Cycle 21 merged. Starting cycle 22.",
                lastTimestamp: ago(3600),
                unreadCount: 2,
                isMention: true
            ),
            InboxThread(
                id: "tg-3",
                account: "tg-personal",
                platform: "telegram",
                participantName: "M1 Worker",
                participantHandle: "@m1_worker_bot",
                lastMessage: "Quota exhausted — backoff 30 min",
                lastTimestamp: ago(7200),
                unreadCount: 0,
                isMention: false
            ),
            InboxThread(
                id: "email-1",
                account: "roki-work",
                platform: "email",
                participantName: "Scaleway Support",
                participantHandle: "support@scaleway.com",
                lastMessage: "Your ticket #8842 has been resolved.",
                lastTimestamp: ago(10800),
                unreadCount: 1,
                isMention: false
            ),
            InboxThread(
                id: "email-2",
                account: "roki-work",
                platform: "email",
                participantName: "Hetzner Billing",
                participantHandle: "billing@hetzner.com",
                lastMessage: "Invoice #2026-05 is now available.",
                lastTimestamp: ago(18000),
                unreadCount: 0,
                isMention: false
            ),
            InboxThread(
                id: "email-3",
                account: "roki-work",
                platform: "email",
                participantName: "Stripe",
                participantHandle: "no-reply@stripe.com",
                lastMessage: "Payout of €1,240.00 initiated.",
                lastTimestamp: ago(86400),
                unreadCount: 0,
                isMention: false
            ),
            InboxThread(
                id: "discord-1",
                account: "discord-main",
                platform: "discord",
                participantName: "#vibeOS-builds",
                participantHandle: "#vibeOS-builds",
                lastMessage: "PR #22 opened: ios-unified-inbox",
                lastTimestamp: ago(300),
                unreadCount: 4,
                isMention: true
            ),
            InboxThread(
                id: "linkedin-1",
                account: "linkedin-roki",
                platform: "linkedin",
                participantName: "Sarah Chen",
                participantHandle: "sarahchen",
                lastMessage: "Loved your post on AI agency systems!",
                lastTimestamp: ago(43200),
                unreadCount: 1,
                isMention: false
            ),
            InboxThread(
                id: "linkedin-2",
                account: "linkedin-roki",
                platform: "linkedin",
                participantName: "Johan Müller",
                participantHandle: "johanmuller",
                lastMessage: "Happy to jump on a call next week.",
                lastTimestamp: ago(172800),
                unreadCount: 0,
                isMention: false
            ),
        ]
    }
}
