import Foundation
import UIKit

// MARK: - PushTokenStore (Cycle 25)
//
// Registers the APNs device token with the BFF after onboarding completes.
// Called from AppDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:)
//
// Hardwall: no third-party packages — Foundation + UIKit only.
// Real token delivery requires a valid APNs certificate (Apple Developer
// Program membership). The registration code is fully wired; it becomes
// a live no-op until the cert is enrolled.

@Observable
@MainActor
final class PushTokenStore {
    static let shared = PushTokenStore()

    var isRegistered: Bool = false
    var registrationError: String?

    private var baseURL: String {
        UserDefaults.standard.string(forKey: "bffURL") ?? "https://app.rokibrain.com"
    }

    private var jwt: String? { Keychain.read(account: "jwt") }

    // MARK: - Register

    /// Call when `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)` fires.
    func register(deviceToken: Data) async {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
        await attemptRegister(token: token, deviceId: deviceId, attempt: 0)
    }

    private func attemptRegister(token: String, deviceId: String, attempt: Int) async {
        struct Body: Encodable {
            let token: String
            let deviceId: String
        }
        do {
            let body = try JSONEncoder().encode(Body(token: token, deviceId: deviceId))
            var req = URLRequest(url: URL(string: "\(baseURL)/push/register-apns")!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let jwt { req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization") }
            req.httpBody = body
            req.timeoutInterval = 15
            let (_, response) = try await URLSession.shared.data(for: req)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(code) {
                isRegistered = true
                registrationError = nil
            } else {
                await retryIfNeeded(token: token, deviceId: deviceId, attempt: attempt)
            }
        } catch {
            await retryIfNeeded(token: token, deviceId: deviceId, attempt: attempt)
        }
    }

    private func retryIfNeeded(token: String, deviceId: String, attempt: Int) async {
        guard attempt < 4 else {
            registrationError = "APNs token registration failed after \(attempt + 1) attempts"
            return
        }
        // Exponential backoff: 2s, 4s, 8s, 16s
        let delay = UInt64(pow(2.0, Double(attempt + 1))) * 1_000_000_000
        try? await Task.sleep(nanoseconds: delay)
        await attemptRegister(token: token, deviceId: deviceId, attempt: attempt + 1)
    }

    // MARK: - Unregister

    /// Call on logout to remove the device token from the BFF.
    func unregister() async {
        let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
        var req = URLRequest(url: URL(string: "\(baseURL)/push/unregister-apns/\(deviceId)")!)
        req.httpMethod = "DELETE"
        if let jwt { req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization") }
        req.timeoutInterval = 10
        _ = try? await URLSession.shared.data(for: req)
        isRegistered = false
    }
}
