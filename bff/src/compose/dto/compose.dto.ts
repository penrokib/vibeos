import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export const COMPOSE_MODES = ["work", "personal"] as const;
export type ComposeMode = (typeof COMPOSE_MODES)[number];

/** Body for POST /compose/text */
export class ComposeTextDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  account!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  recipient!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  persona!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  rawText!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  targetLanguage?: string;

  @IsEnum(COMPOSE_MODES)
  mode!: ComposeMode;
}

/** Body for POST /compose/voice */
export class ComposeVoiceDto {
  /** Base64-encoded audio (e.g. WebM/Opus from iOS). Transcription happens on Mac. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(1_000_000) // ~750 KB raw; audio is very short
  audioBase64!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  account!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  recipient!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  persona!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  targetLanguage?: string;

  @IsEnum(COMPOSE_MODES)
  mode!: ComposeMode;
}
