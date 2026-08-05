import { Controller, Get } from '@nestjs/common';
import { getLocalVersion } from './app-version';
import { OutboxService } from '../modules/sync/outbox.service';
import { isEdge } from '../config/role';

@Controller('api/health')
export class HealthController {
  constructor(private readonly outbox: OutboxService) {}

  @Get()
  async health() {
    const role = process.env.NODE_ROLE || 'MASTER';
    const nodeId = process.env.EDGE_NODE_ID || undefined;
    const rabbitmq = await this.outbox.getRabbitStatus();
    const pendingSubmissions = role === 'EDGE' ? await this.outbox.getPendingSubmissionsCount() : 0;
    const syncPullEnabled =
      isEdge() && process.env.SYNC_PULL_ENABLED !== '0';
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
      ts: new Date().toISOString(),
    };
  }
}
