import { Controller, Get } from '@nestjs/common';
import { getLocalVersion } from './app-version';
import { OutboxService } from '../modules/sync/outbox.service';

@Controller('api/health')
export class HealthController {
  constructor(private readonly outbox: OutboxService) {}

  @Get()
  async health() {
    const role = process.env.NODE_ROLE || 'MASTER';
    const nodeId = process.env.EDGE_NODE_ID || undefined;
    const rabbitmq = await this.outbox.getRabbitStatus();
    return {
      ok: true,
      role,
      service: 'syncpage',
      version: getLocalVersion(),
      ...(nodeId ? { nodeId } : {}),
      rabbitmq,
      ts: new Date().toISOString(),
    };
  }
}
