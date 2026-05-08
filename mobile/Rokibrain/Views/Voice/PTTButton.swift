import SwiftUI
import AVFoundation

// MARK: - PTTButton (Cycle 25)
//
// Floating push-to-talk mic button. Hold to record; release to send.
// Available on Today, Inbox, and Drafts tabs only.
//
// Audio: uses AVAudioEngine (in-RAM, no disk write) per architecture hardwall #14.
// Encoding: converts PCM buffer to M4A/AAC via AVAssetWriter writing to a
//   NSTemporaryDirectory() file, then reads it into Data and immediately
//   deletes the file (max ~2s on disk).
//
// Hardwall: wake-word default OFF (D39) — PTT only.
// Hardwall: recorded audio NEVER auto-sends — always lands in Drafts.
// Hardwall: no third-party packages — AVFoundation + Foundation only.

struct PTTButton: View {

    @Bindable var store: VoiceComposeStore
    var draftsStore: DraftsStore

    // Default persona; tabs may override.
    var persona: String = "robert"

    @State private var recorder = AudioRecorder()
    @State private var isHolding: Bool = false
    @State private var audioLevel: Float = 0
    @State private var toast: String?
    @State private var levelTimer: Timer?

    // MARK: - Body

    var body: some View {
        ZStack {
            micButton
                .frame(width: 60, height: 60)
                .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)

            if let msg = toast {
                toastBanner(msg)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .offset(y: -80)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: toast)
        .onChange(of: store.state) { _, newState in
            handleStateChange(newState)
        }
    }

    // MARK: - Mic button

    private var micButton: some View {
        ZStack {
            // Pulsing ring while recording
            if isHolding {
                Circle()
                    .stroke(Color.indigo.opacity(0.4 + Double(audioLevel) * 0.5), lineWidth: 3)
                    .scaleEffect(1.0 + CGFloat(audioLevel) * 0.3)
                    .animation(.easeOut(duration: 0.1), value: audioLevel)
            }

            // Background circle
            Circle()
                .fill(buttonColor)
                .overlay(
                    Circle()
                        .stroke(Color.white.opacity(0.15), lineWidth: 1)
                )

            // Icon
            Image(systemName: iconName)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white)
        }
        .scaleEffect(isHolding ? 1.12 : 1.0)
        .animation(.spring(response: 0.2, dampingFraction: 0.7), value: isHolding)
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !isHolding else { return }
                    startRecording()
                }
                .onEnded { _ in
                    guard isHolding else { return }
                    stopAndSend()
                }
        )
        .disabled(store.state == .uploading)
        .accessibilityLabel(isHolding ? "Recording — release to send" : "Hold to record voice message")
    }

    // MARK: - State helpers

    private var buttonColor: Color {
        switch store.state {
        case .uploading, .processing: return .orange
        case .done:                   return .green
        case .failed:                 return .red
        default:                      return isHolding ? .indigo : Color(white: 0.22)
        }
    }

    private var iconName: String {
        switch store.state {
        case .uploading:   return "arrow.up.circle"
        case .processing:  return "ellipsis"
        case .done:        return "checkmark"
        case .failed:      return "exclamationmark"
        default:           return isHolding ? "waveform" : "mic.fill"
        }
    }

    // MARK: - Recording lifecycle

    private func startRecording() {
        guard recorder.startRecording() else {
            showToast("Microphone unavailable")
            return
        }
        isHolding = true
        audioLevel = 0

        // Sample audio level at ~15 fps while recording
        levelTimer = Timer.scheduledTimer(withTimeInterval: 0.067, repeats: true) { _ in
            Task { @MainActor in
                audioLevel = recorder.currentLevel
            }
        }
    }

    private func stopAndSend() {
        isHolding = false
        levelTimer?.invalidate()
        levelTimer = nil
        audioLevel = 0

        guard let audioData = recorder.stopRecording() else {
            showToast("No audio captured")
            return
        }
        guard audioData.count > 1024 else {
            showToast("Recording too short")
            return
        }

        showToast("Sending to \(persona)…")
        Task {
            await store.recordAndSend(
                audioData: audioData,
                account: nil,
                recipient: nil,
                persona: persona,
                draftsStore: draftsStore
            )
        }
    }

    // MARK: - State change handler

    private func handleStateChange(_ state: VoiceComposeStore.State) {
        switch state {
        case .done:
            showToast("Sent to \(persona) — draft will appear when ready")
            Task {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                store.reset()
                toast = nil
            }
        case .failed(let msg):
            showToast("Error: \(msg)")
            Task {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                store.reset()
                toast = nil
            }
        default:
            break
        }
    }

    // MARK: - Toast

    private func showToast(_ message: String) {
        toast = message
    }

    private func toastBanner(_ message: String) -> some View {
        Text(message)
            .font(.caption)
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.black.opacity(0.75), in: Capsule())
            .padding(.horizontal, 24)
            .multilineTextAlignment(.center)
    }
}

