import { Module } from '@nestjs/common';
import { NodesService } from './nodes.service';
import { NodesBootstrapController } from './nodes-bootstrap.controller';
import { NodesApiController } from './nodes-api.controller';

@Module({
  controllers: [NodesBootstrapController, NodesApiController],
  providers: [NodesService],
  exports: [NodesService],
})
export class NodesModule {}
