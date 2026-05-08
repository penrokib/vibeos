import Foundation
import Observation

// MARK: - DevicesStore

@Observable
@MainActor
final class DevicesStore {
    var devices: [MeshDevice] = []
    var selectedDeviceId: String?
    var loading: Bool = false
    var error: String?

    // MARK: - Derived

    var selectedDevice: MeshDevice? {
        guard let id = selectedDeviceId else { return devices.first }
        return devices.first { $0.id == id }
    }

    var displayedPanes: [TmuxPane] {
        selectedDevice?.panes ?? []
    }

    // MARK: - Refresh all devices

    func refresh() async {
        loading = true
        error = nil
        defer { loading = false }

        do {
            let fetched = try await APIClient.shared.get("/mesh/devices", as: [MeshDevice].self)
            self.devices = fetched
            if selectedDeviceId == nil {
                selectedDeviceId = fetched.first?.id
            }
        } catch let apiError as APIError {
            switch apiError {
            case .status(let code, _) where [404, 501, 405].contains(code):
                applyMock()
            case .transport:
                applyMock()
            default:
                self.error = apiError.errorDescription ?? "Unknown error"
                if self.devices.isEmpty { applyMock() }
            }
        } catch {
            self.error = error.localizedDescription
            if self.devices.isEmpty { applyMock() }
        }
    }

    // MARK: - Refresh panes for a single device

    func loadPanes(deviceId: String) async {
        do {
            let fetched = try await APIClient.shared.get(
                "/mesh/devices/\(deviceId)/panes",
                as: [TmuxPane].self
            )
            devices = devices.map { device in
                guard device.id == deviceId else { return device }
                return MeshDevice(
                    id: device.id,
                    hostname: device.hostname,
                    kind: device.kind,
                    online: device.online,
                    lastSeen: device.lastSeen,
                    panes: fetched
                )
            }
        } catch let apiError as APIError {
            switch apiError {
            case .status(let code, _) where [404, 501, 405].contains(code):
                break  // keep existing panes from mock
            case .transport:
                break
            default:
                self.error = apiError.errorDescription ?? "Unknown error"
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Private

    private func applyMock() {
        self.devices = MeshDevice.mock
        if selectedDeviceId == nil {
            selectedDeviceId = MeshDevice.mock.first?.id
        }
    }
}
