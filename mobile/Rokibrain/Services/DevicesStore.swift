import Foundation
import Observation

@Observable
@MainActor
final class DevicesStore {
    var devices: [MeshDevice] = []
    var selectedDeviceId: String?
    var panes: [TmuxPane] = []
    var loading: Bool = false
    var panesLoading: Bool = false
    var error: String?

    // MARK: - Refresh device list

    func refresh() async {
        loading = true
        error = nil
        defer { loading = false }

        do {
            let fetched = try await APIClient.shared.get("/mesh/devices", as: [MeshDevice].self)
            self.devices = fetched
            if selectedDeviceId == nil {
                selectedDeviceId = fetched.first(where: { $0.online })?.id
            }
            if let id = selectedDeviceId {
                await loadPanes(deviceId: id)
            }
        } catch let apiError as APIError {
            switch apiError {
            case .status(let code, _) where code == 404 || code == 501 || code == 405:
                applyMockDevices()
            case .transport:
                applyMockDevices()
            default:
                self.error = apiError.errorDescription ?? "Unknown error"
                if self.devices.isEmpty { applyMockDevices() }
            }
        } catch {
            self.error = error.localizedDescription
            if self.devices.isEmpty { applyMockDevices() }
        }
    }

    // MARK: - Load panes for a device

    func loadPanes(deviceId: String) async {
        panesLoading = true
        defer { panesLoading = false }

        do {
            let fetched = try await APIClient.shared.get("/mesh/devices/\(deviceId)/panes", as: [TmuxPane].self)
            self.panes = fetched
        } catch let apiError as APIError {
            switch apiError {
            case .status(let code, _) where code == 404 || code == 501 || code == 405:
                self.panes = TmuxPane.mockPanes(for: deviceId)
            case .transport:
                self.panes = TmuxPane.mockPanes(for: deviceId)
            default:
                self.panes = TmuxPane.mockPanes(for: deviceId)
            }
        } catch {
            self.panes = TmuxPane.mockPanes(for: deviceId)
        }
    }

    // MARK: - Select device

    func selectDevice(_ id: String) {
        selectedDeviceId = id
        Task { await loadPanes(deviceId: id) }
    }

    // MARK: - Helpers

    var selectedDevice: MeshDevice? {
        devices.first { $0.id == selectedDeviceId }
    }

    private func applyMockDevices() {
        self.devices = MeshDevice.mockDevices()
        if selectedDeviceId == nil {
            selectedDeviceId = devices.first(where: { $0.online })?.id
        }
        if let id = selectedDeviceId {
            self.panes = TmuxPane.mockPanes(for: id)
        }
    }
}
