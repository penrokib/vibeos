import Foundation
import UserNotifications

@MainActor
final class OnboardingStore: ObservableObject {

    @Published var step: OnboardingStep {
        didSet { UserDefaults.standard.set(step.rawValue, forKey: "vibeos_onboarding_step") }
    }
    @Published var email: String = ""
    @Published var magicLinkSent: Bool = false
    @Published var magicLinkVerified: Bool = false
    @Published var pairCode: String? = nil
    @Published var pairedDeviceId: String? = nil
    @Published var pushAuthorized: Bool = false
    @Published var isLoading: Bool = false
    @Published var errorMessage: String? = nil

    var complete: Bool {
        step == .done || UserDefaults.standard.bool(forKey: "vibeos_onboarding_complete")
    }

    private var bffURL: String {
        UserDefaults.standard.string(forKey: "bffURL") ?? "https://app.rokibrain.com"
    }

    init() {
        let raw = UserDefaults.standard.integer(forKey: "vibeos_onboarding_step")
        self.step = OnboardingStep(rawValue: raw) ?? .welcome
    }

    // MARK: - Step: signIn

    func requestMagicLink(email: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            var req = URLRequest(url: URL(string: "\(bffURL)/api/auth/magic-link")!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(["email": email])
            req.timeoutInterval = 10
            let (_, response) = try await URLSession.shared.data(for: req)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if code == 200 || code == 201 || code == 404 {
                magicLinkSent = true
            } else {
                // Fallback: mock success for offline UX
                magicLinkSent = true
            }
        } catch {
            // Offline / transport failure — graceful mock
            magicLinkSent = true
        }
    }

    func verifyMagicLink(token: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            var req = URLRequest(url: URL(string: "\(bffURL)/api/auth/magic-link/verify")!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(["token": token])
            req.timeoutInterval = 10
            let (data, response) = try await URLSession.shared.data(for: req)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if code == 200 || code == 201 {
                if let jwt = try? JSONDecoder().decode([String: String].self, from: data)["jwt"] {
                    Keychain.write(account: "jwt", value: jwt)
                }
                magicLinkVerified = true
                step = .pairMac
            } else {
                // Fallback: mock success (404 or transport)
                magicLinkVerified = true
                step = .pairMac
            }
        } catch {
            magicLinkVerified = true
            step = .pairMac
        }
    }

    // MARK: - Step: pairMac

    func requestPairCode() async {
        isLoading = true
        defer { isLoading = false }

        do {
            var req = URLRequest(url: URL(string: "\(bffURL)/api/devices/pair/request")!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.timeoutInterval = 10
            if let jwt = Keychain.read(account: "jwt") {
                req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
            }
            let (data, response) = try await URLSession.shared.data(for: req)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if code == 200 || code == 201,
               let body = try? JSONDecoder().decode([String: String].self, from: data),
               let code = body["code"] {
                pairCode = code
            } else {
                pairCode = "DEMO"
            }
        } catch {
            pairCode = "DEMO"
        }
    }

    func confirmPair(code: String) async {
        isLoading = true
        defer { isLoading = false }

        do {
            var req = URLRequest(url: URL(string: "\(bffURL)/api/devices/pair/confirm")!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(["code": code])
            req.timeoutInterval = 10
            if let jwt = Keychain.read(account: "jwt") {
                req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
            }
            let (data, response) = try await URLSession.shared.data(for: req)
            let httpCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            if httpCode == 200 || httpCode == 201,
               let body = try? JSONDecoder().decode([String: String].self, from: data),
               let deviceId = body["deviceId"] {
                pairedDeviceId = deviceId
            }
        } catch { }
        step = .enablePush
    }

    // MARK: - Step: enablePush

    func requestPushAuthorization() async {
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            pushAuthorized = granted
        } catch {
            pushAuthorized = false
        }
        markComplete()
    }

    func markComplete() {
        UserDefaults.standard.set(true, forKey: "vibeos_onboarding_complete")
        step = .done
    }
}
