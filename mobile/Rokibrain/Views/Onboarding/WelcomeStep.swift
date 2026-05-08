import SwiftUI

struct WelcomeStep: View {
    @ObservedObject var store: OnboardingStore

    private let bullets: [(String, String)] = [
        ("checkmark.circle.fill", "Drafts you approve"),
        ("shield.lefthalf.filled", "Multi-account safe"),
        ("brain.head.profile", "Claude on your side"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Image(systemName: "circle.hexagonpath.fill")
                .resizable()
                .scaledToFit()
                .frame(width: 80, height: 80)
                .foregroundStyle(.indigo)
                .padding(.bottom, 28)

            Text("Welcome to vibeOS")
                .font(.system(size: 30, weight: .bold))
                .foregroundColor(.white)
                .multilineTextAlignment(.center)

            Text("Run your business across every comms channel\n— from anywhere.")
                .font(.subheadline)
                .foregroundColor(.white.opacity(0.65))
                .multilineTextAlignment(.center)
                .padding(.top, 12)
                .padding(.horizontal, 32)

            VStack(alignment: .leading, spacing: 16) {
                ForEach(bullets, id: \.0) { item in
                    HStack(spacing: 12) {
                        Image(systemName: item.0)
                            .foregroundStyle(.indigo)
                            .frame(width: 24)
                        Text(item.1)
                            .foregroundColor(.white.opacity(0.9))
                            .font(.body)
                    }
                }
            }
            .padding(.top, 40)
            .padding(.horizontal, 48)

            Spacer()

            Button {
                withAnimation { store.step = .signIn }
            } label: {
                Text("Continue")
                    .font(.headline)
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color.indigo)
                    .cornerRadius(14)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 48)
        }
    }
}
