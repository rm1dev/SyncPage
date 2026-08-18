import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';
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
};

@Injectable()
export class SyncPullService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncPullService.name);
  private timerFast: NodeJS.Timeout | null = null;
  private timerFull: NodeJS.Timeout | null = null;
  private running = false;
  private lastETag: string | null = null;
  private lastSyncTimestamp: string | null = null;
  private syncStats = { success: 0, failed: 0, lastRun: null as string | null };
  
  private httpClient: AxiosInstance;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly apply: LandingApplyService,
  ) {
    // 1.1 Connection Pooling
    this.httpClient = axios.create({
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 5 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 5 }),
      headers: {
        'Accept-Encoding': 'gzip, deflate, br', // 1.2 Compression
      },
    });
  }

  onModuleInit() {
    if (!isEdge()) return;
    
    if (process.env.SYNC_PULL_ENABLED === '0') {
      this.logger.log('HTTP sync pull disabled (SYNC_PULL_ENABLED=0)');
      return;
    }
    
    const fastMs = this.config.get<number>('syncPullFastMs') || 10000;
    const fullMs = this.config.get<number>('syncPullFullMs') || 300000;
    
    this.logger.log(`HTTP sync pull enabled (Fast: ${fastMs}ms, Full: ${fullMs}ms)`);
    
    // Initial fetch (Full)
    void this.tick(true);
    
    // 1.8 Smart Interval (Fast vs Full)
    this.timerFast = setInterval(() => void this.tick(false), Math.max(5000, fastMs));
    this.timerFull = setInterval(() => void this.tick(true), Math.max(60000, fullMs));
  }

  onModuleDestroy() {
    if (this.timerFast) clearInterval(this.timerFast);
    if (this.timerFull) clearInterval(this.timerFull);
  }

  private async tick(isFullSync: boolean) {
    if (this.running) return;
    this.running = true;
    try {
      const manifest = await this.fetchManifest(isFullSync);
      if (!manifest) {
        // 304 Not Modified -> Skip
        return;
      }
      
      if (manifest.settings) {
        for (const s of manifest.settings) {
          try {
            await this.prisma.systemSetting.upsert({
              where: { key: s.key },
              create: { key: s.key, value: s.value },
              update: { value: s.value },
            });
          } catch (err) {
            this.logger.error(`HTTP pull setting apply failed (${s.key}): ${err}`);
          }
        }
      }
      
      await this.syncForms(manifest.forms);
      await this.processDeletions(manifest.deletedForms || [], manifest.deletedLandings || []);
      
      // 1.6 Download Queue (Concurrent max 2)
      const maxConcurrent = this.config.get<number>('syncPullConcurrent') || 2;
      const landings = manifest.landings ?? [];
      for (let i = 0; i < landings.length; i += maxConcurrent) {
        const batch = landings.slice(i, i + maxConcurrent);
        await Promise.allSettled(batch.map(item => this.syncOne(item)));
      }
      
      // If it was a full sync, do a local cleanup just in case tombstone was missed
      if (isFullSync) {
        await this.cleanupDeletedLandings(manifest.landings ?? []);
      }
      this.syncStats.success++;
      this.syncStats.lastRun = new Date().toISOString();
      
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`HTTP sync pull failed: ${message}`);
      this.syncStats.failed++;
      this.syncStats.lastRun = new Date().toISOString();
      // 1.9 ETag Reset on error
      this.lastETag = null; 
    } finally {
      this.running = false;
    }
  }

  getStats() {
    return this.syncStats;
  }

  private manifestUrls(): string[] {
    const path = '/api/internal/sync/manifest';
    const urls: string[] = [];
    const master = (this.config.get<string>('masterInternalUrl') || '').replace(/\/$/, '');
    const pub = (this.config.get<string>('publicBaseUrl') || '').replace(/\/$/, '');
    if (master) urls.push(`${master}${path}`);
    if (pub && pub !== master) urls.push(`${pub}${path}`);
    return urls;
  }

  private async fetchManifest(isFullSync: boolean): Promise<Manifest | null> {
    const urls = this.manifestUrls();
    if (!urls.length) {
      throw new Error('MASTER_INTERNAL_URL / PUBLIC_BASE_URL not set');
    }
    
    let lastErr: unknown;
    
    // 1.5 Retry with Exponential Backoff
    for (const url of urls) {
      let attempts = 0;
      const maxAttempts = 3;
      
      while (attempts < maxAttempts) {
        try {
          const reqUrl = new URL(url);
          reqUrl.searchParams.set('t', String(Date.now())); // Bypass CDN Cache completely!
          
          // 1.4 Incremental Manifest
          if (!isFullSync && this.lastSyncTimestamp) {
            reqUrl.searchParams.set('since', this.lastSyncTimestamp);
          } else {
            reqUrl.searchParams.set('full', '1');
          }
          
          const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.config.get<string>('syncHttpToken')}`,
          };
          
          // 1.3 ETag Caching
          if (!isFullSync && this.lastETag) {
            headers['If-None-Match'] = this.lastETag;
          }

          const response = await this.httpClient.get<Manifest>(reqUrl.toString(), {
            headers,
            timeout: 120_000, // 120 ثانیه
            validateStatus: (s: number) => s === 200 || s === 304,
          });
          
          if (response.status === 304) {
             return null; // Not modified
          }
          
          if (response.headers['etag']) {
             this.lastETag = response.headers['etag'];
          }
          
          this.lastSyncTimestamp = new Date().toISOString();
          
          const data = response.data;
          return {
            landings: Array.isArray(data?.landings) ? data.landings : [],
            forms: Array.isArray(data?.forms) ? data.forms : undefined,
            settings: Array.isArray(data?.settings) ? data.settings : undefined,
            deletedLandings: Array.isArray(data?.deletedLandings) ? data.deletedLandings : [],
            deletedForms: Array.isArray(data?.deletedForms) ? data.deletedForms : [],
          };
        } catch (err) {
          lastErr = err;
          attempts++;
          if (attempts < maxAttempts) {
             const delay = Math.min(1000 * (2 ** attempts), 15000); // 2s, 4s, 8s
             await new Promise(r => setTimeout(r, delay));
          }
        }
      }
    }
    
    throw lastErr instanceof Error ? lastErr : new Error('Failed to fetch sync manifest');
  }

  private async processDeletions(deletedForms: string[], deletedLandings: string[]) {
     for (const key of deletedForms) {
        try {
           await this.prisma.form.deleteMany({ where: { key } });
           this.logger.log(`Form removed via Tombstone: ${key}`);
        } catch(e) {}
     }
     for (const slug of deletedLandings) {
        try {
           const idempotencyKey = `landing:${slug}:delete:tombstone:${Date.now()}`;
           await this.apply.deleteLanding({ slug, idempotencyKey });
           this.logger.log(`Landing removed via Tombstone: ${slug}`);
        } catch(e) {}
     }
  }

  private async syncForms(forms: FormManifestItem[] | undefined) {
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
  }

  private async cleanupDeletedLandings(landings: ManifestItem[]) {
    try {
      const activeSlugs = new Set(landings.map((l) => l.slug));
      const locals = await this.prisma.landing.findMany({
        select: { slug: true },
      });
      for (const local of locals) {
        if (!activeSlugs.has(local.slug)) {
          const idempotencyKey = `landing:${local.slug}:delete:sync-pull:${Date.now()}`;
          await this.apply.deleteLanding({ slug: local.slug, idempotencyKey });
          this.logger.log(`Landing removed via HTTP full reconcile: ${local.slug}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`HTTP pull landing cleanup failed: ${message}`);
    }
  }

  private async syncOne(item: ManifestItem) {
    // Force log to see what's happening
    this.logger.log(`[DEBUG] Checking landing from manifest: ${item?.slug} (v${item?.version})`);
    
    if (!item?.slug || !item?.checksum || !item?.downloadUrl) {
        this.logger.warn(`Invalid manifest item: ${JSON.stringify(item)}`);
        return;
    }
    
    try {
       const already = await this.apply.alreadyProcessed(item.idempotencyKey);
       if (already) {
           this.logger.log(`[DEBUG] Skipping ${item.slug} v${item.version} - alreadyProcessed is TRUE for key ${item.idempotencyKey}`);
           return;
       }
       
       const local = await this.prisma.landing.findUnique({ where: { slug: item.slug } });
       if (local && local.checksum === item.checksum && local.version >= item.version) {
         this.logger.log(`[DEBUG] Skipping ${item.slug} - local version (${local.version}) is up to date with manifest (${item.version})`);
         await this.apply.markProcessed(item.idempotencyKey);
         return;
       }
       
       this.logger.log(`Will apply landing: ${item.slug} v${item.version} (Local: v${local?.version || 'none'})`);
       await this.apply.applyLanding(item as LandingSyncPayload);
       await this.apply.markProcessed(item.idempotencyKey);
       this.logger.log(`Landing synced via HTTP pull: ${item.slug} v${item.version}`);
       
    } catch (err) {
       const message = err instanceof Error ? err.message : String(err);
       this.logger.error(`HTTP pull landing apply failed (${item.slug} v${item.version}): ${message}`);
       // ETag should be reset so it retries later
       this.lastETag = null; 
    }
  }
}
