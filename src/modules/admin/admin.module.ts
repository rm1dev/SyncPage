import { Module } from '@nestjs/common';
import { FormEngineModule } from '../form-engine/form-engine.module';
import { DeploymentModule } from '../deployment/deployment.module';
import { NodesModule } from '../nodes/nodes.module';
import { UpdatesModule } from '../updates/updates.module';
import { SyncModule } from '../sync/sync.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [FormEngineModule, DeploymentModule, NodesModule, UpdatesModule, SyncModule],
  controllers: [AdminController],
})
export class AdminModule {}
