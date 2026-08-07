import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateFormDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsString()
  @MinLength(1)
  key!: string;

  @IsString()
  @MinLength(1)
  slug!: string;

  @IsArray()
  body!: Record<string, unknown>[];

  @IsOptional()
  @IsString()
  webhookUrl?: string | null;

  @IsOptional()
  @IsString()
  googleSheetUrl?: string | null;

  @IsOptional()
  googleSheetMeta?: Record<string, unknown> | null;

  @IsOptional()
  @IsBoolean()
  otpEnabled?: boolean;

  @IsOptional()
  @IsString()
  otpField?: string | null;

  @IsOptional()
  @IsString()
  otpTemplate?: string | null;

  @IsOptional()
  @IsInt()
  @Min(4)
  @Max(10)
  otpLength?: number;

  @IsOptional()
  @IsString()
  profileId?: string | null;
}

export class UpdateFormDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  slug?: string;

  @IsOptional()
  @IsArray()
  body?: Record<string, unknown>[];

  @IsOptional()
  @IsString()
  webhookUrl?: string | null;

  @IsOptional()
  @IsString()
  googleSheetUrl?: string | null;

  @IsOptional()
  googleSheetMeta?: Record<string, unknown> | null;

  @IsOptional()
  @IsBoolean()
  otpEnabled?: boolean;

  @IsOptional()
  @IsString()
  otpField?: string | null;

  @IsOptional()
  @IsString()
  otpTemplate?: string | null;

  @IsOptional()
  @IsInt()
  @Min(4)
  @Max(10)
  otpLength?: number;

  @IsOptional()
  @IsString()
  profileId?: string | null;
}

export class SubmitFormDto {
  // payload آزاد؛ اعتبارسنجی سمت سرویس انجام می‌شه
  [key: string]: unknown;
}
