import SwiftUI

/// 9 cockpit panes mapped 1:1 to top-9 personas.
private let cockpitSessions: [String] = [
    "rokibrain-cto",
    "rokibrain-devops",
    "rokibrain-pm",
    "rokibrain-qa",
    "rokibrain-docs",
    "ahn-cto",
    "dewx-cto",
    "kidiq-cto",
    "pe-cto",
]

struct TerminalsView: View {
    @State private var selected: String?

    private let columns = [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 8) {
                    ForEach(cockpitSessions, id: \.self) { name in
                        TerminalPaneTile(session: name)
                            .onTapGesture { selected = name }
                    }
                }
                .padding(8)
            }
            .navigationTitle("Terminals")
            .navigationDestination(item: $selected) { name in
                TerminalFullscreenView(session: name)
            }
        }
    }
}

extension String: Identifiable {
    public var id: String { self }
}

/// Live tail tile (compact). Connects to BFF WS for this session, displays last few lines.
struct TerminalPaneTile: View {
    let session: String
    @StateObject private var stream = TerminalStream()

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Circle()
                    .fill(stream.connected ? Color.green : Color.red)
                    .frame(width: 6, height: 6)
                Text(session)
                    .font(.caption2.monospaced())
                    .lineLimit(1)
            }
            ScrollView {
                Text(stream.tail.isEmpty ? "(idle)" : stream.tail)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundColor(.green)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: 80)
        }
        .padding(6)
        .background(Color.black)
        .cornerRadius(6)
        .onAppear { stream.connect(session: session) }
        .onDisappear { stream.disconnect() }
    }
}

struct TerminalFullscreenView: View {
    let session: String
    @StateObject private var stream = TerminalStream()
    @State private var inputText: String = ""
    @State private var showBillingAlert: Bool = false
    @State private var pendingKeystroke: String = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                ScrollViewReader { proxy in
                    Text(stream.buffer)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.green)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .id("bottom")
                        .onChange(of: stream.buffer) { _, _ in
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                }
            }
            .background(Color.black)

            Divider()

            HStack {
                TextField("Type and press send…", text: $inputText)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .onSubmit { trySend(text: inputText, withEnter: true) }

                Button("Send") {
                    trySend(text: inputText, withEnter: false)
                }
                Button {
                    trySend(text: "", withEnter: true)
                } label: {
                    Image(systemName: "return")
                }
                Button {
                    stream.sendKey("C-c")
                } label: {
                    Text("^C").font(.caption.bold())
                }
            }
            .padding(8)
        }
        .navigationTitle(session)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { stream.connect(session: session) }
        .onDisappear { stream.disconnect() }
        .alert("Billing change blocked",
               isPresented: $showBillingAlert) {
            Button("Cancel", role: .cancel) {
                pendingKeystroke = ""
                inputText = ""
            }
            Button("Confirm send anyway", role: .destructive) {
                stream.sendKeystroke(pendingKeystroke, withEnter: true, bypassWall: true)
                pendingKeystroke = ""
                inputText = ""
            }
        } message: {
            Text("Recent pane output mentions plan/billing switch. Sending '\(pendingKeystroke)' could change Roki's billing. Bridge will also reject this. Confirm only if you reviewed it.")
        }
    }

    private func trySend(text: String, withEnter: Bool) {
        // Hard wall: defense-in-depth at iOS layer.
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lastLines = stream.lastLines(10).lowercased()
        let dangerousPrompt = lastLines.contains("switch to extra usage") || lastLines.contains("switch to team plan")
        let dangerousChoice = (trimmed == "2" || trimmed == "3")
        if dangerousPrompt && dangerousChoice {
            pendingKeystroke = trimmed
            showBillingAlert = true
            return
        }
        stream.sendKeystroke(trimmed, withEnter: withEnter)
        inputText = ""
    }
}

@MainActor
final class TerminalStream: ObservableObject {
    @Published var buffer: String = ""
    @Published var connected: Bool = false

    private var ws: WSClient?
    private var session: String = ""

    var tail: String {
        let lines = buffer.split(separator: "\n", omittingEmptySubsequences: false)
        return lines.suffix(8).joined(separator: "\n")
    }

    func lastLines(_ n: Int) -> String {
        let lines = buffer.split(separator: "\n", omittingEmptySubsequences: false)
        return lines.suffix(n).joined(separator: "\n")
    }

    func connect(session: String) {
        self.session = session
        guard let jwt = Keychain.read(account: "jwt") else { return }
        let base = UserDefaults.standard.string(forKey: "bffURL") ?? "https://app.rokibrain.com"
        let wssBase = base.replacingOccurrences(of: "https://", with: "wss://")
                          .replacingOccurrences(of: "http://", with: "ws://")
        guard var comps = URLComponents(string: wssBase + "/ws/terminal") else { return }
        comps.queryItems = [
            URLQueryItem(name: "role", value: "client"),
            URLQueryItem(name: "token", value: jwt),
            URLQueryItem(name: "session", value: session),
        ]
        guard let url = comps.url else { return }

        let client = WSClient(url: url)
        client.onText = { [weak self] s in
            Task { @MainActor in self?.handleMessage(s) }
        }
        client.onState = { [weak self] up in
            Task { @MainActor in self?.connected = up }
        }
        self.ws = client
        client.connect()
    }

    func disconnect() {
        ws?.disconnect()
        ws = nil
    }

    private func handleMessage(_ raw: String) {
        // Expect JSON: {type:"pane", session, data} or fallback raw text.
        if let data = raw.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let type = obj["type"] as? String ?? ""
            if type == "pane" || type == "data" {
                if let payload = obj["data"] as? String {
                    appendBuffer(payload)
                    return
                }
            }
        }
        appendBuffer(raw)
    }

    private func appendBuffer(_ s: String) {
        buffer.append(s)
        if buffer.count > 100_000 {
            buffer = String(buffer.suffix(80_000))
        }
    }

    func sendKeystroke(_ text: String, withEnter: Bool, bypassWall: Bool = false) {
        guard let ws else { return }
        if !text.isEmpty {
            ws.sendJSON(["type": "keystroke", "session": session, "data": text])
        }
        if withEnter {
            ws.sendJSON(["type": "keystroke", "session": session, "key": "Enter"])
        }
    }

    func sendKey(_ key: String) {
        ws?.sendJSON(["type": "keystroke", "session": session, "key": key])
    }
}
