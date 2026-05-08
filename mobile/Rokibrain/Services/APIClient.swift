import Foundation

enum APIError: Error, LocalizedError {
    case invalidURL
    case status(Int, String)
    case decode(Error)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .status(let c, let m): return "HTTP \(c): \(m)"
        case .decode(let e): return "Decode error: \(e.localizedDescription)"
        case .transport(let e): return "Network error: \(e.localizedDescription)"
        }
    }
}

@MainActor
final class APIClient {
    static let shared = APIClient()

    private var baseURL: String {
        UserDefaults.standard.string(forKey: "bffURL") ?? "https://app.rokibrain.com"
    }

    private var jwt: String? { Keychain.read(account: "jwt") }

    private func makeRequest(path: String, method: String = "GET", body: Data? = nil) throws -> URLRequest {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let jwt { req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization") }
        req.httpBody = body
        req.timeoutInterval = 20
        return req
    }

    func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        let req = try makeRequest(path: path)
        return try await perform(req)
    }

    func post<T: Decodable, B: Encodable>(_ path: String, body: B, as: T.Type) async throws -> T {
        let data = try JSONEncoder().encode(body)
        let req = try makeRequest(path: path, method: "POST", body: data)
        return try await perform(req)
    }

    func postNoBody<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        let req = try makeRequest(path: path, method: "POST")
        return try await perform(req)
    }

    func patchNoBody(_ path: String) async throws {
        let req = try makeRequest(path: path, method: "PATCH")
        _ = try await performRaw(req)
    }

    func patch<B: Encodable>(_ path: String, body: B) async throws {
        let data = try JSONEncoder().encode(body)
        let req = try makeRequest(path: path, method: "PATCH", body: data)
        _ = try await performRaw(req)
    }

    private func perform<T: Decodable>(_ req: URLRequest) async throws -> T {
        let data = try await performRaw(req)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decode(error)
        }
    }

    private func performRaw(_ req: URLRequest) async throws -> Data {
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                throw APIError.status(-1, "no http response")
            }
            guard (200..<300).contains(http.statusCode) else {
                let body = String(data: data, encoding: .utf8) ?? ""
                throw APIError.status(http.statusCode, body)
            }
            return data
        } catch let e as APIError {
            throw e
        } catch {
            throw APIError.transport(error)
        }
    }
}
