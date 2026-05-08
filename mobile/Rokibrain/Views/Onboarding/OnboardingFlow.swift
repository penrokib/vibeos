import SwiftUI

struct OnboardingFlow: View {
    @StateObject var store: OnboardingStore

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                Group {
                    switch store.step {
                    case .welcome:
                        WelcomeStep(store: store)
                            .transition(.slide)
                    case .signIn:
                        SignInStep(store: store)
                            .transition(.slide)
                    case .pairMac:
                        PairMacStep(store: store)
                            .transition(.slide)
                    case .enablePush:
                        EnablePushStep(store: store)
                            .transition(.slide)
                    case .done:
                        // Should never render — RootView switches to MainTabView
                        Color.clear
                    }
                }
                .animation(.easeInOut(duration: 0.35), value: store.step)
            }
        }
        .preferredColorScheme(.dark)
    }
}
