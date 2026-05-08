import Foundation

// MARK: - MeshDevice

struct MeshDevice: Codable, Identifiable, Hashable {
    let id: String
    let hostname: String
    let kind: String   // "mac" | "windows" | "linux"
    let online: Bool
    let lastSeen: Date
    let panes: [TmuxPane]?
}

// MARK: - TmuxPane

struct TmuxPane: Codable, Identifiable, Hashable {
    let id: String
    let session: String
    let window: String
    let title: String?
    let lastSnippet: String?
    let updatedAt: Date
}

// MARK: - Mock data

extension MeshDevice {
    static let mock: [MeshDevice] = {
        let now = Date()
        let m3Panes: [TmuxPane] = [
            TmuxPane(id: "p1", session: "orchestrator", window: "loop-a", title: "Loop A — Monitor", lastSnippet: "cycle 23 ✓  devices-tab build succeeded", updatedAt: now.addingTimeInterval(-30)),
            TmuxPane(id: "p2", session: "orchestrator", window: "loop-b", title: "Loop B — Healer", lastSnippet: "no drift detected in last 60 min", updatedAt: now.addingTimeInterval(-90)),
            TmuxPane(id: "p3", session: "dewx",          window: "backend", title: "NestJS API", lastSnippet: "[Nest] LOG [Bootstrap] App running on port 4000", updatedAt: now.addingTimeInterval(-120)),
            TmuxPane(id: "p4", session: "dewx",          window: "frontend", title: "Next.js Zone", lastSnippet: "✓ Compiled /dashboard in 3.4s", updatedAt: now.addingTimeInterval(-180)),
            TmuxPane(id: "p5", session: "ahn",            window: "api", title: "AHN API", lastSnippet: "[Bootstrap] running on port 3000", updatedAt: now.addingTimeInterval(-200)),
            TmuxPane(id: "p6", session: "ahn",            window: "web", title: "AHN Web", lastSnippet: "ready - started server on 0.0.0.0:3001", updatedAt: now.addingTimeInterval(-210)),
            TmuxPane(id: "p7", session: "misc",           window: "wa-bridge", title: "WA Bridge", lastSnippet: "WhatsApp MCP bridge listening :3999", updatedAt: now.addingTimeInterval(-60)),
            TmuxPane(id: "p8", session: "misc",           window: "litellm", title: "LiteLLM Proxy", lastSnippet: "LiteLLM Proxy started on port 4100", updatedAt: now.addingTimeInterval(-300)),
            TmuxPane(id: "p9", session: "misc",           window: "git-ops", title: "Git Ops", lastSnippet: "$ git status\nOn branch main", updatedAt: now.addingTimeInterval(-15)),
        ]
        let m1Panes: [TmuxPane] = [
            TmuxPane(id: "p10", session: "worker-1", window: "claude", title: "Claude Worker 1", lastSnippet: "Running cycle 23 devices tab...", updatedAt: now.addingTimeInterval(-45)),
            TmuxPane(id: "p11", session: "worker-2", window: "claude", title: "Claude Worker 2", lastSnippet: "Idle — awaiting dispatch", updatedAt: now.addingTimeInterval(-600)),
            TmuxPane(id: "p12", session: "worker-3", window: "build", title: "Build Gate", lastSnippet: "xcodebuild: BUILD SUCCEEDED", updatedAt: now.addingTimeInterval(-120)),
            TmuxPane(id: "p13", session: "worker-3", window: "test",  title: "Type Check", lastSnippet: "yarn type-check ✓  0 errors", updatedAt: now.addingTimeInterval(-130)),
        ]
        return [
            MeshDevice(id: "m3", hostname: "M3-MacBook-Pro", kind: "mac",     online: true,  lastSeen: now,                              panes: m3Panes),
            MeshDevice(id: "m1", hostname: "M1-Mac-Mini",    kind: "mac",     online: true,  lastSeen: now.addingTimeInterval(-5),        panes: m1Panes),
            MeshDevice(id: "pc", hostname: "Win-PC",         kind: "windows", online: false, lastSeen: now.addingTimeInterval(-7200),     panes: []),
        ]
    }()
}
