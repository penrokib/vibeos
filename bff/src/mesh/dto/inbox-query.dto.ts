import { Type } from "class-transformer";
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class InboxQueryDto {
  @IsString()
  @MaxLength(200)
  account!: string;

  @IsOptional()
  @IsDateString()
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class ProfileQueryDto {
  @IsString()
  @MaxLength(200)
  account!: string;
}

export class ContactsQueryDto {
  @IsString()
  @MaxLength(200)
  account!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class CountersQueryDto {
  @IsString()
  @MaxLength(200)
  account!: string;

  @IsOptional()
  @IsDateString()
  since?: string;
}
