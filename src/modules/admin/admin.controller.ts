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
// jdate.js extends standard classes
import 'jdate.js';

import { WebhookService } from '../form-engine/webhook.service';
import { KavenegarService } from '../form-engine/kavenegar.service';

import { IntegrationProfileService } from '../form-engine/integration-profile.service';

@Controller('spadmin')
export class AdminController {
  constructor(
    private readonly forms: FormEngineService,
    private readonly deployment: DeploymentService,
    private readonly nodes: NodesService,
    private readonly versions: VersionService,
    private readonly webhook: WebhookService,
    private readonly kavenegar: KavenegarService,
    private readonly profiles: IntegrationProfileService,
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

  @Get('profiles')
  @UseGuards(AdminTokenGuard)
  @Render('admin/profiles')
  async profilesPage(@Query('flash') flash?: string, @Query('error') error?: string) {
    const profiles = await this.profiles.list();
    return { layout: 'main', title: 'مدیریت پروفایل‌ها', active: 'profiles', flash, error, profiles };
  }

  @Get('profiles/new')
  @UseGuards(AdminTokenGuard)
  @Render('admin/profile-edit')
  newProfile() {
    return { layout: 'main', title: 'افزودن پروفایل', active: 'profiles', profile: {}, startRow: 2 };
  }

  @Post('profiles')
  @UseGuards(AdminTokenGuard)
  async createProfile(@Body() body: Record<string, string>, @Res() res: Response) {
    try {
      const columnMapping = body.columnMapping ? JSON.parse(body.columnMapping) : null;
      await this.profiles.create({
        name: body.name,
        webhookUrl: body.webhookUrl || null,
        googleSheetUrl: body.googleSheetUrl || null,
        googleSheetMeta: columnMapping ? { startRow: Number(body.startRow) || 2, columns: columnMapping } : null,
      });
      return res.redirect('/spadmin/profiles?flash=' + encodeURIComponent('پروفایل ساخته شد'));
    } catch (err) {
      return res.status(400).render('admin/profile-edit', {
        layout: 'main', title: 'افزودن پروفایل', active: 'profiles',
        error: err instanceof Error ? err.message : 'Create failed',
        profile: body,
        columnMappingJson: body.columnMapping,
        startRow: body.startRow,
      });
    }
  }

  @Get('profiles/:id')
  @UseGuards(AdminTokenGuard)
  @Render('admin/profile-edit')
  async editProfile(@Param('id') id: string) {
    const profile = await this.profiles.getById(id);
    const meta: any = profile.googleSheetMeta || {};
    return {
      layout: 'main', title: 'ویرایش پروفایل', active: 'profiles',
      profile,
      columnMappingJson: meta.columns ? JSON.stringify(meta.columns, null, 2) : '',
      startRow: meta.startRow || 2,
    };
  }

  @Post('profiles/:id')
  @UseGuards(AdminTokenGuard)
  async updateProfile(@Param('id') id: string, @Body() body: Record<string, string>, @Res() res: Response) {
    try {
      const columnMapping = body.columnMapping ? JSON.parse(body.columnMapping) : null;
      await this.profiles.update(id, {
        name: body.name,
        webhookUrl: body.webhookUrl || null,
        googleSheetUrl: body.googleSheetUrl || null,
        googleSheetMeta: columnMapping ? { startRow: Number(body.startRow) || 2, columns: columnMapping } : null,
      });
      return res.redirect('/spadmin/profiles?flash=' + encodeURIComponent('پروفایل به‌روز شد و تمامی فرم‌های متصل ویرایش شدند.'));
    } catch (err) {
      return res.status(400).render('admin/profile-edit', {
        layout: 'main', title: 'ویرایش پروفایل', active: 'profiles',
        error: err instanceof Error ? err.message : 'Update failed',
        profile: body,
        columnMappingJson: body.columnMapping,
        startRow: body.startRow,
      });
    }
  }

  @Post('profiles/:id/delete')
  @UseGuards(AdminTokenGuard)
  async deleteProfile(@Param('id') id: string, @Res() res: Response) {
    try {
      await this.profiles.remove(id);
      return res.redirect('/spadmin/profiles?flash=' + encodeURIComponent('پروفایل حذف شد'));
    } catch (err) {
      return res.redirect('/spadmin/profiles?error=' + encodeURIComponent(err instanceof Error ? err.message : 'Delete failed'));
    }
  }

  @Get('forms/new')
  @UseGuards(AdminTokenGuard)
  @Render('admin/form-edit')
  async newForm() {
    const profiles = await this.profiles.list();
    return {
      layout: 'main',
      title: 'فرم جدید',
      active: 'forms',
      profiles,
      bodyJson: JSON.stringify(
        [
          {
            type: 'text',
            name: 'fullName',
            label: 'نام کامل',
            required: true,
          },
          {
            type: 'text',
            name: 'mobile',
            label: 'شماره موبایل',
            required: true,
          },
        ],
        null,
        2,
      ),
      columnMappingJson: JSON.stringify({ fullName: "A", mobile: "B" }, null, 2),
      startRow: 2,
      form: {
        otpEnabled: false,
        otpField: 'mobile',
        otpTemplate: 'verify',
      }
    };
  }

  @Get('forms/:id')
  @UseGuards(AdminTokenGuard)
  @Render('admin/form-edit')
  async editForm(@Param('id') id: string) {
    const form = await this.forms.getById(id);
    const profiles = await this.profiles.list();
    const meta: any = form.googleSheetMeta || {};
    return {
      layout: 'main',
      title: 'ویرایش فرم',
      active: 'forms',
      form,
      profiles,
      bodyJson: JSON.stringify(form.body, null, 2),
      columnMappingJson: meta.columns ? JSON.stringify(meta.columns, null, 2) : '',
      startRow: meta.startRow || 2,
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
      const columnMapping = body.columnMapping ? JSON.parse(body.columnMapping) : null;
      await this.forms.create({
        title: body.title,
        key: body.key,
        slug: body.slug,
        body: fields,
        webhookUrl: body.webhookUrl || null,
        googleSheetUrl: body.googleSheetUrl || null,
        googleSheetMeta: columnMapping ? { startRow: Number(body.startRow) || 2, columns: columnMapping } : undefined,
        otpEnabled: body.otpEnabled === 'true' || body.otpEnabled === 'on',
        otpField: body.otpField || 'mobile',
        otpTemplate: body.otpTemplate || 'verify',
        otpLength: body.otpLength ? parseInt(body.otpLength, 10) : 5,
        profileId: body.profileId || null,
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
        columnMappingJson: body.columnMapping,
        startRow: body.startRow,
        form: { 
          title: body.title, key: body.key, slug: body.slug,
          webhookUrl: body.webhookUrl, googleSheetUrl: body.googleSheetUrl,
          otpEnabled: body.otpEnabled === 'true' || body.otpEnabled === 'on',
          otpField: body.otpField,
          otpTemplate: body.otpTemplate,
          otpLength: body.otpLength ? parseInt(body.otpLength, 10) : 5,
        },
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
      const columnMapping = body.columnMapping ? JSON.parse(body.columnMapping) : null;
      await this.forms.update(id, {
        title: body.title,
        slug: body.slug,
        body: fields,
        webhookUrl: body.webhookUrl || null,
        googleSheetUrl: body.googleSheetUrl || null,
        googleSheetMeta: columnMapping ? { startRow: Number(body.startRow) || 2, columns: columnMapping } : undefined,
        otpEnabled: body.otpEnabled === 'true' || body.otpEnabled === 'on',
        otpField: body.otpField || 'mobile',
        otpTemplate: body.otpTemplate || 'verify',
        otpLength: body.otpLength ? parseInt(body.otpLength, 10) : 5,
        profileId: body.profileId || null,
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
        form: {
          ...form,
          title: body.title || form.title,
          slug: body.slug || form.slug,
          webhookUrl: body.webhookUrl,
          googleSheetUrl: body.googleSheetUrl,
          otpEnabled: body.otpEnabled === 'true' || body.otpEnabled === 'on',
          otpField: body.otpField,
          otpTemplate: body.otpTemplate,
          otpLength: body.otpLength ? parseInt(body.otpLength, 10) : 5,
        },
        bodyJson: body.body,
        columnMappingJson: body.columnMapping,
        startRow: body.startRow,
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

  @Post('deploy/sync-all')
  @UseGuards(AdminTokenGuard)
  async syncAllLandings(@Res() res: Response) {
    try {
      const result = await this.deployment.syncAll();
      return res.redirect(`/spadmin?flash=${encodeURIComponent(`همگام‌سازی ${result.synced} لندینگ آغاز شد`)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      return res.redirect(`/spadmin?error=${encodeURIComponent(message)}`);
    }
  }

  @Post('deploy/sync/:slug')
  @UseGuards(AdminTokenGuard)
  async syncSingleLanding(@Param('slug') slug: string, @Res() res: Response) {
    try {
      await this.deployment.syncSingle(slug);
      return res.redirect(`/spadmin?flash=${encodeURIComponent(`همگام‌سازی مجدد ${slug} آغاز شد`)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      return res.redirect(`/spadmin?error=${encodeURIComponent(message)}`);
    }
  }

  @Get('settings')
  @UseGuards(AdminTokenGuard)
  @Render('admin/settings')
  async settingsPage(@Query('flash') flash?: string) {
    const kavenegarApiKey = await this.kavenegar.getApiKey();
    return {
      layout: 'main',
      title: 'تنظیمات سیستم',
      active: 'settings',
      kavenegarApiKey,
      flash,
    };
  }

  @Post('settings/kavenegar')
  @UseGuards(AdminTokenGuard)
  async saveKavenegarSetting(
    @Body('apiKey') apiKey: string,
    @Res() res: Response,
  ) {
    await this.kavenegar.setApiKey(apiKey);
    return res.redirect('/spadmin/settings?flash=' + encodeURIComponent('تنظیمات کاوه‌نگار ذخیره شد'));
  }
  @UseGuards(AdminTokenGuard)
  @Render('admin/submissions')
  async submissionsPage(
    @Query('formId') formId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('otpFilter') otpFilter?: string,
  ) {
    const forms = await this.forms.list();
    const activeFormId = formId || undefined;

    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    // در صورتی که تاریخ جلالی باشد، تبدیل به میلادی
    if (startDate) {
      const [jy, jm, jd] = startDate.split('/').map(Number);
      if (jy && jm && jd) {
        const g = (Date as any).jalaliToGregorian(jy, jm, jd);
        fromDate = new Date(g.year, g.month - 1, g.date, 0, 0, 0, 0);
      }
    }

    if (endDate) {
      const [jy, jm, jd] = endDate.split('/').map(Number);
      if (jy && jm && jd) {
        const g = (Date as any).jalaliToGregorian(jy, jm, jd);
        toDate = new Date(g.year, g.month - 1, g.date, 23, 59, 59, 999);
      }
    }

    const rawSubmissions = await this.forms.listSubmissions(
      activeFormId,
      fromDate,
      toDate,
      otpFilter,
    );

    const submissions = rawSubmissions.map((s) => {
      const d = new Date(s.createdAt);
      const j = (d as any).jalali;
      const jdateStr = j
        ? `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.date).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : d.toLocaleString('fa-IR');

      return {
        id: s.id,
        formTitle: s.form?.title || '—',
        jalaliDate: jdateStr,
        nodeTitle: s.edgeNode ? s.edgeNode.title : 'سرور Master (لوکال)',
        payloadStr: JSON.stringify(s.payload, null, 2),
        otpStatus: s.otpStatus,
        isVerified: s.otpStatus === 'VERIFIED',
        isUnverified: s.otpStatus === 'UNVERIFIED',
      };
    });

    return {
      layout: 'main',
      title: 'لیدها',
      active: 'submissions',
      forms,
      activeFormId,
      startDate,
      endDate,
      otpFilter,
      submissions,
    };
  }

  @Get('failed-webhooks')
  @UseGuards(AdminTokenGuard)
  @Render('admin/failed-webhooks')
  async failedWebhooksPage(
    @Query('flash') flash?: string,
    @Query('error') error?: string,
  ) {
    const raw = await this.forms.listFailedWebhooks();
    const items = raw.map((s) => {
      const d = new Date(s.createdAt);
      const j = (d as any).jalali;
      const jdateStr = j
        ? `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.date).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : d.toLocaleString('fa-IR');

      return {
        id: s.id,
        formTitle: s.form?.title || '—',
        jalaliDate: jdateStr,
        attempts: s.webhookAttempts,
        lastError: s.webhookLastError,
        payloadStr: JSON.stringify(s.payload, null, 2),
      };
    });

    return {
      layout: 'main',
      title: 'خطاهای وب‌هوک',
      active: 'failed-webhooks',
      flash,
      error,
      items,
    };
  }

  @Post('failed-webhooks/:id/retry')
  @UseGuards(AdminTokenGuard)
  async retryWebhook(@Param('id') id: string, @Res() res: Response) {
    try {
      await this.webhook.retryFailedWebhook(id);
      return res.redirect('/spadmin/failed-webhooks?flash=' + encodeURIComponent('وب‌هوک با موفقیت ارسال شد'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.redirect('/spadmin/failed-webhooks?error=' + encodeURIComponent(`ارسال مجدد ناموفق بود: ${message}`));
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

    // پروب کردن سلامتی برای بدست آوردن تعداد سابمیشن‌های منتظر (pending) در Edge
    const probes = await Promise.all(
      nodes.map(n => this.nodes.probeHealth(n.id))
    );

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
      nodes: nodes.map((n, idx) => {
        const v = versionById.get(n.id);
        const probe = probes[idx];
        return {
          ...n,
          lastSeenLabel: n.lastSeenAt
            ? new Date(n.lastSeenAt).toLocaleString('fa-IR')
            : '—',
          statusLabel: statusFa(n.status),
          statusClass: statusClass(n.status),
          rabbitStatusLabel: statusFa(n.rabbitStatus),
          rabbitStatusClass: statusClass(n.rabbitStatus),
          localVersion: v?.localVersion || null,
          versionOutdated: v?.outdated || false,
          versionUnreachable: v?.unreachable || false,
          pendingSubmissions: probe?.pendingSubmissions || 0,
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
        rabbitStatusLabel: statusFa(node.rabbitStatus),
        rabbitStatusClass: statusClass(node.rabbitStatus),
        localVersion,
        latestVersion: latest,
        versionOutdated,
        versionUnreachable: !probed?.ok,
        rabbitLiveOk: probed?.rabbitmq?.ok ?? null,
        rabbitLiveError: probed?.rabbitmq?.error || null,
        rabbitLiveQueue: probed?.rabbitmq?.queue || node.queueName,
        activeDownload: probed?.activeDownload,
        downloadHistory: probed?.downloadHistory,
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
        `/spadmin/nodes/${id}?flash=${encodeURIComponent('نود تایید شد (HTTP). اگر Rabbit قطع باشد لندینگ از HTTP pull می‌آید')}`,
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

  @Post('nodes/:id/sync-landings')
  @UseGuards(AdminTokenGuard)
  async syncLandingsToNode(@Param('id') id: string, @Res() res: Response) {
    try {
      await this.nodes.syncAllLandingsToNode(id);
      return res.redirect(
        `/spadmin/nodes/${id}?flash=${encodeURIComponent('همه لندینگ‌های موجود برای این نود در صف ارسال قرار گرفتند')}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
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
