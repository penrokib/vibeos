import SwiftUI

// MARK: - TmuxPaneView

struct TmuxPaneView: View {
    let pane: TmuxPane
    let device: MeshDevice?

    @State private var liveSnippet: String
    @State private var commandText: String = ""
    @State private var timer: Timer?

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

            // MARK: Sticky send bar (Cycle 24 — disabled)
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
                // intentionally disabled — cycle 24 enables keystroke send
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(10)
                    .background(Color.accentColor.opacity(0.4), in: Circle())
            }
            .disabled(true)
            .help("Keystroke send enabled in Cycle 24")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial)
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
