import { IsArray, IsOptional, IsString, MinLength } from 'class-validator';

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
}

export class SubmitFormDto {
  // payload آزاد؛ اعتبارسنجی سمت سرویس انجام می‌شه
  [key: string]: unknown;
}
