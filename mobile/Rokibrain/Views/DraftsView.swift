import SwiftUI

struct DraftsView: View {
    @StateObject private var vm = DraftsViewModel()

    var body: some View {
        NavigationStack {
            List {
                if vm.drafts.isEmpty {
                    Text("No pending drafts").foregroundColor(.secondary)
                }
                ForEach(vm.drafts) { d in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(d.preview ?? d.body ?? d.id).font(.body).lineLimit(5)
                        HStack {
                            if let p = d.persona { Text(p) }
                            if let c = d.channel { Text("• \(c)") }
                            if let r = d.recipient { Text("→ \(r)") }
                        }
                        .font(.caption).foregroundColor(.secondary)
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        Button {
                            Task { await vm.approve(d) }
                        } label: {
                            Label("Approve", systemImage: "checkmark")
                        }
                        .tint(.green)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) {
                            Task { await vm.reject(d) }
                        } label: {
                            Label("Reject", systemImage: "xmark")
                        }
                    }
                }
            }
            .navigationTitle("Drafts")
            .refreshable { await vm.refresh() }
            .onAppear { Task { await vm.refresh() } }
        }
    }
}

@MainActor
final class DraftsViewModel: ObservableObject {
    @Published var drafts: [Draft] = []

    func refresh() async {
        let r: [Draft]? = try? await APIClient.shared.get("/agency/drafts/pending", as: [Draft].self)
        self.drafts = r ?? []
    }

    func approve(_ d: Draft) async {
        _ = try? await APIClient.shared.postNoBody("/agency/drafts/\(d.id)/approve", as: AckResponse.self)
        await refresh()
    }

    func reject(_ d: Draft) async {
        _ = try? await APIClient.shared.postNoBody("/agency/drafts/\(d.id)/reject", as: AckResponse.self)
        await refresh()
    }
}
