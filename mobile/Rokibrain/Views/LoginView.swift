import SwiftUI

struct LoginView: View {
    @EnvironmentObject var auth: AuthStore
    @State private var email: String = "roki@dewx.com"
    @State private var password: String = ""
    @State private var bffURL: String = ""
    @State private var loading: Bool = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section(header: Text("rokibrain")) {
                    TextField("BFF URL", text: $bffURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                }

                if let error {
                    Section {
                        Text(error).foregroundColor(.red).font(.footnote)
                    }
                }

                Section {
                    Button(action: login) {
                        HStack {
                            Spacer()
                            if loading {
                                ProgressView()
                            } else {
                                Text("Sign In").bold()
                            }
                            Spacer()
                        }
                    }
                    .disabled(loading || email.isEmpty || password.isEmpty)
                }

                Section(footer: Text("Companion app — sole user is Roki. Password validated via /auth/login. JWT stored in iOS Keychain only.")) {
                    EmptyView()
                }
            }
            .navigationTitle("Sign In")
            .onAppear {
                bffURL = auth.bffURL
            }
        }
    }

    private func login() {
        loading = true
        error = nil
        auth.setBFFURL(bffURL.isEmpty ? "https://app.rokibrain.com" : bffURL)
        Task {
            do {
                let resp: LoginResponse = try await APIClient.shared.post(
                    "/auth/login",
                    body: LoginRequest(email: email, password: password),
                    as: LoginResponse.self
                )
                let token = resp.jwt
                guard !token.isEmpty else {
                    self.error = "Login response missing token"
                    self.loading = false
                    return
                }
                auth.setJWT(token)
                self.loading = false
            } catch {
                self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
                self.loading = false
            }
        }
    }
}
