import { Module } from '@nestjs/common';
import { DeploymentController } from './deployment.controller';
import { LandingFilesController } from './landing-files.controller';
import { DeploymentService } from './deployment.service';
import { NodesModule } from '../nodes/nodes.module';
import { FileService } from './file.service';

@Module({
  imports: [NodesModule],
  controllers: [DeploymentController, LandingFilesController],
  providers: [DeploymentService, FileService],
  exports: [DeploymentService, FileService],
})
export class DeploymentModule {}
