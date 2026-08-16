import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { Response } from 'express';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { AdminTokenGuard } from '../../common/guards/admin-token.guard';
import { MasterOnlyGuard } from '../../common/guards/master-only.guard';
import { DeploymentService } from './deployment.service';
import { ConfigService } from '@nestjs/config';

@Controller()
export class DeploymentController {
  constructor(
    private readonly deployment: DeploymentService,
    private readonly config: ConfigService,
  ) {}

  @Get('api/landings')
  @UseGuards(MasterOnlyGuard, AdminTokenGuard)
  list() {
    return this.deployment.listLandings();
  }

  @Post('api/landings/upload')
  @UseGuards(MasterOnlyGuard, AdminTokenGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = join(process.env.TEMP_PATH || './temp', 'uploads');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          cb(null, `${Date.now()}-${file.originalname}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith('.zip')) {
          return cb(
            new BadRequestException('Only ZIP files are allowed'),
            false,
          );
        }
        cb(null, true);
      },
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('slug') slug: string,
  ) {
    if (!file) throw new BadRequestException('ZIP file is required');
    if (!slug) throw new BadRequestException('slug is required');
    return this.deployment.uploadPreview(slug, file.path);
  }

  @Post('api/landings/confirm')
  @UseGuards(MasterOnlyGuard, AdminTokenGuard)
  confirm(@Body() body: { previewId: string; slug: string }) {
    if (!body?.previewId || !body?.slug) {
      throw new BadRequestException('previewId and slug are required');
    }
    return this.deployment.confirm(body.previewId, body.slug);
  }

  @Get('api/internal/landings/:slug/package/:packageFile')
  getImmutablePackage(
    @Param('slug') slug: string,
    @Param('packageFile') packageFile: string,
    @Res() res: Response,
  ) {
    const path = this.deployment.getImmutablePackagePath(slug, packageFile);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.download(path, packageFile);
  }

  /** مسیر قدیمی برای سازگاری با eventهای قبلی */
  @Get('api/internal/landings/:slug/package')
  getPackage(@Param('slug') slug: string, @Res() res: Response) {
    const path = this.deployment.getPackagePath(slug);
    res.setHeader('Cache-Control', 'no-store');
    res.download(path, `${slug}.zip`);
  }

  /** مانیفست همگام‌سازی برای Edge (جایگزین AMQP وقتی مسیر بسته است) */
  @Get('api/internal/sync/manifest')
  getSyncManifest() {
    return this.deployment.getSyncManifest();
  }
}
