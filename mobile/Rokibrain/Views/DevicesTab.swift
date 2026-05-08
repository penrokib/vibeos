import SwiftUI

// MARK: - DevicesTab

struct DevicesTab: View {
    @State private var store = DevicesStore()

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if store.loading && store.devices.isEmpty {
                    loadingView
                } else {
                    devicePickerRow
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                        .padding(.bottom, 4)

                    if let err = store.error {
                        errorBanner(message: err)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 4)
                    }

                    paneList
                }
            }
            .navigationTitle("Devices")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        Task { await store.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(store.loading)
                }
            }
            .refreshable {
                await store.refresh()
            }
            .onAppear {
                if store.devices.isEmpty {
                    Task { await store.refresh() }
                }
            }
        }
        .environment(store)
    }

    // MARK: - Device picker

    private var devicePickerRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(store.devices) { device in
                    DeviceChip(
                        device: device,
                        isSelected: store.selectedDeviceId == device.id
                    )
                    .onTapGesture {
                        store.selectedDeviceId = device.id
                        Task { await store.loadPanes(deviceId: device.id) }
                    }
                }
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: - Pane list

    @ViewBuilder
    private var paneList: some View {
        let panes = store.displayedPanes
        if panes.isEmpty {
            emptyStateView
        } else {
            List(panes) { pane in
                NavigationLink(destination: TmuxPaneView(pane: pane, device: store.selectedDevice)) {
                    TmuxPaneRow(pane: pane)
                }
                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
            }
            .listStyle(.plain)
        }
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.4)
            Text("Loading devices…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Empty state

    private var emptyStateView: some View {
        VStack(spacing: 14) {
            Image(systemName: "desktopcomputer.slash")
                .font(.system(size: 44))
                .foregroundStyle(.tertiary)
            Text("No panes found")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("Select a device above or pull to refresh.")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Error banner

    private func errorBanner(message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.red)
            Spacer()
            Button {
                Task { await store.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .foregroundStyle(.red)
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - DeviceChip

struct DeviceChip: View {
    let device: MeshDevice
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(device.online ? Color.green : Color.red)
                .frame(width: 8, height: 8)
            Text(device.hostname)
                .font(.subheadline)
                .fontWeight(isSelected ? .semibold : .regular)
                .lineLimit(1)
            if let panes = device.panes, !panes.isEmpty {
                Text("\(panes.count)")
                    .font(.caption2)
                    .bold()
                    .foregroundStyle(isSelected ? .white : .secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(isSelected ? Color.accentColor : Color.secondary.opacity(0.25), in: Capsule())
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(
            isSelected
                ? Color.accentColor.opacity(0.15)
                : Color.secondary.opacity(0.1),
            in: RoundedRectangle(cornerRadius: 20)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20)
                .stroke(isSelected ? Color.accentColor : Color.clear, lineWidth: 1.5)
        )
    }
}

// MARK: - TmuxPaneRow

struct TmuxPaneRow: View {
    let pane: TmuxPane

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(pane.session):\(pane.window)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fontDesign(.monospaced)
                Spacer()
                Text(pane.updatedAt, format: .relative(presentation: .named))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            if let title = pane.title, !title.isEmpty {
                Text(title)
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .lineLimit(1)
            }

            if let snippet = pane.lastSnippet, !snippet.isEmpty {
                Text(snippet)
                    .font(.caption)
                    .fontDesign(.monospaced)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .truncationMode(.tail)
            }
        }
        .padding(.vertical, 4)
    }
}
