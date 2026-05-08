import Foundation

// MARK: - Enhanced Draft Models (Cycle 21)

struct DraftDetail: Codable, Identifiable {
    let id: String
    let account: String
    let platform: String
    let recipient: String
    let recipientName: String?
    let body: String
    let persona: String
    let personaReasoning: String?
    let createdAt: Date
    let threadContext: [DraftThreadMessage]?   // last 10 msgs
    let similarPastDrafts: [String]?           // ids
    let recipientProfile: DraftRecipientProfile?
    let status: String                         // pending | sent | rejected | refused
    let refusalReason: String?

    enum CodingKeys: String, CodingKey {
        case id, account, platform, recipient, body, persona, status
        case recipientName      = "recipient_name"
        case personaReasoning   = "persona_reasoning"
        case createdAt          = "created_at"
        case threadContext      = "thread_context"
        case similarPastDrafts  = "similar_past_drafts"
        case recipientProfile   = "recipient_profile"
        case refusalReason      = "refusal_reason"
    }
}

struct DraftThreadMessage: Codable, Identifiable {
    let id: String
    let direction: String   // "outbound" | "inbound"
    let content: String
    let ts: Date
}

struct DraftRecipientProfile: Codable {
    let name: String?
    let lastInteraction: Date?
    let totalSent: Int
    let totalReceived: Int

    enum CodingKeys: String, CodingKey {
        case name
        case lastInteraction = "last_interaction"
        case totalSent       = "total_sent"
        case totalReceived   = "total_received"
    }
}

// MARK: - Mock fixture data (6-8 drafts across all 5 platforms)

