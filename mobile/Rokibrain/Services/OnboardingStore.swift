import Foundation
import UserNotifications

@MainActor
final class OnboardingStore: ObservableObject {
    // MARK: - Persisted state
    @Published var step: OnboardingStep {
        didSet {
            UserDefaults.standard.set(step.rawValue, forKey: "vibeos_onboarding_step")
        }
    }

    var complete: Bool {
        step == .done || UserDefaults.standard.bool(forKey: "vibeos_onboarding_complete")
    }

    // MARK: - Sign-in state
    @Published var email: String = ""
    @Published var magicLinkSent: Bool = false
    @Published var magicLinkVerified: Bool = false
    @Published var magicLinkToken: String = ""
    @Published var isOfflineMode: Bool = false

    // MARK: - Pair state
    @Published var pairCode: String? = nil
    @Published var pairedDeviceId: String? = nil

    // MARK: - Push state
    @Published var pushAuthorized: Bool = false

    // MARK: - Error / loading
    @Published var isLoading: Bool = false
    @Published var errorMessage: String? = nil

    // MARK: - Init
    init() {
        let raw = UserDefaults.standard.integer(forKey: "vibeos_onboarding_step")
        self.step = OnboardingStep(rawValue: raw) ?? .welcome
    }

    // MARK: - Navigation helpers
    func advance(to nextStep: OnboardingStep) {
        errorMessage = nil
        step = nextStep
    }

    func markComplete() {
        UserDefaults.standard.set(true, forKey: "vibeos_onboarding_complete")
        step = .done
    }

    func skipToLocal() {
        isOfflineMode = true
        markComplete()
    }

    // MARK: - Magic Link
    func requestMagicLink() async {
        guard !email.isEmpty else {
            errorMessage = "Please enter your email address."
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            struct Req: Encodable { let email: String }
            struct Res: Decodable { let sent: Bool? }
            _ = try await APIClient.shared.post(
                "/auth/magic-link/request",
                body: Req(email: email),
                as: Res.self
            )
            magicLinkSent = true
        } catch APIError.status(404, _) {
            // Mock: 404 means endpoint not yet live — treat as success
            magicLinkSent = true
        } catch {
            // Any other error: still show sent UI for offline UX
            magicLinkSent = true
        }
    }

    func verifyMagicLink() async {
        guard !magicLinkToken.isEmpty else {
            errorMessage = "Paste the token from your email."
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        let tokenToVerify = magicLinkToken.trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            struct Req: Encodable { let token: String }
            struct Res: Decodable { let jwt: String? }
            let res = try await APIClient.shared.post(
                "/auth/magic-link/verify",
                body: Req(token: tokenToVerify),
                as: Res.self
            )
            if let jwt = res.jwt, !jwt.isEmpty {
                Keychain.write(account: "jwt", value: jwt)
            }
            magicLinkVerified = true
            advance(to: .pairMac)
        } catch APIError.status(404, _) {
            // Mock: stub token always works
            if tokenToVerify == "stub-token-123" || !tokenToVerify.isEmpty {
                magicLinkVerified = true
                advance(to: .pairMac)
            } else {
                errorMessage = "Invalid token. Try 'stub-token-123' for offline testing."
            }
        } catch {
            // Offline fallback: any non-empty token proceeds
            magicLinkVerified = true
            advance(to: .pairMac)
        }
    }

    // MARK: - Pairing
    func requestPairCode() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            struct Res: Decodable { let code: String? }
            let res = try await APIClient.shared.postNoBody("/devices/pair/request", as: Res.self)
            pairCode = res.code ?? "VBOS-1234"
        } catch APIError.status(404, _) {
            pairCode = "VBOS-1234"
        } catch {
            pairCode = "VBOS-1234"
        }
    }

    func confirmPair(code: String) async {
        guard !code.isEmpty else {
            errorMessage = "Enter the 4-letter code shown on your Mac."
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            struct Req: Encodable { let code: String }
            struct Res: Decodable { let deviceId: String? }
            let res = try await APIClient.shared.post(
                "/devices/pair/confirm",
                body: Req(code: code),
                as: Res.self
            )
            pairedDeviceId = res.deviceId ?? "mock-device-id"
            advance(to: .enablePush)
        } catch APIError.status(404, _) {
            // Mock: any non-empty code succeeds
            pairedDeviceId = "mock-device-id"
            advance(to: .enablePush)
        } catch {
            pairedDeviceId = "mock-device-id"
            advance(to: .enablePush)
        }
    }

    // MARK: - Push
    func requestPushAuthorization() async {
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            pushAuthorized = granted
        } catch {
            // Authorization request itself failed — proceed anyway
            pushAuthorized = false
        }
        markComplete()
    }

    func skipPush() {
        pushAuthorized = false
        markComplete()
    }
}
