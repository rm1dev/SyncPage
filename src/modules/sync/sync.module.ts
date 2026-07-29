import { Module } from '@nestjs/common';
import { DeploymentModule } from '../deployment/deployment.module';
import { LandingApplyService } from './landing-apply.service';
import { OutboxService } from './outbox.service';
import { SyncConsumerController } from './sync-consumer.controller';
import { SyncPullService } from './sync-pull.service';

@Module({
  imports: [DeploymentModule],
  controllers: [SyncConsumerController],
  providers: [OutboxService, LandingApplyService, SyncPullService],
  exports: [OutboxService],
})
export class SyncModule {}
