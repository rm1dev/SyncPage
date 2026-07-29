import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Render,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { Response } from 'express';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { AdminTokenGuard } from '../../common/guards/admin-token.guard';
import { FormEngineService } from '../form-engine/form-engine.service';
import { DeploymentService } from '../deployment/deployment.service';
import { NodesService } from '../nodes/nodes.service';
import { VersionService } from '../updates/version.service';
import { isOutdated } from '../../common/app-version';

@Controller('spadmin')
export class AdminController {
  constructor(
    private readonly forms: FormEngineService,
    private readonly deployment: DeploymentService,
    private readonly nodes: NodesService,
    private readonly versions: VersionService,
  ) {}

  @Get('login')
  @Render('admin/login')
  loginPage(@Query('error') error?: string) {
    return {
      layout: 'main',
      title: 'ورود',
      active: 'login',
      error: error ? 'توکن نامعتبر است' : undefined,
    };
  }

  @Post('login')
  login(
    @Body('token') token: string,
    @Res() res: Response,
  ) {
    const expected = process.env.ADMIN_TOKEN || 'change-me-admin-token';
    if (!token || token !== expected) {
      return res.redirect('/spadmin/login?error=1');
    }
    res.cookie('admin_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000,
    });
    return res.redirect('/spadmin');
  }

  @Get('logout')
  logout(@Res() res: Response) {
    res.clearCookie('admin_token');
    return res.redirect('/spadmin/login');
  }

  @Get()
  @UseGuards(AdminTokenGuard)
  @Render('admin/dashboard')
  async dashboard(@Query('flash') flash?: string) {
    const forms = await this.forms.list();
    const landings = await this.deployment.listLandings();
    const nodes = await this.nodes.list();
    const [masterUpdate, nodesVersion] = await Promise.all([
      this.versions.getMasterStatus(),
      this.versions.getNodesVersionStatus(),
    ]);
    const outdatedNodes = nodesVersion.nodes.filter((n) => n.outdated);
    return {
      layout: 'main',
      title: 'داشبورد',
      active: 'dashboard',
      flash,
      appVersion: masterUpdate.localVersion,
      masterUpdate,
      outdatedNodes,
      nodeUpdateCommand: nodesVersion.nodeUpdateCommand,
      forms: forms.map((f) => ({
        ...f,
        fieldCount: Array.isArray(f.body) ? f.body.length : 0,
      })),
      landings: landings.map((l) => ({
        ...l,
        checksumShort: l.checksum.slice(0, 12) + '…',
      })),
      nodeCount: nodes.length,
      onlineCount: nodes.filter((n) => n.status === 'ONLINE').length,
    };
  }

  @Get('forms/new')
  @UseGuards(AdminTokenGuard)
  @Render('admin/form-edit')
  newForm() {
    return {
      layout: 'main',
      title: 'فرم جدید',
      active: 'forms',
      bodyJson: JSON.stringify(
        [
          {
            type: 'text',
            name: 'fullName',
            label: 'نام کامل',
            required: true,
          },
          {
            type: 'email',
            name: 'email',
            label: 'ایمیل',
            required: true,
          },
        ],
        null,
        2,
      ),
    };
  }

  @Get('forms/:id')
  @UseGuards(AdminTokenGuard)
  @Render('admin/form-edit')
  async editForm(@Param('id') id: string) {
    const form = await this.forms.getById(id);
    return {
      layout: 'main',
      title: 'ویرایش فرم',
      active: 'forms',
      form,
      bodyJson: JSON.stringify(form.body, null, 2),
    };
  }

  @Post('forms')
  @UseGuards(AdminTokenGuard)
  async createForm(
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ) {
    try {
      const fields = JSON.parse(body.body || '[]');
      await this.forms.create({
        title: body.title,
        key: body.key,
        slug: body.slug,
        body: fields,
      });
      return res.redirect('/spadmin?flash=' + encodeURIComponent('فرم ذخیره شد'));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      return res.status(400).render('admin/form-edit', {
        layout: 'main',
        title: 'فرم جدید',
        active: 'forms',
        error: message,
        bodyJson: body.body,
        form: { title: body.title, key: body.key, slug: body.slug },
      });
    }
  }

  @Post('forms/:id')
  @UseGuards(AdminTokenGuard)
  async updateForm(
    @Param('id') id: string,
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ) {
    try {
      const fields = JSON.parse(body.body || '[]');
      await this.forms.update(id, {
        title: body.title,
        slug: body.slug,
        body: fields,
      });
      return res.redirect('/spadmin?flash=' + encodeURIComponent('فرم به‌روز شد'));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      const form = await this.forms.getById(id);
      return res.status(400).render('admin/form-edit', {
        layout: 'main',
        title: 'ویرایش فرم',
        active: 'forms',
        error: message,
        form,
        bodyJson: body.body,
      });
    }
  }

  @Get('deploy')
  @UseGuards(AdminTokenGuard)
  @Render('admin/deploy')
  deployPage(
    @Query('previewId') previewId?: string,
    @Query('slug') slug?: string,
    @Query('checksum') checksum?: string,
    @Query('previewUrl') previewUrl?: string,
    @Query('flash') flash?: string,
    @Query('error') error?: string,
  ) {
    return {
      layout: 'main',
      title: 'استقرار',
      active: 'deploy',
      previewId,
      slug,
      checksum,
      previewUrl,
      flash,
      error,
    };
  }

  @Post('deploy/upload')
  @UseGuards(AdminTokenGuard)
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
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('slug') slug: string,
    @Res() res: Response,
  ) {
    try {
      if (!file) throw new BadRequestException('ZIP required');
      const result = await this.deployment.uploadPreview(slug, file.path);
      const q = new URLSearchParams({
        previewId: result.previewId,
        slug: result.slug,
        checksum: result.checksum,
        previewUrl: result.previewUrl,
      });
      return res.redirect(`/spadmin/deploy?${q.toString()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      return res.redirect(
        `/spadmin/deploy?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('deploy/confirm')
  @UseGuards(AdminTokenGuard)
  async confirm(
    @Body() body: { previewId: string; slug: string },
    @Res() res: Response,
  ) {
    try {
      await this.deployment.confirm(body.previewId, body.slug);
      return res.redirect(
        `/spadmin?flash=${encodeURIComponent('لندینگ مستقر و در صف همگام‌سازی قرار گرفت')}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Confirm failed';
      return res.redirect(
        `/spadmin/deploy?error=${encodeURIComponent(message)}`,
      );
    }
  }

  // --- مدیریت نودهای Edge ---

  @Get('nodes')
  @UseGuards(AdminTokenGuard)
  @Render('admin/nodes')
  async nodesPage(
    @Query('flash') flash?: string,
    @Query('error') error?: string,
  ) {
    const [nodes, masterUpdate, nodesVersion] = await Promise.all([
      this.nodes.list(),
      this.versions.getMasterStatus(),
      this.versions.getNodesVersionStatus(),
    ]);
    const versionById = new Map(
      nodesVersion.nodes.map((n) => [n.id, n] as const),
    );
    return {
      layout: 'main',
      title: 'مدیریت نودها',
      active: 'nodes',
      flash,
      error,
      appVersion: masterUpdate.localVersion,
      masterUpdate,
      latestVersion: nodesVersion.latestVersion,
      nodeUpdateCommand: nodesVersion.nodeUpdateCommand,
      hasOutdatedNodes: nodesVersion.nodes.some((n) => n.outdated),
      nodes: nodes.map((n) => {
        const v = versionById.get(n.id);
        return {
          ...n,
          lastSeenLabel: n.lastSeenAt
            ? new Date(n.lastSeenAt).toLocaleString('fa-IR')
            : '—',
          statusLabel: statusFa(n.status),
          statusClass: statusClass(n.status),
          localVersion: v?.localVersion || null,
          versionOutdated: v?.outdated || false,
          versionUnreachable: v?.unreachable || false,
        };
      }),
    };
  }

  @Get('nodes/new')
  @UseGuards(AdminTokenGuard)
  @Render('admin/node-edit')
  newNode() {
    return {
      layout: 'main',
      title: 'افزودن نود',
      active: 'nodes',
      node: { port: 3000 },
    };
  }

  @Post('nodes')
  @UseGuards(AdminTokenGuard)
  async createNode(
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ) {
    try {
      const node = await this.nodes.create({
        title: body.title,
        host: body.host,
        port: body.port ? Number(body.port) : 3000,
        notes: body.notes,
      });
      return res.redirect(
        `/spadmin/nodes/${node.id}?flash=${encodeURIComponent('نود ساخته شد — کامند نصب را کپی کنید')}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Create failed';
      return res.status(400).render('admin/node-edit', {
        layout: 'main',
        title: 'افزودن نود',
        active: 'nodes',
        error: message,
        node: body,
      });
    }
  }

  @Get('nodes/:id')
  @UseGuards(AdminTokenGuard)
  @Render('admin/node-detail')
  async nodeDetail(
    @Param('id') id: string,
    @Query('flash') flash?: string,
    @Query('error') error?: string,
  ) {
    const node = await this.nodes.getById(id);
    const [masterUpdate, probed] = await Promise.all([
      this.versions.getMasterStatus(),
      this.nodes.probeHealth(id),
    ]);
    const latest = masterUpdate.latestVersion;
    const localVersion = probed?.version || null;
    const versionOutdated =
      !!latest && !!localVersion && isOutdated(localVersion, latest);
    return {
      layout: 'main',
      title: node.title,
      active: 'nodes',
      flash,
      error,
      appVersion: masterUpdate.localVersion,
      node: {
        ...node,
        lastSeenLabel: node.lastSeenAt
          ? new Date(node.lastSeenAt).toLocaleString('fa-IR')
          : '—',
        statusLabel: statusFa(node.status),
        statusClass: statusClass(node.status),
        localVersion,
        latestVersion: latest,
        versionOutdated,
        versionUnreachable: !probed?.ok,
      },
    };
  }

  @Post('nodes/:id')
  @UseGuards(AdminTokenGuard)
  async updateNode(
    @Param('id') id: string,
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ) {
    try {
      await this.nodes.update(id, {
        title: body.title,
        host: body.host,
        port: body.port ? Number(body.port) : undefined,
        notes: body.notes,
      });
      return res.redirect(
        `/spadmin/nodes/${id}?flash=${encodeURIComponent('نود به‌روز شد')}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      return res.redirect(
        `/spadmin/nodes/${id}?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('nodes/:id/verify')
  @UseGuards(AdminTokenGuard)
  async verifyNode(@Param('id') id: string, @Res() res: Response) {
    try {
      await this.nodes.verify(id);
      return res.redirect(
        `/spadmin/nodes/${id}?flash=${encodeURIComponent('نود آنلاین و تایید شد')}`,
      );
    } catch (err: unknown) {
      let text = 'تایید ناموفق';
      if (err instanceof HttpException) {
        const r = err.getResponse();
        if (typeof r === 'string') {
          text = r;
        } else if (r && typeof r === 'object' && 'message' in r) {
          const m = (r as { message: unknown }).message;
          text = Array.isArray(m) ? m.join(', ') : String(m);
        } else {
          text = err.message;
        }
      } else if (err instanceof Error) {
        text = err.message;
      }
      return res.redirect(
        `/spadmin/nodes/${id}?error=${encodeURIComponent(text)}`,
      );
    }
  }

  @Post('nodes/:id/regenerate-token')
  @UseGuards(AdminTokenGuard)
  async regenerateToken(@Param('id') id: string, @Res() res: Response) {
    try {
      await this.nodes.regenerateToken(id);
      return res.redirect(
        `/spadmin/nodes/${id}?flash=${encodeURIComponent('توکن نصب جدید ساخته شد')}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed';
      return res.redirect(
        `/spadmin/nodes/${id}?error=${encodeURIComponent(message)}`,
      );
    }
  }

  @Post('nodes/:id/delete')
  @UseGuards(AdminTokenGuard)
  async deleteNode(@Param('id') id: string, @Res() res: Response) {
    try {
      await this.nodes.remove(id);
      return res.redirect(
        `/spadmin/nodes?flash=${encodeURIComponent('نود حذف شد')}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      return res.redirect(
        `/spadmin/nodes?error=${encodeURIComponent(message)}`,
      );
    }
  }
}

function statusFa(status: string): string {
  switch (status) {
    case 'ONLINE':
      return 'آنلاین';
    case 'OFFLINE':
      return 'آفلاین';
    case 'ERROR':
      return 'خطا';
    default:
      return 'در انتظار نصب';
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'ONLINE':
      return 'ok';
    case 'OFFLINE':
    case 'ERROR':
      return 'err';
    default:
      return 'pending';
  }
}
