import SwiftUI

struct TodayView: View {
    @State private var store = DigestStore()

    // Cycle 25: PTT + voice compose
    @State private var voiceStore = VoiceComposeStore()
    @State private var draftsStore = DraftsStore()

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            NavigationStack {
                Group {
                    if store.loading && store.digest == nil {
                        loadingView
                    } else {
                        contentList
                    }
                }
                .navigationTitle("Today")
                .navigationBarTitleDisplayMode(.large)
                .refreshable {
                    await store.refresh()
                }
                .onAppear {
                    if store.digest == nil {
                        Task { await store.refresh() }
                    }
                }
            }

            // Cycle 25: PTT floating button
            PTTButton(store: voiceStore, draftsStore: draftsStore)
                .padding(.trailing, 20)
                .padding(.bottom, 20)
        }
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.4)
            Text("Building your digest…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Main content list

    private var contentList: some View {
        List {
            // Error banner
            if let err = store.error {
                Section {
                    errorBanner(message: err)
                }
            }

            if let digest = store.digest {
                // Needs you
                Section(header: Text("Needs you")) {
                    if digest.needsYou.isEmpty {
                        emptyRow(text: "Nothing waiting on you right now")
                    } else {
                        ForEach(digest.needsYou) { item in
                            digestRow(item: item)
                        }
                    }
                }

                // What happened
                Section(header: Text("What happened")) {
                    if digest.whatHappened.isEmpty {
                        emptyRow(text: "No recent activity")
                    } else {
                        ForEach(digest.whatHappened) { item in
                            digestRow(item: item)
                        }
                    }
                }

                // Stuck
                Section(header: Text("Stuck")) {
                    if digest.stuck.isEmpty {
                        emptyRow(text: "Everything moving")
                    } else {
                        ForEach(digest.stuck) { item in
                            digestRow(item: item)
                        }
                    }
                }

                // Footer timestamp
                Section {
                    HStack {
                        Spacer()
                        Text("Generated \(digest.generatedAt.formatted(.relative(presentation: .named)))")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Spacer()
                    }
                }
                .listRowBackground(Color.clear)
            } else {
                // Empty state — first launch before any refresh
                Section {
                    emptyStateView
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Digest row

    @ViewBuilder
    private func digestRow(item: DigestItem) -> some View {
        NavigationLink(destination: DigestItemDetailView(item: item)) {
            HStack(spacing: 12) {
                kindIcon(for: item.kind)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.subheadline)
                        .bold()
                    if let sub = item.subtitle {
                        Text(sub)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Text(item.ts.formatted(.relative(presentation: .named)))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 2)
        }
    }

    // MARK: - Kind icon

    @ViewBuilder
    private func kindIcon(for kind: String) -> some View {
        let (name, color): (String, Color) = {
            switch kind {
            case "draft":    return ("square.and.pencil", .blue)
            case "decision": return ("checkmark.seal.fill", .orange)
            case "persona":  return ("person.fill.questionmark", .purple)
            case "alert":    return ("bell.fill", .green)
            default:         return ("circle.fill", .secondary)
            }
        }()
        Image(systemName: name)
            .foregroundStyle(color)
            .frame(width: 22)
    }

    // MARK: - Helpers

    private func emptyRow(text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
    }

    private var emptyStateView: some View {
        VStack(spacing: 12) {
            Image(systemName: "rays")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("Digest will populate after first refresh")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .listRowBackground(Color.clear)
    }

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

// MARK: - Detail placeholder (wired up in later cycles)

struct DigestItemDetailView: View {
    let item: DigestItem

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(item.title)
                        .font(.headline)
                    if let sub = item.subtitle {
                        Text(sub)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
            Section(header: Text("Details")) {
                LabeledContent("Kind", value: item.kind)
                LabeledContent("Time", value: item.ts.formatted(date: .abbreviated, time: .shortened))
                if let link = item.deepLink {
                    LabeledContent("Deep link", value: link)
                }
            }
            Section {
                Text("Full action view will be wired in a later cycle.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Item")
        .navigationBarTitleDisplayMode(.inline)
    }
}
