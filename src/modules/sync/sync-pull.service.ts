import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isEdge } from '../../config/role';
import { LandingApplyService } from './landing-apply.service';
import { LandingSyncPayload } from './sync.types';

type ManifestItem = {
  slug: string;
  version: number;
  checksum: string;
  idempotencyKey: string;
  downloadUrl: string;
  downloadUrlFallback?: string;
};

type FormManifestItem = {
  id: string;
  title: string;
  category?: string | null;
  key: string;
  slug: string;
  body: unknown;
  updatedAt: string;
  idempotencyKey: string;
  webhookUrl?: string | null;
  googleSheetUrl?: string | null;
  googleSheetMeta?: unknown;
  otpEnabled?: boolean | null;
  otpField?: string | null;
  otpTemplate?: string | null;
  otpLength?: number | null;
  sendUtmToWebhook?: boolean | null;
  sendUtmToSheet?: boolean | null;
};

type SettingManifestItem = {
  key: string;
  value: string;
};

type Manifest = {
  landings?: ManifestItem[];
  forms?: FormManifestItem[];
  settings?: SettingManifestItem[];
  deletedLandings?: string[];
  deletedForms?: string[];
  deletedSettings?: string[];
};

/**
 * وقتی AMQP از Edge ریموت به Master نمی‌رسه (ETIMEDOUT)،
 * از HTTP manifest لندینگ‌ها رو می‌کشه — مسیر پایدار برای sync
 */
