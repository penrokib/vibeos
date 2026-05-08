import Foundation

struct MeshDevice: Codable, Identifiable, Hashable {
    let id: String
    let hostname: String
    let kind: String  // "mac" | "windows" | "linux"
    let online: Bool
    let lastSeen: Date
    let panes: [TmuxPane]?
}

struct TmuxPane: Codable, Identifiable, Hashable {
    let id: String
    let session: String
    let window: String
    let title: String?
    let lastSnippet: String?  // last few lines, for preview
    let updatedAt: Date
}

// MARK: - Mock fixtures

extension MeshDevice {
    static func mockDevices() -> [MeshDevice] {
        let now = Date()
        return [
            MeshDevice(
                id: "m3",
                hostname: "M3",
                kind: "mac",
                online: true,
                lastSeen: now,
                panes: nil
            ),
            MeshDevice(
                id: "m1",
                hostname: "M1",
                kind: "mac",
                online: true,
                lastSeen: now,
                panes: nil
            ),
            MeshDevice(
                id: "win-pc",
                hostname: "Win-PC",
                kind: "windows",
                online: false,
                lastSeen: now.addingTimeInterval(-7200),
                panes: nil
            ),
        ]
    }
}

extension TmuxPane {
    static func mockPanes(for deviceId: String) -> [TmuxPane] {
        let now = Date()
        switch deviceId {
        case "m3":
            return [
                TmuxPane(id: "m3:0:0", session: "rokibrain-cto", window: "0:main", title: "Claude Code", lastSnippet: "Cycle 23 implementation...\nBUILD SUCCEEDED", updatedAt: now.addingTimeInterval(-30)),
                TmuxPane(id: "m3:0:1", session: "rokibrain-devops", window: "0:deploy", title: "Deploy watch", lastSnippet: "Watching for changes...\npm2 status: OK", updatedAt: now.addingTimeInterval(-120)),
                TmuxPane(id: "m3:1:0", session: "rokibrain-pm", window: "0:plan", title: "Plan", lastSnippet: "Cycle 24 ready for queue", updatedAt: now.addingTimeInterval(-60)),
                TmuxPane(id: "m3:2:0", session: "rokibrain-qa", window: "0:test", title: "QA", lastSnippet: "All tests passing", updatedAt: now.addingTimeInterval(-90)),
                TmuxPane(id: "m3:3:0", session: "dewx-cto", window: "0:main", title: "Dewx CTO", lastSnippet: "Reviewing PR #71...", updatedAt: now.addingTimeInterval(-45)),
                TmuxPane(id: "m3:4:0", session: "ahn-cto", window: "0:main", title: "AHN CTO", lastSnippet: "Provider onboarding flow...", updatedAt: now.addingTimeInterval(-200)),
                TmuxPane(id: "m3:5:0", session: "kidiq-cto", window: "0:main", title: "KidIQ CTO", lastSnippet: "(idle)", updatedAt: now.addingTimeInterval(-600)),
                TmuxPane(id: "m3:6:0", session: "pe-cto", window: "0:main", title: "PE CTO", lastSnippet: "Outreach batch done. 12 sent.", updatedAt: now.addingTimeInterval(-150)),
                TmuxPane(id: "m3:7:0", session: "rokibrain-docs", window: "0:docs", title: "Docs", lastSnippet: "Updating architecture notes...", updatedAt: now.addingTimeInterval(-300)),
            ]
        case "m1":
            return [
                TmuxPane(id: "m1:0:0", session: "wa-bridge", window: "0:bridge", title: "WhatsApp Bridge", lastSnippet: "Connected. 0 pending messages.", updatedAt: now.addingTimeInterval(-10)),
                TmuxPane(id: "m1:1:0", session: "theo-test", window: "0:test", title: "Theo / Test runner", lastSnippet: "Running browser tests...\nPass: 14/14", updatedAt: now.addingTimeInterval(-180)),
                TmuxPane(id: "m1:2:0", session: "m1-worker-1", window: "0:worker", title: "Worker 1", lastSnippet: "Idle — waiting for dispatch", updatedAt: now.addingTimeInterval(-400)),
                TmuxPane(id: "m1:3:0", session: "m1-worker-2", window: "0:worker", title: "Worker 2", lastSnippet: "(idle)", updatedAt: now.addingTimeInterval(-800)),
            ]
        default:
            return []
        }
    }
}
