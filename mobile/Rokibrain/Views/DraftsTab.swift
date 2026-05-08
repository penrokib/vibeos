import SwiftUI

// MARK: - DraftsTab

struct DraftsTab: View {
    @State private var store = DraftsStore()

    // Cycle 25: PTT + voice compose (shares the same DraftsStore so new draft
    // appears immediately in this tab on VoiceComposeStore.state == .done)
    @State private var voiceStore = VoiceComposeStore()

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            NavigationStack {
                Group {
                    if store.loading && store.drafts.isEmpty {
                        loadingView
                    } else {
                        draftsList
                    }
                }
                .navigationTitle("Drafts")
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
                    if store.drafts.isEmpty {
                        Task { await store.refresh() }
                    }
                }
            }
            .environment(store)

            // Cycle 25: PTT floating button — passes shared DraftsStore so
            // completed voice compose immediately refreshes this list.
            PTTButton(store: voiceStore, draftsStore: store)
                .padding(.trailing, 20)
                .padding(.bottom, 20)
        }
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.4)
            Text("Loading drafts…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Drafts list

    private var draftsList: some View {
        List {
            // Error banner
            if let err = store.error {
                Section {
                    errorBanner(message: err)
                }
            }

            // Header count row
            if !store.drafts.isEmpty {
                Section {
                    HStack {
                        Label("\(store.drafts.count) pending", systemImage: "tray.and.arrow.down")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                }
                .listRowBackground(Color.clear)
            }

            // Draft rows
            Section {
                if store.drafts.isEmpty {
                    emptyStateView
                } else {
                    ForEach(store.drafts) { draft in
                        NavigationLink(destination: DraftDetailView(draft: draft)) {
                            DraftRow(draft: draft)
                        }
                        .disabled(store.processing.contains(draft.id))
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Empty state

    private var emptyStateView: some View {
        VStack(spacing: 14) {
            Image(systemName: "tray.and.arrow.down")
                .font(.system(size: 38))
                .foregroundStyle(.tertiary)
            Text("No pending drafts.")
                .font(.subheadline)
                .bold()
            Text("Personas + Claude write here.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
        .listRowBackground(Color.clear)
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
    }
}

// MARK: - DraftRow

struct DraftRow: View {
    let draft: DraftDetail

    var body: some View {
        HStack(spacing: 12) {
            platformIcon
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(draft.recipientName ?? draft.recipient)
                        .font(.subheadline)
                        .bold()
                        .lineLimit(1)
                    Spacer()
                    Text(draft.createdAt.formatted(.relative(presentation: .named)))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Text(draft.body)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    accountChip
                    Text("via \(draft.persona)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var platformIcon: some View {
        let (name, color): (String, Color) = {
            switch draft.platform {
            case "linkedin":  return ("person.crop.square.filled.and.at.rectangle", .blue)
            case "whatsapp":  return ("message.fill", .green)
            case "email":     return ("envelope.fill", .orange)
            case "telegram":  return ("paperplane.fill", .cyan)
            case "instagram": return ("camera.fill", .pink)
            default:          return ("bubble.left.fill", .secondary)
            }
        }()
        return Image(systemName: name)
            .foregroundStyle(color)
            .frame(width: 24)
    }

    private var accountChip: some View {
        Text(draft.account)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.accentColor.opacity(0.15))
            .foregroundStyle(Color.accentColor)
            .clipShape(Capsule())
            .lineLimit(1)
    }
}
