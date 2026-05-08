import SwiftUI

struct DevicesTab: View {
    @State private var store = DevicesStore()
    @State private var selectedPane: TmuxPane?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Device chip picker
                devicePicker
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)

                Divider()

                // Pane list
                panesContent
            }
            .navigationTitle("Devices")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(item: $selectedPane) { pane in
                TmuxPaneView(
                    pane: pane,
                    deviceHostname: store.selectedDevice?.hostname ?? "Unknown"
                )
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
    }

    // MARK: - Device picker

    private var devicePicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.devices) { device in
                    DeviceChip(
                        device: device,
                        isSelected: store.selectedDeviceId == device.id
                    )
                    .onTapGesture {
                        if device.online {
                            store.selectDevice(device.id)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Panes content

    @ViewBuilder
    private var panesContent: some View {
        if store.loading {
            loadingView
        } else if store.selectedDeviceId == nil {
            emptyStateView(
                icon: "desktopcomputer",
                message: "Select a device to see panes"
            )
        } else if let device = store.selectedDevice, !device.online {
            emptyStateView(
                icon: "wifi.slash",
                message: "Device offline — last seen \(device.lastSeen.formatted(.relative(presentation: .named)))"
            )
        } else if store.panesLoading {
            loadingView
        } else if store.panes.isEmpty {
            emptyStateView(
                icon: "terminal",
                message: "No panes — daemon not running on this device"
            )
        } else {
            List(store.panes) { pane in
                TmuxPaneRow(pane: pane)
                    .contentShape(Rectangle())
                    .onTapGesture { selectedPane = pane }
                    .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
            }
            .listStyle(.plain)
        }
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack(spacing: 14) {
            ProgressView()
                .scaleEffect(1.3)
            Text("Loading…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Empty state

    private func emptyStateView(icon: String, message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: icon)
                .font(.system(size: 42))
                .foregroundStyle(.tertiary)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Device chip

struct DeviceChip: View {
    let device: MeshDevice
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(device.online ? Color.green : Color.red)
                .frame(width: 7, height: 7)
            Text(device.hostname)
                .font(.subheadline.weight(isSelected ? .semibold : .regular))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 20)
                .fill(isSelected ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground))
                .overlay(
                    RoundedRectangle(cornerRadius: 20)
                        .strokeBorder(isSelected ? Color.accentColor : Color.clear, lineWidth: 1.5)
                )
        )
        .opacity(device.online ? 1.0 : 0.5)
    }
}

// MARK: - Pane row

struct TmuxPaneRow: View {
    let pane: TmuxPane

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(pane.session)
                        .font(.subheadline.weight(.semibold))
                    Text(pane.window)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(pane.updatedAt.formatted(.relative(presentation: .named)))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if let snippet = pane.lastSnippet, !snippet.isEmpty {
                Text(snippet)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.black.opacity(0.35))
                    .cornerRadius(5)
            }
        }
        .padding(.vertical, 2)
    }
}
