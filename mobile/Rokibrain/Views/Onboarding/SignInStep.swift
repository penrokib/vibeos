import SwiftUI

struct SignInStep: View {
    @ObservedObject var store: OnboardingStore
    @State private var tokenInput: String = ""

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Text("Sign in")
                .font(.system(size: 28, weight: .bold))
                .foregroundColor(.white)

            Text("We'll send a magic link to your email.")
                .font(.subheadline)
                .foregroundColor(.white.opacity(0.65))
                .padding(.top, 8)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            VStack(spacing: 16) {
                if !store.magicLinkSent {
                    TextField("you@example.com", text: $store.email)
                        .keyboardType(.emailAddress)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .padding()
                        .background(Color.white.opacity(0.08))
                        .cornerRadius(12)
                        .foregroundColor(.white)

                    Button {
                        Task { await store.requestMagicLink(email: store.email) }
                    } label: {
                        Group {
                            if store.isLoading {
                                ProgressView().tint(.white)
                            } else {
                                Text("Send magic link")
                            }
                        }
                        .font(.headline)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.indigo)
                        .cornerRadius(14)
                    }
                    .disabled(store.email.isEmpty || store.isLoading)
                } else {
                    Text("Check your email and paste the token below.")
                        .font(.footnote)
                        .foregroundColor(.white.opacity(0.65))
                        .multilineTextAlignment(.center)

                    TextField("Paste token", text: $tokenInput)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .padding()
                        .background(Color.white.opacity(0.08))
                        .cornerRadius(12)
                        .foregroundColor(.white)

                    Button {
                        Task { await store.verifyMagicLink(token: tokenInput) }
                    } label: {
                        Group {
                            if store.isLoading {
                                ProgressView().tint(.white)
                            } else {
                                Text("Verify")
                            }
                        }
                        .font(.headline)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.indigo)
                        .cornerRadius(14)
                    }
                    .disabled(tokenInput.isEmpty || store.isLoading)
                }
            }
            .padding(.top, 36)
            .padding(.horizontal, 24)

            Spacer()

            Button {
                withAnimation { store.markComplete() }
            } label: {
                Text("Skip — use locally")
                    .font(.footnote)
                    .foregroundColor(.white.opacity(0.45))
                    .underline()
            }
            .padding(.bottom, 48)
        }
    }
}
