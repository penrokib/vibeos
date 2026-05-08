import Foundation

// MARK: - Auth
struct LoginRequest: Encodable {
    let email: String
    let password: String
}

struct LoginResponse: Decodable {
    let token: String?
    let access_token: String?
    var jwt: String { token ?? access_token ?? "" }
}

// MARK: - Fleet status
struct FleetStatus: Decodable {
    let machines: [Machine]?
    let personas: [PersonaSummary]?
    let saarland: SaarlandStatus?
    let quotas: [AccountQuota]?
}

struct Machine: Decodable, Identifiable {
    let id: String
    let name: String?
    let status: String?
    let last_seen_at: String?
}

struct PersonaSummary: Decodable, Identifiable {
    let slug: String
    let status: String?
    let last_activity_at: String?
    var id: String { slug }
}

struct SaarlandStatus: Decodable {
    let t_minus_h: Double?
    let reds: Int?
    let active: Bool?
}

struct AccountQuota: Decodable, Identifiable {
    let account: String
    let used: Int?
    let cap: Int?
    var id: String { account }
}

// MARK: - Decisions
struct Decision: Decodable, Identifiable {
    let id: String
    let title: String?
    let description: String?
    let persona: String?
    let status: String?
    let created_at: String?
    let priority: String?
}

// MARK: - Drafts
struct Draft: Decodable, Identifiable {
    let id: String
    let persona: String?
    let channel: String?
    let recipient: String?
    let preview: String?
    let body: String?
    let created_at: String?
}

// MARK: - Knowledge
struct KnowledgeChunk: Decodable, Identifiable {
    let id: String?
    let text: String
    let persona: String?
    let source: String?
    let score: Double?
    var stableId: String { id ?? UUID().uuidString }
}

struct KnowledgeSearchResponse: Decodable {
    let results: [KnowledgeChunk]?
    let chunks: [KnowledgeChunk]?
    var items: [KnowledgeChunk] { results ?? chunks ?? [] }
}

// MARK: - Generic ack
struct AckResponse: Decodable {
    let ok: Bool?
    let success: Bool?
    let id: String?
}
