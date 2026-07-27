import { Module, forwardRef } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module';
import { FormEngineController } from './form-engine.controller';
import { FormEngineService } from './form-engine.service';

@Module({
  imports: [forwardRef(() => SyncModule)],
  controllers: [FormEngineController],
  providers: [FormEngineService],
  exports: [FormEngineService],
})
export class FormEngineModule {}
