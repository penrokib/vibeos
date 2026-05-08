import Foundation

/// URLSessionWebSocketTask wrapper with auto-reconnect.
final class WSClient: NSObject, URLSessionWebSocketDelegate {
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private let url: URL
    private var shouldRun = false
    private var reconnectAttempts = 0

    var onText: ((String) -> Void)?
    var onData: ((Data) -> Void)?
    var onState: ((Bool) -> Void)?

    init(url: URL) {
        self.url = url
        super.init()
        self.session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func connect() {
        shouldRun = true
        openSocket()
    }

    func disconnect() {
        shouldRun = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        onState?(false)
    }

    private func openSocket() {
        guard shouldRun else { return }
        task = session.webSocketTask(with: url)
        task?.resume()
        readNext()
    }

    private func readNext() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.scheduleReconnect()
            case .success(let msg):
                switch msg {
                case .string(let s): self.onText?(s)
                case .data(let d): self.onData?(d)
                @unknown default: break
                }
                self.readNext()
            }
        }
    }

    private func scheduleReconnect() {
        guard shouldRun else { return }
        onState?(false)
        reconnectAttempts += 1
        let delay = min(30.0, pow(2.0, Double(min(reconnectAttempts, 5))))
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.openSocket()
        }
    }

    func sendText(_ s: String) {
        task?.send(.string(s)) { _ in }
    }

    func sendJSON(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return }
        sendText(s)
    }

    // MARK: URLSessionWebSocketDelegate
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        reconnectAttempts = 0
        onState?(true)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        scheduleReconnect()
    }
}
