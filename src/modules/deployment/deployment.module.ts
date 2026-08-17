import { Module } from '@nestjs/common';
import { DeploymentController } from './deployment.controller';
import { LandingFilesController } from './landing-files.controller';
import { DeploymentService } from './deployment.service';
import { NodesModule } from '../nodes/nodes.module';
import { FileService } from './file.service';
import { CategoryModule } from '../categories/category.module';

@Module({
  imports: [NodesModule, CategoryModule],
  controllers: [DeploymentController, LandingFilesController],
  providers: [DeploymentService, FileService],
  exports: [DeploymentService, FileService],
})
export class DeploymentModule {}
