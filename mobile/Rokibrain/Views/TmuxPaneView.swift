import SwiftUI

struct TmuxPaneView: View {
    let pane: TmuxPane
    let deviceHostname: String

    @State private var outputLines: [String] = []
    @State private var inputText: String = ""
    @State private var pollTask: Task<Void, Never>?
    @State private var isLoading: Bool = true

    private var paneLabel: String {
        "\(pane.session) / \(pane.window)"
    }

    var body: some View {
        VStack(spacing: 0) {
            // Output scroll area
            outputArea

            Divider()

            // Read-only input area (Cycle 24 enables real send)
            inputArea
        }
        .navigationTitle(paneLabel)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(deviceHostname)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(paneLabel)
                        .font(.subheadline.weight(.semibold))
                }
            }
        }
        .onAppear {
            startPolling()
        }
        .onDisappear {
            stopPolling()
        }
    }

    // MARK: - Output area

    private var outputArea: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if isLoading && outputLines.isEmpty {
                        HStack {
                            ProgressView()
                            Text("Loading pane output…")
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        .padding(12)
                    } else if outputLines.isEmpty {
                        Text("(no output)")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .padding(12)
                    } else {
                        ForEach(Array(outputLines.enumerated()), id: \.offset) { _, line in
                            Text(line)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundColor(.green)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                        }
                        // Scroll anchor
                        Color.clear
                            .frame(height: 1)
                            .id("outputBottom")
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }
            .background(Color.black)
            .onChange(of: outputLines.count) { _, _ in
                withAnimation(.easeOut(duration: 0.15)) {
                    proxy.scrollTo("outputBottom", anchor: .bottom)
                }
            }
        }
    }

    // MARK: - Input area (disabled — Cycle 24 enables real send)

    private var inputArea: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField("Type command…", text: $inputText, axis: .vertical)
                    .font(.system(size: 13, design: .monospaced))
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .lineLimit(1...4)
                    .disabled(true)
                    .opacity(0.5)

                Button(action: {}) {
                    Text("Send")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .disabled(true)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Text("Cycle 24 enables full keystroke send")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.bottom, 6)
        }
        .background(Color(.secondarySystemBackground))
    }

    // MARK: - Polling (5-second interval)

    private func startPolling() {
        fetchOutput()
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if !Task.isCancelled {
                    fetchOutput()
                }
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func fetchOutput() {
        Task { @MainActor in
            isLoading = true
            defer { isLoading = false }

            let deviceId = pane.id.components(separatedBy: ":").first ?? ""
            let path = "/mesh/devices/\(deviceId)/panes/\(pane.id)/output"
            do {
                let response = try await APIClient.shared.get(path, as: PaneOutputResponse.self)
                let lines = response.output.components(separatedBy: "\n")
                self.outputLines = Array(lines.suffix(500))
            } catch {
                // Fall back to snippet preview on any error (endpoint not yet live)
                if let snippet = pane.lastSnippet, !snippet.isEmpty, self.outputLines.isEmpty {
                    self.outputLines = snippet.components(separatedBy: "\n")
                }
            }
        }
    }
}

// MARK: - Response type

private struct PaneOutputResponse: Decodable {
    let output: String
}
