import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
      const items = await this.fetchManifest();
      for (const item of items) {
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

  private async fetchManifest(): Promise<ManifestItem[]> {
    const urls = this.manifestUrls();
    if (!urls.length) {
      throw new Error('MASTER_INTERNAL_URL / PUBLIC_BASE_URL not set');
    }
    let lastErr: unknown;
    for (const url of urls) {
      try {
        const { data } = await axios.get<{ landings?: ManifestItem[] }>(url, {
          timeout: 15_000,
          validateStatus: (s: number) => s === 200,
        });
        return Array.isArray(data?.landings) ? data.landings : [];
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
