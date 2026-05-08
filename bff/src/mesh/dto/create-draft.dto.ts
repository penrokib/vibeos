import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class CreateDraftDto {
  /** Account external_id OR account UUID — service resolves both. */
  @IsString()
  @MaxLength(200)
  account!: string;

  /** Recipient external_id on the platform (phone, handle, email). */
  @IsString()
  @MaxLength(500)
  to!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  personaSlug?: string;

  /**
   * Optional pre-computed similarity score (0..1) from the persona that
   * generated the draft. Service still applies the §3 0.85 hardwall — the
   * value here is purely for telemetry / UI sort.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  similarityScore?: number;
}

export class ApproveDraftDto {
  /** §10 hardwall: explicit approver email — never auto-approve. */
  @IsString()
  @MaxLength(320)
  approverEmail!: string;
}

export class RejectDraftDto {
  @IsString()
  @MaxLength(320)
  rejectorEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  reason?: string;
}
