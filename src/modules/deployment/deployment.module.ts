import { Module } from '@nestjs/common';
import { DeploymentController } from './deployment.controller';
import { DeploymentService } from './deployment.service';
import { FileService } from './file.service';

@Module({
  controllers: [DeploymentController],
  providers: [DeploymentService, FileService],
  exports: [DeploymentService, FileService],
})
export class DeploymentModule {}
