import { Controller, Get } from '@nestjs/common';
import { getLocalVersion } from './app-version';

@Controller('api/health')
export class HealthController {
  @Get()
  health() {
    const role = process.env.NODE_ROLE || 'MASTER';
    const nodeId = process.env.EDGE_NODE_ID || undefined;
    return {
      ok: true,
      role,
      service: 'syncpage',
      version: getLocalVersion(),
      ...(nodeId ? { nodeId } : {}),
      ts: new Date().toISOString(),
    };
  }
}
