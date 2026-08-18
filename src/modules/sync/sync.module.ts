import { Module, forwardRef } from '@nestjs/common';
import { DeploymentModule } from '../deployment/deployment.module';
import { FormEngineModule } from '../form-engine/form-engine.module';
import { LandingApplyService } from './landing-apply.service';
import { OutboxService } from './outbox.service';
import { SyncConsumerController } from './sync-consumer.controller';
import { SyncHttpController } from './sync-http.controller';
import { SyncPullService } from './sync-pull.service';

@Module({
  imports: [DeploymentModule, forwardRef(() => FormEngineModule)],
  controllers: [SyncConsumerController, SyncHttpController],
  providers: [OutboxService, LandingApplyService, SyncPullService],
  exports: [OutboxService, SyncPullService],
})
export class SyncModule {}
