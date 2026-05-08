import SwiftUI

@main
struct RokibrainApp: App {
    @StateObject private var auth = AuthStore()
    @State private var appMode = AppMode()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(auth)
                .environment(appMode)
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
                OnboardingFlow(store: OnboardingStore())
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

// MARK: - Main tab container with sticky mode toggle

struct MainTabView: View {
    @Environment(AppMode.self) private var appMode

    var body: some View {
        @Bindable var appMode = appMode
        VStack(spacing: 0) {
            // Sticky WORK / PERSONAL toggle bar at the top
            ModeSwitchBar(current: $appMode.current)

            // Tab content beneath
            TabView {
                TodayView()
                    .tabItem { Label("Today", systemImage: "sun.max.fill") }

                InboxTab()
                    .tabItem { Label("Inbox", systemImage: "tray.full") }

                DraftsTab()
                    .tabItem { Label("Drafts", systemImage: "tray.and.arrow.down") }

                DecisionsView()
                    .tabItem { Label("Decisions", systemImage: "checkmark.seal.fill") }

                DevicesTab()
                    .tabItem { Label("Devices", systemImage: "desktopcomputer") }

                TerminalsView()
                    .tabItem { Label("Terminals", systemImage: "terminal.fill") }

                SettingsView()
                    .tabItem { Label("More", systemImage: "ellipsis.circle.fill") }
            }
        }
        .ignoresSafeArea(edges: .bottom)
    }
}

// MARK: - Mode switch bar

struct ModeSwitchBar: View {
    @Binding var current: WorkPersonalMode

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: modeIcon)
                .foregroundStyle(modeColor)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 22)
                .animation(.easeInOut(duration: 0.2), value: current)

            Picker("Mode", selection: $current) {
                ForEach(WorkPersonalMode.allCases) { m in
                    Text(m.label).tag(m)
                }
            }
            .pickerStyle(.segmented)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(.systemBackground).opacity(0.95))
        .overlay(
            Divider()
                .frame(maxHeight: .infinity, alignment: .bottom),
            alignment: .bottom
        )
    }

    private var modeIcon: String {
        switch current {
        case .work:     return "briefcase.fill"
        case .personal: return "house.fill"
        }
    }

    private var modeColor: Color {
        switch current {
        case .work:     return .blue
        case .personal: return .green
        }
    }
}

// MARK: - AuthStore

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
