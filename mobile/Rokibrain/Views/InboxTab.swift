import SwiftUI

// MARK: - InboxTab

struct InboxTab: View {
    @State private var store = InboxStore()

    var body: some View {
        NavigationStack {
            Group {
                if store.loading && store.threads.isEmpty {
                    loadingView
                } else {
                    threadList
                }
            }
            .navigationTitle("Inbox")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    HStack(spacing: 8) {
                        accountMenu
                        platformMenu
                    }
                }
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
                if store.threads.isEmpty {
                    Task { await store.refresh() }
                }
            }
        }
    }

    // MARK: - Menus

    private var accountMenu: some View {
        Menu {
            Button("All Accounts") { store.accountFilter = nil }
            Divider()
            ForEach(store.availableAccounts, id: \.self) { account in
                Button(account) { store.accountFilter = account }
            }
        } label: {
            Label(store.accountFilter ?? "Account", systemImage: "person.crop.circle")
                .font(.footnote)
                .lineLimit(1)
        }
    }

    private var platformMenu: some View {
        Menu {
            Button("All Platforms") { store.platformFilter = nil }
            Divider()
            ForEach(store.availablePlatforms, id: \.self) { platform in
                Button {
                    store.platformFilter = platform
                } label: {
                    Label(platform.capitalized, systemImage: platformIcon(platform))
                }
            }
        } label: {
            Label(store.platformFilter?.capitalized ?? "Platform", systemImage: "tray.2")
                .font(.footnote)
                .lineLimit(1)
        }
    }

    // MARK: - Thread list

    private var threadList: some View {
        VStack(spacing: 0) {
            filterPicker
                .padding(.horizontal)
                .padding(.vertical, 8)

            if let err = store.error {
                errorBanner(message: err)
                    .padding(.horizontal)
                    .padding(.bottom, 4)
            }

            if store.filteredThreads.isEmpty {
                emptyStateView
            } else {
                List(store.filteredThreads) { thread in
                    NavigationLink(destination: InboxThreadView(thread: thread)) {
                        InboxThreadRow(thread: thread)
                    }
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                }
                .listStyle(.plain)
            }
        }
    }

    // MARK: - Filter picker

    private var filterPicker: some View {
        Picker("Filter", selection: $store.viewFilter) {
            ForEach(InboxFilter.allCases) { f in
                Text(f.label).tag(f)
            }
        }
        .pickerStyle(.segmented)
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.4)
            Text("Loading inbox…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Empty state

    private var emptyStateView: some View {
        VStack(spacing: 14) {
            Image(systemName: "tray")
                .font(.system(size: 44))
                .foregroundStyle(.tertiary)
            Text("Nothing here")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("Try a different filter or pull to refresh.")
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

// MARK: - InboxThreadRow

struct InboxThreadRow: View {
    let thread: InboxThread

    var body: some View {
        HStack(spacing: 12) {
            avatarCircle

            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(thread.participantName)
                        .font(.subheadline)
                        .bold()
                        .lineLimit(1)
                    Spacer()
                    Text(thread.lastTimestamp, format: .relative(presentation: .named))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                HStack {
                    Text(thread.lastMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    if thread.unreadCount > 0 {
                        unreadBadge
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - Avatar circle

    private var avatarCircle: some View {
        ZStack {
            Circle()
                .fill(platformColor(thread.platform))
                .frame(width: 42, height: 42)
            Image(systemName: platformIcon(thread.platform))
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
        }
    }

    // MARK: - Unread badge

    private var unreadBadge: some View {
        Text("\(thread.unreadCount)")
            .font(.caption2)
            .bold()
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.accentColor, in: Capsule())
            .fixedSize()
    }
}

// MARK: - InboxThreadView (placeholder for cycle 23-24)

struct InboxThreadView: View {
    let thread: InboxThread

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(thread.participantName)
                        .font(.headline)
                    Text(thread.participantHandle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }
            Section(header: Text("Details")) {
                LabeledContent("Platform", value: thread.platform.capitalized)
                LabeledContent("Account", value: thread.account)
                LabeledContent("Unread", value: "\(thread.unreadCount)")
                LabeledContent("Last message", value: thread.lastTimestamp.formatted(date: .abbreviated, time: .shortened))
            }
            Section {
                Text("Full thread view coming in cycle 23-24.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(thread.participantName)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Platform helpers (shared by row + tab)

func platformColor(_ platform: String) -> Color {
    switch platform {
    case "whatsapp":  return Color(red: 0.07, green: 0.69, blue: 0.44)
    case "telegram":  return Color(red: 0.0,  green: 0.59, blue: 0.87)
    case "email":     return Color(red: 0.28, green: 0.45, blue: 0.96)
    case "discord":   return Color(red: 0.35, green: 0.40, blue: 0.93)
    case "linkedin":  return Color(red: 0.0,  green: 0.46, blue: 0.71)
    default:          return .gray
    }
}

func platformIcon(_ platform: String) -> String {
    switch platform {
    case "whatsapp":  return "message.fill"
    case "telegram":  return "paperplane.fill"
    case "email":     return "envelope.fill"
    case "discord":   return "gamecontroller.fill"
    case "linkedin":  return "network"
    default:          return "bubble.left.fill"
    }
}