// MARK: - AudioRecorder (in-RAM via AVAudioEngine)
//
// Records PCM from the mic using AVAudioEngine (no disk write during capture).
// On stopRecording(), encodes to M4A/AAC via AVAssetWriter to a temp file,
// reads the bytes into Data, then immediately deletes the file.
// Total time on disk: ~1–2s.

@MainActor
final class AudioRecorder {

    private let engine = AVAudioEngine()
    private var pcmBuffers: [AVAudioPCMBuffer] = []
    private var isRunning = false

    /// Normalised 0…1 level for UI visualisation.
    var currentLevel: Float = 0

    // MARK: - Start

    func startRecording() -> Bool {
        guard !isRunning else { return true }

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
        } catch {
            return false
        }

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)

        pcmBuffers.removeAll()
        isRunning = true

        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.pcmBuffers.append(buffer)
            // RMS level for visualisation
            if let channelData = buffer.floatChannelData?[0] {
                let count = Int(buffer.frameLength)
                var sum: Float = 0
                for i in 0..<count { sum += channelData[i] * channelData[i] }
                let rms = sqrt(sum / Float(count))
                Task { @MainActor in self.currentLevel = min(rms * 8, 1.0) }
            }
        }

        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            isRunning = false
            return false
        }
        return true
    }

    // MARK: - Stop + encode

    /// Stops capture, encodes to M4A/AAC, returns Data (temp file deleted immediately).
    func stopRecording() -> Data? {
        guard isRunning else { return nil }
        isRunning = false
        currentLevel = 0

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        engine.stop()

        let buffers = pcmBuffers
        pcmBuffers.removeAll()

        guard !buffers.isEmpty else { return nil }

        // Write to temp file via AVAssetWriter then read back + delete
        let tmpURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("m4a")

        guard let writer = try? AVAssetWriter(outputURL: tmpURL, fileType: .m4a) else { return nil }

        let outputSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: min(format.channelCount, 2),
            AVEncoderBitRateKey: 64_000
        ]
        let input2 = AVAssetWriterInput(mediaType: .audio, outputSettings: outputSettings)
        input2.expectsMediaDataInRealTime = false
        writer.add(input2)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)

        var sampleTime = CMTime.zero
        for buffer in buffers {
            guard let pcm = buffer.floatChannelData else { continue }
            let frameCount = CMItemCount(buffer.frameLength)
            let blockSize = Int(buffer.frameLength) * MemoryLayout<Float>.size
            let channelCount = Int(buffer.format.channelCount)
            var blockBuffer: CMBlockBuffer?
            guard CMBlockBufferCreateWithMemoryBlock(
                allocator: nil,
                memoryBlock: nil,
                blockLength: blockSize * channelCount,
                blockAllocator: nil,
                customBlockSource: nil,
                offsetToData: 0,
                dataLength: blockSize * channelCount,
                flags: 0,
                blockBufferOut: &blockBuffer
            ) == noErr, let bb = blockBuffer else { continue }

            for ch in 0..<channelCount {
                _ = CMBlockBufferReplaceDataBytes(
                    with: pcm[ch],
                    blockBuffer: bb,
                    offsetIntoDestination: ch * blockSize,
                    dataLength: blockSize
                )
            }

            var sampleBuffer: CMSampleBuffer?
            var asbd = format.streamDescription.pointee
            var formatDesc: CMAudioFormatDescription?
            CMAudioFormatDescriptionCreate(
                allocator: nil,
                asbd: &asbd,
                layoutSize: 0,
                layout: nil,
                magicCookieSize: 0,
                magicCookie: nil,
                extensions: nil,
                formatDescriptionOut: &formatDesc
            )
            guard let fd = formatDesc else { continue }
            let duration = CMTimeMake(value: Int64(frameCount), timescale: Int32(format.sampleRate))
            CMSampleBufferCreate(
                allocator: nil,
                dataBuffer: bb,
                dataReady: true,
                makeDataReadyCallback: nil,
                refcon: nil,
                formatDescription: fd,
                sampleCount: frameCount,
                sampleTimingEntryCount: 0,
                sampleTimingArray: nil,
                sampleSizeEntryCount: 0,
                sampleSizeArray: nil,
                sampleBufferOut: &sampleBuffer
            )
            if let sb = sampleBuffer {
                while !input2.isReadyForMoreMediaData {
                    Thread.sleep(forTimeInterval: 0.005)
                }
                input2.append(sb)
            }
            sampleTime = CMTimeAdd(sampleTime, duration)
        }

        input2.markAsFinished()

        var result: Data?
        let sem = DispatchSemaphore(value: 0)
        writer.finishWriting {
            result = try? Data(contentsOf: tmpURL)
            try? FileManager.default.removeItem(at: tmpURL)   // delete immediately
            sem.signal()
        }
        sem.wait()
        return result
    }
}
