import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @State private var bffURL: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section(header: Text("Server")) {
                    TextField("BFF URL", text: $bffURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Save") { auth.setBFFURL(bffURL) }
                }
                Section(header: Text("Account")) {
                    Button("Log out", role: .destructive) { auth.logout() }
                }
                Section(header: Text("About")) {
                    LabeledContent("Version",
                        value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                    LabeledContent("Build",
                        value: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")
                    LabeledContent("Bundle ID",
                        value: Bundle.main.bundleIdentifier ?? "com.rokibrain.ios")
                }
                Section(footer: Text("Brain-native companion. No third-party services. JWT in Keychain. No password storage.")) {
                    EmptyView()
                }
            }
            .navigationTitle("Settings")
            .onAppear { bffURL = auth.bffURL }
        }
    }
}
