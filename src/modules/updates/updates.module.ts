import { Module } from '@nestjs/common';
import { NodesModule } from '../nodes/nodes.module';
import { VersionService } from './version.service';

@Module({
  imports: [NodesModule],
  providers: [VersionService],
  exports: [VersionService],
})
export class UpdatesModule {}
