import SwiftUI

struct OnboardingFlow: View {
    @StateObject private var store = OnboardingStore()

    var body: some View {
        Group {
            switch store.step {
            case .welcome:
                WelcomeStep(store: store)
                    .transition(.asymmetric(
                        insertion: .move(edge: .trailing),
                        removal: .move(edge: .leading)
                    ))
            case .signIn:
                SignInStep(store: store)
                    .transition(.asymmetric(
                        insertion: .move(edge: .trailing),
                        removal: .move(edge: .leading)
                    ))
            case .pairMac:
                PairMacStep(store: store)
                    .transition(.asymmetric(
                        insertion: .move(edge: .trailing),
                        removal: .move(edge: .leading)
                    ))
            case .enablePush:
                EnablePushStep(store: store)
                    .transition(.asymmetric(
                        insertion: .move(edge: .trailing),
                        removal: .move(edge: .leading)
                    ))
            case .done:
                // Should not be shown — RootView switches to MainTabView when complete
                Color.black.ignoresSafeArea()
            }
        }
        .animation(.easeInOut(duration: 0.35), value: store.step)
    }
}
