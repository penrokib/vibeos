import SwiftUI

struct EnablePushStep: View {
    @ObservedObject var store: OnboardingStore

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                VStack(spacing: 8) {
                    Image(systemName: "bell.badge.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(
                            LinearGradient(
                                colors: [.blue, .purple],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .padding(.bottom, 8)

                    Text("Stay in the Loop")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                        .foregroundColor(.white)
                }
                .padding(.top, 60)
                .padding(.horizontal, 24)

                Spacer()

                // Body text
                VStack(spacing: 24) {
                    Text("vibeOS pings you when there's a draft, a stuck persona, or a Claude limit prompt.")
                        .font(.body)
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)

                    // Privacy note
                    HStack(spacing: 12) {
                        Image(systemName: "lock.shield.fill")
                            .font(.title3)
                            .foregroundColor(.green)

                        Text("Content-free notifications — we never see your messages.")
                            .font(.footnote)
                            .foregroundColor(.gray)
                    }
                    .padding(.horizontal, 32)
                    .padding(.vertical, 16)
                    .background(Color.white.opacity(0.05))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 24)
                }

                Spacer()

                // Buttons
                VStack(spacing: 16) {
                    Button {
                        Task { await store.requestPushAuthorization() }
                    } label: {
                        HStack {
                            if store.isLoading {
                                ProgressView().tint(.white)
                            } else {
                                Label("Enable Notifications", systemImage: "bell.fill")
                                    .font(.headline)
                                    .foregroundColor(.white)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(
                            LinearGradient(
                                colors: [.blue, .purple],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                    .disabled(store.isLoading)
                    .opacity(store.isLoading ? 0.5 : 1)
                    .padding(.horizontal, 24)

                    Button {
                        withAnimation(.easeInOut(duration: 0.35)) {
                            store.skipPush()
                        }
                    } label: {
                        Text("Skip for Now")
                            .font(.footnote)
                            .foregroundColor(.gray)
                    }
                }
                .padding(.bottom, 48)
            }
        }
    }
}
