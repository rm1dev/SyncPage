import { Controller, Get } from '@nestjs/common';

@Controller('api/health')
export class HealthController {
  @Get()
  health() {
    const role = process.env.NODE_ROLE || 'MASTER';
    const nodeId = process.env.EDGE_NODE_ID || undefined;
    return {
      ok: true,
      role,
      service: 'spage',
      ...(nodeId ? { nodeId } : {}),
      ts: new Date().toISOString(),
    };
  }
}
