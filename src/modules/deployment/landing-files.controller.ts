import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  Render,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { AdminTokenGuard } from '../../common/guards/admin-token.guard';
import { FileService } from './file.service';
import { DeploymentService } from './deployment.service';

@Controller('spadmin/files')
@UseGuards(AdminTokenGuard)
export class LandingFilesController {
  constructor(
    private readonly files: FileService,
    private readonly deployment: DeploymentService,
  ) {}

  /** صفحه اصلی فایل منیجر */
  @Get()
  @Render('admin/files')
  async filesPage(
    @Query('slug') slug?: string,
    @Query('path') filePath?: string,
    @Query('flash') flash?: string,
    @Query('error') error?: string,
  ) {
    const landings = await this.deployment.listLandings();
    const activeSlug = slug || landings[0]?.slug || '';

    let tree: ReturnType<FileService['listLandingFiles']> = [];
    let currentFile: { path: string; content: string; size: number } | null =
      null;

    if (activeSlug) {
      try {
        tree = this.files.listLandingFiles(activeSlug);
      } catch {
        /* landing dir may not exist yet */
      }
    }

    if (activeSlug && filePath) {
      try {
        const f = this.files.readLandingFile(activeSlug, filePath);
        currentFile = { path: filePath, content: f.content, size: f.size };
      } catch {
        /* file may not be readable as text */
      }
    }

    return {
      layout: 'main',
      title: 'مدیریت فایل‌ها',
      active: 'files',
      flash,
      error,
      landings,
      activeSlug,
      tree,
      currentFile,
    };
  }

  /** JSON: ساختار درختی فایل‌ها */
  @Get('api/tree')
  getTree(@Query('slug') slug: string) {
    if (!slug) throw new BadRequestException('slug is required');
    return { tree: this.files.listLandingFiles(slug) };
  }

  /** JSON: خواندن محتوای فایل */
  @Get('api/read')
  readFile(@Query('slug') slug: string, @Query('path') path: string) {
    if (!slug || !path)
      throw new BadRequestException('slug and path are required');
    try {
      const result = this.files.readLandingFile(slug, path);
      return { path, ...result };
    } catch (err) {
      throw new NotFoundException(
        err instanceof Error ? err.message : 'File not found',
      );
    }
  }

  /** JSON: ذخیره فایل */
  @Post('api/write')
  async writeFile(
    @Body() body: { slug: string; path: string; content: string },
  ) {
    if (!body?.slug || !body?.path) {
      throw new BadRequestException('slug, path and content are required');
    }
    try {
      this.files.writeLandingFile(body.slug, body.path, body.content ?? '');
      // سینک کردن بعد از ویرایش فایل
      const operation = await this.deployment.syncSingle(body.slug);
      return { ok: true, synced: true, operationId: operation.id };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Write failed',
      );
    }
  }

  /** دانلود یک فایل از لندینگ */
  @Get('download/file')
  downloadFile(
    @Query('slug') slug: string,
    @Query('path') path: string,
    @Res() res: Response,
  ) {
    if (!slug || !path)
      throw new BadRequestException('slug and path are required');
    try {
      const absPath = this.files.getLandingFilePath(slug, path);
      const fileName = path.split('/').pop() || 'file';
      return res.download(absPath, fileName);
    } catch (err) {
      throw new NotFoundException(
        err instanceof Error ? err.message : 'File not found',
      );
    }
  }

  /** دانلود کل لندینگ به صورت ZIP */
  @Get('download/zip')
  downloadZip(@Query('slug') slug: string, @Res() res: Response) {
    if (!slug) throw new BadRequestException('slug is required');
    const dir = join(this.files.staticRoot, slug);
    if (!existsSync(dir))
      throw new NotFoundException(`Landing not found: ${slug}`);
    const zipPath = this.files.packageLandingZip(slug);
    return res.download(zipPath, `${slug}.zip`);
  }
}
