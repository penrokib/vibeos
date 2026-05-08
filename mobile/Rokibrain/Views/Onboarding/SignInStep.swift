import SwiftUI

struct SignInStep: View {
    @ObservedObject var store: OnboardingStore

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                VStack(spacing: 8) {
                    Image(systemName: "envelope.badge.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(
                            LinearGradient(
                                colors: [.blue, .purple],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .padding(.bottom, 8)

                    Text("Sign In")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                        .foregroundColor(.white)

                    Text("We'll send a magic link to your email.")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 60)
                .padding(.horizontal, 24)

                Spacer()

                if !store.magicLinkSent {
                    // Email input phase
                    VStack(spacing: 16) {
                        TextField("you@example.com", text: $store.email)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .padding()
                            .background(Color.white.opacity(0.07))
                            .foregroundColor(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12)
                                    .stroke(Color.white.opacity(0.15), lineWidth: 1)
                            )

                        if let error = store.errorMessage {
                            Text(error)
                                .font(.footnote)
                                .foregroundColor(.red)
                                .multilineTextAlignment(.center)
                        }

                        Button {
                            Task { await store.requestMagicLink() }
                        } label: {
                            HStack {
                                if store.isLoading {
                                    ProgressView().tint(.white)
                                } else {
                                    Text("Send Magic Link")
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
                        .disabled(store.isLoading || store.email.isEmpty)
                        .opacity((store.isLoading || store.email.isEmpty) ? 0.5 : 1)
                    }
                    .padding(.horizontal, 24)
                } else {
                    // Token verification phase
                    VStack(spacing: 16) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Check your email and paste the token below.")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                                .multilineTextAlignment(.center)
                                .frame(maxWidth: .infinity)
                        }

                        TextField("Paste token here", text: $store.magicLinkToken)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .padding()
                            .background(Color.white.opacity(0.07))
                            .foregroundColor(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12)
                                    .stroke(Color.white.opacity(0.15), lineWidth: 1)
                            )

                        if let error = store.errorMessage {
                            Text(error)
                                .font(.footnote)
                                .foregroundColor(.red)
                                .multilineTextAlignment(.center)
                        }

                        Button {
                            Task { await store.verifyMagicLink() }
                        } label: {
                            HStack {
                                if store.isLoading {
                                    ProgressView().tint(.white)
                                } else {
                                    Text("Verify")
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
                        .disabled(store.isLoading || store.magicLinkToken.isEmpty)
                        .opacity((store.isLoading || store.magicLinkToken.isEmpty) ? 0.5 : 1)

                        Button {
                            store.magicLinkSent = false
                            store.magicLinkToken = ""
                            store.errorMessage = nil
                        } label: {
                            Text("Resend")
                                .font(.footnote)
                                .foregroundColor(.gray)
                        }
                    }
                    .padding(.horizontal, 24)
                }

                Spacer()

                // Skip — use locally
                Button {
                    withAnimation(.easeInOut(duration: 0.35)) {
                        store.skipToLocal()
                    }
                } label: {
                    Text("Skip — use locally")
                        .font(.footnote)
                        .foregroundColor(.gray)
                }
                .padding(.bottom, 48)
            }
        }
    }
}
