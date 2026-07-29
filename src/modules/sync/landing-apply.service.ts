import { Injectable, Logger } from '@nestjs/common';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FileService } from '../deployment/file.service';
import { LandingSyncPayload } from './sync.types';

/** اعمال لندینگ روی Edge — مشترک بین AMQP consumer و HTTP pull */
@Injectable()
export class LandingApplyService {
  private readonly logger = new Logger(LandingApplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FileService,
  ) {}

  async alreadyProcessed(idempotencyKey: string): Promise<boolean> {
    const existing = await this.prisma.processedEvent.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      this.logger.log(`Duplicate sync ignored (idempotent): ${idempotencyKey}`);
      return true;
    }
    return false;
  }

  markProcessed(idempotencyKey: string) {
    return this.prisma.processedEvent.create({
      data: { idempotencyKey },
    });
  }

  async applyLanding(payload: LandingSyncPayload) {
    this.files.ensureDirs();
    const zipPath = join(
      this.files.tempRoot,
      'packages',
      `edge-${payload.slug}-${payload.version}.zip`,
    );
    const extractDir = join(
      this.files.tempRoot,
      'preview',
      `edge-${payload.slug}-${payload.version}`,
    );

    await this.downloadWithFallback(payload, zipPath);

    const checksum = this.files.checksumFile(zipPath);
    if (checksum !== payload.checksum) {
      throw new Error(
        `Checksum mismatch for ${payload.slug}: expected ${payload.checksum}, got ${checksum}`,
      );
    }

    this.files.extractZip(zipPath, extractDir);
    this.files.replaceLandingAtomic(payload.slug, extractDir);
    this.files.checksumDirMarker(payload.slug, payload.version, checksum);

    await this.prisma.landing.upsert({
      where: { slug: payload.slug },
      create: {
        slug: payload.slug,
        version: payload.version,
        checksum: payload.checksum,
        status: 'ACTIVE',
      },
      update: {
        version: payload.version,
        checksum: payload.checksum,
        status: 'ACTIVE',
      },
    });
  }

  private async downloadWithFallback(
    payload: LandingSyncPayload,
    dest: string,
  ) {
    const candidates = [payload.downloadUrl];
    if (
      payload.downloadUrlFallback &&
      payload.downloadUrlFallback !== payload.downloadUrl
    ) {
      candidates.push(payload.downloadUrlFallback);
    }
    const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (publicBase) {
      try {
        const path = new URL(payload.downloadUrl).pathname;
        const viaPublic = `${publicBase}${path}`;
        if (!candidates.includes(viaPublic)) candidates.push(viaPublic);
      } catch {
        /* ignore */
      }
    }

    let lastErr: unknown;
    for (const url of candidates) {
      try {
        this.logger.log(`Downloading landing package: ${url}`);
        await this.downloadFile(url, dest);
        return;
      } catch (err) {
        lastErr = err;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Download failed (${url}): ${message}`);
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Failed to download package for ${payload.slug}`);
  }

  private async downloadFile(url: string, dest: string) {
    const dir = join(dest, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 120_000,
      maxRedirects: 5,
      validateStatus: (s: number) => s >= 200 && s < 300,
    });
    await pipeline(response.data, createWriteStream(dest));
  }
}
