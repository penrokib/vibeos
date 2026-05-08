// =============================================================================
// rokibrain.app — Quickbar (M11)
// -----------------------------------------------------------------------------
// Voice-input overlay. Activated by global ⌥-Space hotkey (registered in main).
//
// Interaction flow:
//   mousedown on mic button  → start MediaRecorder (audio only, RAM buffer)
//   mouseup / mouseleave     → stop recording → IPC VOICE_RECORD_STOP_AND_TRANSCRIBE
//   transcript received      → display inline; "Send" button posts to BFF
//   Escape / blur            → window.rokibrain.quickbar.toggle() (main hides)
//
// Hardwall §14: audio bytes stay in the renderer RAM as a Blob/ArrayBuffer and
// are sent via IPC as Uint8Array. Main pipes them to whisper.cpp via stdin.
// NEVER use URL.createObjectURL + write to disk.
//
// Privacy banner: always visible. No audio ever hits disk.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceTranscriptResult } from '@shared/ipc-contracts';

type Phase = 'idle' | 'recording' | 'transcribing' | 'done' | 'error';

export function Quickbar(): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState<string>('');
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [pushed, setPushed] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const animFrameRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  // Escape → hide window
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        void window.rokibrain.quickbar.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Audio level animation loop
  const startLevelLoop = useCallback((analyser: AnalyserNode): void => {
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = (): void => {
      analyser.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      setAudioLevel(avg / 128); // 0..1 (roughly)
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
  }, []);

  const stopLevelLoop = useCallback((): void => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    setAudioLevel(0);
  }, []);

  const startRecording = useCallback(async (): Promise<void> => {
    if (phase !== 'idle' && phase !== 'done' && phase !== 'error') return;

    setPhase('recording');
    setTranscript('');
    setError(null);
    setPushed(false);
    chunksRef.current = [];
    sessionIdRef.current = crypto.randomUUID();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

      // Audio level meter via AnalyserNode
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      startLevelLoop(analyser);

      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e): void => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.start(100); // 100ms chunks → low latency
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Mic access denied: ${msg}`);
      setPhase('error');
      stopLevelLoop();
    }
  }, [phase, startLevelLoop, stopLevelLoop]);

  const stopRecording = useCallback(async (): Promise<void> => {
    if (phase !== 'recording') return;
    setPhase('transcribing');
    stopLevelLoop();

    const mr = mediaRecorderRef.current;
    if (!mr) {
      setPhase('error');
      setError('MediaRecorder not initialised');
      return;
    }

    // Collect remaining chunks and stop stream
    await new Promise<void>((resolve) => {
      mr.onstop = (): void => resolve();
      mr.stop();
    });

    // Stop mic tracks (release hardware)
    mr.stream.getTracks().forEach((t) => t.stop());
    mediaRecorderRef.current = null;

    // Merge chunks into a single Blob → ArrayBuffer → Uint8Array (RAM only)
    const blob = new Blob(chunksRef.current, { type: 'audio/webm;codecs=opus' });
    chunksRef.current = [];
    const arrayBuffer = await blob.arrayBuffer();
    const audioData = new Uint8Array(arrayBuffer);

    try {
      const result: VoiceTranscriptResult =
        await window.rokibrain.quickbar.recordStopAndTranscribe({
          sessionId: sessionIdRef.current,
          audioData,
        });

      setTranscript(result.text);
      setPhase('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Transcription failed: ${msg}`);
      setPhase('error');
    }
  }, [phase, stopLevelLoop]);

  const handleMicDown = useCallback((): void => {
    void startRecording();
  }, [startRecording]);

  const handleMicUp = useCallback((): void => {
    void stopRecording();
  }, [stopRecording]);

  const handleSend = useCallback(async (): Promise<void> => {
    if (!transcript) return;
    const result = await window.rokibrain.quickbar.pushToBff({
      text: transcript,
      capturedAt: new Date().toISOString(),
    });
    if (result.success) {
      setPushed(true);
      // Auto-hide after successful send
      setTimeout(() => {
        void window.rokibrain.quickbar.toggle();
      }, 800);
    } else {
      setError(`BFF push failed: ${result.error ?? 'unknown error'}`);
    }
  }, [transcript]);

  const handleDismiss = useCallback((): void => {
    void window.rokibrain.quickbar.toggle();
  }, []);

  // Mic button radius driven by audio level
  const micScale = phase === 'recording' ? 1 + audioLevel * 0.3 : 1;

  return (
    <div
      style={{
        width: '600px',
        height: '120px',
        background: 'rgba(15,15,20,0.92)',
        borderRadius: '16px',
        border: '1px solid rgba(255,255,255,0.08)',
        backdropFilter: 'blur(20px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 20px',
        boxSizing: 'border-box',
        color: '#e5e7eb',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        userSelect: 'none',
        // Electron-specific drag region (not in React CSSProperties typedefs)
        ...({ WebkitAppRegion: 'drag' } as Record<string, string>),
      }}
    >
      {/* Top row: mic button + status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          width: '100%',
          ...({ WebkitAppRegion: 'no-drag' } as Record<string, string>),
        }}
      >
        {/* Mic button */}
        <button
          onMouseDown={handleMicDown}
          onMouseUp={handleMicUp}
          onMouseLeave={phase === 'recording' ? handleMicUp : undefined}
          disabled={phase === 'transcribing'}
          aria-label={phase === 'recording' ? 'Recording — release to transcribe' : 'Hold to record'}
          style={{
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            background: phase === 'recording'
              ? `rgba(239,68,68,${0.7 + audioLevel * 0.3})`
              : 'rgba(99,102,241,0.8)',
            border: 'none',
            cursor: phase === 'transcribing' ? 'wait' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '20px',
            transform: `scale(${micScale})`,
            transition: 'transform 0.05s, background 0.1s',
            flexShrink: 0,
          }}
        >
          {phase === 'transcribing' ? '⏳' : phase === 'recording' ? '🔴' : '🎙️'}
        </button>

        {/* Status / transcript area */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {phase === 'idle' && (
            <span style={{ color: 'rgba(156,163,175,1)', fontSize: '13px' }}>
              Hold mic to speak
            </span>
          )}
          {phase === 'recording' && (
            <span style={{ color: '#fca5a5', fontSize: '13px' }}>
              Recording… release to transcribe
            </span>
          )}
          {phase === 'transcribing' && (
            <span style={{ color: 'rgba(156,163,175,1)', fontSize: '13px' }}>
              Transcribing…
            </span>
          )}
          {phase === 'done' && (
            <span
              style={{
                fontSize: '13px',
                color: '#e5e7eb',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'block',
              }}
              title={transcript}
            >
              {pushed ? '✓ Sent to persona' : transcript || '(empty)'}
            </span>
          )}
          {phase === 'error' && (
            <span style={{ color: '#f87171', fontSize: '12px' }}>
              {error}
            </span>
          )}
        </div>

        {/* Action buttons */}
        {phase === 'done' && !pushed && (
          <button
            onClick={(): void => { void handleSend(); }}
            style={{
              background: 'rgba(99,102,241,0.8)',
              border: 'none',
              borderRadius: '8px',
              color: 'white',
              fontSize: '12px',
              padding: '4px 10px',
              cursor: 'pointer',
            }}
          >
            Send →
          </button>
        )}

        {/* Dismiss */}
        <button
          onClick={handleDismiss}
          aria-label="Close quickbar"
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(156,163,175,0.6)',
            fontSize: '14px',
            cursor: 'pointer',
            padding: '4px',
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      </div>

      {/* Privacy banner — always visible */}
      <div
        style={{
          fontSize: '10px',
          color: 'rgba(107,114,128,0.8)',
          alignSelf: 'flex-start',
        }}
      >
        🔒 Audio stays in RAM. Never written to disk.
      </div>
    </div>
  );
}
