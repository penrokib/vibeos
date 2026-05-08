import SwiftUI

@main
struct RokibrainApp: App {
    @StateObject private var auth = AuthStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(auth)
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var auth: AuthStore
    @AppStorage("vibeos_onboarding_complete") private var onboardingComplete: Bool = false

    var body: some View {
        Group {
            if !onboardingComplete {
                OnboardingFlow()
            } else if auth.jwt != nil {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .onAppear {
            auth.loadFromKeychain()
        }
    }
}

struct MainTabView: View {
    var body: some View {
        TabView {
            TodayView()
                .tabItem { Label("Today", systemImage: "sun.max.fill") }

            InboxTab()
                .tabItem { Label("Inbox", systemImage: "tray.full") }

            HomeView()
                .tabItem { Label("Home", systemImage: "house.fill") }

            DecisionsView()
                .tabItem { Label("Decisions", systemImage: "checkmark.seal.fill") }

            DraftsView()
                .tabItem { Label("Drafts", systemImage: "square.and.pencil") }

            TerminalsView()
                .tabItem { Label("Terminals", systemImage: "terminal.fill") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gear") }
        }
    }
}

@MainActor
final class AuthStore: ObservableObject {
    @Published var jwt: String?
    @Published var bffURL: String = UserDefaults.standard.string(forKey: "bffURL") ?? "https://app.rokibrain.com"

    func loadFromKeychain() {
        self.jwt = Keychain.read(account: "jwt")
    }

    func setJWT(_ token: String) {
        Keychain.write(account: "jwt", value: token)
        self.jwt = token
    }

    func logout() {
        Keychain.delete(account: "jwt")
        self.jwt = nil
    }

    func setBFFURL(_ url: String) {
        UserDefaults.standard.set(url, forKey: "bffURL")
        self.bffURL = url
    }
}