@Injectable()
export class SyncPullService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncPullService.name);
  private fastTimer: NodeJS.Timeout | null = null;
  private fullTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastEtag: string | null = null;
  private lastSinceDate: Date | null = null;
  private syncStats = {
    lastSuccess: null as Date | null,
    lastFailure: null as Date | null,
    lastError: null as string | null,
    pending: 0,
    successCount: 0,
    failureCount: 0,
  };

  private readonly axiosInstance = axios.create({
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 5 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 5 }),
  });

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly apply: LandingApplyService,
  ) {}

  onModuleInit() {
    if (!isEdge()) return;
    if (process.env.SYNC_PULL_ENABLED === '0') {
      this.logger.log('HTTP sync pull disabled (SYNC_PULL_ENABLED=0)');
      return;
    }
    const fastMs = parseInt(process.env.SYNC_PULL_FAST_MS || '10000', 10);
    const fullMs = parseInt(process.env.SYNC_PULL_FULL_MS || '300000', 10);
    this.logger.log(`HTTP sync pull enabled (fast: ${fastMs}ms, full: ${fullMs}ms)`);
    
    // Initial fetch
    void this.tick(true);
    
    this.fastTimer = setInterval(() => void this.tick(false), Math.max(5_000, fastMs));
    this.fullTimer = setInterval(() => void this.tick(true), Math.max(60_000, fullMs));
  }

  onModuleDestroy() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.fullTimer) clearInterval(this.fullTimer);
  }

  getStats() {
    return this.syncStats;
  }

  private async tick(isFull: boolean) {
    if (this.running) return;
    this.running = true;
    try {
      const manifest = await this.fetchManifestWithRetry(isFull);
      if (!manifest) {
        // 304 Not Modified
        this.running = false;
        return;
      }

      this.syncStats.pending = (manifest.landings?.length || 0) + (manifest.forms?.length || 0) + (manifest.settings?.length || 0);

      // اول فرم‌ها و تنظیمات که لندینگ‌های وابسته به فرم چیزی کم نداشته باشن
      if (manifest.settings) {
        for (const s of manifest.settings) {
          try {
            await this.prisma.systemSetting.upsert({
              where: { key: s.key },
              create: { key: s.key, value: s.value },
              update: { value: s.value },
            });
          } catch (err) {
            this.logger.error(
              `HTTP pull setting apply failed (${s.key}): ${err}`,
            );
          }
        }
      }
      if (manifest.deletedSettings) {
         for (const key of manifest.deletedSettings) {
             try {
                 await this.prisma.systemSetting.delete({ where: { key }});
             } catch (e) {
                 /* ignore */
             }
         }
      }

      await this.syncForms(manifest.forms, manifest.deletedForms);
      for (const item of manifest.landings ?? []) {
        await this.syncOne(item);
      }
      await this.cleanupDeletedLandings(manifest.landings ?? [], manifest.deletedLandings);
      
      this.syncStats.lastSuccess = new Date();
      this.syncStats.successCount++;
      this.syncStats.lastError = null;
      this.syncStats.pending = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`HTTP sync pull failed: ${message}`);
      this.syncStats.lastFailure = new Date();
      this.syncStats.failureCount++;
      this.syncStats.lastError = message;
      // Reset ETag on failure to force full sync next time
      this.lastEtag = null;
    } finally {
      this.running = false;
    }
  }

  private manifestUrls(): string[] {
    const path = '/api/internal/sync/manifest';
    const urls: string[] = [];
    const master = (this.config.get<string>('masterInternalUrl') || '').replace(
      /\/$/,
      '',
    );
    const pub = (this.config.get<string>('publicBaseUrl') || '').replace(
      /\/$/,
      '',
    );
    if (master) urls.push(`${master}${path}`);
    if (pub && pub !== master) urls.push(`${pub}${path}`);
    return urls;
  }

  private async fetchManifestWithRetry(isFull: boolean, attempt = 1): Promise<Manifest | null> {
    try {
      return await this.fetchManifest(isFull);
    } catch (err) {
      if (attempt >= 5) throw err;
      const delay = Math.min(60_000, 2000 * 2 ** (attempt - 1));
      await new Promise(r => setTimeout(r, delay));
      return this.fetchManifestWithRetry(isFull, attempt + 1);
    }
  }

  private async fetchManifest(isFull: boolean): Promise<Manifest | null> {
    const urls = this.manifestUrls();
    if (!urls.length) {
      throw new Error('MASTER_INTERNAL_URL / PUBLIC_BASE_URL not set');
    }
    
    const token = this.config.get<string>('syncHttpToken') || '';
    const headers: Record<string, string> = {
       'Accept-Encoding': 'gzip, deflate, br',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (!isFull && this.lastEtag) {
       headers['If-None-Match'] = this.lastEtag;
    }

    const sinceParam = !isFull && this.lastSinceDate ? `since=${this.lastSinceDate.toISOString()}` : '';
    const fullParam = isFull ? 'full=1' : '';
    const qs = [sinceParam, fullParam].filter(Boolean).join('&');
    const qsPrefix = qs ? '?' + qs : '';

    let lastErr: unknown;
    for (const url of urls) {
      const fetchUrl = `${url}${qsPrefix}`;
      try {
        const response = await this.axiosInstance.get<Manifest>(fetchUrl, {
          headers,
          timeout: 15_000,
          validateStatus: (s: number) => s === 200 || s === 304,
        });

        if (response.status === 304) {
           return null;
        }

        if (response.headers['etag']) {
           this.lastEtag = response.headers['etag'];
        }
        this.lastSinceDate = new Date();

        const data = response.data;
        return {
          landings: Array.isArray(data?.landings) ? data.landings : [],
          forms: Array.isArray(data?.forms) ? data.forms : undefined,
          settings: Array.isArray(data?.settings) ? data.settings : undefined,
          deletedLandings: Array.isArray(data?.deletedLandings) ? data.deletedLandings : undefined,
          deletedForms: Array.isArray(data?.deletedForms) ? data.deletedForms : undefined,
          deletedSettings: Array.isArray(data?.deletedSettings) ? data.deletedSettings : undefined,
        };
      } catch (err) {
        lastErr = err;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Manifest fetch failed (${fetchUrl}): ${message}`);
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Failed to fetch sync manifest');
  }

  /** تعریف فرم‌ها از مانیفست — upsert جدیدها، حذف اون‌هایی که روی مستر پاک شدن */
  private async syncForms(forms: FormManifestItem[] | undefined, deletedForms: string[] | undefined) {
    // مستر قدیمی forms نمی‌فرسته — دست به فرم‌های محلی نزن
    if (!Array.isArray(forms)) return;

    for (const f of forms) {
      if (!f?.key || !f.idempotencyKey) continue;
      try {
        if (await this.apply.alreadyProcessed(f.idempotencyKey)) continue;
        const categoryId = f.category
          ? (
              await this.prisma.category.upsert({
                where: {
                  normalizedName: f.category.toLocaleLowerCase('fa-IR'),
                },
                create: {
                  name: f.category,
                  normalizedName: f.category.toLocaleLowerCase('fa-IR'),
                },
                update: {},
              })
            ).id
          : null;
        await this.prisma.form.upsert({
          where: { key: f.key },
          create: {
            id: f.id,
            title: f.title,
            categoryId,
            key: f.key,
            slug: f.slug,
            body: f.body as Prisma.InputJsonValue,
            webhookUrl: f.webhookUrl || null,
            googleSheetUrl: f.googleSheetUrl || null,
            googleSheetMeta: f.googleSheetMeta
              ? (f.googleSheetMeta as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            otpEnabled: f.otpEnabled || false,
            otpField: f.otpField || 'mobile',
            otpTemplate: f.otpTemplate || 'verify',
            otpLength: f.otpLength || 5,
            sendUtmToWebhook: f.sendUtmToWebhook ?? true,
            sendUtmToSheet: f.sendUtmToSheet ?? true,
          },
          update: {
            title: f.title,
            ...(Object.prototype.hasOwnProperty.call(f, 'category')
              ? { categoryId }
              : {}),
            slug: f.slug,
            body: f.body as Prisma.InputJsonValue,
            webhookUrl: f.webhookUrl || null,
            googleSheetUrl: f.googleSheetUrl || null,
            googleSheetMeta: f.googleSheetMeta
              ? (f.googleSheetMeta as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            otpEnabled: f.otpEnabled || false,
            otpField: f.otpField || 'mobile',
            otpTemplate: f.otpTemplate || 'verify',
            otpLength: f.otpLength || 5,
            sendUtmToWebhook: f.sendUtmToWebhook ?? true,
            sendUtmToSheet: f.sendUtmToSheet ?? true,
          },
        });
        await this.apply.markProcessed(f.idempotencyKey);
        this.logger.log(`Form synced via HTTP pull: ${f.key}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`HTTP pull form apply failed (${f.key}): ${message}`);
      }
    }

    // فرم‌هایی که دیگه توی مانیفست نیستن یعنی روی مستر حذف شدن
    if (deletedForms) {
        for (const key of deletedForms) {
           try {
             await this.prisma.form.delete({ where: { key } });
             this.logger.log(`Form removed via HTTP pull (tombstone): ${key}`);
           } catch (e) {
             /* ignore */
           }
        }
    } else {
        try {
          const keys = new Set(forms.map((f) => f.key));
          const locals = await this.prisma.form.findMany({
            select: { key: true },
          });
          for (const local of locals) {
            if (keys.has(local.key)) continue;
            await this.prisma.form.delete({ where: { key: local.key } });
            this.logger.log(`Form removed via HTTP pull (full sync): ${local.key}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`HTTP pull form cleanup failed: ${message}`);
        }
    }
  }

  private async cleanupDeletedLandings(landings: ManifestItem[], deletedLandings: string[] | undefined) {
    if (deletedLandings) {
        for (const slug of deletedLandings) {
             try {
                const idempotencyKey = `landing:${slug}:delete:sync-pull:${Date.now()}`;
                await this.apply.deleteLanding({ slug, idempotencyKey });
                this.logger.log(`Landing removed via HTTP pull (tombstone): ${slug}`);
             } catch (e) {
                /* ignore */
             }
        }
        return;
    }

    try {
      const activeSlugs = new Set(landings.map((l) => l.slug));
      const locals = await this.prisma.landing.findMany({
        select: { slug: true },
      });
      for (const local of locals) {
        if (!activeSlugs.has(local.slug)) {
          const idempotencyKey = `landing:${local.slug}:delete:sync-pull:${Date.now()}`;
          await this.apply.deleteLanding({ slug: local.slug, idempotencyKey });
          this.logger.log(`Landing removed via HTTP pull (full sync): ${local.slug}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`HTTP pull landing cleanup failed: ${message}`);
    }
  }

  private async syncOne(item: ManifestItem) {
    if (!item?.slug || !item?.checksum || !item?.downloadUrl) return;

    const local = await this.prisma.landing.findUnique({
      where: { slug: item.slug },
    });
    if (
      local &&
      local.version >= item.version &&
      local.checksum === item.checksum
    ) {
      return;
    }

    const idempotencyKey =
      item.idempotencyKey ||
      `landing:${item.slug}:v${item.version}:${item.checksum}`;

    if (await this.apply.alreadyProcessed(idempotencyKey)) return;

    const payload: LandingSyncPayload = {
      idempotencyKey,
      slug: item.slug,
      version: item.version,
      checksum: item.checksum,
      downloadUrl: item.downloadUrl,
      downloadUrlFallback: item.downloadUrlFallback,
    };

    try {
      await this.apply.applyLanding(payload);
      await this.apply.markProcessed(idempotencyKey);
      this.logger.log(
        `Landing synced via HTTP pull: ${item.slug} v${item.version}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`HTTP pull apply failed (${item.slug}): ${message}`);
    }
  }
}
