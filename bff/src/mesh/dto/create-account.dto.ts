import {
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator";
import { MESH_PLATFORMS, type MeshPlatform } from "./platform.dto";

export class CreateAccountDto {
  @IsIn(MESH_PLATFORMS)
  platform!: MeshPlatform;

  @IsUUID()
  deviceId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  countryCc?: string;

  @IsOptional()
  @IsEmail()
  ownerEmail?: string;

  @IsOptional()
  @IsObject()
  policyJson?: Record<string, unknown>;
}
