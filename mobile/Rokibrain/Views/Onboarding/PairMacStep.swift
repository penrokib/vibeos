import SwiftUI

struct PairMacStep: View {
    @ObservedObject var store: OnboardingStore

    // 4-character code fields
    @State private var c1: String = ""
    @State private var c2: String = ""
    @State private var c3: String = ""
    @State private var c4: String = ""

    @FocusState private var focused: Int?

    private var enteredCode: String {
        (c1 + c2 + c3 + c4).uppercased()
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                VStack(spacing: 8) {
                    Image(systemName: "macbook.and.iphone")
                        .font(.system(size: 48))
                        .foregroundStyle(
                            LinearGradient(
                                colors: [.blue, .purple],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .padding(.bottom, 8)

                    Text("Pair to Your Mac")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                        .foregroundColor(.white)
                }
                .padding(.top, 60)
                .padding(.horizontal, 24)

                Spacer()

                // Instructions
                VStack(alignment: .leading, spacing: 14) {
                    ForEach([
                        ("1", "Open vibeOS on your Mac."),
                        ("2", "Go to Settings → Pair Phone."),
                        ("3", "A 4-letter code will appear.")
                    ], id: \.0) { step, text in
                        HStack(alignment: .top, spacing: 14) {
                            Text(step)
                                .font(.headline)
                                .foregroundColor(.white)
                                .frame(width: 28, height: 28)
                                .background(Color.white.opacity(0.12))
                                .clipShape(Circle())

                            Text(text)
                                .font(.body)
                                .foregroundColor(.gray)
                        }
                    }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 36)

                // 4-box code input
                HStack(spacing: 12) {
                    codeBox(binding: $c1, tag: 1, next: 2)
                    codeBox(binding: $c2, tag: 2, next: 3)
                    codeBox(binding: $c3, tag: 3, next: 4)
                    codeBox(binding: $c4, tag: 4, next: nil)
                }
                .padding(.horizontal, 40)
                .padding(.bottom, 8)

                if let error = store.errorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundColor(.red)
                        .padding(.bottom, 8)
                }

                Spacer()

                // Pair button
                VStack(spacing: 16) {
                    Button {
                        Task { await store.confirmPair(code: enteredCode) }
                    } label: {
                        HStack {
                            if store.isLoading {
                                ProgressView().tint(.white)
                            } else {
                                Text("Pair")
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
                    .disabled(store.isLoading || enteredCode.count < 4)
                    .opacity((store.isLoading || enteredCode.count < 4) ? 0.5 : 1)
                    .padding(.horizontal, 24)

                    Button {
                        withAnimation(.easeInOut(duration: 0.35)) {
                            store.advance(to: .enablePush)
                        }
                    } label: {
                        Text("Skip")
                            .font(.footnote)
                            .foregroundColor(.gray)
                    }
                }
                .padding(.bottom, 48)
            }
        }
        .onAppear {
            focused = 1
        }
    }

    @ViewBuilder
    private func codeBox(binding: Binding<String>, tag: Int, next: Int?) -> some View {
        TextField("", text: binding)
            .keyboardType(.default)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .multilineTextAlignment(.center)
            .font(.title2.bold())
            .foregroundColor(.white)
            .frame(width: 60, height: 64)
            .background(Color.white.opacity(0.07))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(
                        focused == tag ? Color.blue : Color.white.opacity(0.15),
                        lineWidth: focused == tag ? 2 : 1
                    )
            )
            .focused($focused, equals: tag)
            .onChange(of: binding.wrappedValue) { _, newValue in
                // Keep only first character, uppercase
                let filtered = String(newValue.uppercased().prefix(1))
                if filtered != newValue {
                    binding.wrappedValue = filtered
                }
                // Auto-advance
                if !filtered.isEmpty, let next = next {
                    focused = next
                }
            }
    }
}
