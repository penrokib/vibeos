import SwiftUI

struct HomeView: View {
    @StateObject private var vm = HomeViewModel()
    @State private var searchQuery: String = ""

    var body: some View {
        NavigationStack {
            List {
                // Saarland banner
                if let saarland = vm.fleet?.saarland,
                   let t = saarland.t_minus_h, t <= 24 {
                    Section {
                        HStack(spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(.orange)
                            VStack(alignment: .leading) {
                                Text("Saarland T-\(String(format: "%.1f", t))h")
                                    .font(.headline)
                                if let r = saarland.reds {
                                    Text("\(r) reds blocked on Roki decisions")
                                        .font(.subheadline).foregroundColor(.secondary)
                                }
                            }
                        }
                    }
                }

                // Fleet health
                Section(header: Text("Fleet")) {
                    if vm.loading {
                        ProgressView()
                    } else if let fleet = vm.fleet {
                        HStack {
                            Label("\(fleet.machines?.count ?? 0) machines", systemImage: "desktopcomputer")
                            Spacer()
                            Label("\(fleet.personas?.count ?? 0) personas", systemImage: "person.3.fill")
                        }
                        .font(.subheadline)
                    } else if let err = vm.error {
                        Text(err).font(.footnote).foregroundColor(.red)
                    }
                }

                // Account quotas
                if let quotas = vm.fleet?.quotas, !quotas.isEmpty {
                    Section(header: Text("Account quotas")) {
                        ForEach(quotas) { q in
                            HStack {
                                Text(q.account).font(.subheadline)
                                Spacer()
                                Text("\(q.used ?? 0)/\(q.cap ?? 0)").font(.footnote).foregroundColor(.secondary)
                            }
                        }
                    }
                }

                // Knowledge search
                Section(header: Text("Knowledge")) {
                    HStack {
                        Image(systemName: "magnifyingglass")
                        TextField("Search persona learnings…", text: $searchQuery)
                            .textInputAutocapitalization(.never)
                            .onSubmit { Task { await vm.search(query: searchQuery) } }
                    }
                    if vm.searching {
                        ProgressView()
                    }
                    ForEach(vm.knowledgeResults) { chunk in
                        VStack(alignment: .leading, spacing: 4) {
                            if let p = chunk.persona {
                                Text(p).font(.caption).foregroundColor(.accentColor)
                            }
                            Text(chunk.text).font(.footnote).lineLimit(4)
                        }
                        .padding(.vertical, 2)
                    }
                }

                // Top 3 pending decisions
                Section(header: Text("Pending decisions (top 3)")) {
                    if vm.topDecisions.isEmpty {
                        Text("No pending decisions").font(.footnote).foregroundColor(.secondary)
                    }
                    ForEach(vm.topDecisions.prefix(3)) { d in
                        VStack(alignment: .leading) {
                            Text(d.title ?? d.id).font(.subheadline).bold()
                            if let p = d.persona {
                                Text(p).font(.caption).foregroundColor(.secondary)
                            }
                            HStack {
                                Button("Approve") { Task { await vm.approveDecision(d) } }
                                    .buttonStyle(.borderedProminent).controlSize(.small)
                                Button("Skip") { Task { await vm.skipDecision(d) } }
                                    .buttonStyle(.bordered).controlSize(.small)
                            }
                        }
                    }
                }

                // Top 3 pending drafts
                Section(header: Text("Pending drafts (top 3)")) {
                    if vm.topDrafts.isEmpty {
                        Text("No pending drafts").font(.footnote).foregroundColor(.secondary)
                    }
                    ForEach(vm.topDrafts.prefix(3)) { d in
                        VStack(alignment: .leading) {
                            Text(d.preview ?? d.body ?? d.id).font(.subheadline).lineLimit(3)
                            if let p = d.persona, let c = d.channel {
                                Text("\(p) → \(c)").font(.caption).foregroundColor(.secondary)
                            }
                            HStack {
                                Button("Approve") { Task { await vm.approveDraft(d) } }
                                    .buttonStyle(.borderedProminent).controlSize(.small)
                                Button("Reject") { Task { await vm.rejectDraft(d) } }
                                    .buttonStyle(.bordered).controlSize(.small)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Home")
            .refreshable { await vm.refresh() }
            .onAppear { vm.start() }
        }
    }
}

@MainActor
final class HomeViewModel: ObservableObject {
    @Published var fleet: FleetStatus?
    @Published var topDecisions: [Decision] = []
    @Published var topDrafts: [Draft] = []
    @Published var knowledgeResults: [KnowledgeChunk] = []
    @Published var loading: Bool = false
    @Published var searching: Bool = false
    @Published var error: String?

    private var pollTimer: Timer?

    func start() {
        Task { await refresh() }
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
    }

    func refresh() async {
        loading = true
        defer { loading = false }
        async let f: FleetStatus? = try? APIClient.shared.get("/agency/fleet-status", as: FleetStatus.self)
        async let d: [Decision]? = try? APIClient.shared.get("/decisions?status=pending&limit=10", as: [Decision].self)
        async let dr: [Draft]? = try? APIClient.shared.get("/agency/drafts/pending?limit=10", as: [Draft].self)

        let (fleet, decisions, drafts) = await (f, d, dr)
        self.fleet = fleet
        self.topDecisions = decisions ?? []
        self.topDrafts = drafts ?? []
    }

    func search(query: String) async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            knowledgeResults = []
            return
        }
        searching = true
        defer { searching = false }
        let path = "/knowledge/search?q=\(q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")&top_k=10"
        do {
            let resp = try await APIClient.shared.get(path, as: KnowledgeSearchResponse.self)
            self.knowledgeResults = resp.items
        } catch {
            self.knowledgeResults = []
        }
    }

    func approveDecision(_ d: Decision) async {
        struct Body: Encodable { let status: String }
        try? await APIClient.shared.patch("/decisions/\(d.id)", body: Body(status: "approved"))
        await refresh()
    }

    func skipDecision(_ d: Decision) async {
        struct Body: Encodable { let status: String }
        try? await APIClient.shared.patch("/decisions/\(d.id)", body: Body(status: "skipped"))
        await refresh()
    }

    func approveDraft(_ d: Draft) async {
        _ = try? await APIClient.shared.postNoBody("/agency/drafts/\(d.id)/approve", as: AckResponse.self)
        await refresh()
    }

    func rejectDraft(_ d: Draft) async {
        _ = try? await APIClient.shared.postNoBody("/agency/drafts/\(d.id)/reject", as: AckResponse.self)
        await refresh()
    }
}
