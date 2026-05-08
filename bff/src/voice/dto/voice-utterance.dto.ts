import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";

/**
 * Voice grammar — paralysis-first, 14-word kernel.
 * See protocols/voice-grammar.md for the full spec. The cap is enforced
 * server-side: anything longer than 14 words is rejected with 422 because
 * Roki's voice budget cannot afford long utterances.
 */
export const VOICE_NOISE_MARKERS = ["pop", "hiss", "click", "shh"] as const;
export type VoiceNoiseMarker = (typeof VOICE_NOISE_MARKERS)[number];

export const VOICE_SOURCES = ["ios", "mac", "watch"] as const;
export type VoiceSource = (typeof VOICE_SOURCES)[number];

/** Hard cap from voice-grammar.md — 14 words is the kernel ceiling. */
export const VOICE_KERNEL_MAX_WORDS = 14;

/**
 * `POST /voice/utterance` body. Origin: iOS app, Mac companion, or Apple Watch.
 *
 * Class-C bug-prevention:
 *   - Length-capped to keep log volume bounded.
 *   - Word count enforced in the controller (class-validator can't count words).
 *   - Source allowlist closed — no free-text sources.
 *   - audioUrl optional + capped — prevents log abuse.
 */
export class VoiceUtteranceDto {
  /** The 14-word kernel utterance. Whitespace-normalized server-side. */
  @IsString()
  @MaxLength(500)
  utterance!: string;

  /** Optional sub-100ms abort/control noise. */
  @IsOptional()
  @IsIn(VOICE_NOISE_MARKERS)
  noise_marker?: VoiceNoiseMarker;

  @IsIn(VOICE_SOURCES)
  source!: VoiceSource;

  /** Client clock — Unix epoch ms. Server records its own ts too. */
  @IsInt()
  @Min(0)
  timestamp!: number;

  /** Optional pre-uploaded S3 audio URL for re-transcription / audit. */
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  audio_url?: string;
}
