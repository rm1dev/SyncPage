import { Controller, Get, Optional } from '@nestjs/common';
import { getLocalVersion } from './app-version';
import { OutboxService } from '../modules/sync/outbox.service';
import { LandingApplyService } from '../modules/sync/landing-apply.service';
import { isEdge } from '../config/role';

@Controller('api/health')
export class HealthController {
  constructor(
    private readonly outbox: OutboxService,
    @Optional() private readonly landingApply?: LandingApplyService,
  ) {}

  @Get()
  async health() {
    const role = process.env.NODE_ROLE || 'MASTER';
    const nodeId = process.env.EDGE_NODE_ID || undefined;
    const rabbitmq = await this.outbox.getRabbitStatus();
    const pendingSubmissions =
      role === 'EDGE' ? await this.outbox.getPendingSubmissionsCount() : 0;
    const syncPullEnabled = isEdge() && process.env.SYNC_PULL_ENABLED !== '0';

    const activeDownload =
      role === 'EDGE' && this.landingApply
        ? this.landingApply.getActiveDownload()
        : null;
    const downloadHistory =
      role === 'EDGE' && this.landingApply
        ? this.landingApply.getDownloadHistory()
        : [];

    // واکشی لیست لندینگ‌ها و نسخه آن‌ها از پوشه روی دیسک
    const edgeLandings: any[] = [];
    if (role === 'EDGE') {
      try {
        const { readdirSync, existsSync, readFileSync } = await import('fs');
        const { join } = await import('path');
        const staticPagesPath = process.env.STATIC_PAGES_PATH || join(process.cwd(), 'static_pages');

        if (existsSync(staticPagesPath)) {
          const dirs = readdirSync(staticPagesPath, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);

          for (const dir of dirs) {
            const markerPath = join(
              staticPagesPath,
              dir,
              '.syncpage-meta.json',
            );
            let version = 1;
            let checksum = '';

            if (existsSync(markerPath)) {
              try {
                const meta = JSON.parse(readFileSync(markerPath, 'utf-8'));
                version = meta.version || 1;
                checksum = meta.checksum || '';
              } catch (e) {}
            }

            edgeLandings.push({
              slug: dir,
              version,
              checksum,
            });
          }
        }
      } catch (err) {}
    }

    return {
      ok: true,
      role,
      service: 'syncpage',
      version: getLocalVersion(),
      ...(nodeId ? { nodeId } : {}),
      rabbitmq,
      pendingSubmissions,
      syncPull: {
        enabled: syncPullEnabled,
        intervalMs: syncPullEnabled
          ? parseInt(process.env.SYNC_PULL_MS || '20000', 10)
          : null,
      },
      ...(role === 'EDGE'
        ? { activeDownload, downloadHistory, edgeLandings }
        : {}),
      ts: new Date().toISOString(),
    };
  }
}
