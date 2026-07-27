import { Module } from '@nestjs/common';
import { NodesService } from './nodes.service';
import { NodesBootstrapController } from './nodes-bootstrap.controller';

@Module({
  controllers: [NodesBootstrapController],
  providers: [NodesService],
  exports: [NodesService],
})
export class NodesModule {}
