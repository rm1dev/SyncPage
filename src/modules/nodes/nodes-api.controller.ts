import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../../common/guards/admin-token.guard';
import { CreateEdgeNodeDto } from './dto/edge-node.dto';
import { NodesService } from './nodes.service';

/**
 * API مدیریت نود برای اسکریپت نصب و اتوماسیون
 * (فرم پنل جداگانه توی admin.controller هست)
 */
@Controller('api/nodes')
@UseGuards(AdminTokenGuard)
export class NodesApiController {
  constructor(private readonly nodes: NodesService) {}

  @Post()
  create(@Body() dto: CreateEdgeNodeDto) {
    return this.nodes.create(dto);
  }

  @Post(':id/verify')
  verify(@Param('id') id: string) {
    return this.nodes.verify(id);
  }
}
