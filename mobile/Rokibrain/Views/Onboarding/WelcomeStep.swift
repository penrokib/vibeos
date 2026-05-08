import SwiftUI

struct WelcomeStep: View {
    @ObservedObject var store: OnboardingStore

    private let bullets: [(icon: String, text: String)] = [
        ("checkmark.bubble.fill", "Drafts you approve"),
        ("person.2.fill", "Multi-account safe"),
        ("sparkles", "Claude on your side")
    ]

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Logo
                Image(systemName: "circle.hexagonpath.fill")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 80, height: 80)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [.blue, .purple],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .padding(.bottom, 32)

                // Title
                Text("Welcome to vibeOS")
                    .font(.largeTitle)
                    .fontWeight(.bold)
                    .foregroundColor(.white)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 12)

                // Subtitle
                Text("Run your business across every comms channel — from anywhere.")
                    .font(.body)
                    .foregroundColor(.gray)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.bottom, 48)

                // Bullets
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(bullets, id: \.text) { bullet in
                        HStack(spacing: 16) {
                            Image(systemName: bullet.icon)
                                .font(.title3)
                                .foregroundStyle(
                                    LinearGradient(
                                        colors: [.blue, .purple],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                                .frame(width: 28)
                            Text(bullet.text)
                                .font(.body)
                                .foregroundColor(.white)
                        }
                    }
                }
                .padding(.horizontal, 40)
                .padding(.bottom, 56)

                Spacer()

                // Continue button
                Button {
                    withAnimation(.easeInOut(duration: 0.35)) {
                        store.advance(to: .signIn)
                    }
                } label: {
                    Text("Get Started")
                        .font(.headline)
                        .foregroundColor(.white)
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
                .padding(.horizontal, 24)
                .padding(.bottom, 48)
            }
        }
    }
}
