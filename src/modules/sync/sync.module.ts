import { Module } from '@nestjs/common';
import { DeploymentModule } from '../deployment/deployment.module';
import { OutboxService } from './outbox.service';
import { SyncConsumerController } from './sync-consumer.controller';

@Module({
  imports: [DeploymentModule],
  controllers: [SyncConsumerController],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class SyncModule {}
