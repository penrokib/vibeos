import SwiftUI

// MARK: - TmuxPaneView

struct TmuxPaneView: View {
    let pane: TmuxPane
    let device: MeshDevice?

    @Environment(DevicesStore.self) private var store

    @State private var liveSnippet: String
    @State private var commandText: String = ""
    @State private var timer: Timer?
    @State private var sendStatus: SendStatusBanner? = nil

    private var deviceLabel: String {
        device?.hostname ?? "Unknown device"
    }

    private var paneLabel: String {
        "\(pane.session):\(pane.window)"
    }

    init(pane: TmuxPane, device: MeshDevice?) {
        self.pane = pane
        self.device = device
        self._liveSnippet = State(initialValue: pane.lastSnippet ?? "")
    }

    var body: some View {
        VStack(spacing: 0) {
            // MARK: Scrollable output
            ScrollViewReader { proxy in
                ScrollView {
                    Text(liveSnippet.isEmpty ? "(no output)" : liveSnippet)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(liveSnippet.isEmpty ? .tertiary : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .id("bottom")
                }
                .background(Color(.systemBackground))
                .onChange(of: liveSnippet) { _, _ in
                    withAnimation {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
                .onAppear {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }

            Divider()

            // MARK: Privacy banner
            privacyBanner

            // MARK: Shortcut row
            shortcutRow

            Divider()

            // MARK: Send status inline (last send result)
            if let status = sendStatus {
                sendStatusRow(status)
            }

            // MARK: Sticky send bar
            sendBar
        }
        .navigationTitle(pane.title ?? paneLabel)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(pane.title ?? paneLabel)
                        .font(.headline)
                        .lineLimit(1)
                    Text("\(deviceLabel) · \(paneLabel)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .onAppear { startPolling() }
        .onDisappear { stopPolling() }
    }

    // MARK: - Privacy banner

    private var privacyBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "lock.shield")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text("Sent via your daemon — anti-ban + cc-modal hardwall enforced server-side")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground))
    }

    // MARK: - Shortcut row

    private var shortcutRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                shortcutButton(label: "Esc",    keys: "\u{1B}")
                shortcutButton(label: "↑",      keys: "\u{1B}[A")
                shortcutButton(label: "↓",      keys: "\u{1B}[B")
                shortcutButton(label: "Tab",    keys: "\t")
                shortcutButton(label: "Ctrl+C", keys: "\u{03}")
                shortcutButton(label: "Ctrl+D", keys: "\u{04}")
                shortcutButton(label: "↵",      keys: "\n")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
        }
        .background(Color(.secondarySystemBackground))
    }

    private func shortcutButton(label: String, keys: String) -> some View {
        Button {
            Task { await performSend(keys: keys) }
        } label: {
            Text(label)
                .font(.system(.caption, design: .monospaced))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(Color(.separator), lineWidth: 0.5)
                )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Send status row

    private func sendStatusRow(_ status: SendStatusBanner) -> some View {
        HStack(spacing: 6) {
            Image(systemName: status.accepted ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(status.accepted ? .green : .orange)
            Text(status.message)
                .font(.caption2)
                .foregroundStyle(status.accepted ? .green : .orange)
                .lineLimit(2)
            Spacer()
            Text(status.timestamp, style: .time)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .background(
            (status.accepted ? Color.green : Color.orange).opacity(0.08)
        )
    }

    // MARK: - Send bar

    private var sendBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Type command…", text: $commandText, axis: .vertical)
                .font(.system(.subheadline, design: .monospaced))
                .lineLimit(1...5)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))

            Button {
                let text = commandText
                commandText = ""
                Task { await performSend(keys: text) }
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(10)
                    .background(
                        commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? Color.accentColor.opacity(0.3)
                            : Color.accentColor,
                        in: Circle()
                    )
            }
            .disabled(commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
    }

    // MARK: - Send action

    @MainActor
    private func performSend(keys: String) async {
        guard let deviceId = device?.id else {
            sendStatus = SendStatusBanner(
                accepted: false,
                message: "Refused: no device selected",
                timestamp: Date()
            )
            return
        }

        do {
            let result = try await store.sendKeystrokes(
                deviceId: deviceId,
                paneId: pane.id,
                keys: keys
            )
            if result.accepted {
                sendStatus = SendStatusBanner(
                    accepted: true,
                    message: "Sent",
                    timestamp: Date()
                )
            } else {
                let reason = result.refusedReason ?? "unknown"
                let humanReason: String
                switch reason {
                case "BFF_UNREACHABLE":
                    humanReason = "Refused: daemon unreachable (BFF_UNREACHABLE)"
                case "cc-modal hardwall":
                    humanReason = "Refused: cc-modal hardwall (bare 2/3 + Enter blocked)"
                default:
                    humanReason = "Refused: \(reason)"
                }
                sendStatus = SendStatusBanner(
                    accepted: false,
                    message: humanReason,
                    timestamp: Date()
                )
            }
        } catch {
            sendStatus = SendStatusBanner(
                accepted: false,
                message: "Error: \(error.localizedDescription)",
                timestamp: Date()
            )
        }
    }

    // MARK: - 5-second poll

    private func startPolling() {
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
            Task { @MainActor in
                await pollPane()
            }
        }
    }

    private func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    @MainActor
    private func pollPane() async {
        do {
            struct PaneDetail: Decodable {
                let lastSnippet: String?
            }
            let detail = try await APIClient.shared.get(
                "/mesh/devices/\(device?.id ?? "")/panes/\(pane.id)",
                as: PaneDetail.self
            )
            if let s = detail.lastSnippet {
                liveSnippet = s
            }
        } catch {
            // silently ignore on poll failure — keep last known value
        }
    }
}

// MARK: - SendStatusBanner

private struct SendStatusBanner {
    let accepted: Bool
    let message: String
    let timestamp: Date
}
