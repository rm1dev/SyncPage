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

export interface ActiveDownload {
  slug: string;
  version: number;
  currentSpeed: string;
  speedBps: number;
  downloadedBytes: number;
  totalBytes: number | null;
  progress: number;
  retries: number;
  etaSeconds: number | null;
  sourceUrl: string;
  startedAt: string;
}

export interface DownloadHistory {
  slug: string;
  durationSec: number;
  avgSpeed: string;
  status: 'SUCCESS' | 'FAILED';
  timestamp: string;
  error?: string;
}

/** اعمال لندینگ روی Edge — مشترک بین AMQP consumer و HTTP pull */
@Injectable()
export class LandingApplyService {
  private readonly logger = new Logger(LandingApplyService.name);
  
  private activeDownload: ActiveDownload | null = null;
  private downloadHistory: DownloadHistory[] = [];
  private readonly maxHistory = 10;

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

  getActiveDownload(): ActiveDownload | null {
    return this.activeDownload;
  }

  getDownloadHistory(): DownloadHistory[] {
    return this.downloadHistory;
  }

  private addHistory(entry: DownloadHistory) {
    this.downloadHistory.unshift(entry);
    if (this.downloadHistory.length > this.maxHistory) {
      this.downloadHistory.pop();
    }
  }

  private formatSpeed(bps: number): string {
    if (bps < 1024) return `${bps} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
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
    const startTime = Date.now();
    
    for (const url of candidates) {
      try {
        this.logger.log(`Downloading landing package: ${url}`);
        await this.downloadFile(url, dest, payload);
        
        const durationSec = (Date.now() - startTime) / 1000;
        const size = existsSync(dest) ? statSync(dest).size : 0;
        
        this.addHistory({
          slug: payload.slug,
          durationSec,
          avgSpeed: this.formatSpeed(size / (durationSec || 1)),
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
        });
        
        return;
      } catch (err) {
        lastErr = err;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Download failed (${url}): ${message}`);
      }
    }
    
    this.addHistory({
      slug: payload.slug,
      durationSec: (Date.now() - startTime) / 1000,
      avgSpeed: '0 B/s',
      status: 'FAILED',
      timestamp: new Date().toISOString(),
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Failed to download package for ${payload.slug}`);
  }

  /**
   * دانلود resumable با Range —
   * مسیر بین‌الملل انتقال‌های طولانی رو وسط راه قطع می‌کنه (aborted)؛
   * به‌جای شروع از صفر، از همون بایتی که رسیدیم ادامه می‌دیم
   */
  private async downloadFile(url: string, dest: string, payload: LandingSyncPayload) {
    const dir = join(dest, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const maxResumes = parseInt(process.env.SYNC_DOWNLOAD_RESUMES || '30', 10);
    // فایل ناقص از دور قبلِ همین URL به درد نمی‌خوره — تمیز شروع کن
    rmSync(dest, { force: true });

    let downloaded = 0;
    let total: number | null = null;
    let lastErr: unknown = null;
    
    this.activeDownload = {
      slug: payload.slug,
      version: payload.version,
      currentSpeed: '0 B/s',
      speedBps: 0,
      downloadedBytes: 0,
      totalBytes: null,
      progress: 0,
      retries: 0,
      etaSeconds: null,
      sourceUrl: url,
      startedAt: new Date().toISOString(),
    };

    try {
      for (let attempt = 0; attempt <= maxResumes; attempt++) {
        if (attempt > 0) {
          this.logger.warn(
            `Resuming download from byte ${downloaded}${total ? `/${total}` : ''} (attempt ${attempt}): ${url}`,
          );
          if (this.activeDownload) this.activeDownload.retries = attempt;
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
              downloaded > 0 ? (s === 206 || s === 200 || s === 416) : (s >= 200 && s < 300),
          });

          if (response.status === 416) {
            // Range Not Satisfiable: دانلود از قبل کامل شده است.
            if (attempt > 0) {
              this.logger.log(`Download considered complete (416 Range Not Satisfiable): ${url} (${downloaded} bytes)`);
            }
            return;
          }

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
            if (this.activeDownload) this.activeDownload.totalBytes = total;
          }

          try {
            let lastSpeedCheck = Date.now();
            let bytesSinceLastCheck = 0;
            
            response.data.on('data', (chunk: Buffer) => {
              const now = Date.now();
              downloaded += chunk.length;
              bytesSinceLastCheck += chunk.length;
              
              if (this.activeDownload) {
                this.activeDownload.downloadedBytes = downloaded;
                if (total) {
                  this.activeDownload.progress = Math.round((downloaded / total) * 1000) / 10;
                }
                
                // بروزرسانی سرعت هر ۱ ثانیه
                const timeDiff = now - lastSpeedCheck;
                if (timeDiff >= 1000) {
                  const speedBps = (bytesSinceLastCheck / timeDiff) * 1000;
                  this.activeDownload.speedBps = speedBps;
                  this.activeDownload.currentSpeed = this.formatSpeed(speedBps);
                  
                  if (total && speedBps > 0) {
                    this.activeDownload.etaSeconds = Math.round((total - downloaded) / speedBps);
                  }
                  
                  lastSpeedCheck = now;
                  bytesSinceLastCheck = 0;
                }
              }
            });

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
    } finally {
      this.activeDownload = null;
    }
  }

  async deleteLanding(payload: { slug: string; idempotencyKey: string }) {
    this.logger.log(`Deleting landing ${payload.slug} from edge...`);
    
    // ۱. حذف از دیتابیس لوکال
    const existing = await this.prisma.landing.findUnique({
      where: { slug: payload.slug },
    });
    if (existing) {
      await this.prisma.landing.delete({ where: { slug: payload.slug } });
    }

    // ۲. حذف از فایل‌سیستم
    const staticDir = join(this.files.staticRoot, payload.slug);
    if (existsSync(staticDir)) {
      rmSync(staticDir, { recursive: true, force: true });
    }
    const packageZip = join(this.files.tempRoot, 'packages', `${payload.slug}.zip`);
    if (existsSync(packageZip)) {
      rmSync(packageZip, { force: true });
    }
  }
}
