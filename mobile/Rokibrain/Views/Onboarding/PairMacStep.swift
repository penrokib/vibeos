import SwiftUI

struct PairMacStep: View {
    @ObservedObject var store: OnboardingStore
    @FocusState private var focusedField: Int?

    @State private var segments: [String] = ["", "", "", ""]

    var combinedCode: String { segments.joined() }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Text("Pair your Mac")
                .font(.system(size: 28, weight: .bold))
                .foregroundColor(.white)

            VStack(alignment: .leading, spacing: 8) {
                Text("1. Open vibeOS on your Mac")
                Text("2. Go to Settings → Mobile")
                Text("3. Enter the 4-character code shown here")
            }
            .font(.subheadline)
            .foregroundColor(.white.opacity(0.65))
            .padding(.top, 16)
            .padding(.horizontal, 32)

            if let code = store.pairCode {
                Text("Your code: \(code)")
                    .font(.title2.monospaced().bold())
                    .foregroundColor(.indigo)
                    .padding(.top, 24)
            }

            HStack(spacing: 12) {
                ForEach(0..<4, id: \.self) { idx in
                    TextField("", text: $segments[idx])
                        .frame(width: 56, height: 60)
                        .multilineTextAlignment(.center)
                        .font(.title.bold().monospaced())
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .background(Color.white.opacity(0.08))
                        .cornerRadius(10)
                        .foregroundColor(.white)
                        .focused($focusedField, equals: idx)
                        .onChange(of: segments[idx]) { _, newVal in
                            let filtered = String(newVal.uppercased().prefix(1))
                            if segments[idx] != filtered { segments[idx] = filtered }
                            if !filtered.isEmpty && idx < 3 {
                                focusedField = idx + 1
                            }
                        }
                }
            }
            .padding(.top, 28)

            Button {
                Task { await store.confirmPair(code: combinedCode) }
            } label: {
                Group {
                    if store.isLoading {
                        ProgressView().tint(.white)
                    } else {
                        Text("Pair")
                    }
                }
                .font(.headline)
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(combinedCode.count == 4 ? Color.indigo : Color.indigo.opacity(0.4))
                .cornerRadius(14)
            }
            .disabled(combinedCode.count < 4 || store.isLoading)
            .padding(.horizontal, 24)
            .padding(.top, 28)

            Spacer()

            Button {
                withAnimation { store.step = .enablePush }
            } label: {
                Text("Skip")
                    .font(.footnote)
                    .foregroundColor(.white.opacity(0.45))
                    .underline()
            }
            .padding(.bottom, 48)
        }
        .task { await store.requestPairCode() }
        .onAppear { focusedField = 0 }
    }
}
