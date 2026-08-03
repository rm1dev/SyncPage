import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import axios from 'axios';
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
  key: string;
  slug: string;
  body: unknown;
  updatedAt: string;
  idempotencyKey: string;
};

type Manifest = {
  landings?: ManifestItem[];
  forms?: FormManifestItem[];
};

/**
 * وقتی AMQP از Edge ریموت به Master نمی‌رسه (ETIMEDOUT)،
 * از HTTP manifest لندینگ‌ها رو می‌کشه — مسیر پایدار برای sync
 */
@Injectable()
export class SyncPullService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncPullService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly apply: LandingApplyService,
  ) {}

  onModuleInit() {
    if (!isEdge()) return;
    // پیش‌فرض روشن روی Edge — حتی اگه AMQP اوکی باشه، فقط نسخهٔ عقب‌مونده رو می‌گیره
    if (process.env.SYNC_PULL_ENABLED === '0') {
      this.logger.log('HTTP sync pull disabled (SYNC_PULL_ENABLED=0)');
      return;
    }
    const ms = parseInt(process.env.SYNC_PULL_MS || '20000', 10);
    this.logger.log(`HTTP sync pull enabled (every ${ms}ms)`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), Math.max(10_000, ms));
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const manifest = await this.fetchManifest();
      // اول فرم‌ها که لندینگ‌های وابسته به فرم چیزی کم نداشته باشن
      await this.syncForms(manifest.forms);
      for (const item of manifest.landings ?? []) {
        await this.syncOne(item);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`HTTP sync pull failed: ${message}`);
    } finally {
      this.running = false;
    }
  }

  private manifestUrls(): string[] {
    const path = '/api/internal/sync/manifest';
    const urls: string[] = [];
    const master = (
      this.config.get<string>('masterInternalUrl') || ''
    ).replace(/\/$/, '');
    const pub = (this.config.get<string>('publicBaseUrl') || '').replace(
      /\/$/,
      '',
    );
    if (master) urls.push(`${master}${path}`);
    if (pub && pub !== master) urls.push(`${pub}${path}`);
    return urls;
  }

  private async fetchManifest(): Promise<Manifest> {
    const urls = this.manifestUrls();
    if (!urls.length) {
      throw new Error('MASTER_INTERNAL_URL / PUBLIC_BASE_URL not set');
    }
    let lastErr: unknown;
    for (const url of urls) {
      try {
        const { data } = await axios.get<Manifest>(url, {
          timeout: 15_000,
          validateStatus: (s: number) => s === 200,
        });
        return {
          landings: Array.isArray(data?.landings) ? data.landings : [],
          forms: Array.isArray(data?.forms) ? data.forms : undefined,
        };
      } catch (err) {
        lastErr = err;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Manifest fetch failed (${url}): ${message}`);
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Failed to fetch sync manifest');
  }

  /** تعریف فرم‌ها از مانیفست — upsert جدیدها، حذف اون‌هایی که روی مستر پاک شدن */
  private async syncForms(forms: FormManifestItem[] | undefined) {
    // مستر قدیمی forms نمی‌فرسته — دست به فرم‌های محلی نزن
    if (!Array.isArray(forms)) return;

    for (const f of forms) {
      if (!f?.key || !f.idempotencyKey) continue;
      try {
        if (await this.apply.alreadyProcessed(f.idempotencyKey)) continue;
        await this.prisma.form.upsert({
          where: { key: f.key },
          create: {
            id: f.id,
            title: f.title,
            key: f.key,
            slug: f.slug,
            body: f.body as Prisma.InputJsonValue,
          },
          update: {
            title: f.title,
            slug: f.slug,
            body: f.body as Prisma.InputJsonValue,
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
    try {
      const keys = new Set(forms.map((f) => f.key));
      const locals = await this.prisma.form.findMany({
        select: { key: true },
      });
      for (const local of locals) {
        if (keys.has(local.key)) continue;
        await this.prisma.form.delete({ where: { key: local.key } });
        this.logger.log(`Form removed via HTTP pull: ${local.key}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`HTTP pull form cleanup failed: ${message}`);
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
      this.logger.error(
        `HTTP pull apply failed (${item.slug}): ${message}`,
      );
    }
  }
}
