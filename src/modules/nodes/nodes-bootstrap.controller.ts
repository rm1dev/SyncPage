import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { NodesService } from './nodes.service';

/**
 * endpoint عمومی بوت‌استرپ — فقط با توکن نصب معتبر کار می‌کنه
 * اسکریپت install-node.sh از این‌جا کانفیگ می‌گیره
 */
@Controller('api/nodes')
export class NodesBootstrapController {
  constructor(private readonly nodes: NodesService) {}

  @Get('bootstrap/:token')
  async bootstrap(@Param('token') token: string) {
    if (!token || token.length < 16) {
      throw new NotFoundException('Invalid install token');
    }
    return this.nodes.getBootstrapByToken(token);
  }
}
