import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';
import { FormEngineController } from './form-engine.controller';
import { FormEngineService } from './form-engine.service';
import { WebhookService } from './webhook.service';
import { KavenegarService } from './kavenegar.service';
import { IntegrationProfileService } from './integration-profile.service';

@Module({
  imports: [forwardRef(() => SyncModule)],
  controllers: [FormEngineController],
  providers: [
    FormEngineService,
    WebhookService,
    KavenegarService,
    IntegrationProfileService,
  ],
  exports: [
    FormEngineService,
    WebhookService,
    KavenegarService,
    IntegrationProfileService,
  ],
})
export class FormEngineModule {}
