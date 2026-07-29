import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { PrismaModule } from './common/prisma/prisma.module';
import { FormEngineModule } from './modules/form-engine/form-engine.module';
import { DeploymentModule } from './modules/deployment/deployment.module';
import { SyncModule } from './modules/sync/sync.module';
import { StaticModule } from './modules/static/static.module';
import { AdminModule } from './modules/admin/admin.module';
import { NodesModule } from './modules/nodes/nodes.module';
import { HealthController } from './common/health.controller';
import { isMaster } from './config/role';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // فقط env کانتینر/سیستم — فایل .env داخل ایمیج نداریم و نباید قاطی بشه
      ignoreEnvFile: process.env.NODE_ENV === 'production',
    }),
    PrismaModule,
    FormEngineModule,
    DeploymentModule,
    SyncModule,
    StaticModule,
    // پنل ادمین + مدیریت نود فقط روی Master
    ...(isMaster() ? [AdminModule, NodesModule] : []),
  ],
  controllers: [HealthController],
})
export class AppModule {}
