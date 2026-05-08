import { IsNotEmpty, IsString, MaxLength, MinLength } from "class-validator";

/**
 * Body for POST /mesh/devices/:deviceId/panes/:paneId/keystroke
 *
 * keys is the raw keystroke payload (string or stringified array).
 * Max 2 KB: sufficient for any realistic single-send; prevents DoS blobs.
 */
export class KeystrokeDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(2048)
  keys!: string;
}

/** Response shape (mirrored in iOS SendKeystrokesResult). */
export interface KeystrokeResponseDto {
  accepted: boolean;
  refusedReason?: string;
}
