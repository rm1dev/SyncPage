import { Injectable, Logger } from '@nestjs/common';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'fs';
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

  /**
   * دانلود resumable با Range —
   * مسیر بین‌الملل انتقال‌های طولانی رو وسط راه قطع می‌کنه (aborted)؛
   * به‌جای شروع از صفر، از همون بایتی که رسیدیم ادامه می‌دیم
   */
  private async downloadFile(url: string, dest: string) {
    const dir = join(dest, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const maxResumes = parseInt(process.env.SYNC_DOWNLOAD_RESUMES || '30', 10);
    // فایل ناقص از دور قبلِ همین URL به درد نمی‌خوره — تمیز شروع کن
    rmSync(dest, { force: true });

    let downloaded = 0;
    let total: number | null = null;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= maxResumes; attempt++) {
      if (attempt > 0) {
        this.logger.warn(
          `Resuming download from byte ${downloaded}${total ? `/${total}` : ''} (attempt ${attempt}): ${url}`,
        );
        await new Promise((r) => setTimeout(r, 1500));
      }

      try {
        const headers: Record<string, string> = {};
        if (downloaded > 0) headers.Range = `bytes=${downloaded}-`;

        const response = await axios.get(url, {
          responseType: 'stream',
          timeout: 120_000,
          maxRedirects: 5,
          headers,
          validateStatus: (s: number) =>
            downloaded > 0 ? s === 206 || s === 200 : s >= 200 && s < 300,
        });

        // سرور Range رو نشناخت و کل فایل رو از اول فرستاد
        if (downloaded > 0 && response.status === 200) {
          downloaded = 0;
          rmSync(dest, { force: true });
        }

        if (total === null) {
          const contentRange = String(
            response.headers['content-range'] || '',
          );
          const m = contentRange.match(/\/(\d+)\s*$/);
          if (m) {
            total = parseInt(m[1], 10);
          } else {
            const cl = parseInt(
              String(response.headers['content-length'] || ''),
              10,
            );
            if (Number.isFinite(cl) && cl > 0) total = downloaded + cl;
          }
        }

        try {
          await pipeline(
            response.data,
            createWriteStream(dest, {
              flags: downloaded > 0 ? 'a' : 'w',
            }),
          );
        } finally {
          downloaded = existsSync(dest) ? statSync(dest).size : 0;
        }

        // بدون content-length یعنی سرور سایز نگفته — همین که pipeline تموم شد کافیه
        if (total === null || downloaded >= total) {
          if (attempt > 0) {
            this.logger.log(
              `Download completed after ${attempt} resume(s): ${url} (${downloaded} bytes)`,
            );
          }
          return;
        }

        // استریم بدون خطا بسته شد ولی فایل کامل نیست — ادامه بده
        lastErr = new Error(
          `Incomplete download: ${downloaded}/${total} bytes`,
        );
      } catch (err) {
        lastErr = err;
        downloaded = existsSync(dest) ? statSync(dest).size : 0;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Download chunk failed at byte ${downloaded}${total ? `/${total}` : ''}: ${message}`,
        );
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Download failed after ${maxResumes} resumes: ${url}`);
  }
}
