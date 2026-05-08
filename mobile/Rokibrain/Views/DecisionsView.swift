import SwiftUI

struct DecisionsView: View {
    @StateObject private var vm = DecisionsViewModel()

    var body: some View {
        NavigationStack {
            List {
                if vm.decisions.isEmpty {
                    Text("No pending decisions")
                        .foregroundColor(.secondary)
                }
                ForEach(vm.decisions) { d in
                    NavigationLink {
                        DecisionDetailView(decision: d, vm: vm)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(d.title ?? d.id).font(.subheadline).bold()
                            HStack {
                                if let p = d.persona { Text(p) }
                                if let pr = d.priority { Text("• \(pr)") }
                            }
                            .font(.caption).foregroundColor(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Decisions")
            .refreshable { await vm.refresh() }
            .onAppear { Task { await vm.refresh() } }
        }
    }
}

struct DecisionDetailView: View {
    let decision: Decision
    @ObservedObject var vm: DecisionsViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section(header: Text("Decision")) {
                Text(decision.title ?? decision.id).font(.headline)
                if let desc = decision.description {
                    Text(desc).font(.body)
                }
            }
            Section(header: Text("Meta")) {
                if let p = decision.persona { LabeledContent("Persona", value: p) }
                if let pr = decision.priority { LabeledContent("Priority", value: pr) }
                if let s = decision.status { LabeledContent("Status", value: s) }
            }
            Section {
                Button("Approve") {
                    Task { await vm.approve(decision); dismiss() }
                }
                .buttonStyle(.borderedProminent)
                Button("Skip") {
                    Task { await vm.skip(decision); dismiss() }
                }
            }
        }
        .navigationTitle("Decision")
    }
}

@MainActor
final class DecisionsViewModel: ObservableObject {
    @Published var decisions: [Decision] = []

    func refresh() async {
        let result: [Decision]? = try? await APIClient.shared.get("/decisions?status=pending", as: [Decision].self)
        self.decisions = result ?? []
    }

    func approve(_ d: Decision) async {
        struct Body: Encodable { let status: String }
        try? await APIClient.shared.patch("/decisions/\(d.id)", body: Body(status: "approved"))
        await refresh()
    }

    func skip(_ d: Decision) async {
        struct Body: Encodable { let status: String }
        try? await APIClient.shared.patch("/decisions/\(d.id)", body: Body(status: "skipped"))
        await refresh()
    }
}