extension DraftDetail {
    static func mockDrafts() -> [DraftDetail] {
        let now = Date()
        func ago(_ seconds: TimeInterval) -> Date { now.addingTimeInterval(-seconds) }

        return [
            DraftDetail(
                id: "draft-li-001",
                account: "roki@dewx.com",
                platform: "linkedin",
                recipient: "sarah.chen@growthco.io",
                recipientName: "Sarah Chen",
                body: "Hey Sarah — saw your post about scaling SDRs without burning cash. We've been automating that exact problem at Dewx. Worth a 15-min call this week?",
                persona: "robert",
                personaReasoning: "High ICP fit (VP Sales, 80-person SaaS). Recent post signals budget pain. Sent cold 3 weeks ago — no reply. Warm-up window expired, safe to follow up.",
                createdAt: ago(900),
                threadContext: [
                    DraftThreadMessage(id: "tm-001", direction: "outbound", content: "Hi Sarah, noticed you're growing the sales team at GrowthCo. Curious if you're exploring AI-assisted outreach.", ts: ago(1_814_400)),
                ],
                similarPastDrafts: ["draft-li-old-44", "draft-li-old-67"],
                recipientProfile: DraftRecipientProfile(name: "Sarah Chen", lastInteraction: ago(1_814_400), totalSent: 1, totalReceived: 0),
                status: "pending",
                refusalReason: nil
            ),
            DraftDetail(
                id: "draft-wa-002",
                account: "+60123456789",
                platform: "whatsapp",
                recipient: "+4917612345678",
                recipientName: "Marcus Bauer",
                body: "Marcus, quick heads-up — the proposal I mentioned is ready. Happy to walk you through it on a call or just drop the PDF here. Which works better?",
                persona: "maya",
                personaReasoning: "Active deal in pipeline (€14k). Last WhatsApp 5 days ago — maya flagged stale. Proposal was promised. This closes the loop.",
                createdAt: ago(1_800),
                threadContext: [
                    DraftThreadMessage(id: "tm-002a", direction: "inbound", content: "Sounds good Roki, send me the proposal when ready.", ts: ago(432_000)),
                    DraftThreadMessage(id: "tm-002b", direction: "outbound", content: "Will do — give me a couple of days to finalise numbers.", ts: ago(432_000 - 300)),
                ],
                similarPastDrafts: nil,
                recipientProfile: DraftRecipientProfile(name: "Marcus Bauer", lastInteraction: ago(432_000), totalSent: 3, totalReceived: 4),
                status: "pending",
                refusalReason: nil
            ),
            DraftDetail(
                id: "draft-em-003",
                account: "roki@prospectengine.com",
                platform: "email",
                recipient: "founder@atomicstudio.de",
                recipientName: "Lena Fischer",
                body: "Hi Lena,\n\nFollowing up on our chat from the Hamburg SaaS Meetup. You mentioned attribution was a constant headache — that's exactly what Dewx's pipeline intelligence solves.\n\nWould you be open to a 20-minute demo this Thursday?\n\nBest,\nRoki",
                persona: "robert",
                personaReasoning: "Met in-person 8 days ago. LinkedIn profile: Founder, 12-person product studio. Pain point stated verbally. First email follow-up — high deliverability expected.",
                createdAt: ago(3_600),
                threadContext: nil,
                similarPastDrafts: ["draft-em-old-12"],
                recipientProfile: DraftRecipientProfile(name: "Lena Fischer", lastInteraction: ago(691_200), totalSent: 0, totalReceived: 0),
                status: "pending",
                refusalReason: nil
            ),
            DraftDetail(
                id: "draft-tg-004",
                account: "@rokibrain_bot",
                platform: "telegram",
                recipient: "alex_volkov_spb",
                recipientName: "Alex Volkov",
                body: "Алекс, всё готово с нашей стороны. Когда удобно созвониться — сегодня после 18:00 или завтра утром?",
                persona: "maya",
                personaReasoning: "Russian-speaking lead, preferred channel confirmed as Telegram. Deal stage: Proposal Sent. maya selected language from contact profile.",
                createdAt: ago(600),
                threadContext: [
                    DraftThreadMessage(id: "tm-004a", direction: "inbound", content: "Да, интересно. Пришли детали.", ts: ago(86_400)),
                    DraftThreadMessage(id: "tm-004b", direction: "outbound", content: "Отправил на email. Дай знать если вопросы.", ts: ago(82_000)),
                    DraftThreadMessage(id: "tm-004c", direction: "inbound", content: "Ок, посмотрю сегодня.", ts: ago(79_200)),
                ],
                similarPastDrafts: nil,
                recipientProfile: DraftRecipientProfile(name: "Alex Volkov", lastInteraction: ago(79_200), totalSent: 2, totalReceived: 3),
                status: "pending",
                refusalReason: nil
            ),
            DraftDetail(
                id: "draft-li-005",
                account: "roki@dewx.com",
                platform: "linkedin",
                recipient: "priya.nair.ops",
                recipientName: "Priya Nair",
                body: "Priya — loved your article on async-first ops. We built a lot of Dewx's internal tooling around that philosophy. Would you be open to exchanging notes?",
                persona: "kai",
                personaReasoning: "No commercial intent — pure relationship-building. Priya is COO at 45-person startup, soft ICP. kai picked low-pressure opener based on content engagement.",
                createdAt: ago(7_200),
                threadContext: nil,
                similarPastDrafts: ["draft-li-old-88", "draft-li-old-91", "draft-li-old-103"],
                recipientProfile: DraftRecipientProfile(name: "Priya Nair", lastInteraction: nil, totalSent: 0, totalReceived: 0),
                status: "pending",
                refusalReason: nil
            ),
            DraftDetail(
                id: "draft-wa-006",
                account: "+60123456789",
                platform: "whatsapp",
                recipient: "+44771234567",
                recipientName: "James Whitfield",
                body: "James — just checking in. Last we spoke you were evaluating options through end of Q1. Did you end up making a call?",
                persona: "robert",
                personaReasoning: "Deal went dark 42 days ago. WhatsApp had 6 exchanges previously — good rapport. robert calculated reachout probability at 71%. Low-risk nudge.",
                createdAt: ago(10_800),
                threadContext: [
                    DraftThreadMessage(id: "tm-006a", direction: "outbound", content: "Great talking today James, I'll send the one-pager over.", ts: ago(3_628_800)),
                    DraftThreadMessage(id: "tm-006b", direction: "inbound", content: "Cheers! Send it through.", ts: ago(3_625_000)),
                    DraftThreadMessage(id: "tm-006c", direction: "outbound", content: "Here you go 👆 Let me know what you think after the eval.", ts: ago(3_620_000)),
                ],
                similarPastDrafts: ["draft-wa-old-22"],
                recipientProfile: DraftRecipientProfile(name: "James Whitfield", lastInteraction: ago(3_628_800), totalSent: 3, totalReceived: 2),
                status: "pending",
                refusalReason: nil
            ),
            DraftDetail(
                id: "draft-em-007",
                account: "roki@dewx.com",
                platform: "email",
                recipient: "cto@novastream.io",
                recipientName: nil,
                body: "Hi there,\n\nI help B2B SaaS teams cut pipeline admin by 60% using AI. One customer went from 3 hours of CRM updates daily to under 20 minutes.\n\nWould a short case study be useful?",
                persona: "robert",
                personaReasoning: "Cold outreach — no prior interaction. Company fits ICP (Series A, 30 employees, revenue ops gap visible from job listings). robert used low-ask CTA.",
                createdAt: ago(14_400),
                threadContext: nil,
                similarPastDrafts: nil,
                recipientProfile: DraftRecipientProfile(name: nil, lastInteraction: nil, totalSent: 0, totalReceived: 0),
                status: "pending",
                refusalReason: nil
            ),
        ]
    }
}
