import SwiftUI

struct EnablePushStep: View {
    @ObservedObject var store: OnboardingStore

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Image(systemName: "bell.badge.fill")
                .resizable()
                .scaledToFit()
                .frame(width: 64, height: 64)
                .foregroundStyle(.indigo)
                .padding(.bottom, 24)

            Text("Stay in the loop")
                .font(.system(size: 28, weight: .bold))
                .foregroundColor(.white)

            Text("vibeOS only sends notifications for replies awaiting your approval. No noise — just the moments that matter. You can change this anytime in Settings.")
                .font(.subheadline)
                .foregroundColor(.white.opacity(0.65))
                .multilineTextAlignment(.center)
                .padding(.top, 12)
                .padding(.horizontal, 32)

            Spacer()

            Button {
                Task { await store.requestPushAuthorization() }
            } label: {
                Group {
                    if store.isLoading {
                        ProgressView().tint(.white)
                    } else {
                        Text("Enable notifications")
                    }
                }
                .font(.headline)
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(Color.indigo)
                .cornerRadius(14)
            }
            .padding(.horizontal, 24)

            Button {
                store.markComplete()
            } label: {
                Text("Not now")
                    .font(.footnote)
                    .foregroundColor(.white.opacity(0.45))
                    .underline()
            }
            .padding(.top, 16)
            .padding(.bottom, 48)
        }
    }
}
