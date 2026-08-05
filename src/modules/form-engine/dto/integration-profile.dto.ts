import { IsOptional, IsString, MinLength } from 'class-validator';

export class IntegrationProfileDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  webhookUrl?: string | null;

  @IsOptional()
  @IsString()
  googleSheetUrl?: string | null;

  @IsOptional()
  googleSheetMeta?: Record<string, unknown> | null;
}
